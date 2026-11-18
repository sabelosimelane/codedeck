/**
 * Live Phase 3 multi-step run: real git worktree + real tmux + real loop engine.
 * Readiness is faked (agent screen classifier needs a real CLI); the stub agent
 * reads the pasted workflow prompt and prints COMPLETE (or CONTINUE then COMPLETE).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createAgentStore } from '../pipelines/agent-store.js';
import { createWorkflowStore } from '../pipelines/workflow-store.js';
import { createSettingsStore } from '../pipelines/settings-store.js';
import { createRunStore } from '../pipelines/run-store.js';
import { createRunEngine } from '../pipelines/run-engine.js';
import { createRunProgressReader, readRunProgress, parsePhaseProgress } from '../pipelines/run-progress.js';
import { createDecisionStore } from '../pipelines/decision-store.js';
import { createAnswerStore } from '../pipelines/answer-store.js';
import { createNoteStore } from '../pipelines/note-store.js';
import { createReviewStore } from '../pipelines/review-store.js';
import {
  create as createWorktree,
  remove as removeWorktree,
  listDirtyPaths,
  planNames,
  resolveHomeRepoPath,
  buildSetupPrompt,
} from '../pipelines/run-worktree.js';
import { createTerminalRuntime } from '../terminal-runtime.js';
import { attachBackgroundSession, backgroundSessionAvailable } from '../ws-handler.js';
import { createTerminalWorkflow } from '../terminal-workflow.js';
import { INITIAL_COLS, INITIAL_ROWS } from '../mobile-session-start.js';
import { classify as classifyAgentReadiness } from '../pipelines/agent-readiness.js';
import { findAgentProfile } from '../agent-profiles/index.js';

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

function writeStubAgent(dir, { continueFirst = false, writeNote = false } = {}) {
  // Reads PTY input; emits CONTINUE once (optional) then COMPLETE for each iteration id.
  const script = path.join(dir, continueFirst ? 'stub-agent-repeat' : 'stub-agent');
  writeFileSync(script, `#!/usr/bin/env node
let buf = '';
let armed = true;
let emitted = 0;
const continueFirst = ${continueFirst ? 'true' : 'false'};
const writeNote = ${writeNote ? 'true' : 'false'};
process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdout.write('>_ OpenAI Codex (stub)\\n› \\n');
process.stdin.on('data', chunk => {
  if (chunk.includes('/clear')) { buf = ''; armed = true; return; }
  if (!armed) return;
  buf += chunk;
  const match = buf.match(/Iteration identifier: ([\\w-]+)/);
  if (!match) return;
  const id = match[1];
  armed = false;
  emitted += 1;
  const pass = emitted;
  if (writeNote) {
    const note = buf.match(/write your note to (\\.codedeck\\/runs\\/[0-9a-f]{8}\\/[^\\s]+\\.md)/);
    if (!note) throw new Error('run note path absent from terminal guidance');
    require('node:fs').writeFileSync(note[1], '# Pass ' + pass + '\\nWork completed');
  }
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

function writeAskingAgent(dir, { alternate = false, agentsDecide = false } = {}) {
  // Asks two questions the way the loop instruction requires, then completes once it is answered.
  const script = path.join(dir, 'stub-agent-asking');
  writeFileSync(script, `#!/usr/bin/env node
let buf = '';
let id = null;
process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdout.write('${alternate ? '\\x1b[?1049h' : ''}>_ OpenAI Codex (stub)\\n› \\n');
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
  if (!/${agentsDecide ? 'Proceed with your recommendations\\.' : 'Use the existing schema\\.'}/.test(buf)) return;
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
    const repeatStub = writeStubAgent(base, { continueFirst: true, writeNote: true });

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
    const muting = [];

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

    const notes = createNoteStore(db);
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
        progressFile: null,
        notesDir: `.codedeck/runs/${runId.slice(0, 8)}`,
        steps: [
          {
            kind: 'setup', role: '', askOwner: false, readOnly: false, approval: false,
            name: 'Setup',
            prompt: buildSetupPrompt(homeRepoPath, names.worktreePath),
            repeat: { mode: 'until_complete', max: 3 },
            agent: agentSnap(setupAgent),
          },
          {
            kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
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
      taskId: null,
      finishedAt: null,
    });

    const engine = createRunEngine({
      runStore: runs,
      setTerminalMuted: (sessionId, muted) => {
        const state = runs.get(runId);
        muting.push({ sessionId, muted, status: state.status, step: state.currentStepIndex, worktreeState: state.worktreeState });
        return true;
      },
      readProgressCount: async () => null,
      decisionStore: createDecisionStore(db), answerStore: createAnswerStore(db),
      noteStore: notes,
      reviewStore: createReviewStore(db),
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
      terminalAvailable: (sessionId) => backgroundSessionAvailable(sessionId, sessions, runtime, deletedSessionIds),
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
      expect(muting).toContainEqual(expect.objectContaining({ sessionId: 'codedeck-1', muted: false, status: 'running', step: 0 }));
      expect(muting).toContainEqual(expect.objectContaining({ sessionId: 'codedeck-1', muted: true, status: 'running', step: 1 }));
      expect(muting).toContainEqual(expect.objectContaining({ sessionId: 'codedeck-2', muted: false, status: 'running', step: 1 }));
      expect(muting).toContainEqual(expect.objectContaining({ sessionId: 'codedeck-1', muted: true, status: 'complete', worktreeState: 'present' }));
      expect(muting).toContainEqual(expect.objectContaining({ sessionId: 'codedeck-2', muted: true, status: 'complete', worktreeState: 'present' }));
      expect(finished.definition.steps.map(s => s.kind)).toEqual(['setup', 'node']);
      expect(finished.steps.map(s => s.status)).toEqual(['complete', 'complete']);
      expect(notes.list(runId, { offset: 0, limit: 10, direction: 'asc' }).map(note => [note.status, note.summary])).toEqual([['written', 'Pass 1'], ['written', 'Pass 2']]);
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

describeLive('pipeline run live notes', () => {
  it('pauses after Analyse, sends it back with feedback, then approves and runs Develop', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-notes-'));
    temps.push(base);
    const tmuxDir = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-tmux-'));
    temps.push(tmuxDir);
    const home = path.join(base, 'codedeck');
    initRepo(home);
    const second = path.join(base, 'second');
    mkdirSync(second);
    const commands = [writeStubAgent(base, { writeNote: true }), writeStubAgent(second, { writeNote: true })];
    const previousTmp = process.env.TMUX_TMPDIR;
    const previousTmux = process.env.TMUX;
    process.env.TMUX_TMPDIR = tmuxDir;
    delete process.env.TMUX;
    const db = new Database(':memory:');
    const runs = createRunStore(db);
    const notes = createNoteStore(db);
    const runtime = createTerminalRuntime('tmux');
    const sessions = new Map();
    const deletedSessionIds = new Set();
    const prompts = new Map();
    const runId = '0d9e4b1a-5555-4555-8555-555555555555';
    const workflowId = '0d9e4b1a-6666-4666-8666-666666666666';
    const notesDir = `.codedeck/runs/${runId.slice(0, 8)}`;
    const steps = ['Analyse', 'Develop'].map((name, index) => ({
      kind: 'node', role: '', askOwner: false, readOnly: index === 0, approval: index === 0, name, prompt: `do ${name}`, repeat: { mode: 'once' },
      agent: { id: `0d9e4b1a-7777-4777-8777-77777777777${index}`, name: `stub-${index}`, launchCommand: commands[index], resetCommand: '/clear' },
    }));
    runs.create({
      id: runId, requestId: 'live-notes-1', workflowId, project: 'codedeck', input: '',
      status: 'pending', stopReason: null, currentStepIndex: 0, error: null,
      definition: { workflowId, workflowName: 'Live notes', workflowRevision: 1, agentsDecide: false, progressFile: null, notesDir, steps },
      steps: steps.map(() => ({ status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null })),
      homePath: home, worktreePath: home, worktreeBranch: 'master', baseCommit: git(home, ['rev-parse', 'HEAD']),
      worktreeState: 'external', worktreeDetail: null, inputRequest: null, taskId: null, finishedAt: null,
    });
    let sessionSeq = 0;
    const engine = createRunEngine({
      runStore: runs,
      setTerminalMuted: () => true,
      readProgressCount: async () => null, decisionStore: createDecisionStore(db), answerStore: createAnswerStore(db), noteStore: notes, reviewStore: createReviewStore(db),
      createWorktree: async () => { throw new Error('existing worktree must be reused'); },
      startSession: async ({ cwd }) => {
        const sessionId = `codedeck-${++sessionSeq}`;
        runtime.createDetachedSession({ cwd, cols: INITIAL_COLS, rows: INITIAL_ROWS, sessionId });
        return sessionId;
      },
      attachBackground: (sessionId, options) => {
        const attachment = attachBackgroundSession(sessionId, sessions, runtime, deletedSessionIds, options);
        const write = attachment.entry.pty.write.bind(attachment.entry.pty);
        prompts.set(sessionId, []);
        attachment.entry.pty.write = data => { prompts.get(sessionId).push(String(data)); return write(data); };
        return attachment;
      },
      terminalAvailable: sessionId => backgroundSessionAvailable(sessionId, sessions, runtime, deletedSessionIds),
      createWorkflow: ({ write, notify }) => createTerminalWorkflow({ write, notify }),
      classifyReadiness: () => 'ready',
      readExecutionState: async () => ({ executionReason: 'agent_prompt_idle', foregroundCommand: 'node', lines: ['› '], profile: { promptVisible: () => true, skillPrefix: '/' }, isAlive: true, entryExists: true }),
      readScreen: async () => [],
      readinessPollMs: 50, launchEnterDelayMs: 50,
    });
    try {
      await engine.start(runId);
      const firstGate = await waitFor(() => runs.get(runId).status === 'awaiting_approval' && runs.get(runId), 60000, 'Analyse approval');
      expect(firstGate.currentStepIndex).toBe(0);
      expect(notes.list(runId, { offset: 0, limit: 10, direction: 'asc' })).toMatchObject([{ status: 'written', summary: 'Pass 1' }]);
      await engine.sendBack(runId, 'Include the comparison evidence');
      await waitFor(() => runs.get(runId).status === 'awaiting_approval' && runs.get(runId).steps[0].attempt === 2, 60000, 'Analyse sent back');
      const feedback = readFileSync(path.join(home, notesDir, '00-analyse.feedback.md'), 'utf8');
      expect(feedback).toContain('Include the comparison evidence');
      expect(prompts.get('codedeck-1').join('')).toContain('00-analyse.feedback.md');
      await engine.approve(runId);
      const finished = await waitFor(() => ['complete', 'error'].includes(runs.get(runId).status) && runs.get(runId), 60000, 'notes run complete');
      expect(finished.status).toBe('complete');
      const readme = readFileSync(path.join(home, notesDir, 'README.md'), 'utf8');
      expect(readme).toContain(`${notesDir}/00-analyse.md`);
      expect(readme).toContain(`${notesDir}/01-develop.md`);
      expect(notes.list(runId, { offset: 0, limit: 10, direction: 'asc' }).map(row => [row.status, row.summary])).toEqual([['written', 'Pass 1'], ['written', 'Pass 2'], ['written', 'Pass 1']]);
      expect(prompts.size).toBe(2);
      for (const [index, typed] of [...prompts.values()].entries()) {
        expect(typed.join('')).toContain(`${notesDir}/README.md`);
        expect(typed.join('')).toContain(`${notesDir}/${index === 0 ? '00-analyse.md' : '01-develop.md'}`);
      }
      expect(git(home, ['status', '--porcelain'])).toBe('');
    } finally {
      try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); } catch { /* ignore */ }
      if (previousTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmp;
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      db.close();
    }
  }, 90000);
});

describeLive('pipeline run live — an agent that needs input', () => {
  it.each([
    ['primary screen', false, false],
    ['alternate screen', true, false],
    ['alternate screen with agents decide', true, true],
  ])('reads questions from the %s and handles the answer', async (_case, alternate, agentsDecide) => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-ask-'));
    temps.push(base);
    const tmuxDir = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-tmux-'));
    temps.push(tmuxDir);
    const home = path.join(base, 'codedeck');
    initRepo(home);
    const askingStub = writeAskingAgent(base, { alternate, agentsDecide });

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
        agentsDecide,
        progressFile: null,
        notesDir: null,
        steps: [{
          kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
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
      taskId: null,
      finishedAt: null,
    });

    // The same capture the live backend uses for readScreen (server/index.js).
    const readScreen = async (sessionId) => {
      const snapshot = runtime.captureAgentScreen(sessionId, 400);
      if (snapshot.historyGuaranteed !== true) throw new Error('screen capture failed');
      return snapshot.data.replace(/\r/g, '').split('\n');
    };

    const engine = createRunEngine({
      runStore: runs,
      setTerminalMuted: () => true,
      readProgressCount: async () => null,
      decisionStore: createDecisionStore(db), answerStore: createAnswerStore(db),
      noteStore: createNoteStore(db),
      reviewStore: createReviewStore(db),
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
      terminalAvailable: (sessionId) => backgroundSessionAvailable(sessionId, sessions, runtime, deletedSessionIds),
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
        return ['needs_input', 'error', 'complete'].includes(run.status) ? run : null;
      }, 30000, 'run needs input or error');
      const expectedQuestions = [
        '1. Which schema should the migration target?',
        'Recommended: the existing guardian schema.',
        '2. May I delete the old index? Recommended: no.',
      ].join('\n');
      if (agentsDecide) {
        expect(waiting.status).toBe('complete');
        const decisions = createDecisionStore(db).list(runId, { offset: 0, limit: 10, direction: 'asc' });
        expect(decisions).toEqual([expect.objectContaining({ questions: expectedQuestions, answer: 'Proceed with your recommendations.' })]);
      } else {
        expect(waiting.status).toBe('needs_input');
        expect(waiting.inputRequest).toEqual({ questions: expectedQuestions, truncated: false });
        const answered = await engine.answer(runId, 'Use the existing schema.');
        expect(answered.inputRequest).toBeNull();
        expect(['running', 'complete']).toContain(answered.status);
      }

      await done;
      const finished = runs.get(runId);
      expect(finished).toMatchObject({ status: 'complete', inputRequest: null, worktreeState: 'external' });
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
let dialogFor = null;
let dialogShown = false;
process.stdin.setEncoding('utf8');
// Like a real agent CLI, read the terminal raw and draw what arrives: the terminal's own
// line mode cuts a line at 1024 characters, and a prompt is one longer line.
process.stdin.setRawMode(true);
process.stdout.write('>_ OpenAI Codex (stub)\\n› \\n');
const say = text => setTimeout(() => process.stdout.write(text), 200);
process.stdin.on('data', chunk => {
  process.stdout.write(chunk.replace(/\\x1b\\[20[01]~/g, '').replace(/\\r\\n|\\r|\\n/g, '\\r\\n'));
  buf += chunk;
  if (dialogFor !== null) {
    // Like a real CLI dialog: nothing happens until it is on screen and Enter is pressed.
    if (!dialogShown || !/\\r/.test(chunk)) return;
    const id = dialogFor;
    dialogFor = null;
    buf = '';
    process.stdout.write('\\x1b[2J\\x1b[H');
    say('dialog answered\\n[[CDW:' + id + ':CONTINUE]]\\n');
    return;
  }
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
  if (mode === 'dialog') {
    // Shown after the prompt was submitted, the way Codex shows "Hooks need review".
    dialogFor = id;
    setTimeout(() => {
      dialogShown = true;
      process.stdout.write('\\n  Hooks need review\\n› 1. Review hooks\\n  2. Trust all and continue\\n  enter confirm · esc skip\\n');
    }, 600);
  } else if (mode === 'silent-first') {
    // Ends its first turn without a signal, the way a CLI does on an API error.
    if (prompts === 1) say('\\nAPI Error: the request was refused\\n› \\n');
    else say('\\nresumed pass ' + prompts + '\\n[[CDW:' + id + ':COMPLETE]]\\n');
  } else if (mode === 'continue') {
    say('\\ndeveloped round ' + prompts + '\\n[[CDW:' + id + ':CONTINUE]]\\n');
  } else if (mode === 'tick') {
    require('node:fs').writeFileSync('todo.md', '## Phase 1\\n' + Array.from({ length: 4 }, (_, i) => '- [' + (i < prompts ? 'x' : ' ') + '] task ' + i).join('\\n'));
    say('\\ntested round ' + prompts + '\\n[[CDW:' + id + ':' + (prompts < 3 ? 'CONTINUE' : 'COMPLETE') + ']]\\n');
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
  it.each([
    ['asks and completes', 'ask-then-complete', null],
    ['stops after two unchanged rounds', 'continue', 'no_progress'],
    ['keeps going while tasks are ticked', 'tick', 'tick'],
  ])('%s', async (_name, testMode, progressMode) => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-loop-'));
    temps.push(base);
    const tmuxDir = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-tmux-'));
    temps.push(tmuxDir);
    const home = path.join(base, 'codedeck');
    initRepo(home);
    const developStub = writeLoopAgent(base, 'continue');
    const testStub = writeLoopAgent(base, testMode);
    if (progressMode !== null) writeFileSync(path.join(home, 'todo.md'), '## Phase 1\n- [ ] task 0\n- [ ] task 1\n- [ ] task 2\n- [ ] task 3');

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
        progressFile: progressMode === null ? null : 'todo.md',
        notesDir: null,
        steps: [
          { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Develop', prompt: 'build the next phase', repeat: { mode: 'once' }, agent: stubAgent('0d9e4b1a-8888-4888-8888-888888888888', 'develop-stub', developStub) },
          { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Test', prompt: 'test the phase', repeat: { mode: 'loop_back', toStepIndex: 0, max: 5 }, agent: stubAgent('0d9e4b1a-9999-4999-8999-999999999999', 'test-stub', testStub) },
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
      taskId: null,
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
      setTerminalMuted: () => true,
      readProgressCount: async run => {
        const progress = await readRunProgress({ run, workflowProgressFile: null, progressReader: createRunProgressReader() });
        return progress?.phaseCount > 0 ? { tasksDone: progress.tasksDone, tasksTotal: progress.tasksTotal } : null;
      },
      decisionStore: decisions, answerStore: createAnswerStore(db),
      noteStore: createNoteStore(db),
      reviewStore: createReviewStore(db),
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
      terminalAvailable: (sessionId) => backgroundSessionAvailable(sessionId, sessions, runtime, deletedSessionIds),
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
      if (['complete', 'stopped'].includes(finished.status)) await done;

      if (progressMode === 'no_progress') {
        expect(finished).toMatchObject({ status: 'stopped', stopReason: 'no_progress', currentStepIndex: 0 });
        expect(finished.steps[1].roundsCompleted).toBe(3);
        expect(finished.steps[0].status).toBe('stopped');
        expect(sessionSeq).toBe(2);
        return;
      }
      if (progressMode === 'tick') {
        expect(finished.status).toBe('complete');
        expect(finished.steps[1].roundsCompleted).toBe(2);
        expect(parsePhaseProgress(readFileSync(path.join(home, 'todo.md'), 'utf8')).tasksDone).toBe(3);
        return;
      }

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
      // Join tmux soft wraps before checking guidance that can span rows.
      const developGuidance = execFileSync('tmux', ['capture-pane', '-p', '-J', '-S', '-400', '-t', 'codedeck-1'], {
        encoding: 'utf8',
      });
      expect(developGuidance).toContain('The owner is not available during this run.');

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

describeLive('pipeline run live — a dialog shown after the prompt was sent', () => {
  it('pauses the run until the dialog is answered in the terminal, also when agents decide', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-dialog-'));
    temps.push(base);
    const tmuxDir = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-tmux-'));
    temps.push(tmuxDir);
    const home = path.join(base, 'codedeck');
    initRepo(home);
    const stub = writeLoopAgent(base, 'dialog');

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
    const runId = '0d9e4b1a-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const workflowId = '0d9e4b1a-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const homeRepoPath = await resolveHomeRepoPath({ projectPath: home, execFile });

    runs.create({
      id: runId,
      requestId: 'live-dialog-1',
      workflowId,
      project: 'codedeck',
      input: '',
      status: 'pending',
      stopReason: null,
      currentStepIndex: 0,
      error: null,
      definition: {
        workflowId,
        workflowName: 'Dialog',
        workflowRevision: 1,
        agentsDecide: true,
        progressFile: null,
        notesDir: null,
        steps: [
          { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Develop', prompt: 'build the next phase', repeat: { mode: 'once' }, agent: { id: '0d9e4b1a-cccc-4ccc-8ccc-cccccccccccc', name: 'dialog-stub', launchCommand: stub, resetCommand: '/clear' } },
        ],
      },
      steps: [{ status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null }],
      homePath: homeRepoPath,
      worktreePath: homeRepoPath,
      worktreeBranch: git(home, ['rev-parse', '--abbrev-ref', 'HEAD']),
      baseCommit: git(home, ['rev-parse', 'HEAD']),
      worktreeState: 'external',
      worktreeDetail: null,
      inputRequest: null,
      taskId: null,
      finishedAt: null,
    });

    const readScreen = async (sessionId) => {
      const snapshot = runtime.captureSessionSnapshot(sessionId, 400);
      if (snapshot.historyGuaranteed !== true) throw new Error('screen capture failed');
      return snapshot.data.replace(/\r/g, '').split('\n');
    };
    // What the terminal really shows, read and classified the way the server does it.
    const readExecutionState = async (sessionId) => {
      let snapshotText;
      const execution = await runtime.getSessionExecutionStateAsync(sessionId, { onSnapshot: (text) => { snapshotText = text; } });
      const lines = typeof snapshotText === 'string' ? snapshotText.replace(/\r/g, '').split('\n') : [];
      return {
        executionReason: execution.executionReason,
        foregroundCommand: execution.foregroundCommand,
        lines,
        profile: findAgentProfile({ foregroundCommand: execution.foregroundCommand, lines }),
        isAlive: true,
        entryExists: true,
      };
    };

    const engine = createRunEngine({
      runStore: runs,
      setTerminalMuted: () => true,
      readProgressCount: async () => null,
      decisionStore: decisions, answerStore: createAnswerStore(db),
      noteStore: createNoteStore(db),
      reviewStore: createReviewStore(db),
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
      terminalAvailable: (sessionId) => backgroundSessionAvailable(sessionId, sessions, runtime, deletedSessionIds),
      createWorkflow: ({ write, notify }) => createTerminalWorkflow({ write, notify }),
      classifyReadiness: classifyAgentReadiness,
      readExecutionState,
      readinessPollMs: 50,
      launchEnterDelayMs: 50,
      dialogPollMs: 200,
    });

    const describeRun = async () => {
      const run = runs.get(runId);
      const screen = run.steps[0].sessionId ? (await readScreen(run.steps[0].sessionId)).join('\n') : '(no terminal)';
      return `status=${run.status} error=${run.error} step=${JSON.stringify([run.steps[0].status, run.steps[0].iteration])}\n${screen}`;
    };

    try {
      const done = engine.start(runId);
      try {
        await waitFor(() => ['needs_input', 'error', 'complete'].includes(runs.get(runId).status), 30000, 'the run to pause for the dialog');
      } catch (err) {
        throw new Error(`${err.message}: ${await describeRun()}`);
      }
      const paused = runs.get(runId);
      expect(paused.error).toBeNull();
      expect(paused.status).toBe('needs_input');
      // The prompt had been sent, and the agent signalled nothing: there is no request to answer.
      expect(paused.steps[0].iteration).toBe(1);
      expect(paused.inputRequest).toBeNull();
      expect((await readScreen('codedeck-1')).join('\n')).toContain('Hooks need review');

      // Agents decide what they ask, never a dialog of their CLI: it is still on screen later.
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(runs.get(runId).status).toBe('needs_input');
      expect(decisions.count(runId)).toBe(0);
      expect((await readScreen('codedeck-1')).join('\n')).not.toContain('dialog answered');

      execFileSync('tmux', ['send-keys', '-t', 'codedeck-1', 'Enter'], { stdio: 'pipe' });
      try {
        await waitFor(() => ['complete', 'error', 'stopped'].includes(runs.get(runId).status), 30000, 'the run to finish after the dialog');
      } catch (err) {
        throw new Error(`${err.message}: ${await describeRun()}`);
      }
      await done;

      const finished = runs.get(runId);
      expect(finished.error).toBeNull();
      expect(finished.status).toBe('complete');
      expect(finished.inputRequest).toBeNull();
      expect((await readScreen('codedeck-1')).join('\n')).toContain('dialog answered');
      expect(decisions.count(runId)).toBe(0);
    } finally {
      if (['running', 'needs_input'].includes(runs.get(runId).status)) await engine.stop(runId);
      try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); } catch { /* ignore */ }
      if (previousTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmp;
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      db.close();
    }
  }, 120000);
});

describeLive('pipeline run live — Resume', () => {
  async function liveRun(mode, stepNames = ['Test']) {
    const base = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-resume-'));
    temps.push(base);
    const tmuxDir = mkdtempSync(path.join(os.tmpdir(), 'cd-pipeline-tmux-'));
    temps.push(tmuxDir);
    const home = path.join(base, 'codedeck');
    initRepo(home);
    const stub = writeLoopAgent(base, mode);

    const previousTmp = process.env.TMUX_TMPDIR;
    const previousTmux = process.env.TMUX;
    process.env.TMUX_TMPDIR = tmuxDir;
    delete process.env.TMUX;

    const db = new Database(':memory:');
    const runs = createRunStore(db);
    const sessions = new Map();
    const deletedSessionIds = new Set();
    const runtime = createTerminalRuntime('tmux');
    const runId = '0e9e4b1a-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const workflowId = '0e9e4b1a-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const homeRepoPath = await resolveHomeRepoPath({ projectPath: home, execFile });

    // Every step uses the same agent. `id` lets a test add a later run in the same worktree.
    const createRun = (id) => runs.create({
      id,
      requestId: `live-resume-${mode}-${id}`,
      workflowId,
      project: 'codedeck',
      input: '',
      status: 'pending',
      stopReason: null,
      currentStepIndex: 0,
      error: null,
      definition: {
        workflowId,
        workflowName: 'Resume',
        workflowRevision: 1,
        agentsDecide: false,
        progressFile: null,
        notesDir: null,
        steps: stepNames.map(name => (
          { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name, prompt: `do the ${name} step`, repeat: { mode: 'once' }, agent: { id: '0e9e4b1a-cccc-4ccc-8ccc-cccccccccccc', name: 'resume-stub', launchCommand: stub, resetCommand: '/clear' } }
        )),
      },
      steps: stepNames.map(() => ({ status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null })),
      homePath: homeRepoPath,
      worktreePath: homeRepoPath,
      worktreeBranch: git(home, ['rev-parse', '--abbrev-ref', 'HEAD']),
      baseCommit: git(home, ['rev-parse', 'HEAD']),
      worktreeState: 'external',
      worktreeDetail: null,
      inputRequest: null,
      taskId: null,
      finishedAt: null,
    });

    const readScreen = async (sessionId) => {
      const snapshot = runtime.captureSessionSnapshot(sessionId, 400);
      if (snapshot.historyGuaranteed !== true) throw new Error('screen capture failed');
      return snapshot.data.replace(/\r/g, '').split('\n');
    };
    const readExecutionState = async (sessionId) => {
      let snapshotText;
      const execution = await runtime.getSessionExecutionStateAsync(sessionId, { onSnapshot: (text) => { snapshotText = text; } });
      const lines = typeof snapshotText === 'string' ? snapshotText.replace(/\r/g, '').split('\n') : [];
      return {
        executionReason: execution.executionReason,
        foregroundCommand: execution.foregroundCommand,
        lines,
        profile: findAgentProfile({ foregroundCommand: execution.foregroundCommand, lines }),
        isAlive: sessions.get(sessionId)?.alive !== false,
        entryExists: true,
      };
    };

    createRun(runId);

    const started = [];
    const engine = createRunEngine({
      runStore: runs,
      setTerminalMuted: () => true,
      readProgressCount: async () => null,
      decisionStore: createDecisionStore(db), answerStore: createAnswerStore(db),
      noteStore: createNoteStore(db),
      reviewStore: createReviewStore(db),
      readScreen,
      createWorktree: async () => { throw new Error('an existing worktree is never created'); },
      removeWorktree: async () => { throw new Error('an existing worktree is never removed'); },
      listDirtyPaths: async ({ worktreePath }) => listDirtyPaths({ worktreePath, execFile }),
      startSession: async ({ cwd }) => {
        const sessionId = `codedeck-${started.length + 1}`;
        runtime.createDetachedSession({ cwd, cols: INITIAL_COLS, rows: INITIAL_ROWS, sessionId });
        started.push(sessionId);
        return sessionId;
      },
      attachBackground: (sessionId, { cwd } = {}) => attachBackgroundSession(
        sessionId, sessions, runtime, deletedSessionIds, { cwd },
      ),
      // The server's own check, against the real tmux server.
      terminalAvailable: (sessionId) => backgroundSessionAvailable(sessionId, sessions, runtime, deletedSessionIds),
      createWorkflow: ({ write, notify }) => createTerminalWorkflow({ write, notify }),
      classifyReadiness: classifyAgentReadiness,
      readExecutionState,
      readinessPollMs: 50,
      launchEnterDelayMs: 50,
      dialogPollMs: 200,
    });

    const describeRun = async (id) => {
      const run = runs.get(id);
      const { sessionId } = run.steps[run.currentStepIndex];
      let screen = '(no terminal)';
      if (sessionId) {
        try { screen = (await readScreen(sessionId)).join('\n'); } catch (err) { screen = `(unreadable: ${err.message})`; }
      }
      return `status=${run.status} error=${run.error} steps=${JSON.stringify(run.steps)}\n${screen}`;
    };
    const waitForRun = async (statuses, label, id = runId) => {
      try {
        await waitFor(() => statuses.includes(runs.get(id).status), 30000, label);
      } catch (err) {
        throw new Error(`${err.message}: ${await describeRun(id)}`);
      }
    };
    const waitForScreen = async (sessionId, text) => {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        // The terminal is created by the run; until then there is no screen to read.
        if (started.includes(sessionId) && (await readScreen(sessionId)).join('\n').includes(text)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for "${text}" on ${sessionId}: ${await describeRun(runId)}`);
    };
    const tmuxSessions = () => {
      let listed;
      try {
        listed = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        // tmux exits when its last session is closed: no server means no sessions.
        if (/no server running/.test(String(err.stderr))) return [];
        throw err;
      }
      return listed.split('\n').filter(Boolean).sort();
    };
    const cleanup = async () => {
      for (const run of runs.list()) {
        if (['running', 'needs_input'].includes(run.status)) await engine.stop(run.id);
      }
      try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); } catch { /* ignore */ }
      if (previousTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmp;
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      db.close();
    };

    return { runs, engine, runId, createRun, started, readScreen, waitForRun, waitForScreen, tmuxSessions, cleanup };
  }

  it('clears the agent in the terminal of the step and sends the prompt again there', async () => {
    const live = await liveRun('silent-first');
    const { runs, engine, runId } = live;
    try {
      const done = engine.start(runId);
      // The agent ends its turn without a signal: the run is still "running" with nothing happening.
      await live.waitForScreen('codedeck-1', 'API Error: the request was refused');
      expect(runs.get(runId).status).toBe('running');
      await engine.stop(runId);
      await done;
      expect(runs.get(runId)).toMatchObject({ status: 'stopped', error: null });

      const acknowledged = await engine.resume(runId);
      expect(acknowledged.steps[0]).toMatchObject({ sessionId: 'codedeck-1', priorSessionIds: [], attempt: 2 });
      await live.waitForRun(['complete', 'error', 'stopped'], 'the resumed run to finish');

      const finished = runs.get(runId);
      expect(finished.error).toBeNull();
      expect(finished.status).toBe('complete');
      expect(finished.steps[0]).toMatchObject({ sessionId: 'codedeck-1', priorSessionIds: [], attempt: 2 });
      // One terminal, one agent process: it was cleared, then given the prompt a second time.
      expect(live.started).toEqual(['codedeck-1']);
      expect(live.tmuxSessions()).toEqual(['codedeck-1']);
      const screen = (await live.readScreen('codedeck-1')).join('\n');
      expect(screen).toContain('context cleared');
      expect(screen).toContain('resumed pass 2');
      expect(screen.indexOf('context cleared')).toBeLessThan(screen.indexOf('resumed pass 2'));
    } finally {
      await live.cleanup();
    }
  }, 120000);

  it('starts the agent again in the terminal of the step when it has exited there', async () => {
    const live = await liveRun('dialog');
    const { runs, engine, runId } = live;
    try {
      const done = engine.start(runId);
      await live.waitForRun(['needs_input', 'error', 'complete'], 'the run to pause for the dialog');
      expect(runs.get(runId).status).toBe('needs_input');
      await engine.stop(runId);
      await done;
      // The agent process is killed; the terminal goes back to a shell in the same tmux session.
      execFileSync('tmux', ['respawn-pane', '-k', '-t', 'codedeck-1'], { stdio: 'pipe' });

      const acknowledged = await engine.resume(runId);
      expect(acknowledged.steps[0]).toMatchObject({ sessionId: 'codedeck-1', priorSessionIds: [], attempt: 2 });
      await live.waitForRun(['needs_input', 'error', 'complete'], 'the resumed run to reach the dialog again');
      expect(runs.get(runId)).toMatchObject({ status: 'needs_input', error: null });
      expect(runs.get(runId).steps[0]).toMatchObject({ sessionId: 'codedeck-1', priorSessionIds: [] });

      execFileSync('tmux', ['send-keys', '-t', 'codedeck-1', 'Enter'], { stdio: 'pipe' });
      await live.waitForRun(['complete', 'error', 'stopped'], 'the resumed run to finish');
      expect(runs.get(runId)).toMatchObject({ status: 'complete', error: null });
      expect(live.started).toEqual(['codedeck-1']);
      expect(live.tmuxSessions()).toEqual(['codedeck-1']);
    } finally {
      await live.cleanup();
    }
  }, 120000);

  it('runs two steps of the same agent, and then a second run, in one terminal', async () => {
    const live = await liveRun('continue', ['Review', 'Test']);
    const { runs, engine, runId } = live;
    try {
      await engine.start(runId);
      const first = runs.get(runId);
      expect(first.error).toBeNull();
      expect(first.status).toBe('complete');
      expect(first.steps.map(step => step.sessionId)).toEqual(['codedeck-1', 'codedeck-1']);
      expect(live.started).toEqual(['codedeck-1']);

      // The agent was launched once, cleared between the steps, and given each prompt in turn.
      const afterFirst = (await live.readScreen('codedeck-1')).join('\n');
      expect(afterFirst.match(/OpenAI Codex \(stub\)/g)).toHaveLength(1);
      expect(afterFirst.indexOf('developed round 1')).toBeGreaterThan(-1);
      expect(afterFirst.indexOf('context cleared')).toBeGreaterThan(afterFirst.indexOf('developed round 1'));
      expect(afterFirst.indexOf('developed round 2')).toBeGreaterThan(afterFirst.indexOf('context cleared'));

      // A later run in the same worktree goes back to that terminal instead of opening tabs.
      const secondId = '0e9e4b1a-dddd-4ddd-8ddd-dddddddddddd';
      live.createRun(secondId);
      await engine.start(secondId);
      const second = runs.get(secondId);
      expect(second.error).toBeNull();
      expect(second.status).toBe('complete');
      expect(second.steps.map(step => step.sessionId)).toEqual(['codedeck-1', 'codedeck-1']);
      expect(live.started).toEqual(['codedeck-1']);
      expect(live.tmuxSessions()).toEqual(['codedeck-1']);
      const afterSecond = (await live.readScreen('codedeck-1')).join('\n');
      expect(afterSecond.match(/OpenAI Codex \(stub\)/g)).toHaveLength(1);
      expect(afterSecond).toContain('developed round 4');
    } finally {
      await live.cleanup();
    }
  }, 120000);

  it('opens a new terminal when the terminal of the step no longer exists', async () => {
    const live = await liveRun('dialog');
    const { runs, engine, runId } = live;
    try {
      const done = engine.start(runId);
      await live.waitForRun(['needs_input', 'error', 'complete'], 'the run to pause for the dialog');
      expect(runs.get(runId).status).toBe('needs_input');
      await engine.stop(runId);
      await done;
      execFileSync('tmux', ['kill-session', '-t', 'codedeck-1'], { stdio: 'pipe' });
      await waitFor(() => !live.tmuxSessions().includes('codedeck-1'), 10000, 'the terminal to be gone');

      const acknowledged = await engine.resume(runId);
      expect(acknowledged.steps[0]).toMatchObject({ sessionId: null, priorSessionIds: ['codedeck-1'], attempt: 2 });
      await live.waitForRun(['needs_input', 'error', 'complete'], 'the resumed run to reach the dialog again');
      expect(runs.get(runId)).toMatchObject({ status: 'needs_input', error: null });
      expect(runs.get(runId).steps[0]).toMatchObject({ sessionId: 'codedeck-2', priorSessionIds: ['codedeck-1'] });
      expect(live.started).toEqual(['codedeck-1', 'codedeck-2']);

      execFileSync('tmux', ['send-keys', '-t', 'codedeck-2', 'Enter'], { stdio: 'pipe' });
      await live.waitForRun(['complete', 'error', 'stopped'], 'the resumed run to finish');
      expect(runs.get(runId)).toMatchObject({ status: 'complete', error: null });
    } finally {
      await live.cleanup();
    }
  }, 120000);
});

describe('pipeline run live gate', () => {
  it('documents skip when tmux or git is missing', () => {
    expect(typeof hasGit()).toBe('boolean');
    expect(typeof hasTmux()).toBe('boolean');
  });
});
