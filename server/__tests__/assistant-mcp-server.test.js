import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CODEDECK_ASSISTANT_TOOLS } from '../assistant/codedeck-tools.js';
import { createConversationStore } from '../assistant/conversation-store.js';
import { createProposalStore } from '../assistant/proposal-store.js';
import { createSessionTokens } from '../assistant/session-tokens.js';
import { createAssistantRouter } from '../routes/assistant.js';

const mcpServerPath = fileURLToPath(new URL('../assistant/mcp-server.js', import.meta.url));
const TASK_A = '11111111-1111-4111-8111-111111111111';
const WT_A = '33333333-3333-4333-8333-333333333333';
const RUN_A = '44444444-4444-4444-8444-444444444444';
const WF_A = '55555555-5555-4555-8555-555555555555';
const TEAM_A = '66666666-6666-4666-8666-666666666666';

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function startTestServer() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-mcp-'));
  cleanups.push(() => fs.rm(tmpDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(tmpDir, 'docs', 'todos'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'docs', 'todos', 'feature.md'), '# Feature Todo\n- [x] One\n- [ ] Two\n');

  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  const store = createConversationStore(db);
  const proposalStore = createProposalStore(db);
  const sessionTokens = createSessionTokens();
  const conv = store.current('Demo');
  const session = sessionTokens.issue({ project: 'Demo', conversationId: conv.id });

  const app = express();
  app.use(createAssistantRouter({
    compose: async project => ({
      project,
      generatedAt: '2026-11-26T00:00:00.000Z',
      flags: [{ code: 'work_uncommitted_no_commits', message: 'Task has uncommitted files.', where: { taskId: TASK_A } }],
      markdown: `# ${project} — where things stand\n- Task has uncommitted files.`,
      truncated: { dirty: false, todos: false, specifications: false },
      skipped: [],
    }),
    store,
    proposalStore,
    findProject: name => (name === 'Demo' ? { name, path: tmpDir, defaultHost: 'local' } : null),
    sessionTokens,
    repositoryService: { list: async () => [{ name: 'backend', own: true, path: tmpDir, usable: true }] },
    taskStore: { get: id => (id === TASK_A ? { id: TASK_A, project: 'Demo', title: 'Demo task', state: 'active', worktrees: [{ id: WT_A, repository: 'backend', worktreePath: tmpDir }] } : null) },
    landing: { worktrees: async () => [{ worktreeId: WT_A, repository: 'backend', worktreePath: tmpDir, branch: 'feat/demo', commitsAhead: 0, uncommittedCount: 5 }] },
    runStore: {
      get: id => (id === RUN_A ? { id: RUN_A, project: 'Demo', taskId: TASK_A, status: 'complete', createdAt: '2026-11-26T00:00:00.000Z' } : null),
      list: () => [{ id: RUN_A, project: 'Demo', taskId: TASK_A, status: 'complete', createdAt: '2026-11-26T00:00:00.000Z' }],
    },
    noteStore: {
      lastWritten: (runId, stepIndex) => (runId === RUN_A && stepIndex === 2
        ? { id: 1, runId, stepIndex, stepName: 'Test', attempt: 1, pass: 1, status: 'written', summary: 'All red fixed', content: '# Test Note', createdAt: '2026-11-26T00:01:00.000Z' }
        : null),
    },
    runView: async run => ({ id: run.id, project: run.project, taskId: run.taskId, status: run.status, createdAt: run.createdAt }),
    teamStore: { get: id => (id === TEAM_A ? { id: TEAM_A } : null), list: () => [{ id: TEAM_A, name: 'The Fast Dev Team', members: [{ role: 'Developer', agentId: WF_A }] }] },
    workflowStore: { list: () => [{ id: WF_A, name: 'Feature Build from Spec', kind: 'build', description: 'Builds a todo', agentsDecide: true, nodes: [{ name: 'Develop', role: 'Developer', prompt: 'secret prompt' }] }] },
    agentStore: { get: id => (id === WF_A ? { id, name: 'Codex Sol' } : null) },
  }));

  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, session, sessionTokens, proposalStore };
}

async function connectMcp(baseUrl, token) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServerPath],
    env: {
      ...process.env,
      CODEDECK_ASSISTANT_URL: baseUrl,
      CODEDECK_ASSISTANT_TOKEN: token,
    },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

describe('assistant stdio MCP server', () => {
  it('exposes the five read tools and returns real data through the session token', async () => {
    const { baseUrl, session } = await startTestServer();
    const client = await connectMcp(baseUrl, session.token);

    const listed = await client.listTools();
    expect(listed.tools.map(t => t.name).sort()).toEqual([
      'get_situation',
      'get_task_landing',
      'list_runs',
      'list_teams',
      'list_workflows',
      'propose_answer_run',
      'propose_change_team',
      'propose_close',
      'propose_commit',
      'propose_continue_run',
      'propose_merge',
      'propose_new_task',
      'propose_pull_request',
      'propose_resume_run',
      'propose_start_run',
      'propose_stop_run',
      'read_run_notes',
      'read_todo',
    ]);

    // The bridge allows exactly these without asking: a new tool must be added there on purpose.
    expect(listed.tools.map(t => t.name).sort()).toEqual([...CODEDECK_ASSISTANT_TOOLS].sort());

    const sit = await client.callTool({ name: 'get_situation', arguments: {} });
    expect(sit.isError).toBeFalsy();
    expect(JSON.parse(sit.content[0].text)).toEqual({
      markdown: '# Demo — where things stand\n- Task has uncommitted files.',
      flags: [expect.objectContaining({ code: 'work_uncommitted_no_commits' })],
    });

    const landing = await client.callTool({ name: 'get_task_landing', arguments: { taskId: TASK_A } });
    expect(landing.isError).toBeFalsy();
    expect(JSON.parse(landing.content[0].text)).toMatchObject({
      taskId: TASK_A,
      worktrees: [expect.objectContaining({ worktreeId: WT_A, uncommittedCount: 5 })],
    });

    const todo = await client.callTool({ name: 'read_todo', arguments: { location: 'main:backend', path: 'docs/todos/feature.md' } });
    expect(todo.isError).toBeFalsy();
    expect(JSON.parse(todo.content[0].text)).toMatchObject({
      location: 'main:backend',
      path: 'docs/todos/feature.md',
      content: '# Feature Todo\n- [x] One\n- [ ] Two\n',
    });

    const note = await client.callTool({ name: 'read_run_notes', arguments: { runId: RUN_A, stepIndex: 2 } });
    expect(note.isError).toBeFalsy();
    expect(JSON.parse(note.content[0].text)).toMatchObject({
      runId: RUN_A,
      stepIndex: 2,
      note: { summary: 'All red fixed', content: '# Test Note' },
    });

    const runs = await client.callTool({ name: 'list_runs', arguments: { taskId: TASK_A } });
    expect(runs.isError).toBeFalsy();
    expect(JSON.parse(runs.content[0].text)).toMatchObject({
      data: [expect.objectContaining({ id: RUN_A })],
      page: { totalElements: 1 },
    });
  });

  it('returns MCP errors carrying the RFC 9457 problem message when a token is wrong or a request is refused', async () => {
    const { baseUrl } = await startTestServer();
    const badClient = await connectMcp(baseUrl, 'f'.repeat(64));

    const refused = await badClient.callTool({ name: 'get_situation', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Invalid or expired assistant session token');

    const { baseUrl: url2, session } = await startTestServer();
    const client = await connectMcp(url2, session.token);
    const badPath = await client.callTool({ name: 'read_todo', arguments: { location: 'main:backend', path: '../secret.md' } });
    expect(badPath.isError).toBe(true);
    expect(badPath.content[0].text).toContain('One or more fields failed validation');
    expect(badPath.content[0].text).toContain('path: Use a markdown file directly inside docs/todos/ or docs/specifications/');
  });

  it('creates pending proposals through all six propose_* tools and reports validation errors', async () => {
    const { baseUrl, session, proposalStore } = await startTestServer();
    const client = await connectMcp(baseUrl, session.token);

    const commitRes = await client.callTool({
      name: 'propose_commit',
      arguments: { taskId: TASK_A, worktreeId: WT_A, message: 'wip: checkpoint', summary: 'Commit demo task', reason: 'Save work.' },
    });
    expect(commitRes.isError).toBeFalsy();
    const commitOut = JSON.parse(commitRes.content[0].text);
    expect(commitOut).toEqual({ proposalId: expect.any(String), state: 'pending' });
    expect(proposalStore.get(commitOut.proposalId)).toMatchObject({ kind: 'commit', state: 'pending' });

    const mergeRes = await client.callTool({
      name: 'propose_merge',
      arguments: { taskId: TASK_A, summary: 'Merge demo task', reason: 'Ready.' },
    });
    expect(mergeRes.isError).toBeFalsy();

    const prRes = await client.callTool({
      name: 'propose_pull_request',
      arguments: { taskId: TASK_A, remote: 'origin', summary: 'Open PR', reason: 'Review.' },
    });
    expect(prRes.isError).toBeFalsy();

    const closeRes = await client.callTool({
      name: 'propose_close',
      arguments: { taskId: TASK_A, summary: 'Close task', reason: 'Done.' },
    });
    expect(closeRes.isError).toBeFalsy();

    const newTaskRes = await client.callTool({
      name: 'propose_new_task',
      arguments: { title: 'Next phase', repositories: ['backend'], summary: 'Create task', reason: 'Start next phase.' },
    });
    expect(newTaskRes.isError).toBeFalsy();

    const runRes = await client.callTool({
      name: 'propose_start_run',
      arguments: { workflowId: WF_A, input: 'todos/feature.md', teamId: TEAM_A, taskId: TASK_A, summary: 'Start run', reason: 'Continue.' },
    });
    expect(runRes.isError).toBeFalsy();

    const invalid = await client.callTool({
      name: 'propose_commit',
      arguments: { taskId: '99999999-9999-4999-8999-999999999999', message: 'wip', summary: 'Commit missing', reason: 'Test.' },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain('payload.taskId');
  });

  it('reports a non-JSON answer from the server instead of using nothing', async () => {
    const plain = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('not json');
    });
    await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise(resolve => plain.close(resolve)));
    const { port } = plain.address();
    const client = await connectMcp(`http://127.0.0.1:${port}`, 'a'.repeat(64));
    const result = await client.callTool({ name: 'get_situation', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not JSON');
  });
});

describe('assistant MCP tools for driving runs', () => {
  const text = result => JSON.parse(result.content[0].text);
  it('lists teams and workflows with the ids a run proposal needs, and no prompts', async () => {
    const { baseUrl, session } = await startTestServer();
    const client = await connectMcp(baseUrl, session.token);
    const teams = await client.callTool({ name: 'list_teams', arguments: {} });
    expect(teams.isError).toBeFalsy();
    expect(text(teams).data).toEqual([{ id: TEAM_A, name: 'The Fast Dev Team', members: [{ role: 'Developer', agentId: WF_A, agentName: 'Codex Sol' }] }]);
    const workflows = await client.callTool({ name: 'list_workflows', arguments: { kind: 'build' } });
    expect(text(workflows).data).toEqual([{ id: WF_A, name: 'Feature Build from Spec', kind: 'build', description: 'Builds a todo', agentsDecide: true, steps: [{ name: 'Develop', role: 'Developer' }] }]);
    expect(workflows.content[0].text).not.toContain('secret prompt');
  });
  it('creates a pending proposal through each run tool and reports a refused one', async () => {
    const { baseUrl, session, proposalStore } = await startTestServer();
    const client = await connectMcp(baseUrl, session.token);
    const calls = [
      ['propose_stop_run', { runId: RUN_A }, 'stop_run'],
      ['propose_resume_run', { runId: RUN_A }, 'resume_run'],
      ['propose_answer_run', { runId: RUN_A, answer: '1. (a) Close Batch 1 first' }, 'answer_run'],
      ['propose_continue_run', { runId: RUN_A, stepIndex: 2, roundsCompleted: 8 }, 'continue_run'],
      ['propose_change_team', { runId: RUN_A, teamId: TEAM_A }, 'change_team'],
    ];
    for (const [name, args, kind] of calls) {
      const result = await client.callTool({ name, arguments: { ...args, summary: `Do ${kind}`, reason: 'The owner asked for it.' } });
      expect(result.isError, `${name}: ${result.content[0].text}`).toBeFalsy();
      const { proposalId, state } = text(result);
      expect(state).toBe('pending');
      expect(proposalStore.get(proposalId)).toMatchObject({ kind, state: 'pending', payload: args });
    }
    const refused = await client.callTool({ name: 'propose_stop_run', arguments: { runId: '99999999-9999-4999-8999-999999999999', summary: 'Stop', reason: 'r' } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Run not found');
  });
});
