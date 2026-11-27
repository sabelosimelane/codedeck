import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

function requireConfig(env = process.env) {
  const rawUrl = env.CODEDECK_ASSISTANT_URL;
  const token = env.CODEDECK_ASSISTANT_TOKEN;
  if (typeof rawUrl !== 'string' || !rawUrl) {
    throw new Error('CODEDECK_ASSISTANT_URL is required');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('CODEDECK_ASSISTANT_URL must be a valid URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('CODEDECK_ASSISTANT_URL must use http or https');
  }
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new Error('CODEDECK_ASSISTANT_TOKEN must be a 64-character hex token');
  }
  return { baseUrl: parsed.origin, token };
}

async function requestJson(url, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(error?.message || 'CodeDeck server request failed');
  }

  let parsed = null;
  let parseFailed = false;
  try {
    parsed = await response.json();
  } catch {
    parseFailed = true;
  }

  if (!response.ok) {
    const message = typeof parsed?.message === 'string' && parsed.message.trim()
      ? parsed.message
      : `CodeDeck request failed with status ${response.status}`;
    const fields = Array.isArray(parsed?.errors)
      ? parsed.errors
        .filter(item => typeof item?.field === 'string' && typeof item?.message === 'string')
        .map(item => `${item.field}: ${item.message}`)
      : [];
    throw new Error(fields.length ? `${message} (${fields.join('; ')})` : message);
  }
  if (parseFailed) {
    throw new Error(`CodeDeck returned a response that is not JSON (status ${response.status}).`);
  }
  return parsed;
}

const fetchJson = url => requestJson(url);
const postJson = (url, body) => requestJson(url, { method: 'POST', body });

function okResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  };
}

export function createAssistantMcpServer({ baseUrl, token }) {
  const server = new McpServer({
    name: 'codedeck',
    version: '1.0.0',
  });
  const sessionBase = `${baseUrl}/api/assistant/sessions/${encodeURIComponent(token)}`;

  server.registerTool(
    'get_situation',
    {
      description: 'Return the current project situation markdown and flags.',
      inputSchema: {},
    },
    async () => {
      try {
        const data = await fetchJson(`${sessionBase}/situation`);
        return okResult({ markdown: data.markdown, flags: data.flags });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_task_landing',
    {
      description: 'Return the live Git landing view for each worktree of a task in this project.',
      inputSchema: {
        taskId: z.string().min(1).describe('UUID of the task'),
      },
    },
    async ({ taskId }) => {
      try {
        const data = await fetchJson(`${sessionBase}/tasks/${encodeURIComponent(taskId)}/landing`);
        return okResult(data);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'read_todo',
    {
      description: 'Read a todo or specification markdown file (up to 512 KiB) from a main repository or open task worktree.',
      inputSchema: {
        location: z.string().min(1).describe('Location string: main:<repository> or task:<taskId>/<worktreeId>'),
        path: z.string().min(1).describe('Relative path under docs/todos/ or docs/specifications/'),
      },
    },
    async ({ location, path: relPath }) => {
      try {
        const params = new URLSearchParams({ location, path: relPath });
        const data = await fetchJson(`${sessionBase}/todo?${params.toString()}`);
        return okResult(data);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'read_run_notes',
    {
      description: 'Read the latest written step note for a workflow run in this project.',
      inputSchema: {
        runId: z.string().min(1).describe('UUID of the workflow run'),
        stepIndex: z.number().int().min(0).max(32).describe('Zero-based step index'),
      },
    },
    async ({ runId, stepIndex }) => {
      try {
        const params = new URLSearchParams({ stepIndex: String(stepIndex) });
        const data = await fetchJson(`${sessionBase}/runs/${encodeURIComponent(runId)}/notes?${params.toString()}`);
        return okResult(data);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'list_teams',
    {
      description: 'List the teams that can staff a workflow run: id, name, and each role with its agent. Use the id in propose_start_run or propose_change_team.',
      inputSchema: {
        page: z.number().int().min(0).optional().describe('Page from 0'),
      },
    },
    async ({ page }) => {
      try {
        return okResult(await fetchJson(`${sessionBase}/teams?size=100${page !== undefined ? `&page=${page}` : ''}`));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'list_workflows',
    {
      description: 'List the workflows a run can follow: id, name, kind, description, and its steps with their roles. Use the id in propose_start_run.',
      inputSchema: {
        kind: z.enum(['build', 'bugfix', 'troubleshoot', 'review', 'other']).optional().describe('Only workflows of this kind'),
        page: z.number().int().min(0).optional().describe('Page from 0'),
      },
    },
    async ({ kind, page }) => {
      try {
        const params = new URLSearchParams({ size: '100' });
        if (kind !== undefined) params.set('kind', kind);
        if (page !== undefined) params.set('page', String(page));
        return okResult(await fetchJson(`${sessionBase}/workflows?${params}`));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'list_runs',
    {
      description: 'List workflow runs for this project, optionally filtered to one task.',
      inputSchema: {
        taskId: z.string().min(1).optional().describe('Optional task UUID filter'),
      },
    },
    async ({ taskId }) => {
      try {
        const params = new URLSearchParams();
        if (taskId !== undefined) params.set('taskId', taskId);
        const query = params.toString();
        const data = await fetchJson(`${sessionBase}/runs${query ? `?${query}` : ''}`);
        return okResult(data);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  const createProposal = async (kind, payload, { summary, reason }) => {
    const created = await postJson(`${sessionBase}/proposals`, { kind, payload, summary, reason });
    return okResult({ proposalId: created.id, state: created.state });
  };

  const PROPOSE_STOP_HINT = 'Returns {proposalId, state: "pending"} immediately without waiting. Stop after proposing and explain what you proposed to the owner.';

  const RUN_ID = z.string().min(1).describe('Run UUID, from list_runs');
  const CARD = {
    summary: z.string().min(1).describe('One-line summary for the proposal card (1-300 characters)'),
    reason: z.string().min(1).describe('Why you are proposing this (1-2000 characters)'),
  };
  const runProposal = (name, kind, description, fields) => server.registerTool(
    name,
    { description: `${description} ${PROPOSE_STOP_HINT}`, inputSchema: { runId: RUN_ID, ...fields, ...CARD } },
    async ({ summary, reason, ...payload }) => {
      try {
        return await createProposal(kind, payload, { summary, reason });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  runProposal('propose_stop_run', 'stop_run', 'Propose stopping a workflow run of this project (when it is blocked or should not continue). A stopped run can be resumed later.', {});
  runProposal('propose_resume_run', 'resume_run', 'Propose resuming a stopped or interrupted workflow run of this project (its actions.resume in list_runs is true).', {});
  runProposal('propose_answer_run', 'answer_run', 'Propose an answer to a workflow run that needs input (status needs_input; its questions are in inputRequest from list_runs). The owner approves the exact text before it is typed to the agent. "Proceed with your recommendations." accepts every recommendation the agent gave.', {
    answer: z.string().min(1).describe('The answer, 1-4000 characters; for listed questions one numbered line each, e.g. "1. (a) …"'),
  });
  runProposal('propose_continue_run', 'continue_run', 'Propose granting one more round to a run paused at its round limit (status limit_paused). Copy stepIndex, roundsCompleted and extraRounds from its limitPause in list_runs: the grant only applies to that exact pause.', {
    stepIndex: z.number().int().describe('limitPause.stepIndex'),
    roundsCompleted: z.number().int().describe('limitPause.roundsCompleted'),
    extraRounds: z.number().int().optional().describe('limitPause.extraRounds'),
  });
  runProposal('propose_change_team', 'change_team', 'Propose giving a stopped or interrupted run another team for its remaining steps (team UUID from list_teams). Then propose resuming it.', {
    teamId: z.string().min(1).describe('Team UUID, from list_teams'),
  });

  server.registerTool(
    'propose_commit',
    {
      description: `Propose committing uncommitted changes in a task worktree. ${PROPOSE_STOP_HINT}`,
      inputSchema: {
        taskId: z.string().min(1).describe('UUID of an open task in this project'),
        worktreeId: z.string().min(1).optional().describe('Optional worktree UUID'),
        message: z.string().min(1).describe('Single-line commit message (1-200 characters)'),
        summary: z.string().min(1).describe('One-line summary for the proposal card (1-300 characters)'),
        reason: z.string().min(1).describe('Why you are proposing this commit (1-2000 characters)'),
      },
    },
    async ({ taskId, worktreeId, message, summary, reason }) => {
      try {
        const payload = { taskId, message, ...(worktreeId !== undefined ? { worktreeId } : {}) };
        return await createProposal('commit', payload, { summary, reason });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'propose_merge',
    {
      description: `Propose merging a task branch into its base branch. ${PROPOSE_STOP_HINT}`,
      inputSchema: {
        taskId: z.string().min(1).describe('UUID of an open task in this project'),
        worktreeId: z.string().min(1).optional().describe('Optional worktree UUID'),
        summary: z.string().min(1).describe('One-line summary for the proposal card (1-300 characters)'),
        reason: z.string().min(1).describe('Why you are proposing this merge (1-2000 characters)'),
      },
    },
    async ({ taskId, worktreeId, summary, reason }) => {
      try {
        const payload = { taskId, ...(worktreeId !== undefined ? { worktreeId } : {}) };
        return await createProposal('merge', payload, { summary, reason });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'propose_pull_request',
    {
      description: `Propose pushing a task branch and opening a pull/merge request. ${PROPOSE_STOP_HINT}`,
      inputSchema: {
        taskId: z.string().min(1).describe('UUID of an open task in this project'),
        worktreeId: z.string().min(1).optional().describe('Optional worktree UUID'),
        remote: z.string().min(1).describe('Git remote name (1-100 characters)'),
        summary: z.string().min(1).describe('One-line summary for the proposal card (1-300 characters)'),
        reason: z.string().min(1).describe('Why you are proposing this pull request (1-2000 characters)'),
      },
    },
    async ({ taskId, worktreeId, remote, summary, reason }) => {
      try {
        const payload = { taskId, remote, ...(worktreeId !== undefined ? { worktreeId } : {}) };
        return await createProposal('pull_request', payload, { summary, reason });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'propose_close',
    {
      description: `Propose closing an open task or one of its worktrees (never deletes ignored files). ${PROPOSE_STOP_HINT}`,
      inputSchema: {
        taskId: z.string().min(1).describe('UUID of an open task in this project'),
        worktreeId: z.string().min(1).optional().describe('Optional worktree UUID'),
        summary: z.string().min(1).describe('One-line summary for the proposal card (1-300 characters)'),
        reason: z.string().min(1).describe('Why you are proposing closing this task (1-2000 characters)'),
      },
    },
    async ({ taskId, worktreeId, summary, reason }) => {
      try {
        const payload = { taskId, ...(worktreeId !== undefined ? { worktreeId } : {}) };
        return await createProposal('close', payload, { summary, reason });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'propose_new_task',
    {
      description: `Propose creating a new task in this project; it cannot choose a base branch. To start a run in a new task cut from a particular branch, use propose_start_run with newTask.baseBranch instead. ${PROPOSE_STOP_HINT}`,
      inputSchema: {
        title: z.string().min(1).describe('Task title (1-80 characters on one line)'),
        repositories: z.array(z.string().min(1)).optional().describe('Optional list of repository names'),
        summary: z.string().min(1).describe('One-line summary for the proposal card (1-300 characters)'),
        reason: z.string().min(1).describe('Why you are proposing a new task (1-2000 characters)'),
      },
    },
    async ({ title, repositories, summary, reason }) => {
      try {
        const payload = { title, ...(repositories !== undefined ? { repositories } : {}) };
        return await createProposal('new_task', payload, { summary, reason });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'propose_start_run',
    {
      description: `Propose starting a workflow run in this project. Take workflowId from list_workflows and teamId from list_teams. To run in a new task cut from a particular branch, pass newTask.baseBranch. ${PROPOSE_STOP_HINT}`,
      inputSchema: {
        workflowId: z.string().min(1).describe('Workflow UUID'),
        input: z.string().describe('Run input text or todo path'),
        teamId: z.string().min(1).describe('Team UUID'),
        taskId: z.string().min(1).optional().describe('Optional existing open task UUID'),
        newTask: z.object({
          title: z.string().optional(),
          repositories: z.array(z.string()).optional(),
          baseBranch: z.string().optional(),
        }).optional().describe('Optional new task configuration'),
        startIn: z.string().min(1).optional().describe('Optional repository name to start in'),
        summary: z.string().min(1).describe('One-line summary for the proposal card (1-300 characters)'),
        reason: z.string().min(1).describe('Why you are proposing this run (1-2000 characters)'),
      },
    },
    async ({ workflowId, input, teamId, taskId, newTask, startIn, summary, reason }) => {
      try {
        const payload = {
          workflowId,
          input,
          teamId,
          ...(taskId !== undefined ? { taskId } : {}),
          ...(newTask !== undefined ? { newTask } : {}),
          ...(startIn !== undefined ? { startIn } : {}),
        };
        return await createProposal('start_run', payload, { summary, reason });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

async function main() {
  const config = requireConfig(process.env);
  const server = createAssistantMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[codedeck-mcp] ${error?.message ?? String(error)}`);
    process.exit(1);
  });
}
