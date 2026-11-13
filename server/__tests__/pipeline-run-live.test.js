/**
 * Live Phase 3 multi-step run: real git worktree + real tmux + real loop engine.
 * Readiness is faked (agent screen classifier needs a real CLI); the stub agent
 * reads the pasted workflow prompt and prints COMPLETE (or CONTINUE then COMPLETE).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { createSettingsStore } from '../pipelines/settings-store.js';
import { createRunStore } from '../pipelines/run-store.js';
import { createRunEngine } from '../pipelines/run-engine.js';
import {
  create as createWorktree,
  remove as removeWorktree,
  listDirtyPaths,
  planNames,
  resolveHomeRepoPath,
  buildSetupPrompt,
} from '../pipelines/run-worktree.js';
import { createTerminalRuntime } from '../terminal-runtime.js';
import { attachBackgroundSession } from '../ws-handler.js';
import { createTerminalWorkflow } from '../terminal-workflow.js';
import { INITIAL_COLS, INITIAL_ROWS } from '../mobile-session-start.js';

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function hasTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const describeLive = hasGit() && hasTmux() ? describe : describe.skip;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(root) {
  mkdirSync(root, { recursive: true });
  git(root, ['init']);
  git(root, ['config', 'user.email', 'pipeline@test.local']);
  git(root, ['config', 'user.name', 'Pipeline Test']);
  writeFileSync(path.join(root, 'README.md'), '# pipeline live\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'init']);
}

function writeStubAgent(dir, { continueFirst = false } = {}) {
  // Reads PTY input; emits CONTINUE once (optional) then COMPLETE for each iteration id.
  const script = path.join(dir, continueFirst ? 'stub-agent-repeat' : 'stub-agent');
  writeFileSync(script, `#!/usr/bin/env node
let buf = '';
let armed = true;
let emitted = 0;
const continueFirst = ${continueFirst ? 'true' : 'false'};
process.stdin.setEncoding('utf8');
process.stdout.write('>_ OpenAI Codex (stub)\\n› \\n');
process.stdin.on('data', chunk => {
  if (!armed) return;
  buf += chunk;
  const match = buf.match(/Iteration identifier: ([\\w-]+)/);
  if (!match) return;
  const id = match[1];
  armed = false;
  emitted += 1;
  const pass = emitted;
  setTimeout(() => {
    if (continueFirst && pass === 1) {
      process.stdout.write('\\n[[CDW:' + id + ':CONTINUE]]\\n');
      buf = '';
      armed = true;
      return;
    }
    process.stdout.write('\\n[[CDW:' + id + ':COMPLETE]]\\n');
  }, 200);
});
`);
  chmodSync(script, 0o755);
  return script;
}

async function waitFor(predicate, timeoutMs = 30000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const temps = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describeLive('pipeline run live (Phase 3)', () => {
  it('runs Setup then a repeating node and removes the worktree on complete', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-live-'));
    temps.push(base);
    const tmuxDir = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-tmux-'));
    temps.push(tmuxDir);
    const home = path.join(base, 'codedeck');
    initRepo(home);
    const setupStub = writeStubAgent(base);
    const repeatStub = writeStubAgent(base, { continueFirst: true });

    const previousTmp = process.env.TMUX_TMPDIR;
    const previousTmux = process.env.TMUX;
    process.env.TMUX_TMPDIR = tmuxDir;
    delete process.env.TMUX;

    const db = new Database(':memory:');
    const agents = createAgentStore(db);
    const workflows = createWorkflowStore(db);
    const settings = createSettingsStore(db);
    const runs = createRunStore(db);
    const sessions = new Map();
    const deletedSessionIds = new Set();
    const runtime = createTerminalRuntime('tmux');
    let sessionSeq = 0;

    const setupAgent = agents.create({
      name: 'setup-stub',
      launchCommand: setupStub,
      resetCommand: '/clear',
    });
    const nodeAgent = agents.create({
      name: 'codex-stub',
      launchCommand: repeatStub,
      resetCommand: '/clear',
    });
    settings.update({ setupAgentId: setupAgent.id, revision: 1 });
    const workflow = workflows.create({
      name: 'Live',
      nodes: [{
        name: 'Echo',
        agentId: nodeAgent.id,
        prompt: 'finish now',
        repeat: { mode: 'until_complete', max: 3 },
      }],
    });

    const homeRepoPath = await resolveHomeRepoPath({ projectPath: home, execFile });
    const runId = '0d9e4b1a-2222-4222-8222-222222222222';
    const names = planNames({ runId, workflowName: workflow.name, homeRepoPath });
    mkdirSync(path.dirname(names.worktreePath), { recursive: true });

    const agentSnap = (agent) => ({
      id: agent.id,
      name: agent.name,
      launchCommand: agent.launchCommand,
      resetCommand: agent.resetCommand,
    });

    runs.create({
      id: runId,
      requestId: 'live-complete-1',
      workflowId: workflow.id,
      project: 'codedeck',
      input: '',
      status: 'pending',
      stopReason: null,
      currentStepIndex: 0,
      error: null,
      definition: {
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowRevision: workflow.revision,
        steps: [
          {
            kind: 'setup',
            name: 'Setup',
            prompt: buildSetupPrompt(homeRepoPath, names.worktreePath),
            repeat: { mode: 'until_complete', max: 3 },
            agent: agentSnap(setupAgent),
          },
          {
            kind: 'node',
            name: 'Echo',
            prompt: 'finish now',
            repeat: { mode: 'until_complete', max: 3 },
            agent: agentSnap(nodeAgent),
          },
        ],
      },
      steps: [
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, detail: null, startedAt: null, finishedAt: null },
      ],
      homePath: homeRepoPath,
      worktreePath: names.worktreePath,
      worktreeBranch: names.branch,
      baseCommit: null,
      worktreeState: 'not_created',
      worktreeDetail: null,
      finishedAt: null,
    });

    const engine = createRunEngine({
      runStore: runs,
      createWorktree: async (run) => createWorktree({
        homePath: run.homePath,
        worktreePath: run.worktreePath,
        branch: run.worktreeBranch,
        projectPath: home,
        execFile,
      }),
      removeWorktree: async (run) => removeWorktree({
        homePath: run.homePath,
        worktreePath: run.worktreePath,
        execFile,
      }),
      listDirtyPaths: async ({ worktreePath }) => listDirtyPaths({ worktreePath, execFile }),
      startSession: async ({ cwd }) => {
        sessionSeq += 1;
        const sessionId = `codedeck-${sessionSeq}`;
        runtime.createDetachedSession({
          cwd,
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
          sessionId,
        });
        return sessionId;
      },
      attachBackground: (sessionId, { cwd } = {}) => attachBackgroundSession(
        sessionId, sessions, runtime, deletedSessionIds, { cwd },
      ),
      createWorkflow: ({ write, notify }) => createTerminalWorkflow({ write, notify }),
      // Live classifier needs a real agent CLI; stub readiness once the process is up.
      classifyReadiness: () => 'ready',
      readExecutionState: async () => ({
        executionReason: 'agent_prompt_idle',
        foregroundCommand: 'node',
        lines: ['› '],
        profile: { promptVisible: () => true },
        isAlive: true,
        entryExists: true,
      }),
      readinessPollMs: 50,
      launchEnterDelayMs: 50,
    });

    try {
      await engine.start(runId);
      const finished = await waitFor(() => {
        const run = runs.get(runId);
        return run.status === 'complete' || run.status === 'error' ? run : null;
      }, 60000, 'run complete or error');

      expect(finished.status).toBe('complete');
      expect(finished.definition.steps.map(s => s.kind)).toEqual(['setup', 'node']);
      expect(finished.steps.map(s => s.status)).toEqual(['complete', 'complete']);
      expect(finished.worktreeState).toBe('removed');
      expect(existsSync(finished.worktreePath)).toBe(false);
      expect(git(home, ['rev-parse', '--verify', names.branch])).toBeTruthy();

      const setupSession = finished.steps[0].sessionId;
      expect(setupSession).toMatch(/^codedeck-\d+$/);
      const cwd = execFileSync('tmux', ['display-message', '-p', '-t', `${setupSession}:0`, '#{pane_current_path}'], {
        encoding: 'utf8',
      }).trim();
      // Session cwd was the worktree while it existed; path may be gone after cleanup.
      expect(path.basename(path.resolve(cwd))).toBe(path.basename(finished.worktreePath));
    } finally {
      try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); } catch { /* ignore */ }
      if (previousTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmp;
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      try {
        execFileSync('git', ['-C', home, 'worktree', 'remove', '--force', names.worktreePath], { stdio: 'pipe' });
      } catch { /* cleanup */ }
      db.close();
    }
  }, 90000);
});

describe('pipeline run live gate', () => {
  it('documents skip when tmux or git is missing', () => {
    expect(typeof hasGit()).toBe('boolean');
    expect(typeof hasTmux()).toBe('boolean');
  });
});
