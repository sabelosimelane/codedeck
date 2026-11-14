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
import { createDecisionStore } from '../pipelines/decision-store.js';
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

function writeAskingAgent(dir) {
  // Asks two questions the way the loop instruction requires, then completes once it is answered.
  const script = path.join(dir, 'stub-agent-asking');
  writeFileSync(script, `#!/usr/bin/env node
let buf = '';
let id = null;
process.stdin.setEncoding('utf8');
process.stdout.write('>_ OpenAI Codex (stub)\\n› \\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  if (id === null) {
    const match = buf.match(/Iteration identifier: ([\\w-]+)/);
    if (!match) return;
    id = match[1];
    buf = '';
    setTimeout(() => {
      process.stdout.write([
        '',
        '• Phase 0 is complete.',
        '',
        '• [[CDW:' + id + ':QUESTIONS]]',
        '  1. Which schema should the migration target?',
        '     Recommended: the existing guardian schema.',
        '  2. May I delete the old index? Recommended: no.',
        '• [[CDW:' + id + ':NEEDS_INPUT]]',
        '',
      ].join('\\n'));
    }, 200);
    return;
  }
  if (!/Use the existing schema\\./.test(buf)) return;
  buf = '';
  setTimeout(() => {
    process.stdout.write('\\nstub agent was answered\\n[[CDW:' + id + ':COMPLETE]]\\n');
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
      agentsDecide: false,
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
        agentsDecide: false,
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
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
      ],
      homePath: homeRepoPath,
      worktreePath: names.worktreePath,
      worktreeBranch: names.branch,
      baseCommit: null,
      worktreeState: 'not_created',
      worktreeDetail: null,
      inputRequest: null,
      finishedAt: null,
    });

    const engine = createRunEngine({
      runStore: runs,
      decisionStore: createDecisionStore(db),
      readScreen: async () => [],
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
        profile: { promptVisible: () => true, skillPrefix: '/' },
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

describeLive('pipeline run live — an agent that needs input', () => {
  it('reads the questions off the real terminal screen, types the answer in and completes', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-ask-'));
    temps.push(base);
    const tmuxDir = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-tmux-'));
    temps.push(tmuxDir);
    const home = path.join(base, 'codedeck');
    initRepo(home);
    const askingStub = writeAskingAgent(base);

    const previousTmp = process.env.TMUX_TMPDIR;
    const previousTmux = process.env.TMUX;
    process.env.TMUX_TMPDIR = tmuxDir;
    delete process.env.TMUX;

    const db = new Database(':memory:');
    const runs = createRunStore(db);
    const sessions = new Map();
    const deletedSessionIds = new Set();
    const runtime = createTerminalRuntime('tmux');
    const runId = '0d9e4b1a-3333-4333-8333-333333333333';
    const workflowId = '0d9e4b1a-4444-4444-8444-444444444444';
    const homeRepoPath = await resolveHomeRepoPath({ projectPath: home, execFile });

    // The run uses the home checkout as an existing worktree, so nothing is created or removed.
    runs.create({
      id: runId,
      requestId: 'live-ask-1',
      workflowId,
      project: 'codedeck',
      input: '',
      status: 'pending',
      stopReason: null,
      currentStepIndex: 0,
      error: null,
      definition: {
        workflowId,
        workflowName: 'Ask',
        workflowRevision: 1,
        agentsDecide: false,
        steps: [{
          kind: 'node',
          name: 'Develop',
          prompt: 'migrate the schema',
          repeat: { mode: 'once' },
          agent: { id: '0d9e4b1a-5555-4555-8555-555555555555', name: 'asking-stub', launchCommand: askingStub, resetCommand: '/clear' },
        }],
      },
      steps: [
        { status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null },
      ],
      homePath: homeRepoPath,
      worktreePath: homeRepoPath,
      worktreeBranch: git(home, ['rev-parse', '--abbrev-ref', 'HEAD']),
      baseCommit: git(home, ['rev-parse', 'HEAD']),
      worktreeState: 'external',
      worktreeDetail: null,
      inputRequest: null,
      finishedAt: null,
    });

    // The same capture the live backend uses for readScreen (server/index.js).
    const readScreen = async (sessionId) => {
      const snapshot = runtime.captureSessionSnapshot(sessionId, 400);
      if (snapshot.historyGuaranteed !== true) throw new Error('screen capture failed');
      return snapshot.data.replace(/\r/g, '').split('\n');
    };

    const engine = createRunEngine({
      runStore: runs,
      decisionStore: createDecisionStore(db),
      readScreen,
      createWorktree: async () => { throw new Error('an existing worktree is never created'); },
      removeWorktree: async () => { throw new Error('an existing worktree is never removed'); },
      listDirtyPaths: async ({ worktreePath }) => listDirtyPaths({ worktreePath, execFile }),
      startSession: async ({ cwd }) => {
        runtime.createDetachedSession({ cwd, cols: INITIAL_COLS, rows: INITIAL_ROWS, sessionId: 'codedeck-1' });
        return 'codedeck-1';
      },
      attachBackground: (sessionId, { cwd } = {}) => attachBackgroundSession(
        sessionId, sessions, runtime, deletedSessionIds, { cwd },
      ),
      createWorkflow: ({ write, notify }) => createTerminalWorkflow({ write, notify }),
      classifyReadiness: () => 'ready',
      readExecutionState: async () => ({
        executionReason: 'agent_prompt_idle',
        foregroundCommand: 'node',
        lines: ['› '],
        profile: { promptVisible: () => true, skillPrefix: '/' },
        isAlive: true,
        entryExists: true,
      }),
      readinessPollMs: 50,
      launchEnterDelayMs: 50,
    });

    try {
      const done = engine.start(runId);
      const waiting = await waitFor(() => {
        const run = runs.get(runId);
        return run.status === 'needs_input' || run.status === 'error' ? run : null;
      }, 30000, 'run needs input or error');

      expect(waiting.status).toBe('needs_input');
      expect(waiting.inputRequest).toEqual({
        questions: [
          '1. Which schema should the migration target?',
          'Recommended: the existing guardian schema.',
          '2. May I delete the old index? Recommended: no.',
        ].join('\n'),
        truncated: false,
      });

      const answered = await engine.answer(runId, 'Use the existing schema.');
      expect(answered.inputRequest).toBeNull();
      expect(['running', 'complete']).toContain(answered.status);

      await done;
      const finished = runs.get(runId);
      expect(finished).toMatchObject({ status: 'complete', inputRequest: null, worktreeState: 'released' });
      // The agent received the answer through its terminal.
      expect((await readScreen('codedeck-1')).join('\n')).toContain('stub agent was answered');
    } finally {
      try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); } catch { /* ignore */ }
      if (previousTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmp;
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      db.close();
    }
  }, 90000);
});

/**
 * A stub agent for a loop. It answers the reset command, and for each prompt it either
 * reports work left (`continue`), or — `ask-then-complete` — lists a question in the first
 * round, reports work left once it is told to proceed, and reports COMPLETE in the next round.
 */
function writeLoopAgent(dir, mode) {
  const script = path.join(dir, `stub-agent-loop-${mode}`);
  writeFileSync(script, `#!/usr/bin/env node
const mode = ${JSON.stringify(mode)};
let buf = '';
let prompts = 0;
let waitingOn = null;
process.stdin.setEncoding('utf8');
// Like a real agent CLI, read the terminal raw and draw what arrives: the terminal's own
// line mode cuts a line at 1024 characters, and a prompt is one longer line.
process.stdin.setRawMode(true);
process.stdout.write('>_ OpenAI Codex (stub)\\n› \\n');
const say = text => setTimeout(() => process.stdout.write(text), 200);
process.stdin.on('data', chunk => {
  process.stdout.write(chunk.replace(/\\x1b\\[20[01]~/g, '').replace(/\\r\\n|\\r|\\n/g, '\\r\\n'));
  buf += chunk;
  if (waitingOn !== null) {
    if (!/Proceed with your recommendations\\./.test(buf)) return;
    const id = waitingOn;
    waitingOn = null;
    buf = '';
    say('\\naccepted recommendations\\n[[CDW:' + id + ':CONTINUE]]\\n');
    return;
  }
  if (/\\/clear/.test(buf)) {
    buf = '';
    say('\\ncontext cleared\\n› \\n');
    return;
  }
  const match = buf.match(/Iteration identifier: ([\\w-]+)\\n/);
  if (!match) return;
  const id = match[1];
  buf = '';
  prompts += 1;
  if (mode === 'continue') {
    say('\\ndeveloped round ' + prompts + '\\n[[CDW:' + id + ':CONTINUE]]\\n');
  } else if (prompts === 1) {
    waitingOn = id;
    say([
      '',
      '• [[CDW:' + id + ':QUESTIONS]]',
      '  1. Should the slow suite run too? Recommended: yes.',
      '• [[CDW:' + id + ':NEEDS_INPUT]]',
      '',
    ].join('\\n'));
  } else {
    say('\\ntested round ' + prompts + '\\n[[CDW:' + id + ':COMPLETE]]\\n');
  }
});
`);
  chmodSync(script, 0o755);
  return script;
}

describeLive('pipeline run live — a loop of steps whose agents decide', () => {
  it('runs Develop and Test twice in their own two terminals and answers the question itself', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-loop-'));
    temps.push(base);
    const tmuxDir = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-tmux-'));
    temps.push(tmuxDir);
    const home = path.join(base, 'codedeck');
    initRepo(home);
    const developStub = writeLoopAgent(base, 'continue');
    const testStub = writeLoopAgent(base, 'ask-then-complete');

    const previousTmp = process.env.TMUX_TMPDIR;
    const previousTmux = process.env.TMUX;
    process.env.TMUX_TMPDIR = tmuxDir;
    delete process.env.TMUX;

    const db = new Database(':memory:');
    const runs = createRunStore(db);
    const decisions = createDecisionStore(db);
    const sessions = new Map();
    const deletedSessionIds = new Set();
    const runtime = createTerminalRuntime('tmux');
    const runId = '0d9e4b1a-6666-4666-8666-666666666666';
    const workflowId = '0d9e4b1a-7777-4777-8777-777777777777';
    const homeRepoPath = await resolveHomeRepoPath({ projectPath: home, execFile });
    const stubAgent = (id, name, launchCommand) => ({ id, name, launchCommand, resetCommand: '/clear' });
    const pending = () => ({ status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null });

    runs.create({
      id: runId,
      requestId: 'live-loop-1',
      workflowId,
      project: 'codedeck',
      input: '',
      status: 'pending',
      stopReason: null,
      currentStepIndex: 0,
      error: null,
      definition: {
        workflowId,
        workflowName: 'Loop',
        workflowRevision: 1,
        agentsDecide: true,
        steps: [
          { kind: 'node', name: 'Develop', prompt: 'build the next phase', repeat: { mode: 'once' }, agent: stubAgent('0d9e4b1a-8888-4888-8888-888888888888', 'develop-stub', developStub) },
          { kind: 'node', name: 'Test', prompt: 'test the phase', repeat: { mode: 'loop_back', toStepIndex: 0, max: 3 }, agent: stubAgent('0d9e4b1a-9999-4999-8999-999999999999', 'test-stub', testStub) },
        ],
      },
      steps: [pending(), pending()],
      homePath: homeRepoPath,
      worktreePath: homeRepoPath,
      worktreeBranch: git(home, ['rev-parse', '--abbrev-ref', 'HEAD']),
      baseCommit: git(home, ['rev-parse', 'HEAD']),
      worktreeState: 'external',
      worktreeDetail: null,
      inputRequest: null,
      finishedAt: null,
    });

    const readScreen = async (sessionId) => {
      const snapshot = runtime.captureSessionSnapshot(sessionId, 400);
      if (snapshot.historyGuaranteed !== true) throw new Error('screen capture failed');
      return snapshot.data.replace(/\r/g, '').split('\n');
    };
    let sessionSeq = 0;

    const engine = createRunEngine({
      runStore: runs,
      decisionStore: decisions,
      readScreen,
      createWorktree: async () => { throw new Error('an existing worktree is never created'); },
      removeWorktree: async () => { throw new Error('an existing worktree is never removed'); },
      listDirtyPaths: async ({ worktreePath }) => listDirtyPaths({ worktreePath, execFile }),
      startSession: async ({ cwd }) => {
        sessionSeq += 1;
        const sessionId = `codedeck-${sessionSeq}`;
        runtime.createDetachedSession({ cwd, cols: INITIAL_COLS, rows: INITIAL_ROWS, sessionId });
        return sessionId;
      },
      attachBackground: (sessionId, { cwd } = {}) => attachBackgroundSession(
        sessionId, sessions, runtime, deletedSessionIds, { cwd },
      ),
      createWorkflow: ({ write, notify }) => createTerminalWorkflow({ write, notify }),
      classifyReadiness: () => 'ready',
      readExecutionState: async () => ({
        executionReason: 'agent_prompt_idle',
        foregroundCommand: 'node',
        lines: ['› '],
        profile: { promptVisible: () => true, skillPrefix: '/' },
        isAlive: true,
        entryExists: true,
      }),
      readinessPollMs: 50,
      launchEnterDelayMs: 50,
    });

    try {
      const done = engine.start(runId);
      const settled = () => {
        const run = runs.get(runId);
        return ['complete', 'error', 'needs_input', 'limit_paused', 'stopped'].includes(run.status) ? run : null;
      };
      try {
        await waitFor(settled, 60000, 'the looping run to settle');
      } catch (err) {
        // Say where the run stood and what each terminal showed; a bare timeout explains nothing.
        const run = runs.get(runId);
        const screens = await Promise.all(run.steps.filter(s => s.sessionId).map(async s => `--- ${s.sessionId} ---\n${(await readScreen(s.sessionId)).join('\n')}`));
        throw new Error(`${err.message}: status=${run.status} step=${run.currentStepIndex} steps=${JSON.stringify(run.steps.map(s => [s.status, s.iteration, s.roundsCompleted]))}\n${screens.join('\n')}`);
      }
      const finished = runs.get(runId);
      if (finished.status === 'complete') await done;

      expect(finished.error).toBeNull();
      expect(finished.status).toBe('complete');
      expect(finished.steps.map(s => s.status)).toEqual(['complete', 'complete']);
      expect(finished.steps[1].roundsCompleted).toBe(1);
      // Two rounds, two terminals: each step went back to its own.
      expect(sessionSeq).toBe(2);
      expect(finished.steps.map(s => s.sessionId)).toEqual(['codedeck-1', 'codedeck-2']);

      const developScreen = (await readScreen('codedeck-1')).join('\n');
      expect(developScreen).toContain('developed round 1');
      expect(developScreen).toContain('context cleared');
      expect(developScreen).toContain('developed round 2');
      const testScreen = (await readScreen('codedeck-2')).join('\n');
      expect(testScreen).toContain('accepted recommendations');
      expect(testScreen).toContain('context cleared');
      expect(testScreen).toContain('tested round 2');
      // The step that closes the loop was told what the loop is; both were told to decide.
      expect(testScreen.replace(/\s+/g, ' ')).toContain('This step closes a loop');
      expect(developScreen.replace(/\s+/g, ' ')).toContain('The owner is not available during this run.');

      expect(decisions.list(runId, { offset: 0, limit: 10, direction: 'asc' })).toEqual([expect.objectContaining({
        stepIndex: 1,
        stepName: 'Test',
        pass: 1,
        questions: '1. Should the slow suite run too? Recommended: yes.',
        truncated: false,
        answer: 'Proceed with your recommendations.',
      })]);
    } finally {
      // A run that never settled is still being driven; end it before its database closes.
      if (runs.get(runId).status === 'running') await engine.stop(runId);
      try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); } catch { /* ignore */ }
      if (previousTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmp;
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      db.close();
    }
  }, 120000);
});

describe('pipeline run live gate', () => {
  it('documents skip when tmux or git is missing', () => {
    expect(typeof hasGit()).toBe('boolean');
    expect(typeof hasTmux()).toBe('boolean');
  });
});
