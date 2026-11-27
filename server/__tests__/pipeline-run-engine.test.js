import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { findAgentProfileById } from '../agent-profiles/index.js';
import { classify as classifyReadiness } from '../pipelines/agent-readiness.js';
import { findAgentProfile } from '../agent-profiles/index.js';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as muse from '../agent-profiles/muse.js';
import { quotaNegatives, quotaScreens } from './fixtures/quota-screens.js';
import { classifyTerminalExecution } from '../terminal-execution-classifier.js';
import * as agy from '../agent-profiles/agy.js';
import { notePath } from '../pipelines/run-notes.js';
import { remove as removeGitWorktree } from '../pipelines/run-worktree.js';
import { buildTemplateDraft } from '../../shared/workflow-templates.mjs';
import { createTaskChanges } from '../tasks/task-changes.js';
import { groupFixture, git } from './helpers/group-fixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRunStore } from '../pipelines/run-store.js';
import { createRunEngine } from '../pipelines/run-engine.js';
import { createTerminalWorkflow } from '../terminal-workflow.js';
import { createDecisionStore } from '../pipelines/decision-store.js';
import { createAnswerStore } from '../pipelines/answer-store.js';
import { createNoteStore } from '../pipelines/note-store.js';
import { createReviewStore } from '../pipelines/review-store.js';

const TIMEOUTS = { agentReadySeconds: 120, resetSettleSeconds: 15, finalSignalIdleSeconds: 24, lostPromptSeconds: 30, stallWarningMinutes: 15 };

const WORKFLOW_ID = 'a2d0b1c2-3456-4789-8abc-def012345678';
const AGENT_ID = 'c410a1b2-3456-4789-8abc-def012345678';
const BASE_COMMIT = 'a'.repeat(40);
// What every step that may change the worktree is told: where it may work, and that the test environment is its own.
const BOUNDARY = "Work only inside this run's worktree, /tmp/worktrees/home-feature-abcd1234, which is your current directory. Do not create, change or delete files outside it. You may read files outside it that your instructions, your skills or the project's documents refer to. If the files of the task itself are not in the worktree, do not look for them in other repositories: use NEEDS_INPUT and say what is missing." + ' You own the test environment: whatever a check needs that this machine can give (the app running from this worktree on ports nothing else uses, test data, a test sign-in, an emulator or simulator, a browser), set it up yourself and stop what you started. Do not ask the owner for an environment, a test harness or evidence you can produce yourself: use NEEDS_INPUT for one only after you tried, and say what you tried and what failed.';
const databases = [];

function definition(overrides = {}) {
  return {
    workflowId: WORKFLOW_ID,
    workflowName: 'Feature',
    workflowRevision: 1,
    agentsDecide: false,
    progressFile: null,
    notesDir: null,
    steps: [
      {
        kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
        name: 'Develop',
        // Snapshot prompts are already composed at POST /runs.
        prompt: 'Implement ship it',
        repeat: { mode: 'once' },
        agent: {
          id: AGENT_ID,
          name: 'codex',
          launchCommand: 'codex',
          resetCommand: '/clear',
        },
      },
    ],
    ...overrides,
  };
}

function step(overrides = {}) {
  return {
    status: 'pending',
    sessionId: null,
    priorSessionIds: [],
    attempt: 0,
    iteration: 0,
    roundsCompleted: 0,
    detail: null,
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    ...overrides,
  };
}

function validRun(overrides = {}) {
  const def = overrides.definition ?? definition();
  return {
    requestId: 'req-1',
    workflowId: WORKFLOW_ID,
    project: 'Demo',
    input: 'ship it',
    status: 'pending',
    stopReason: null,
    currentStepIndex: 0,
    error: null,
    definition: def,
    steps: def.steps.map(() => step()),
    homePath: '/tmp/home',
    worktreePath: '/tmp/worktrees/home-feature-abcd1234',
    worktreeBranch: 'workflow/feature-abcd1234',
    baseCommit: null,
    worktreeState: 'not_created',
    worktreeDetail: null,
    inputRequest: null,
    taskId: null,
    finishedAt: null,
    ...overrides,
  };
}

function executionState(overrides = {}) {
  return {
    executionReason: 'agent_prompt_idle',
    foregroundCommand: 'node',
    lines: ['› '],
    profile: { promptVisible: () => true, skillPrefix: '/' },
    isAlive: true,
    entryExists: true,
    ...overrides,
  };
}

// Most fakes below only model start/stop; the engine also hands every workflow its timeouts.
// pipeline-run-live.test.js drives the real ws-handler workflow, which must have the method itself.
function giveTimeouts(workflow) {
  if (workflow && typeof workflow === 'object' && typeof workflow.readTimeoutsFrom !== 'function') workflow.readTimeoutsFrom = () => {};
  return workflow;
}
function withTimeouts(createWorkflow) {
  return (...args) => giveTimeouts(createWorkflow(...args));
}
function withTimeoutsOnAttachment(attachBackground) {
  return async (...args) => {
    const attachment = await attachBackground(...args);
    giveTimeouts(attachment?.workflow);
    return attachment;
  };
}

function setupEngine(overrides = {}) {
  const db = new Database(overrides.databasePath ?? ':memory:');
  databases.push(db);
  const runStore = createRunStore(db, {
    now: overrides.now ?? (() => new Date().toISOString()),
  });

  const writes = [];
  const releases = [];
  let workflowNotify = null;
  let workflowStartArgs = null;
  let readinessQueue = overrides.readinessQueue ?? [executionState()];

  const createWorktree = overrides.createWorktree ?? vi.fn(async () => ({ baseCommit: BASE_COMMIT }));
  let sessionCounter = 0;
  const startSession = overrides.startSession ?? vi.fn(async () => {
    sessionCounter += 1;
    return `Demo-${sessionCounter}`;
  });
  const attachBackground = overrides.attachBackground ?? vi.fn(() => ({
    write: (data) => { writes.push(data); },
    release: () => { releases.push(true); },
  }));
  const createWorkflow = overrides.createWorkflow ?? vi.fn(({ notify }) => {
    workflowNotify = notify;
    return {
      start(args) {
        workflowStartArgs = args;
        queueMicrotask(() => {
          notify({
            status: 'complete',
            active: false,
            error: null,
            requestId: args.requestId,
            iteration: 1,
            limitReached: false,
          });
        });
      },
      stop() {},
      snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
    };
  });
  const classifyReadiness = overrides.classifyReadiness ?? vi.fn((state) => {
    if (state.entryExists === false || state.isAlive === false) return 'closed';
    if (state.executionReason === 'agent_needs_input') return 'needs_input';
    if (state.executionReason === 'shell_prompt') return 'exited';
    if (state.executionReason === 'agent_prompt_idle' && state.profile?.promptVisible?.(state.lines)) return 'ready';
    return 'waiting';
  });
  const readExecutionState = overrides.readExecutionState ?? vi.fn(async () => {
    if (readinessQueue.length === 0) return executionState();
    return readinessQueue.shift();
  });
  const removeWorktree = overrides.removeWorktree ?? vi.fn(async () => ({ ok: true }));
  const listDirtyPaths = overrides.listDirtyPaths ?? vi.fn(async () => []);
  const pathExists = overrides.pathExists ?? vi.fn(async () => true);
  const terminalAvailable = overrides.terminalAvailable ?? vi.fn(() => true);
  const setTerminalMuted = overrides.setTerminalMuted ?? vi.fn(() => true);
  const readScreen = overrides.readScreen ?? vi.fn(async () => []);
  const decisionStore = overrides.decisionStore ?? createDecisionStore(db);
  const answerStore = overrides.answerStore ?? createAnswerStore(db);
  const writeBrief = overrides.writeBrief ?? vi.fn(async () => '.codedeck/runs/abcdef12/brief.md');
  const noteStore = overrides.noteStore ?? createNoteStore(db);
  const reviewStore = overrides.reviewStore ?? createReviewStore(db);

  const engine = createRunEngine({
    runStore,
    createWorktree,
    startSession,
    attachBackground: withTimeoutsOnAttachment(attachBackground),
    createWorkflow: withTimeouts(createWorkflow),
    classifyReadiness,
    readExecutionState,
    readScreen,
    readProgressCount: overrides.readProgressCount ?? vi.fn(async () => null),
    decisionStore,
    answerStore,
    writeBrief,
    noteStore,
    reviewStore,
    removeWorktree,
    listDirtyPaths,
    pathExists,
    terminalAvailable,
    setTerminalMuted,
    restartAgentTerminal: overrides.restartAgentTerminal ?? vi.fn(async () => {}),
    typeIntoTerminal: vi.fn(async () => {}),
    inspectTerminal: vi.fn(async () => ({})),
    terminalInFolder: vi.fn(async () => true),
    setTimeout: overrides.setTimeout ?? setTimeout,
    clearTimeout: overrides.clearTimeout ?? clearTimeout,
    now: overrides.now ?? (() => new Date().toISOString()),
    readinessPollMs: overrides.readinessPollMs ?? 1000,
    readinessTimeoutMs: overrides.readinessTimeoutMs,
    readTimeouts: overrides.readTimeouts ?? (() => TIMEOUTS),
    launchEnterDelayMs: overrides.launchEnterDelayMs ?? 100,
    ...overrides.engineExtras,
  });

  return {
    runStore,
    engine,
    createWorktree,
    startSession,
    attachBackground,
    createWorkflow,
    classifyReadiness,
    readExecutionState,
    removeWorktree,
    listDirtyPaths,
    pathExists,
    terminalAvailable,
    setTerminalMuted,
    readScreen,
    decisionStore,
    answerStore,
    writeBrief,
    noteStore,
    reviewStore,
    writes,
    releases,
    getWorkflowNotify: () => workflowNotify,
    getWorkflowStartArgs: () => workflowStartArgs,
    setReadinessQueue: (queue) => { readinessQueue = queue; },
  };
}

afterEach(() => {
  databases.splice(0).forEach(db => db.close());
  vi.useRealTimers();
});

describe('createRunEngine (Spec §8.3–§8.4)', () => {
  it('pins a local pipeline terminal even when project defaults can change', async () => {
    vi.useFakeTimers();
    const ctx = setupEngine();
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1500);
    await done;
    expect(ctx.startSession).toHaveBeenCalledWith({project:'Demo', cwd:run.worktreePath, host:'local'});
  });
  it('blocks the next agent when its required handoff is missing on the execution host', async () => {
    vi.useFakeTimers();
    const ctx = setupEngine({engineExtras:{prepareNotes:vi.fn(),readNote:async()=>({status:'missing',content:null})}});
    const def = definition({notesDir:'.codedeck/runs/abcdef12'});
    def.steps.push({...def.steps[0],name:'Review'});
    const run = ctx.runStore.create(validRun({definition:def,host:'worker'}));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(ctx.runStore.get(run.id)).toMatchObject({status:'error',error:expect.stringMatching(/worker.*00-develop.md/)});
    expect(ctx.startSession).toHaveBeenCalledTimes(1);
  });
  it('requires a way to tell whether a terminal is in a folder', () => {
    expect(() => setupEngine({ engineExtras: { terminalInFolder: undefined } })).toThrow('createRunEngine: terminalInFolder must be a function');
  });
  it('requires ways to type into a terminal directly and to describe it', () => {
    expect(() => setupEngine({ engineExtras: { typeIntoTerminal: null } })).toThrow('createRunEngine: typeIntoTerminal must be a function');
    expect(() => setupEngine({ engineExtras: { inspectTerminal: null } })).toThrow('createRunEngine: inspectTerminal must be a function');
  });
  it('requires a way to start a terminal again for an agent that takes no input', () => {
    expect(() => setupEngine({ engineExtras: { restartAgentTerminal: 'no' } })).toThrow('createRunEngine: restartAgentTerminal must be a function');
  });
  it('requires a positive whole number of milliseconds for a prompt to be taken', () => {
    expect(() => setupEngine({ engineExtras: { promptPickupMs: 0 } })).toThrow('createRunEngine: promptPickupMs must be a positive integer, got 0');
    expect(() => setupEngine({ engineExtras: { promptPickupMs: 1.5 } })).toThrow('createRunEngine: promptPickupMs must be a positive integer, got 1.5');
  });
  it('requires a terminal muting function at construction', () => {
    expect(() => setupEngine({ engineExtras: { setTerminalMuted: undefined } })).toThrow('createRunEngine: setTerminalMuted is required');
  });
  it('requires a review store with add and listSentBack at construction', () => {
    expect(() => setupEngine({ engineExtras: { reviewStore: undefined } })).toThrow('createRunEngine: reviewStore is required');
    expect(() => setupEngine({ engineExtras: { reviewStore: { add() {} } } })).toThrow('createRunEngine: reviewStore is required');
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('attributes only submitted agent work and records the actual assignment on a retry', async () => {
    const denied = vi.fn().mockRejectedValueOnce(new Error('Terminal unavailable')).mockResolvedValue('Demo-1');
    const ctx = setupEngine({startSession:denied});
    const def = definition();
    const team = {id:WORKFLOW_ID,name:'Developers',revision:1};
    def.steps[0].role = 'Fix';
    def.steps[0].agent.assignment = {source:'team',agentRevision:1,teamId:team.id,teamRevision:1};
    const run = ctx.runStore.create(validRun({definition:def}),{team,workload:'a'.repeat(64),mixed:false});
    const failed = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100); await failed;
    expect(ctx.runStore.get(run.id).status).toBe('error');
    expect(ctx.runStore.attribution(run.id).attempts).toEqual([]);
    await ctx.engine.resume(run.id);
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx.runStore.attribution(run.id).attempts).toMatchObject([
      {attempt:2,agentId:AGENT_ID,teamId:team.id,role:'Fix',activeMs:expect.any(Number)}]);
  });

  it('records a gated pass before waiting, then approves only once', async () => {
    const readNote = vi.fn(async () => ({ status: 'present', content: '# Analysis complete\nEvidence' }));
    const ctx = setupEngine({ engineExtras: { prepareNotes: vi.fn(async () => {}), readNote } });
    const def = definition({ notesDir: '.codedeck/runs/abcdef12' });
    def.steps[0].approval = true;
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('awaiting_approval');
    expect(ctx.setTerminalMuted).toHaveBeenCalledWith('Demo-1', false);
    expect(ctx.noteStore.latestByStep(run.id).get(0).summary).toBe('Analysis complete');
    expect(ctx.removeWorktree).not.toHaveBeenCalled();
    await ctx.engine.approve(run.id);
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(ctx.reviewStore.list(run.id)).toMatchObject([{ verdict: 'approved', comment: null }]);
    await expect(ctx.engine.approve(run.id)).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
  });
  it('approving the last gated step completes the run and removes its worktree', async () => {
    const ctx = setupEngine();
    const def = definition(); def.steps[0].approval = true;
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100); await done;
    expect(ctx.runStore.get(run.id).status).toBe('awaiting_approval');
    await ctx.engine.approve(run.id);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'complete', worktreeState: 'removed' });
    expect(ctx.removeWorktree).toHaveBeenCalledOnce();
  });
  it('send-back after its terminal closes launches a new terminal and records the prior session', async () => {
    let available = true;
    const ctx = setupEngine({ terminalAvailable: vi.fn(() => available) });
    const def = definition(); def.steps[0].approval = true;
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100); await done;
    expect(ctx.runStore.get(run.id).steps[0].sessionId).toBe('Demo-1');
    available = false;
    await ctx.engine.sendBack(run.id, 'Please revise');
    available = true;
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx.runStore.get(run.id).steps[0]).toMatchObject({ sessionId: 'Demo-2', priorSessionIds: ['Demo-1'], attempt: 2 });
  });
  it('a workflow without gates completes without an approval wait or review rows', async () => {
    const ctx = setupEngine();
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100); await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(ctx.runStore.get(run.id).steps[0].status).toBe('complete');
    expect(ctx.reviewStore.list(run.id)).toEqual([]);
  });
  it.each([
    ['missing final signal', /requires a COMPLETE signal/],
    ['open task', /open task.*1\/2/],
    ['missing todo', /required progress file.*docs\/todo.md/],
    ['failed probe', /failed probe.*B1/],
    ['stale verdict', /passing verdict for attempt 1/],
    ['missing suite', /missing a final suite for backend/],
    ['failed suite', /failed suite for backend.*exit 1/],
    ['changed HEAD', /changed revision for backend/],
    ['changed dirty source', /changed since Test started/],
    ['missing repository inventory', /recorded worktree/],
  ])('keeps a closing Test decision recoverable for %s, then completes once', async (scenario, expected) => {
    const head = 'd'.repeat(40);
    const suite = (exit = 0, revision = head) => `SUITE backend | npx vitest run --maxWorkers=1 | exit ${exit} | ${revision}`;
    const goodNote = attempt => `# Verified\nVERDICT ${attempt} PASS\n${suite()}`;
    const progress = { file: 'docs/todo.md', status: 'all_done', tasksDone: 2, tasksTotal: 2 };
    let currentProgress = progress;
    let note = goodNote(1);
    let fingerprint = 'a'.repeat(64);
    let reads = 0;
    let missingPlaces = false;
    if (scenario === 'open task') currentProgress = { ...progress, status: 'in_progress', tasksDone: 1 };
    if (scenario === 'missing todo') currentProgress = null;
    if (scenario === 'failed probe') note += '\nREPAIR 1 B1 | src/batch.js | probe fails';
    if (scenario === 'stale verdict') note = goodNote(7);
    if (scenario === 'missing suite') note = '# Verified\nVERDICT 1 PASS';
    if (scenario === 'failed suite') note = `# Verified\nVERDICT 1 PASS\n${suite(1)}`;
    if (scenario === 'changed HEAD') note = `# Verified\nVERDICT 1 PASS\n${suite(0, BASE_COMMIT)}`;
    if (scenario === 'missing repository inventory') missingPlaces = true;
    const ctx = setupEngine({
      ...(scenario === 'missing final signal' ? { createWorkflow: ({ notify }) => ({
        start(request) {
          const complete = request.requestId.endsWith('-2');
          queueMicrotask(() => notify({ requestId: request.requestId, status: complete ? 'complete' : 'stopped',
            active: false, iteration: 1, error: null, limitReached: !complete }));
        },
        stop() {},
        snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
      }) } : {}),
      engineExtras: {
        prepareNotes: vi.fn(),
        readProgress: vi.fn(async () => currentProgress),
        readNote: vi.fn(async () => {
          if (scenario === 'changed dirty source' && reads++ === 0) fingerprint = 'b'.repeat(64);
          return { status: 'present', content: note };
        }),
        fingerprintSources: vi.fn(async () => fingerprint),
        listRunPlaces: vi.fn(async (run, { includeGit } = {}) => ({ current: 'backend',
          worktrees: missingPlaces && includeGit ? [] : [{ repository: 'backend', path: run.worktreePath, branch: 'b', baseCommit: BASE_COMMIT, repositoryPath: '/tmp/home' }], readOnly: [] })),
        inspectCommitWorktree: vi.fn(async () => ({ repository: 'backend', branch: 'b', head, dirty: true })),
      },
    });
    const def = definition({ notesDir: '.codedeck/runs/abcdef12', progressFile: 'docs/todo.md',
      steps: [{ ...definition().steps[0], name: 'Test', prompt: 'do it' }] });
    const run = ctx.runStore.create(validRun({ definition: def }));
    const first = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100); await first;
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error', error: expect.stringMatching(expected) });

    currentProgress = progress;
    missingPlaces = false;
    note = goodNote(2);
    await ctx.engine.resume(run.id);
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'complete', steps: [expect.objectContaining({ status: 'complete' })] });
    const audit = ctx.runStore.auditPage(run.id, { page: 0, size: 100, direction: 'asc', stepIndex: null }).data;
    expect(audit.filter(entry => entry.kind === 'step_complete')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
  });
  it('Stop during an approval wait stops the run and Resume reruns the step', async () => {
    const ctx = setupEngine();
    const def = definition(); def.steps[0].approval = true;
    const run = ctx.runStore.create(validRun({ definition: def }));
    const first = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100); await first;
    expect(ctx.runStore.get(run.id).status).toBe('awaiting_approval');
    await ctx.engine.stop(run.id);
    expect(ctx.runStore.get(run.id).status).toBe('stopped');
    await ctx.engine.resume(run.id);
    await vi.advanceTimersByTimeAsync(1100);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'awaiting_approval', steps: [expect.objectContaining({ attempt: 2 })] });
  });
  it('serializes simultaneous approvals so the waiting step advances once', async () => {
    const ctx = setupEngine();
    const def = definition(); def.steps[0].approval = true;
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100); await done;
    const results = await Promise.allSettled([ctx.engine.approve(run.id), ctx.engine.approve(run.id)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(ctx.reviewStore.list(run.id)).toHaveLength(1);
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });
  it('gates an until-complete step only after COMPLETE, and leaves pass-limit Continue unchanged', async () => {
    const createWorkflow = vi.fn(({ notify }) => ({
      start: () => queueMicrotask(() => { notify({ status: 'resetting', iteration: 1 }); notify({ status: 'complete', iteration: 2 }); }),
      stop() {}, snapshot: () => ({ status: 'stopped' }),
    }));
    const ctx = setupEngine({ createWorkflow });
    const def = definition(); def.steps[0].approval = true; def.steps[0].repeat = { mode: 'until_complete', max: 3 };
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100); await done;
    expect(ctx.runStore.get(run.id).status).toBe('awaiting_approval');

    const limitWorkflow = vi.fn(({ notify }) => ({
      start: () => queueMicrotask(() => notify({ status: 'stopped', iteration: 2, limitReached: true })),
      stop() {}, snapshot: () => ({ status: 'stopped' }),
    }));
    const limited = setupEngine({ createWorkflow: limitWorkflow });
    const limitedDef = definition(); limitedDef.steps[0].approval = true; limitedDef.steps[0].repeat = { mode: 'until_complete', max: 2 };
    const limitedRun = limited.runStore.create(validRun({ requestId: 'limit-approval', definition: limitedDef }));
    const limitedDone = limited.engine.start(limitedRun.id);
    await vi.advanceTimersByTimeAsync(1100); await limitedDone;
    expect(limited.runStore.get(limitedRun.id).status).toBe('limit_paused');
    const acknowledged = await limited.engine.continue(limitedRun.id);
    expect(acknowledged.status).toBe('running');
    expect(acknowledged.steps[0]).toMatchObject({ status: 'launching', extraRounds: 1 });
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);
    // The relaunched pass hits the mock's limit again, so the cap pauses rather than completes.
    expect(limited.runStore.get(limitedRun.id).status).toBe('limit_paused');
  });

  it('sends a gated step back into the same terminal with feedback and a new attempt', async () => {
    const writeFeedback = vi.fn(async () => '.codedeck/runs/abcdef12/00-develop.feedback.md');
    const ctx = setupEngine({ engineExtras: { prepareNotes: vi.fn(async () => {}), readNote: vi.fn(async () => ({ status: 'missing', content: null })), writeFeedback } });
    const def = definition({ notesDir: '.codedeck/runs/abcdef12' });
    def.steps[0].approval = true;
    const run = ctx.runStore.create(validRun({ definition: def }));
    const first = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(ctx.runStore.get(run.id).steps[0].sessionId).toBe('Demo-1');
    await ctx.engine.sendBack(run.id, 'Please add evidence');
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.runStore.get(run.id).steps[0]).toMatchObject({ attempt: 2, sessionId: 'Demo-1' });
    expect(ctx.reviewStore.listSentBack(run.id, 0)).toMatchObject([{ comment: 'Please add evidence' }]);
    expect(writeFeedback).toHaveBeenCalledOnce();
    expect(ctx.getWorkflowStartArgs().guidance).toContain('The owner sent this step back: read .codedeck/runs/abcdef12/00-develop.feedback.md before you start.');
  });

  it('prepares run notes before launch and records a completed pass', async () => {
    const prepareNotes = vi.fn(async () => {});
    const readNote = vi.fn(async () => ({ status: 'present', content: '# Finished\nChanged file' }));
    const ctx = setupEngine({ engineExtras: { prepareNotes, readNote } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(prepareNotes).toHaveBeenCalledBefore(ctx.startSession);
    expect(ctx.noteStore.list(run.id, { offset: 0, limit: 10, direction: 'asc' })).toMatchObject([{ status: 'written', summary: 'Finished', pass: 1 }]);
  });
  it('tells its listener what a step wrote, once the note is stored', async () => {
    const onNoteWritten = vi.fn();
    const readNote = vi.fn(async () => ({ status: 'present', content: '# Finished\nChanged file' }));
    const ctx = setupEngine({ engineExtras: { prepareNotes: vi.fn(async () => {}), readNote, onNoteWritten } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    onNoteWritten.mockImplementation(() => expect(ctx.noteStore.latestByStep(run.id).get(0).status).toBe('written'));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(onNoteWritten).toHaveBeenCalledTimes(1);
    expect(onNoteWritten).toHaveBeenCalledWith({ runId: run.id, taskId: run.taskId, input: run.input, stepIndex: 0, content: '# Finished\nChanged file' });
  });
  it.each([
    [{ status: 'missing', content: null }],
    [{ status: 'unreadable', content: null }],
  ])('tells its listener nothing when a step wrote no note (%j)', async result => {
    const onNoteWritten = vi.fn();
    const ctx = setupEngine({ engineExtras: { prepareNotes: vi.fn(async () => {}), readNote: vi.fn(async () => result), onNoteWritten } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(onNoteWritten).not.toHaveBeenCalled();
  });
  it('finishes the run when its note listener fails, and reports the failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onNoteWritten = vi.fn(() => { throw new Error('listener broke'); });
    const readNote = vi.fn(async () => ({ status: 'present', content: '# Finished' }));
    const ctx = setupEngine({ engineExtras: { prepareNotes: vi.fn(async () => {}), readNote, onNoteWritten } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(ctx.noteStore.latestByStep(run.id).get(0).status).toBe('written');
    expect(warn).toHaveBeenCalledWith(`[pipeline-notes] run=${run.id} step=0 error=listener broke`);
    warn.mockRestore();
  });
  it('records each changed note before the next pass prompt and on completion', async () => {
    const events = [];
    const readNote = vi.fn(async () => {
      const pass = Math.min(readNote.mock.calls.length, 2);
      events.push(`read ${pass}`);
      return { status: 'present', content: `# Pass ${pass}\nChanged in pass ${pass}` };
    });
    const createWorkflow = vi.fn(({ notify, write }) => ({
      start(args) {
        queueMicrotask(async () => {
          notify({ status: 'resetting', iteration: 1 }); // CONTINUE on pass 1
          for (let i = 0; i < 100 && ctx.noteStore.count(run.id) < 1; i += 1) await Promise.resolve();
          events.push(`stored ${ctx.noteStore.count(run.id)}`);
          write('pass 2 prompt');
          events.push('prompt 2');
          notify({ status: 'complete', iteration: 2 }); // COMPLETE on pass 2
        });
      },
      stop() {},
      snapshot: () => ({ status: 'stopped' }),
    }));
    const ctx = setupEngine({ createWorkflow, engineExtras: { prepareNotes: vi.fn(async () => {}), readNote } });
    const def = definition({ notesDir: '.codedeck/runs/abcdef12' });
    def.steps[0].repeat = { mode: 'until_complete', max: 3 };
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.noteStore.list(run.id, { offset: 0, limit: 10, direction: 'asc' })).toMatchObject([
      { pass: 1, status: 'written', content: '# Pass 1\nChanged in pass 1' },
      { pass: 2, status: 'written', content: '# Pass 2\nChanged in pass 2' },
    ]);
    expect(events.indexOf('read 1')).toBeLessThan(events.indexOf('prompt 2'));
    expect(events).toContain('stored 1');
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });
  it('records both passes when CONTINUE reaches the repeat limit', async () => {
    const readNote = vi.fn(async () => ({ status: 'present', content: `# Pass ${readNote.mock.calls.length}` }));
    const createWorkflow = vi.fn(({ notify }) => ({
      start: () => queueMicrotask(() => {
        notify({ status: 'resetting', iteration: 1 }); // CONTINUE on pass 1
        notify({ status: 'stopped', iteration: 2, limitReached: true }); // CONTINUE on pass 2
      }),
      stop() {},
      snapshot: () => ({ status: 'stopped' }),
    }));
    const ctx = setupEngine({ createWorkflow, engineExtras: { prepareNotes: vi.fn(async () => {}), readNote } });
    const def = definition({ notesDir: '.codedeck/runs/abcdef12' });
    def.steps[0].repeat = { mode: 'until_complete', max: 2 };
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');
    expect(ctx.noteStore.list(run.id, { offset: 0, limit: 10, direction: 'asc' })).toMatchObject([
      { pass: 1, status: 'written' }, { pass: 2, status: 'written' },
    ]);
    expect(readNote).toHaveBeenCalledTimes(2);
  });
  it('reads and records a pass only once when its reset snapshot repeats', async () => {
    const readNote = vi.fn(async () => ({ status: 'present', content: '# First pass' }));
    const createWorkflow = vi.fn(({ notify }) => ({
      start: () => queueMicrotask(() => {
        notify({ status: 'resetting', iteration: 1 });
        notify({ status: 'resetting', iteration: 1 });
        notify({ status: 'stopped', iteration: 2, limitReached: true });
      }),
      stop() {},
      snapshot: () => ({ status: 'stopped' }),
    }));
    const ctx = setupEngine({ createWorkflow, engineExtras: { prepareNotes: vi.fn(async () => {}), readNote } });
    const def = definition({ notesDir: '.codedeck/runs/abcdef12' });
    def.steps[0].repeat = { mode: 'until_complete', max: 2 };
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.noteStore.list(run.id, { offset: 0, limit: 10, direction: 'asc' }).filter(row => row.pass === 1)).toMatchObject([
      { pass: 1, status: 'written' },
    ]);
    expect(readNote.mock.calls).toHaveLength(2);
  });
  it('fails before launching when run notes cannot be prepared', async () => {
    const prepareNotes = vi.fn(async () => { throw new Error('Run notes folder is not ignored'); });
    const ctx = setupEngine({ engineExtras: { prepareNotes } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    await ctx.engine.start(run.id);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error', error: 'Run notes folder is not ignored' });
    expect(ctx.startSession).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: 'present', content: '# Same' }, 'unchanged'],
    [{ status: 'missing', content: null }, 'missing'],
    [{ status: 'unreadable', content: null }, 'unreadable'],
    [{ status: 'too_large', content: null }, 'too_large'],
  ])('records %s without failing the run', async (result, status) => {
    const ctx = setupEngine({ engineExtras: { prepareNotes: vi.fn(async () => {}), readNote: vi.fn(async () => result) } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    if (status === 'unchanged') ctx.noteStore.add({ runId: run.id, stepIndex: 0, stepName: 'Develop', attempt: 2, pass: 1, status: 'written', summary: 'Same', content: '# Same' });
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(ctx.noteStore.latestByStep(run.id).get(0).status).toBe(status);
  });

  it('keeps a legacy run free of note preparation and recording', async () => {
    const prepareNotes = vi.fn();
    const readNote = vi.fn();
    const ctx = setupEngine({ engineExtras: { prepareNotes, readNote } });
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(prepareNotes).not.toHaveBeenCalled();
    expect(readNote).not.toHaveBeenCalled();
    expect(ctx.noteStore.count(run.id)).toBe(0);
  });
  it('sweeps a note written after the pass boundary before worktree removal', async () => {
    const readNote = vi.fn()
      .mockResolvedValueOnce({ status: 'missing', content: null })
      .mockResolvedValueOnce({ status: 'present', content: '# Late\nSaved before cleanup' });
    const ctx = setupEngine({ engineExtras: { prepareNotes: vi.fn(async () => {}), readNote } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.noteStore.list(run.id, { offset: 0, limit: 10, direction: 'asc' }).map(row => row.status)).toEqual(['missing', 'written']);
    expect(ctx.noteStore.lastContent(run.id, 0)).toContain('Saved before cleanup');
    expect(readNote).toHaveBeenCalledTimes(2);
  });
  it('logs a recording error and still completes the run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = setupEngine({ engineExtras: { prepareNotes: vi.fn(async () => {}), readNote: vi.fn(async () => { throw new Error('read failed'); }) } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('[pipeline-notes]');
    warn.mockRestore();
  });
  it('does not record the iteration-zero reset of a reused terminal', async () => {
    const readNote = vi.fn(async () => ({ status: 'present', content: '# Done' }));
    const createWorkflow = vi.fn(({ notify }) => ({
      start: () => queueMicrotask(() => {
        notify({ status: 'resetting', iteration: 0 });
        notify({ status: 'complete', iteration: 1 });
      }),
      stop() {},
    }));
    const ctx = setupEngine({ createWorkflow, engineExtras: { prepareNotes: vi.fn(async () => {}), readNote } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.noteStore.count(run.id)).toBe(1);
  });
  it.each([
    ['two passes', [{ status: 'resetting', iteration: 1 }, { status: 'complete', iteration: 2 }], 2, ['written', 'unchanged']],
    ['pass limit', [{ status: 'stopped', iteration: 2, limitReached: true }], 1, ['written']],
    ['duplicate pass end', [{ status: 'resetting', iteration: 1 }, { status: 'resetting', iteration: 1 }, { status: 'complete', iteration: 2 }], 2, ['written', 'unchanged']],
  ])('records once for %s', async (_name, snapshots, expectedCount, statuses) => {
    const createWorkflow = vi.fn(({ notify }) => ({
      start: () => queueMicrotask(() => snapshots.forEach(snapshot => notify(snapshot))),
      stop() {},
      snapshot: () => ({ status: 'stopped' }),
    }));
    const ctx = setupEngine({ createWorkflow, engineExtras: { prepareNotes: vi.fn(async () => {}), readNote: vi.fn(async () => ({ status: 'present', content: '# Same' })) } });
    const def = definition({ notesDir: '.codedeck/runs/abcdef12' });
    def.steps[0].repeat = { mode: 'until_complete', max: 2 };
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    const rows = ctx.noteStore.list(run.id, { offset: 0, limit: 10, direction: 'asc' });
    expect(rows).toHaveLength(expectedCount);
    expect(rows.map(row => row.status)).toEqual(statuses);
    expect(rows.map(row => row.pass)).toEqual(expectedCount === 1 ? [2] : [1, 2]);
  });
  it('does not record an iteration-zero reset before the first pass', async () => {
    const readNote = vi.fn(async () => ({ status: 'present', content: '# Done' }));
    let startArgs;
    const createWorkflow = vi.fn(({ notify }) => ({
      start: (args) => { startArgs = args; queueMicrotask(() => { notify({ status: 'resetting', iteration: 0 }); notify({ status: 'complete', iteration: 1 }); }); },
      stop() {}, snapshot: () => ({ status: 'stopped' }),
    }));
    const ctx = setupEngine({ createWorkflow, engineExtras: { prepareNotes: vi.fn(async () => {}), readNote } });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }), worktreeState: 'external', steps: [step({ sessionId: 'Demo-1' })] }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(startArgs.resetFirst).toBe(true);
    expect(ctx.noteStore.count(run.id)).toBe(1);
    expect(readNote).toHaveBeenCalledTimes(2);
  });
  it.each(['read', 'add'])('keeps the run outcome and warns once when note %s fails', async (failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = setupEngine({ engineExtras: { prepareNotes: vi.fn(async () => {}), readNote: failure === 'read' ? vi.fn(async () => { throw new Error('note read failed'); }) : vi.fn(async () => ({ status: 'present', content: '# Done' })) } });
    if (failure === 'add') vi.spyOn(ctx.noteStore, 'add').mockImplementation(() => { throw new Error('note add failed'); });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  async function runSkillStep(profile) {
    const ctx = setupEngine({ readinessQueue: [executionState({ profile })] });
    const skill = definition();
    skill.steps[0].prompt = '/feature-dev docs/todos/x.md';
    const run = ctx.runStore.create(validRun({ definition: skill }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100); // launch Enter
    await vi.advanceTimersByTimeAsync(1000); // first poll → ready
    await done;
    return { ctx, run: ctx.runStore.get(run.id) };
  }

  it('sends a leading /skill as $skill when the CLI that became ready invokes skills with $', async () => {
    const { ctx, run } = await runSkillStep({ promptVisible: () => true, skillPrefix: '$' });
    expect(ctx.getWorkflowStartArgs().command).toBe('$feature-dev docs/todos/x.md');
    expect(run.status).toBe('complete');
  });

  it('sends a leading /skill as written when the CLI that became ready invokes skills with /', async () => {
    const { ctx } = await runSkillStep({ promptVisible: () => true, skillPrefix: '/' });
    expect(ctx.getWorkflowStartArgs().command).toBe('/feature-dev docs/todos/x.md');
  });

  it('fails the run when the ready CLI profile does not say how it invokes skills', async () => {
    const { ctx, run } = await runSkillStep({ promptVisible: () => true });
    expect(ctx.getWorkflowStartArgs()).toBeNull();
    expect(run.status).toBe('error');
    expect(run.error).toContain('skill prefix must be "/" or "$"');
  });

  it('happy path: single step reaches complete', async () => {
    const ctx = setupEngine({
      readinessQueue: [
        executionState({ executionReason: 'agent_working' }),
        executionState(),
      ],
    });
    const run = ctx.runStore.create(validRun());

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100); // launch Enter
    await vi.advanceTimersByTimeAsync(1000); // first poll → waiting
    await vi.advanceTimersByTimeAsync(1000); // second poll → ready
    await done;

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('complete');
    expect(finished.finishedAt).toBeTruthy();
    expect(finished.worktreeState).toBe('removed');
    expect(finished.baseCommit).toBe(BASE_COMMIT);
    expect(finished.steps[0]).toMatchObject({
      status: 'complete',
      sessionId: 'Demo-1',
      attempt: 1,
    });
    expect(finished.steps[0].finishedAt).toBeTruthy();

    expect(ctx.createWorktree).toHaveBeenCalledWith(expect.objectContaining({
      id: run.id,
      worktreePath: run.worktreePath,
      homePath: run.homePath,
    }));
    expect(ctx.startSession).toHaveBeenCalledWith({
      host:'local', project: 'Demo',
      cwd: run.worktreePath,
    });
    expect(ctx.attachBackground).toHaveBeenCalledWith('Demo-1', { cwd: run.worktreePath });
    expect(ctx.writes[0]).toBe('codex');
    expect(ctx.writes).toContain('\r');
    expect(ctx.getWorkflowStartArgs()).toEqual({
      requestId: `run-${run.id}-0-1`,
      command: 'Implement ship it',
      resetCommand: '/clear',
      maxIterations: 1,
      guidance: BOUNDARY,
      // A step in a new terminal starts on a fresh agent; nothing to reset.
      resetFirst: false,
    });
    expect(ctx.releases).toEqual([true]);
    expect(ctx.removeWorktree).toHaveBeenCalledWith(expect.objectContaining({ id: run.id }));
  });

  it('errors with a readiness timeout message after 120s of waiting', async () => {
    const ctx = setupEngine({
      readinessQueue: Array.from({ length: 130 }, () => executionState({
        executionReason: 'agent_working',
        foregroundCommand: 'codex',
        profile: { promptVisible: () => false },
      })),
    });
    const run = ctx.runStore.create(validRun());

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(120_000);
    await done;

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('error');
    expect(ctx.setTerminalMuted).toHaveBeenCalledWith('Demo-1', true);
    expect(finished.error).toMatch(/codex/i);
    expect(finished.error).toMatch(/agent_working/);
    expect(finished.error).toMatch(/codex/);
    expect(finished.error).toMatch(/120/);
    expect(finished.steps[0].status).toBe('failed');
    expect(ctx.releases).toEqual([true]);
    expect(ctx.createWorkflow).not.toHaveBeenCalled();
  });

  it('reads the current agent-ready setting while waiting', async () => {
    let timeouts = TIMEOUTS;
    const ctx = setupEngine({
      readTimeouts: () => timeouts,
      readinessQueue: Array.from({ length: 20 }, () => executionState({
        executionReason: 'agent_marker_stale', foregroundCommand: 'codex', profile: { promptVisible: () => false },
      })),
    });
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(5100);
    expect(ctx.runStore.get(run.id).status).toBe('running');
    timeouts = { ...TIMEOUTS, agentReadySeconds: 10 };
    await vi.advanceTimersByTimeAsync(6000);
    await done;
    expect(ctx.runStore.get(run.id).error).toContain('within 10 seconds');
  });

  it('errors when the launch command exited', async () => {
    const ctx = setupEngine({
      readinessQueue: [
        executionState({
          executionReason: 'shell_prompt',
          foregroundCommand: 'zsh',
          profile: null,
          // The shell echoed the launch command before the agent exited.
          lines: ['me@host demo % codex', 'me@host demo %'],
        }),
      ],
      classifyReadiness: vi.fn(() => 'exited'),
    });
    const run = ctx.runStore.create(validRun());

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toBe('The launch command for agent codex exited.');
    expect(finished.steps[0].status).toBe('failed');
    expect(ctx.releases).toEqual([true]);
  });

  it('errors when the terminal closed while launching', async () => {
    const ctx = setupEngine({
      readinessQueue: [
        executionState({ isAlive: false }),
      ],
      classifyReadiness: vi.fn(() => 'closed'),
    });
    const run = ctx.runStore.create(validRun());

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toBe('The terminal closed while launching agent codex.');
    expect(finished.steps[0].status).toBe('failed');
    expect(ctx.releases).toEqual([true]);
  });

  it('errors when worktree creation fails', async () => {
    const ctx = setupEngine({
      createWorktree: vi.fn(async () => {
        throw new Error('fatal: \'branch\' is not a commit');
      }),
    });
    const run = ctx.runStore.create(validRun());

    await expect(ctx.engine.start(run.id)).resolves.toBeUndefined();

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toMatch(/fatal: 'branch' is not a commit/);
    expect(finished.worktreeState).toBe('not_created');
    // Worktree fails while still pending — step has not launched yet (run-machine).
    expect(finished.steps[0].status).toBe('pending');
    expect(ctx.startSession).not.toHaveBeenCalled();
    expect(ctx.releases).toEqual([]);
  });

  it('never advances the run inside the loop engine notify call stack', async () => {
    let statusDuringNotify = null;
    let runId = null;
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: vi.fn(({ notify }) => ({
        start(args) {
          notify({
            status: 'complete',
            active: false,
            error: null,
            requestId: args.requestId,
            iteration: 1,
            limitReached: false,
          });
          statusDuringNotify = ctx.runStore.get(runId).status;
        },
        stop() {},
        snapshot: () => ({ status: 'complete', active: false, error: null, requestId: null, iteration: 1, limitReached: false }),
      })),
    });
    const run = ctx.runStore.create(validRun());
    runId = run.id;

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(statusDuringNotify).toBe('running');
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(ctx.releases).toEqual([true]);
  });

  it('pauses the readiness clock while needs_input and still reaches ready', async () => {
    const ctx = setupEngine({
      readinessQueue: [
        executionState({ executionReason: 'agent_needs_input' }),
        executionState({ executionReason: 'agent_needs_input' }),
        executionState({ executionReason: 'agent_working', profile: { promptVisible: () => false } }),
        executionState(),
      ],
      classifyReadiness: vi.fn((state) => {
        if (state.executionReason === 'agent_needs_input') return 'needs_input';
        if (state.executionReason === 'agent_prompt_idle' && state.profile?.promptVisible?.(state.lines)) return 'ready';
        return 'waiting';
      }),
    });
    const run = ctx.runStore.create(validRun());

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.runStore.get(run.id).status).toBe('needs_input');
    // A launch dialog is not a request the agent signalled: nothing to show, nothing to answer.
    expect(ctx.runStore.get(run.id).inputRequest).toBeNull();
    expect(ctx.readScreen).not.toHaveBeenCalled();
    await expect(ctx.engine.answer(run.id, 'yes')).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });

  it('uses maxIterations from until_complete.repeat.max', async () => {
    const ctx = setupEngine({ readinessQueue: [executionState()] });
    const run = ctx.runStore.create(validRun({
      definition: definition({
        steps: [{
          kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
          name: 'Develop',
          prompt: 'Implement ship it',
          repeat: { mode: 'until_complete', max: 7 },
          agent: {
            id: AGENT_ID,
            name: 'codex',
            launchCommand: 'codex',
            resetCommand: '/clear',
          },
        }],
      }),
    }));

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(ctx.getWorkflowStartArgs().maxIterations).toBe(7);
    expect(ctx.getWorkflowStartArgs().command).toBe('Implement ship it');
  });

  it('rejects a readiness timeout or poll interval that is not a positive integer', () => {
    for (const readinessTimeoutMs of ['5000', -1, 1.5]) {
      expect(() => setupEngine({ readinessTimeoutMs })).toThrow(/readinessTimeoutMs/);
    }
    for (const readinessPollMs of ['1000', 0, 1.5]) {
      expect(() => setupEngine({ readinessPollMs })).toThrow(/readinessPollMs/);
    }
  });

  it('names the stored settings when a timeout read during a run is invalid', async () => {
    const stuck = () => executionState({ executionReason: 'agent_marker_stale', foregroundCommand: 'codex', profile: { promptVisible: () => false } });
    const ctx = setupEngine({ readinessQueue: Array.from({ length: 5 }, stuck), readTimeouts: () => ({ ...TIMEOUTS, agentReadySeconds: 0 }) });
    const created = ctx.runStore.create(validRun());
    const done = ctx.engine.start(created.id);
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(ctx.runStore.get(created.id).error).toMatch(/^pipeline run: settings timeouts\.agentReadySeconds/);
  });

  it('gives a terminal-owned workflow the current reset and final-signal timeouts before its pass', async () => {
    let observed;
    const calls = [];
    const sharedWorkflow = {
      readTimeoutsFrom(read) { calls.push(['readTimeoutsFrom', read()]); },
      start(args) {
        calls.push(['start']);
        queueMicrotask(() => observed({ status: 'complete', active: false, error: null, requestId: args.requestId, iteration: 1, limitReached: false }));
      },
      stop() {},
      snapshot: () => ({ status: 'stopped', active: false }),
    };
    const attachBackground = vi.fn(() => ({
      workflow: sharedWorkflow, write: () => {}, observe: (fn) => { observed = fn; }, release: () => {},
    }));
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      attachBackground,
      readTimeouts: () => ({ ...TIMEOUTS, resetSettleSeconds: 45, finalSignalIdleSeconds: 90 }),
    });
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(calls.slice(0, 2)).toEqual([['readTimeoutsFrom', { resetTimeoutMs: 45000, handoffIdleMs: 90000 }], ['start']]);
  });

  it('prefers attachment.workflow over createWorkflow so PTY-fed engines are used', async () => {
    let observed;
    const sharedWorkflow = {
      start(args) {
        queueMicrotask(() => {
          observed({
            status: 'complete',
            active: false,
            error: null,
            requestId: args.requestId,
            iteration: 1,
            limitReached: false,
          });
        });
      },
      stop() {},
      snapshot: () => ({ status: 'stopped', active: false }),
    };
    const createWorkflow = vi.fn();
    const attachBackground = vi.fn(() => ({
      workflow: sharedWorkflow,
      write: () => {},
      observe: (fn) => { observed = fn; },
      release: () => {},
    }));
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      attachBackground,
      createWorkflow,
    });
    const run = ctx.runStore.create(validRun());

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    expect(createWorkflow).not.toHaveBeenCalled();
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });
});

describe('createRunEngine Phase 3 (Spec §8.3, §8.5–§8.8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  async function driveReady(done, steps = 1) {
    for (let i = 0; i < steps; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await done;
  }

  async function advanceReadiness(steps = 1) {
    for (let i = 0; i < steps; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Flush workflow notify + transition microtasks after timers.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  function multiNodeDefinition(names = ['A', 'B', 'C']) {
    return definition({
      steps: names.map((name, index) => ({
        kind: index === 0 ? 'setup' : 'node',
        role: '',
        askOwner: false,
        readOnly: false,
        approval: false,
        name,
        prompt: `Prompt ${name}`,
        repeat: { mode: 'once' },
        // Each step has an agent of its own, so each works in its own terminal.
        agent: {
          id: `c410a1b2-3456-4789-8abc-def01234560${index}`,
          name: 'codex',
          launchCommand: 'codex',
          resetCommand: '/clear',
        },
      })),
    });
  }

  const quotaMessage = 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 118h12m56s.';
  function quotaFixture({ databasePath, mode, launchGate, readNote } = {}) {
    const team = { id: randomUUID(), name: 'Builders', revision: 1 };
    const assignment = { source: 'team', agentRevision: 1, teamId: team.id, teamRevision: 1 };
    const primary = { id: AGENT_ID, name: 'Primary', launchCommand: 'agy', resetCommand: '/clear', assignment };
    const backup = name => ({ id: randomUUID(), name, launchCommand: 'agy', resetCommand: '/clear', assignment: { ...assignment, source: 'fallback' } });
    const developer = backup('Developer backup');
    const reviewer = backup('Reviewer backup');
    const override = { ...backup('Owner choice'), assignment: { source: 'override', agentRevision: 1, teamId: null, teamRevision: null } };
    const steps = [
      { name: 'Develop', role: 'Developer', agent: { ...primary, fallbackAgent: developer }, approval: true, repeat: { mode: 'until_complete', max: 3 } },
      { name: 'Review', role: 'Reviewer', agent: { ...primary, fallbackAgent: reviewer }, repeat: { mode: 'loop_back', toStepIndex: 0, max: 3 } },
      { name: 'Ship', role: 'Release', agent: primary, repeat: { mode: 'once' } },
      { name: 'Report', role: 'Reporter', agent: { ...primary, assignment: override.assignment }, repeat: { mode: 'once' } },
    ].map(item => ({ ...definition().steps[0], ...item, approval: item.approval === true }));
    if (mode === 'absent') delete steps[0].agent.fallbackAgent;
    if (mode === 'self') steps[0].agent.fallbackAgent.id = primary.id;
    const screens = new Map();
    const quota = executionState({
      lines: ['⚠ Individual quota reached. Please upgrade your subscription to increase your',
        'limits. Resets in 118h12m56s.', 'Error ID: 05e31602-daa9-494e-8b02-31f32545a6d7-56', '>', '? for shortcuts   auto · Gemini 4 Hydrogen · medium'],
      profile: agy,
    });
    const terminals = [];
    const inputs = [];
    const ctx = setupEngine({
      databasePath,
      readExecutionState: vi.fn(async id => screens.get(id) ?? executionState()),
      attachBackground: vi.fn(id => ({ write: data => inputs.push([id, data]), release() {} })),
      createWorkflow: options => {
        const workflow = createTerminalWorkflow({ ...options, resetTimeoutMs: 15000, handoffIdleMs: 24000 });
        terminals.push(workflow);
        return workflow;
      },
      engineExtras: { listRunPlaces: launchGate, ...(readNote && { readNote, prepareNotes: vi.fn(async () => {}) }) },
    });
    const run = ctx.runStore.create(validRun({ definition: definition({
      steps, team: { name: team.name, changed: false },
      ...(readNote && { notesDir: '.codedeck/runs/aabbccdd' }),
    }) }), {
      team, mixed: false, workload: 'a'.repeat(64),
    });
    const audit = store => store.auditPage(run.id, { page: 0, size: 100, direction: 'asc', stepIndex: null }).data.filter(entry => entry.kind === 'quota_takeover');
    const refuse = (session = 'Demo-1') => screens.set(session, quota);
    const signal = (workflow, kind) => workflow.output('[[CDW:' + workflow.exportState().identifier + ':' + kind + ']]');
    const settleReset = async workflow => {
      await vi.advanceTimersByTimeAsync(1100);
      workflow.output('Ready for input');
      await vi.advanceTimersByTimeAsync(1100);
    };
    const prompts = id => inputs.filter(([session, data]) => session === id && data.includes('Iteration identifier:'));
    return { ...ctx, run, audit, developer, reviewer, override, refuse, settleReset, signal, terminals, prompts, screens };
  }

  it('restarts a settled quota refusal once, preserving a completed pass, attribution, and role-specific successors', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'quota-reopen-'));
    const databasePath = path.join(dir, 'run.db');
    try {
      let note = '# Baseline verified';
      const ctx = quotaFixture({ databasePath, readNote: async () => ({ status: 'present', content: note }) });
      const done = ctx.engine.start(ctx.run.id);
      await advanceReadiness();
      const first = ctx.terminals[0];
      ctx.signal(first, 'CONTINUE');
      await ctx.settleReset(first);
      expect(first.snapshot().iteration).toBe(2);
      const oldPassId = first.exportState().identifier;
      ctx.refuse();
      await vi.advanceTimersByTimeAsync(13000);
      expect(ctx.terminals).toHaveLength(2);
      const replacement = ctx.terminals[1];
      expect(replacement.snapshot().iteration).toBe(2);
      expect(replacement.exportState().request.maxIterations).toBe(3);
      expect(replacement.exportState().identifier).not.toBe(oldPassId);
      first.output('[[CDW:' + oldPassId + ':COMPLETE]]');
      await vi.advanceTimersByTimeAsync(3000);
      expect(ctx.runStore.get(ctx.run.id).status).toBe('running');
      expect(ctx.prompts('Demo-1')).toHaveLength(2);
      expect(ctx.prompts('Demo-2')).toHaveLength(1);
      note = '# Verification completed by the fallback';
      ctx.signal(replacement, 'COMPLETE');
      await done;
      const reopened = new Database(databasePath);
      try {
        const store = createRunStore(reopened);
        const stored = store.get(ctx.run.id);
        expect(stored.status).toBe('awaiting_approval');
        expect(stored.steps[0]).toMatchObject({ attempt: 2, iteration: 2, sessionId: 'Demo-2', priorSessionIds: ['Demo-1'], roundsCompleted: 0 });
        expect(stored.steps[0].elapsedMs).toBeGreaterThan(10000);
        expect(stored.definition.team.changed).toBe(true);
        expect(stored.definition.steps.map(item => item.agent.name)).toEqual(['Developer backup', 'Reviewer backup', 'Primary', 'Primary']);
        expect(store.attribution(stored.id)).toMatchObject({ mixed: true, attempts: [
          { attempt: 1, agentId: AGENT_ID, source: 'team' }, { attempt: 2, agentId: ctx.developer.id, source: 'fallback' },
        ] });
        const audit = ctx.audit(store);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ agentName: 'Primary', attempt: 1, pass: 2, sessionId: 'Demo-1' });
        expect(audit[0].detail).toContain('Develop');
        expect(audit[0].detail).toContain('Developer backup');
        expect(audit[0].detail).toContain(quotaMessage);
        const notes = createNoteStore(reopened);
        expect(notes.hasPass(stored.id, 0, 1, 1)).toBe(true);
        expect(notes.hasPass(stored.id, 0, 1, 2)).toBe(false);
        expect(notes.hasPass(stored.id, 0, 2, 2)).toBe(true);
        expect(notes.lastContent(stored.id, 0)).toBe(note);
      } finally {
        reopened.close();
      }
      await ctx.engine.approve(ctx.run.id);
      await advanceReadiness();
      ctx.signal(ctx.terminals[2], 'CONTINUE');
      await advanceReadiness();
      await ctx.settleReset(ctx.terminals[3]);
      expect(ctx.runStore.get(ctx.run.id).steps[1].roundsCompleted).toBe(1);
      expect(ctx.startSession).toHaveBeenCalledTimes(3);
      expect(ctx.prompts('Demo-2')).toHaveLength(2);
      await ctx.engine.stop(ctx.run.id);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each(['absent', 'self', 'exhausted successor', 'blocked later role'])('reports a recoverable quota error for %s', async mode => {
    const ctx = quotaFixture({ mode });
    const done = ctx.engine.start(ctx.run.id);
    await advanceReadiness();
    if (mode === 'absent') {
      const current = ctx.runStore.get(ctx.run.id);
      current.definition.steps[0].nextAgent = ctx.override;
      ctx.runStore.update(ctx.run.id, { definition: current.definition });
    }
    ctx.refuse();
    await vi.advanceTimersByTimeAsync(13000);
    if (mode === 'exhausted successor') {
      expect(ctx.terminals).toHaveLength(2);
      ctx.refuse('Demo-2');
      await vi.advanceTimersByTimeAsync(12000);
    }
    if (mode === 'blocked later role') {
      expect(ctx.terminals).toHaveLength(2);
      ctx.signal(ctx.terminals[1], 'COMPLETE');
      await done;
      await ctx.engine.approve(ctx.run.id);
      await advanceReadiness();
      ctx.signal(ctx.terminals[2], 'COMPLETE');
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.prompts('Demo-1')).toHaveLength(1);
      expect(ctx.startSession).toHaveBeenCalledTimes(3);
    }
    const stored = ctx.runStore.get(ctx.run.id);
    expect(stored.status).toBe('error');
    expect(stored.error).toContain(mode === 'blocked later role' ? 'during step Ship' : 'during step Develop');
    expect(stored.error).toContain(mode === 'exhausted successor' ? 'The agent Developer backup' : 'The agent Primary');
    expect(stored.error).toContain(quotaMessage);
    expect(stored.error).toContain('Change team, or Resume once the limit resets');
    expect(ctx.audit(ctx.runStore)).toHaveLength(['absent', 'self'].includes(mode) ? 0 : 1);
    if (mode === 'absent') expect(stored.definition.steps[0].nextAgent).toEqual(ctx.override);
    await done;
  });

  it('gives a queued owner override precedence at the eligible quota restart boundary', async () => {
    const ctx = quotaFixture();
    const done = ctx.engine.start(ctx.run.id);
    await advanceReadiness();
    const current = ctx.runStore.get(ctx.run.id);
    current.definition.steps[0].nextAgent = ctx.override;
    ctx.runStore.update(ctx.run.id, { definition: current.definition });
    ctx.refuse();
    await vi.advanceTimersByTimeAsync(13000);
    expect(ctx.runStore.get(ctx.run.id).definition.steps[0]).toMatchObject({ agent: ctx.override });
    expect(ctx.audit(ctx.runStore)[0].detail).toContain('Owner choice');
    expect(ctx.prompts('Demo-2')).toHaveLength(1);
    await ctx.engine.stop(ctx.run.id);
    await done;
  });

  it('carries an owner answer into a quota restart of the unfinished logical pass', async () => {
    const ctx = quotaFixture();
    const done = ctx.engine.start(ctx.run.id);
    await advanceReadiness();
    await vi.advanceTimersByTimeAsync(100);
    ctx.signal(ctx.terminals[0], 'NEEDS_INPUT');
    await vi.advanceTimersByTimeAsync(0);
    const answer = ctx.engine.answer(ctx.run.id, 'Keep the existing test data.');
    await vi.advanceTimersByTimeAsync(100);
    await answer;
    ctx.refuse();
    await vi.advanceTimersByTimeAsync(13000);
    expect(ctx.prompts('Demo-2')).toEqual([['Demo-2', expect.stringContaining('Keep the existing test data.')]]);
    expect(ctx.answerStore.list(ctx.run.id)).toHaveLength(1);
    await ctx.engine.stop(ctx.run.id);
    await done;
  });

  it('queues earlier role takeovers for reachable loop revisits and preserves a separate future choice', async () => {
    const ctx = quotaFixture();
    const done = ctx.engine.start(ctx.run.id);
    await advanceReadiness();
    ctx.signal(ctx.terminals[0], 'COMPLETE');
    await done;
    await ctx.engine.approve(ctx.run.id);
    await advanceReadiness();
    await ctx.settleReset(ctx.terminals[1]);
    const current = ctx.runStore.get(ctx.run.id);
    current.definition.steps[2].nextAgent = ctx.override;
    ctx.runStore.update(ctx.run.id, { definition: current.definition });
    ctx.refuse();
    await vi.advanceTimersByTimeAsync(13000);
    const restarted = ctx.runStore.get(ctx.run.id);
    expect(restarted.definition.steps[0]).toMatchObject({ agent: { id: AGENT_ID }, nextAgent: ctx.developer });
    expect(restarted.steps[0]).toMatchObject({ status: 'complete', sessionId: 'Demo-1' });
    expect(restarted.definition.steps[1].agent).toEqual(ctx.reviewer);
    expect(restarted.definition.steps[2].nextAgent).toEqual(ctx.override);
    expect(restarted.steps[2].quotaBlocked).toBeUndefined();
    ctx.signal(ctx.terminals[2], 'CONTINUE');
    await advanceReadiness();
    const revisited = ctx.runStore.get(ctx.run.id);
    expect(revisited.definition.steps[0].agent).toEqual(ctx.developer);
    expect(revisited.steps[0]).toMatchObject({ sessionId: 'Demo-3', priorSessionIds: ['Demo-1'], attempt: 2 });
    await ctx.engine.stop(ctx.run.id);
  });

  it.each(['stop', 'complete'])('lets %s win over the final refusal reading', async action => {
    const ctx = quotaFixture();
    const done = ctx.engine.start(ctx.run.id);
    await advanceReadiness();
    ctx.refuse();
    await vi.advanceTimersByTimeAsync(8500);
    expect(ctx.runStore.get(ctx.run.id).status).toBe('running');
    if (action === 'stop') await ctx.engine.stop(ctx.run.id);
    else ctx.signal(ctx.terminals[0], 'COMPLETE');
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(ctx.runStore.get(ctx.run.id).status).toBe(action === 'stop' ? 'stopped' : 'awaiting_approval');
    expect(ctx.audit(ctx.runStore)).toHaveLength(0);
    expect(ctx.startSession).toHaveBeenCalledTimes(1);
  });

  it('fails a settled quota refusal on a legacy run with no fallback', async () => {
    const screens = new Map();
    const ctx = setupEngine({
      readExecutionState: async id => screens.get(id) ?? executionState(),
      createWorkflow: options => createTerminalWorkflow({ ...options, resetTimeoutMs: 15000, handoffIdleMs: 24000 }),
    });
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await advanceReadiness();
    screens.set('Demo-1', executionState({
      lines: ['Refusal', '>'],
      profile: { promptVisible: () => true, usageLimit: () => quotaMessage },
    }));
    await vi.advanceTimersByTimeAsync(13000);
    expect(ctx.runStore.get(run.id)).toMatchObject({
      status: 'error', error: expect.stringContaining('codex reached its usage limit during step Develop'),
    });
    await done;
  });

  it('resumes the persisted quota restart after interruption before the successor launches', async () => {
    let releaseLaunch;
    const awaitingLaunch = new Promise(resolve => { releaseLaunch = resolve; });
    const listRunPlaces = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => awaitingLaunch);
    const ctx = quotaFixture({ launchGate: listRunPlaces });
    const done = ctx.engine.start(ctx.run.id);
    await advanceReadiness();
    ctx.signal(ctx.terminals[0], 'CONTINUE');
    await ctx.settleReset(ctx.terminals[0]);
    ctx.refuse();
    await vi.advanceTimersByTimeAsync(13000);
    expect(listRunPlaces).toHaveBeenCalledTimes(2);
    const stored = ctx.runStore.get(ctx.run.id);
    expect(stored.steps[0]).toMatchObject({ attempt: 2, iteration: 1, status: 'launching', priorSessionIds: ['Demo-1'] });
    expect(stored.workflowState).toBeNull();
    expect(await ctx.engine.reconcileOnStartup()).toEqual({ reattached: [], interrupted: [ctx.run.id] });
    releaseLaunch();
    await done;
    await ctx.engine.resume(ctx.run.id);
    await advanceReadiness();
    expect(ctx.terminals[1].snapshot().iteration).toBe(2);
    expect(ctx.runStore.get(ctx.run.id).steps[0].attempt).toBe(2);
    expect(ctx.audit(ctx.runStore)).toHaveLength(1);
    expect(ctx.prompts('Demo-2')).toHaveLength(1);
    await ctx.engine.stop(ctx.run.id);
  });

  describe.each(quotaScreens)('$profile.id quota monitoring', fixture => {
    const { command, profile, refusal, idle } = fixture;
    function screenState(lines, subagentPanes = []) {
      const state = classifyTerminalExecution({
        paneCurrentCommand: command, paneDead: '0', snapshotText: lines.join('\n'),
        subagentPanes, quietSeconds: 10,
      });
      return executionState({ ...state, lines, profile: findAgentProfileById(state.agentCli) });
    }

    it.each(['takeover', 'absent'])('settles exactly one quota outcome with %s', async mode => {
      const ctx = quotaFixture({ mode });
      const done = ctx.engine.start(ctx.run.id);
      await advanceReadiness();
      expect(ctx.prompts('Demo-1')).toHaveLength(1);

      const refused = screenState([...refusal, ...idle]);
      expect(refused.profile).toBe(profile);
      ctx.screens.set('Demo-1', refused);
      await vi.advanceTimersByTimeAsync(13000);
      try {
        const stored = ctx.runStore.get(ctx.run.id);
        if (mode === 'takeover') {
          expect(stored.steps[0]).toMatchObject({ attempt: 2, sessionId: 'Demo-2', priorSessionIds: ['Demo-1'] });
          expect(ctx.prompts('Demo-2')).toHaveLength(1);
          expect(ctx.audit(ctx.runStore)).toHaveLength(1);
        } else {
          expect(stored.status).toBe('error');
          expect(stored.error).toMatch(/The agent Primary reached its usage limit during step Develop/);
          expect(ctx.startSession).toHaveBeenCalledTimes(1);
          expect(ctx.audit(ctx.runStore)).toHaveLength(0);
        }
      } finally {
        if (ctx.runStore.get(ctx.run.id).status === 'running') await ctx.engine.stop(ctx.run.id);
        await done;
      }
    });

    it('keeps monitoring every ambiguous or busy screen and a pre-dispatch refusal', async () => {
      const ctx = quotaFixture();
      ctx.screens.set('Demo-1', screenState([...refusal, ...idle]));
      const done = ctx.engine.start(ctx.run.id);
      try {
        await vi.advanceTimersByTimeAsync(13000);
        expect(ctx.prompts('Demo-1')).toHaveLength(1);
        expect(ctx.audit(ctx.runStore)).toHaveLength(0);
        const delegated = screenState([...refusal, ...idle], [{
          paneCurrentCommand: 'codex',
          paneDead: '0',
          snapshotText: '• Working (27s • esc to interrupt)\n› Ask Codex to do anything',
        }]);
        expect(delegated.executionReason).toBe('agent_delegated');
        ctx.screens.set('Demo-1', delegated);
        await vi.advanceTimersByTimeAsync(5000);
        expect(ctx.audit(ctx.runStore)).toHaveLength(0);
        for (const [kind, lines] of Object.entries(quotaNegatives(fixture))) {
          ctx.screens.set('Demo-1', screenState(lines));
          await vi.advanceTimersByTimeAsync(5000);
          expect(ctx.runStore.get(ctx.run.id).status, kind).toBe('running');
          expect(ctx.audit(ctx.runStore), kind).toHaveLength(0);
          expect(ctx.startSession, kind).toHaveBeenCalledTimes(1);
        }
      } finally {
        await ctx.engine.stop(ctx.run.id);
        await done;
      }
    });
  });

  it('ignores an unchanged Antigravity quota screen present before dispatch', async () => {
    const ctx = quotaFixture();
    ctx.refuse();
    const done = ctx.engine.start(ctx.run.id);
    await vi.advanceTimersByTimeAsync(13000);
    expect(ctx.runStore.get(ctx.run.id).status).toBe('running');
    expect(ctx.audit(ctx.runStore)).toHaveLength(0);
    expect(ctx.startSession).toHaveBeenCalledTimes(1);
    await ctx.engine.stop(ctx.run.id);
    await done;
  });

  it('keeps an answered pass on its original terminal, then dispatches the next pass to the queued agent', async () => {
    const terminals = [];
    const inputs = [];
    const replacement = { id: randomUUID(), name: 'Replacement', launchCommand: 'codex --model replacement', resetCommand: '/new' };
    const def = definition();
    def.steps[0].repeat = { mode: 'until_complete', max: 2 };
    const team = { id: randomUUID(), name: 'Builders', revision: 1 };
    def.steps[0].role = 'Developer';
    def.steps[0].agent.assignment = { agentRevision: 1, source: 'team', teamId: team.id, teamRevision: 1 };
    replacement.assignment = { agentRevision: 2, source: 'override', teamId: null, teamRevision: null };
    const ctx = setupEngine({
      attachBackground: vi.fn(sessionId => ({ write: data => inputs.push([sessionId, data]), release() {} })),
      createWorkflow: options => {
        const workflow = createTerminalWorkflow({ ...options, resetTimeoutMs: 15000, handoffIdleMs: 24000 });
        terminals.push(workflow);
        return workflow;
      },
    });
    const run = ctx.runStore.create(validRun({ definition: def }), { team, workload: 'a'.repeat(64), mixed: false });
    const done = ctx.engine.start(run.id);
    await advanceReadiness();
    const active = ctx.runStore.get(run.id);
    expect(active.steps[0].sessionId).toBe('Demo-1');
    ctx.runStore.update(run.id, { definition: { ...def, steps: [{ ...def.steps[0], nextAgent: replacement }] } });
    const old = terminals[0];
    old.output('[[CDW:' + old.exportState().identifier + ':NEEDS_INPUT]]');
    await vi.advanceTimersByTimeAsync(0);
    const answer = ctx.engine.answer(run.id, 'Use the example.');
    await vi.advanceTimersByTimeAsync(100);
    await answer;
    expect(inputs).toEqual(expect.arrayContaining([['Demo-1', expect.stringContaining('Use the example.')]]));
    expect(terminals).toHaveLength(1);
    old.output('[[CDW:' + old.exportState().identifier + ':CONTINUE]]');
    await vi.advanceTimersByTimeAsync(3300);
    expect(inputs).toContainEqual(['Demo-2', 'codex --model replacement']);
    expect(inputs.filter(([id, data]) => id === 'Demo-1' && data.includes('Iteration identifier:'))).toHaveLength(1);
    expect(terminals[1].snapshot().iteration).toBe(2);
    expect(inputs).toContainEqual(['Demo-2', expect.stringContaining('Use the example.')]);
    terminals[1].output('[[CDW:' + terminals[1].exportState().identifier + ':COMPLETE]]');
    await done;
    expect(ctx.runStore.get(run.id).steps[0]).toMatchObject({ status: 'complete', sessionId: 'Demo-2', priorSessionIds: ['Demo-1'], attempt: 2 });
    expect(ctx.runStore.attribution(run.id).attempts).toMatchObject([
      { attempt: 1, source: 'team', agentRevision: 1, agentId: AGENT_ID },
      { attempt: 2, source: 'override', agentRevision: 2, agentId: replacement.id },
    ]);
  });

  it.each([
    ['awaiting_approval', 'awaiting_approval', 'sendBack'],
    ['stopped', 'stopped', 'resume'],
    ['limit_paused', 'limit_reached', 'continue'],
  ])('uses a fresh terminal for a queued agent on %s + %s + %s', async (status, stepStatus, action) => {
    const def = definition();
    def.steps[0].approval = status === 'awaiting_approval';
    def.steps[0].repeat = { mode: 'until_complete', max: 2 };
    const replacement = { id: randomUUID(), name: 'Replacement', launchCommand: 'codex --model trial', resetCommand: '/new' };
    def.steps[0].nextAgent = replacement;
    const ctx = setupEngine();
    const stopped = status === 'stopped';
    const run = ctx.runStore.create(validRun({ definition: def, status, stopReason: stopped ? 'user' : null,
      worktreeState: 'present', finishedAt: stopped ? new Date().toISOString() : null,
      steps: [step({ status: stepStatus, sessionId: 'Demo-9', attempt: 1, iteration: 1 })] }));
    await ctx.engine[action](run.id, action === 'continue' ? undefined : 'Include the missing evidence.');
    await advanceReadiness();

    const finished = ctx.runStore.get(run.id);
    expect(finished.definition.steps[0].agent.name).toBe(replacement.name);
    expect(finished.steps[0]).toMatchObject({ sessionId: 'Demo-1', priorSessionIds: ['Demo-9'], attempt: 2 });
    expect(ctx.writes).toContain(replacement.launchCommand);
    expect(ctx.attachBackground).toHaveBeenCalledTimes(1);
    if (action === 'sendBack') {
      expect(ctx.reviewStore.list(run.id)).toMatchObject([{ attempt: 1, verdict: 'sent_back', comment: 'Include the missing evidence.' }]);
      expect(ctx.getWorkflowStartArgs().ownerContext).toContain('Include the missing evidence.');
    }
  });

  it('does not restore an archived future terminal when dispatch finishes after an override', async () => {
    let launch;
    const startSession = vi.fn(() => new Promise(resolve => { launch = resolve; }));
    const ctx = setupEngine({ startSession });
    const def = multiNodeDefinition(['Setup', 'Verify']);
    const run = ctx.runStore.create(validRun({ definition: def, steps: [step(), step({ sessionId: 'Demo-9' })] }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(startSession).toHaveBeenCalledTimes(1);
    const active = ctx.runStore.get(run.id);
    const replacement = { ...def.steps[1].agent, id: randomUUID(), name: 'Replacement' };
    ctx.runStore.update(run.id, {
      definition: { ...def, steps: [def.steps[0], { ...def.steps[1], agent: replacement }] },
      steps: [active.steps[0], { ...active.steps[1], sessionId: null, priorSessionIds: ['Demo-9'] }],
    }, { expectedUpdatedAt: active.updatedAt });
    launch('Demo-1');
    await vi.advanceTimersByTimeAsync(1100);
    const dispatched = ctx.runStore.get(run.id);
    expect(dispatched.definition.steps[1].agent).toEqual(replacement);
    expect(dispatched.steps[1]).toMatchObject({ sessionId: null, priorSessionIds: ['Demo-9'] });
    expect(ctx.runStore.update(run.id, { steps: active.steps }, { expectedUpdatedAt: active.updatedAt })).toBeNull();
    expect(startSession).toHaveBeenCalledTimes(2);
    launch('Demo-2');
    await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(ctx.runStore.get(run.id).steps[1]).toMatchObject({ sessionId: 'Demo-2', priorSessionIds: ['Demo-9'] });
  });

  it('advances through three steps with a new terminal each when each has its own agent', async () => {
    const ctx = setupEngine({ readinessQueue: [executionState(), executionState(), executionState()] });
    const def = multiNodeDefinition();
    const run = ctx.runStore.create(validRun({ definition: def }));

    const done = ctx.engine.start(run.id);
    await driveReady(done, 3);

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('complete');
    expect(finished.steps.map(s => s.status)).toEqual(['complete', 'complete', 'complete']);
    expect(finished.steps.map(s => s.sessionId)).toEqual(['Demo-1', 'Demo-2', 'Demo-3']);
    expect(ctx.startSession).toHaveBeenCalledTimes(3);
    expect(ctx.releases).toEqual([true, true, true]);
    expect(ctx.removeWorktree).toHaveBeenCalled();
  });

  it('maps once + limitReached to step complete (advance)', async () => {
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: vi.fn(({ notify }) => ({
        start(args) {
          queueMicrotask(() => {
            notify({
              status: 'stopped',
              active: false,
              error: null,
              requestId: args.requestId,
              iteration: 1,
              limitReached: true,
            });
          });
        },
        stop() {},
        snapshot: () => ({ status: 'stopped', limitReached: true }),
      })),
    });
    const run = ctx.runStore.create(validRun());

    await driveReady(ctx.engine.start(run.id));

    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(ctx.runStore.get(run.id).steps[0].status).toBe('complete');
  });

  it('pauses at pass limit for until_complete, then Continue advances or completes', async () => {
    const outcomes = ['limit', 'complete'];
    const ctx = setupEngine({
      readinessQueue: [executionState(), executionState()],
      createWorkflow: vi.fn(({ notify }) => ({
        start(args) {
          const outcome = outcomes.shift();
          queueMicrotask(() => {
            if (outcome === 'limit') {
              notify({
                status: 'stopped',
                active: false,
                error: null,
                requestId: args.requestId,
                iteration: 2,
                limitReached: true,
              });
            } else {
              notify({
                status: 'complete',
                active: false,
                error: null,
                requestId: args.requestId,
                iteration: 1,
                limitReached: false,
              });
            }
          });
        },
        stop() {},
        snapshot: () => ({ status: 'stopped' }),
      })),
    });
    const def = definition({
      steps: [
        {
          kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
          name: 'Develop',
          prompt: 'do it',
          repeat: { mode: 'until_complete', max: 2 },
          agent: {
            id: AGENT_ID,
            name: 'codex',
            launchCommand: 'codex',
            resetCommand: '/clear',
          },
        },
        {
          kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
          name: 'Review',
          prompt: 'review it',
          repeat: { mode: 'once' },
          agent: {
            id: AGENT_ID,
            name: 'codex',
            launchCommand: 'codex',
            resetCommand: '/clear',
          },
        },
      ],
    });
    const run = ctx.runStore.create(validRun({ definition: def }));

    await driveReady(ctx.engine.start(run.id));
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');
    expect(ctx.runStore.get(run.id).steps[0].status).toBe('limit_reached');

    const acknowledged = await ctx.engine.continue(run.id);
    expect(acknowledged.status).toBe('running');
    expect(acknowledged.currentStepIndex).toBe(0);
    expect(acknowledged.steps[0].extraRounds).toBe(1);
    await advanceReadiness(2);
    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('complete');
    expect(finished.currentStepIndex).toBe(1);
    expect(finished.steps.map(step => step.status)).toEqual(['complete', 'complete']);
    expect(finished.steps[0].extraRounds).toBe(1);
  });

  it('Continue on the last limit_paused step grants one more pass instead of completing', async () => {
    const starts = [];
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: vi.fn(({ notify }) => ({
        start(args) {
          starts.push(args);
          queueMicrotask(() => {
            notify({
              status: 'stopped',
              active: false,
              error: null,
              requestId: args.requestId,
              iteration: 3,
              limitReached: true,
            });
          });
        },
        stop() {},
        snapshot: () => ({ status: 'stopped', limitReached: true }),
      })),
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({
        steps: [{
          kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
          name: 'Develop',
          prompt: 'do it',
          repeat: { mode: 'until_complete', max: 3 },
          agent: {
            id: AGENT_ID,
            name: 'codex',
            launchCommand: 'codex',
            resetCommand: '/clear',
          },
        }],
      }),
    }));

    await driveReady(ctx.engine.start(run.id));
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');

    const acknowledged = await ctx.engine.continue(run.id, { stepIndex: 0, roundsCompleted: 0, extraRounds: 0 });
    expect(acknowledged.status).toBe('running');
    expect(acknowledged.steps[0]).toMatchObject({ status: 'launching', extraRounds: 1 });
    await advanceReadiness(1);
    const paused = ctx.runStore.get(run.id);
    expect(paused.status).toBe('limit_paused');
    expect(paused.steps[0]).toMatchObject({ status: 'limit_reached', extraRounds: 1, roundsCompleted: 0 });
    // Exactly one more pass: the granted attempt starts after the three passes already run.
    expect(starts.at(-1)).toMatchObject({ maxIterations: 4, startAfterPass: 3 });
    // A stale click from the first pause cannot spend the second pause's grant.
    await expect(ctx.engine.continue(run.id, { stepIndex: 0, roundsCompleted: 0, extraRounds: 0 })).rejects.toThrow(/pause|current/i);
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');
    // A pass limit cannot be raised past the hundred passes a workflow may run.
    const full = ctx.runStore.get(run.id);
    ctx.runStore.update(run.id, { steps: [{ ...full.steps[0], extraRounds: 97 }] });
    await expect(ctx.engine.continue(run.id)).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');
  });

  it('refuses a loop_back grant once the allowance reaches one hundred extra rounds', async () => {
    const ctx = setupEngine();
    const agent = { id: AGENT_ID, name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };
    const def = definition({
      steps: [
        { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Develop', prompt: 'do it', repeat: { mode: 'once' }, agent },
        { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Test', prompt: 'do it', repeat: { mode: 'loop_back', toStepIndex: 0, max: 8 }, agent },
      ],
    });
    const run = ctx.runStore.create(validRun({
      definition: def,
      status: 'limit_paused',
      currentStepIndex: 1,
      steps: [
        step({ status: 'complete', sessionId: 'Demo-1', attempt: 1, iteration: 1 }),
        step({ status: 'limit_reached', sessionId: 'Demo-2', attempt: 8, iteration: 8, roundsCompleted: 8, extraRounds: 100 }),
      ],
    }));
    await expect(ctx.engine.continue(run.id)).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
    await expect(ctx.engine.continue(run.id, { stepIndex: 1, roundsCompleted: 8, extraRounds: 100 })).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');
  });

  it('Stop while running sets stop_reason=user', async () => {
    let resolveNotify;
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: vi.fn(({ notify }) => ({
        start() {
          resolveNotify = () => notify({
            status: 'running',
            active: true,
            error: null,
            requestId: 'x',
            iteration: 0,
            limitReached: false,
          });
        },
        stop() {
          queueMicrotask(() => {
            notify({
              status: 'stopped',
              active: false,
              error: null,
              requestId: 'x',
              iteration: 0,
              limitReached: false,
            });
          });
        },
        snapshot: () => ({ status: 'running' }),
      })),
    });
    const run = ctx.runStore.create(validRun());
    const started = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    resolveNotify?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.runStore.get(run.id).status).toBe('running');

    await ctx.engine.stop(run.id);
    await started;

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('stopped');
    expect(ctx.setTerminalMuted).toHaveBeenCalledWith('Demo-1', true);
    expect(finished.stopReason).toBe('user');
  });

  it('unsolicited loop stopped → stop_reason=terminal', async () => {
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: vi.fn(({ notify }) => ({
        start(args) {
          queueMicrotask(() => {
            notify({
              status: 'stopped',
              active: false,
              error: null,
              requestId: args.requestId,
              iteration: 0,
              limitReached: false,
            });
          });
        },
        stop() {},
        snapshot: () => ({ status: 'stopped' }),
      })),
    });
    const run = ctx.runStore.create(validRun());
    await driveReady(ctx.engine.start(run.id));
    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('stopped');
    expect(finished.stopReason).toBe('terminal');
  });

  describe('a run in a task with several repositories', () => {
    const places = (worktreePath) => ({
      current: 'mobile-app',
      worktrees: [{ repository: 'mobile-app', path: worktreePath }, { repository: 'backend', path: '/group/worktrees/replies/backend' }],
      readOnly: [{ repository: 'frontend', path: '/group/frontend' }],
    });

    it('tells a step where it may work and read, as it is when the step starts, and writes it into the run notes', async () => {
      const prepareNotes = vi.fn(async () => {});
      const listRunPlaces = vi.fn(async run => places(run.worktreePath));
      const ctx = setupEngine({ engineExtras: { prepareNotes, readNote: vi.fn(async () => ({ status: 'present', content: '# Done' })), listRunPlaces } });
      const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
      const done = ctx.engine.start(run.id);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      expect(listRunPlaces).toHaveBeenCalledWith(expect.objectContaining({ id: run.id, worktreePath: run.worktreePath }), { includeGit: false });
      const guidance = ctx.getWorkflowStartArgs().guidance;
      expect(guidance).toContain(`Work only inside this task's worktrees: mobile-app at ${run.worktreePath}, backend at /group/worktrees/replies/backend. Your current directory is the mobile-app one.`);
      expect(guidance).toContain('These repositories of the project are not part of this task: frontend at /group/frontend.');
      expect(prepareNotes).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: run.worktreePath, places: places(run.worktreePath) }));
    });

    it('fails the run when Setup left any worktree of the task with uncommitted changes, and names the repository', async () => {
      const listDirtyPaths = vi.fn(async ({ worktreePath }) => (worktreePath === '/group/worktrees/replies/backend' ? ['tmp.out'] : []));
      const ctx = setupEngine({ readinessQueue: [executionState()], listDirtyPaths, engineExtras: { listRunPlaces: async run => places(run.worktreePath) } });
      const run = ctx.runStore.create(validRun({
        definition: definition({
          steps: [{ kind: 'setup', role: '', askOwner: false, readOnly: false, approval: false, name: 'Setup', prompt: 'setup', repeat: { mode: 'until_complete', max: 3 },
            agent: { id: AGENT_ID, name: 'haiku', launchCommand: 'claude', resetCommand: '/clear' } }],
        }),
      }));
      await driveReady(ctx.engine.start(run.id));
      const finished = ctx.runStore.get(run.id);
      expect(finished.status).toBe('error');
      expect(finished.error).toBe('Setup left uncommitted changes in the worktree of backend\ntmp.out');
      expect(listDirtyPaths.mock.calls.map(([options]) => options.worktreePath)).toEqual([run.worktreePath, '/group/worktrees/replies/backend']);
    });

    it('fails the run when it cannot be told where it may work', async () => {
      const ctx = setupEngine({ engineExtras: { listRunPlaces: async () => { throw new Error('Project Demo of this run no longer exists'); } } });
      const run = ctx.runStore.create(validRun());
      await driveReady(ctx.engine.start(run.id));
      expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error', error: 'Project Demo of this run no longer exists' });
    });
  });

  it('Setup leaving dirty paths errors the run', async () => {
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      listDirtyPaths: vi.fn(async () => ['node_modules/.cache', 'tmp.out']),
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({
        steps: [{
          kind: 'setup', role: '', askOwner: false, readOnly: false, approval: false,
          name: 'Setup',
          prompt: 'setup',
          repeat: { mode: 'until_complete', max: 3 },
          agent: {
            id: AGENT_ID,
            name: 'haiku',
            launchCommand: 'claude',
            resetCommand: '/clear',
          },
        }],
      }),
    }));

    await driveReady(ctx.engine.start(run.id));
    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toMatch(/Setup left uncommitted changes/);
    expect(finished.error).toContain('node_modules/.cache');
    expect(finished.error).toContain('tmp.out');
  });

  function interruptedRun(ctx, stepOverrides = {}, runOverrides = {}) {
    const created = ctx.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT, ...runOverrides }));
    ctx.runStore.update(created.id, {
      status: 'interrupted',
      steps: [step({
        status: 'interrupted',
        sessionId: 'Demo-9',
        priorSessionIds: [],
        attempt: 1,
        ...stepOverrides,
      })],
    });
    return created;
  }

  it('Resume returns the step to its own terminal, clears the agent there and sends the prompt again', async () => {
    const ctx = setupEngine({ readinessQueue: [executionState()] });
    const created = interruptedRun(ctx);

    const acknowledged = await ctx.engine.resume(created.id);
    expect(acknowledged.status).toBe('running');
    expect(acknowledged.steps[0]).toMatchObject({ sessionId: 'Demo-9', priorSessionIds: [], attempt: 2 });
    await advanceReadiness(1);

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('complete');
    expect(finished.steps[0]).toMatchObject({ sessionId: 'Demo-9', priorSessionIds: [], attempt: 2 });
    expect(ctx.terminalAvailable).toHaveBeenCalledWith('Demo-9');
    expect(ctx.startSession).not.toHaveBeenCalled();
    expect(ctx.attachBackground).toHaveBeenCalledWith('Demo-9', { cwd: created.worktreePath });
    // The agent is still running there: nothing is launched, and its context is cleared first.
    expect(ctx.writes).not.toContain('codex');
    expect(ctx.getWorkflowStartArgs()).toMatchObject({
      command: 'Implement ship it',
      resetCommand: '/clear',
      resetFirst: true,
    });
  });

  it('Resume opens a new terminal when the terminal of the step is gone', async () => {
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      terminalAvailable: vi.fn(() => false),
    });
    const created = interruptedRun(ctx);

    const acknowledged = await ctx.engine.resume(created.id);
    expect(acknowledged.steps[0]).toMatchObject({ sessionId: null, priorSessionIds: ['Demo-9'], attempt: 2 });
    await advanceReadiness(1);

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('complete');
    expect(finished.steps[0]).toMatchObject({ sessionId: 'Demo-1', priorSessionIds: ['Demo-9'], attempt: 2 });
    expect(ctx.writes).toContain('codex');
    expect(ctx.getWorkflowStartArgs().resetFirst).toBe(false);
    // A terminal that is gone is not asked what it shows.
    expect(ctx.readExecutionState).not.toHaveBeenCalledWith('Demo-9');
  });

  it('resends the recorded multiline prompt and regenerates the brief with the original input on Resume', async () => {
    const prepareNotes = vi.fn(async () => {});
    const ctx = setupEngine({ engineExtras: { prepareNotes } });
    const input = 'First paragraph\n\n```md\n{input}\n```\nLast paragraph.  \n';
    const command = `Implement ${input}`;
    const snapshot = definition({ inputMode: 'descriptive', notesDir: '.codedeck/runs/abcdef12' });
    snapshot.steps[0].prompt = command;
    const run = interruptedRun(ctx, {}, { input, definition: snapshot });

    await ctx.engine.resume(run.id);
    await advanceReadiness(1);

    expect(prepareNotes).toHaveBeenCalledWith(expect.objectContaining({ input, definition: snapshot }));
    expect(ctx.writeBrief).toHaveBeenCalledWith(expect.objectContaining({ input, definition: snapshot }));
    expect(ctx.getWorkflowStartArgs()).toMatchObject({ command, resetFirst: true });
  });

  it('Resume starts the agent again in the terminal of the step when it has exited there', async () => {
    const ctx = setupEngine({
      readinessQueue: [executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh' }), executionState()],
    });
    const created = interruptedRun(ctx);

    const acknowledged = await ctx.engine.resume(created.id);
    expect(acknowledged.steps[0]).toMatchObject({ sessionId: 'Demo-9', priorSessionIds: [] });
    await advanceReadiness(2);

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('complete');
    expect(finished.steps[0]).toMatchObject({ sessionId: 'Demo-9', priorSessionIds: [] });
    expect(ctx.startSession).not.toHaveBeenCalled();
    // The launch command and its Enter are typed into the same terminal; a new agent has nothing to clear.
    expect(ctx.writes.slice(0, 2)).toEqual(['codex', '\r']);
    expect(ctx.getWorkflowStartArgs().resetFirst).toBe(false);
  });

  it('Resume fails the run when the agent started again in the terminal exits too', async () => {
    const exited = executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', lines: ['me@host demo %'] });
    // The shell echoed the launch command, then the agent exited.
    const exitedAgain = executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', lines: ['me@host demo % codex', 'me@host demo %'] });
    const ctx = setupEngine({ readinessQueue: [exited, exitedAgain] });
    const created = interruptedRun(ctx);

    await ctx.engine.resume(created.id);
    await advanceReadiness(2);

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toBe('The launch command for agent codex exited.');
    expect(ctx.writes.filter(data => data === 'codex')).toHaveLength(1);
  });

  it.each([
    ['bash', '/bin/bash: line 1: codex: command not found'],
    ['bash interactive', 'bash: codex: command not found'],
    ['zsh', 'zsh: command not found: codex'],
  ])('says the CLI is not installed when the %s shell cannot find the launch command', async (_shell, notFound) => {
    const exited = executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', lines: ['me@host demo %'] });
    const exitedAgain = executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', lines: ['me@host demo % codex', notFound, 'me@host demo %'] });
    const ctx = setupEngine({ readinessQueue: [exited, exitedAgain] });
    const created = interruptedRun(ctx);

    await ctx.engine.resume(created.id);
    await advanceReadiness(2);

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toBe('The launch command for agent codex exited: the shell could not find codex, so it is not installed on the machine this run works on, or not on its PATH. Install it there or choose another agent, then Resume.');
  });

  it('does not blame a missing CLI that an earlier launch reported, when the latest launch exited for another reason', async () => {
    const exited = executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', lines: ['me@host demo % codex', 'zsh: command not found: codex', 'me@host demo %'] });
    const exitedAgain = executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', lines: ['me@host demo % codex', 'zsh: command not found: codex', 'me@host demo % codex', 'error: model not supported', 'me@host demo %'] });
    const ctx = setupEngine({ readinessQueue: [exited, exitedAgain] });
    const created = interruptedRun(ctx);

    await ctx.engine.resume(created.id);
    await advanceReadiness(2);

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toBe('The launch command for agent codex exited.');
  });

  describe('a terminal that is no longer in the run\'s worktree', () => {
    it('opens a new terminal in the worktree instead of returning to it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const terminalInFolder = vi.fn(async (sessionId) => sessionId !== 'Demo-9');
      const ctx = setupEngine({ readinessQueue: [executionState()], engineExtras: { terminalInFolder } });
      const created = interruptedRun(ctx);
      try {
        await ctx.engine.resume(created.id);
        await advanceReadiness(2);
        expect(terminalInFolder).toHaveBeenCalledWith('Demo-9', '/tmp/worktrees/home-feature-abcd1234', 'local');
        expect(ctx.startSession).toHaveBeenCalledWith({ project: 'Demo', host:'local', cwd: '/tmp/worktrees/home-feature-abcd1234' });
        const finished = ctx.runStore.get(created.id);
        expect(finished.status).toBe('complete');
        expect(finished.steps[0]).toMatchObject({ sessionId: 'Demo-1', priorSessionIds: ['Demo-9'] });
        expect(ctx.attachBackground).not.toHaveBeenCalledWith('Demo-9', expect.anything());
        expect(warn.mock.calls.flat().join('\n')).toContain('Demo-9 is not in /tmp/worktrees/home-feature-abcd1234');
      } finally {
        warn.mockRestore();
      }
    });

    it('does not lend another step\'s terminal that has left the worktree', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const terminalInFolder = vi.fn(async () => false);
      const def = definition({ steps: [definition().steps[0], { ...definition().steps[0], name: 'Review' }] });
      const ctx = setupEngine({ engineExtras: { terminalInFolder } });
      const created = ctx.runStore.create(validRun({ definition: def, worktreeState: 'present', baseCommit: BASE_COMMIT }));
      ctx.runStore.update(created.id, {
        status: 'interrupted', currentStepIndex: 1,
        steps: [step({ status: 'complete', sessionId: 'Demo-7', attempt: 1, iteration: 1 }), step({ status: 'interrupted', sessionId: null, attempt: 1 })],
      });
      try {
        await ctx.engine.resume(created.id);
        await advanceReadiness(2);
        expect(terminalInFolder).toHaveBeenCalledWith('Demo-7', '/tmp/worktrees/home-feature-abcd1234', 'local');
        const finished = ctx.runStore.get(created.id);
        expect(finished.steps[1].sessionId).not.toBe('Demo-7');
        expect(finished.steps[1].priorSessionIds).toEqual([]);
        expect(ctx.startSession).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('a launch command that never reaches the terminal', () => {
    const PROMPT = ['me@host demo %'];
    const shellAt = lines => executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', profile: null, lines });

    it('types the command into the terminal directly once the screen has stayed unchanged, and carries on', async () => {
      const typeIntoTerminal = vi.fn(async () => {});
      const inspectTerminal = vi.fn(async () => ({ paneInMode: false, wsAttached: true }));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = setupEngine({
        readinessQueue: [shellAt(PROMPT), shellAt(PROMPT), shellAt(PROMPT), shellAt(PROMPT), executionState()],
        engineExtras: { typeIntoTerminal, inspectTerminal },
      });
      const created = interruptedRun(ctx);
      try {
        await ctx.engine.resume(created.id);
        await advanceReadiness(2);
        expect(typeIntoTerminal).not.toHaveBeenCalled();
        await advanceReadiness(2);
        expect(typeIntoTerminal).toHaveBeenCalledWith('Demo-9', 'codex');
        expect(inspectTerminal).toHaveBeenCalledWith('Demo-9');
        expect(warn.mock.calls.flat().join('\n')).toContain('did not reach Demo-9');
        expect(warn.mock.calls.flat().join('\n')).toContain('"wsAttached":true');
        await advanceReadiness(1);

        const finished = ctx.runStore.get(created.id);
        expect(finished.status).toBe('complete');
        // Only the first launch went through the attachment.
        expect(ctx.writes.filter(data => data === 'codex')).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('fails the run, saying so, when the command typed directly does not arrive either', async () => {
      const typeIntoTerminal = vi.fn(async () => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = setupEngine({
        readinessQueue: Array.from({ length: 12 }, () => shellAt(PROMPT)),
        engineExtras: { typeIntoTerminal },
      });
      const created = interruptedRun(ctx);
      try {
        await ctx.engine.resume(created.id);
        await advanceReadiness(8);
        const finished = ctx.runStore.get(created.id);
        expect(typeIntoTerminal).toHaveBeenCalledTimes(1);
        expect(finished.status).toBe('error');
        expect(finished.error).toBe('The launch command for agent codex never reached its terminal Demo-9, also when typed into it directly. Check the terminal, then Resume.');
      } finally {
        warn.mockRestore();
      }
    });

    it('also notices it in a new terminal, where the command is nowhere on the screen', async () => {
      const typeIntoTerminal = vi.fn(async () => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = setupEngine({
        readinessQueue: [shellAt(PROMPT), shellAt(PROMPT), shellAt(PROMPT), executionState()],
        engineExtras: { typeIntoTerminal },
      });
      const run = ctx.runStore.create(validRun());
      try {
        const done = ctx.engine.start(run.id);
        await advanceReadiness(4);
        await done;
        expect(typeIntoTerminal).toHaveBeenCalledWith('Demo-1', 'codex');
        expect(ctx.runStore.get(run.id).status).toBe('complete');
      } finally {
        warn.mockRestore();
      }
    });

    it('never types the command again when the shell shows it ran', async () => {
      const typeIntoTerminal = vi.fn(async () => {});
      const ran = shellAt(['me@host demo % codex', 'Update ran successfully! Please restart Codex.', 'me@host demo %']);
      const ctx = setupEngine({ readinessQueue: [shellAt(PROMPT), ran, ran, ran, ran], engineExtras: { typeIntoTerminal } });
      const created = interruptedRun(ctx);
      await ctx.engine.resume(created.id);
      await advanceReadiness(5);
      expect(typeIntoTerminal).not.toHaveBeenCalled();
      expect(ctx.runStore.get(created.id)).toMatchObject({ status: 'error', error: 'The launch command for agent codex exited.' });
    });
  });

  it('Resume opens a terminal for a step that never had one, without asking about a terminal', async () => {
    const ctx = setupEngine({ readinessQueue: [executionState()] });
    const created = interruptedRun(ctx, { sessionId: null });

    await ctx.engine.resume(created.id);
    await advanceReadiness(1);

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('complete');
    expect(finished.steps[0]).toMatchObject({ sessionId: 'Demo-1', priorSessionIds: [] });
    expect(ctx.terminalAvailable).not.toHaveBeenCalled();
  });

  it('Resume waits for a busy agent in the terminal, then clears it and sends the prompt', async () => {
    const busy = executionState({ executionReason: 'agent_working' });
    const ctx = setupEngine({ readinessQueue: [busy, busy, executionState()] });
    const created = interruptedRun(ctx);

    await ctx.engine.resume(created.id);
    await advanceReadiness(2);
    expect(ctx.getWorkflowStartArgs()).toBeNull();
    expect(ctx.runStore.get(created.id).status).toBe('running');
    await advanceReadiness(1);

    expect(ctx.getWorkflowStartArgs()).toMatchObject({ resetFirst: true });
    expect(ctx.runStore.get(created.id).steps[0].sessionId).toBe('Demo-9');
  });

  // Spec §9: Stop does not interrupt the agent, and Resume waits for one that is still working.
  // The 120 s of §8.4 limit a launch; they are not a limit on work the agent was already doing.
  it.each(['agent_working', 'agent_delegated'])('Resume keeps waiting past the launch limit while the agent is still at work (%s)', async (executionReason) => {
    const busy = () => executionState({ executionReason, foregroundCommand: 'codex', profile: { promptVisible: () => false } });
    const ctx = setupEngine({ readinessQueue: Array.from({ length: 150 }, busy) });
    const created = interruptedRun(ctx);

    await ctx.engine.resume(created.id);
    await vi.advanceTimersByTimeAsync(140_000);

    expect(ctx.runStore.get(created.id)).toMatchObject({ status: 'running', error: null });
    expect(ctx.runStore.get(created.id).steps[0].status).toBe('launching');
    expect(ctx.getWorkflowStartArgs()).toBeNull();

    // The agent reaches its prompt after 150 s: it is cleared and the prompt is sent again.
    await vi.advanceTimersByTimeAsync(11_000);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    expect(ctx.getWorkflowStartArgs()).toMatchObject({ resetFirst: true });
    expect(ctx.runStore.get(created.id)).toMatchObject({ status: 'complete', error: null });
    expect(ctx.writes).not.toContain('codex');
  });

  it('Resume still fails after the limit when the agent in the terminal is neither working nor at its prompt', async () => {
    const stuck = () => executionState({ executionReason: 'agent_marker_stale', foregroundCommand: 'codex', profile: { promptVisible: () => false } });
    const ctx = setupEngine({ readinessQueue: Array.from({ length: 130 }, stuck) });
    const created = interruptedRun(ctx);

    await ctx.engine.resume(created.id);
    await vi.advanceTimersByTimeAsync(121_000);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toBe('Agent codex did not become ready within 120 seconds (last reason: agent_marker_stale, foreground: codex).');
  });

  it('Resume counts only the time the agent is not at work towards the limit', async () => {
    const state = executionReason => executionState({ executionReason, foregroundCommand: 'codex', profile: { promptVisible: () => false } });
    const ctx = setupEngine({
      readinessQueue: [
        ...Array.from({ length: 200 }, () => state('agent_working')),
        ...Array.from({ length: 130 }, () => state('agent_marker_stale')),
      ],
    });
    const created = interruptedRun(ctx);

    await ctx.engine.resume(created.id);
    await vi.advanceTimersByTimeAsync(319_000);
    expect(ctx.runStore.get(created.id).status).toBe('running');

    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(ctx.runStore.get(created.id).status).toBe('error');
    expect(ctx.runStore.get(created.id).error).toMatch(/last reason: agent_marker_stale/);
  });

  it('Resume fails the run when the availability of the terminal cannot be answered', async () => {
    const ctx = setupEngine({
      terminalAvailable: vi.fn(() => 'yes'),
    });
    const created = interruptedRun(ctx);
    await expect(ctx.engine.resume(created.id)).rejects.toThrow('pipeline run: terminalAvailable must answer true or false for Demo-9');
    expect(ctx.runStore.get(created.id).status).toBe('interrupted');
  });

  it('requires terminalAvailable', () => {
    expect(() => setupEngine({ engineExtras: { terminalAvailable: undefined } })).toThrow('createRunEngine: terminalAvailable is required');
  });

  it('Resume acknowledges before the agent finishes', async () => {
    let releaseNotify;
    const hold = new Promise((resolve) => { releaseNotify = resolve; });
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: vi.fn(({ notify }) => ({
        start(args) {
          hold.then(() => {
            notify({
              status: 'complete',
              active: false,
              error: null,
              requestId: args.requestId,
              iteration: 1,
              limitReached: false,
            });
          });
        },
        stop() {},
        snapshot: () => ({ status: 'running' }),
      })),
    });
    const created = ctx.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    ctx.runStore.update(created.id, {
      status: 'stopped',
      stopReason: 'user',
      finishedAt: new Date().toISOString(),
      steps: [step({ status: 'stopped', attempt: 1, sessionId: 'Demo-9' })],
    });

    const acknowledged = await ctx.engine.resume(created.id);
    expect(acknowledged.status).toBe('running');
    expect(ctx.runStore.get(created.id).status).toBe('running');

    await advanceReadiness(1);
    expect(ctx.runStore.get(created.id).status).toBe('running');
    releaseNotify();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(ctx.runStore.get(created.id).status).toBe('complete');
  });

  it.each(['resume', 'continue', 'cleanup'])('rejects %s immediately during resumed execution', async (action) => {
    const ctx = setupEngine({
      createWorkflow: vi.fn(() => ({ start() {}, stop() {} })),
    });
    const run = ctx.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    ctx.runStore.update(run.id, {
      status: 'interrupted',
      steps: [step({ status: 'interrupted', attempt: 1 })],
    });
    await ctx.engine.resume(run.id);
    await advanceReadiness(1);

    let outcome = 'pending';
    const actionFinished = ctx.engine[action](run.id).then(
      () => { outcome = 'accepted'; },
      (err) => { outcome = err.code; },
    );
    await vi.advanceTimersByTimeAsync(10);
    const observed = outcome;
    // Release execution even on the unfixed implementation, which queues the action.
    await ctx.engine.stop(run.id);
    await actionFinished;
    await advanceReadiness(1);
    await ctx.engine.stop(run.id);

    expect(observed).toBe('ACTION_REFUSED');
  });

  it('revalidates a queued Resume after another Resume changes the status', async () => {
    let releasePathCheck;
    const pathCheck = new Promise((resolve) => { releasePathCheck = resolve; });
    const ctx = setupEngine({
      pathExists: vi.fn(() => pathCheck),
      createWorkflow: vi.fn(() => ({ start() {}, stop() {} })),
    });
    const run = ctx.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    ctx.runStore.update(run.id, {
      status: 'interrupted',
      steps: [step({ status: 'interrupted', attempt: 1 })],
    });
    const first = ctx.engine.resume(run.id);
    const second = ctx.engine.resume(run.id);
    const refused = expect(second).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
    releasePathCheck(true);
    await first;
    await refused;
    await advanceReadiness(1);
    await ctx.engine.stop(run.id);
    expect(ctx.startSession).toHaveBeenCalledTimes(1);
  });

  it('Continue past Setup limit checks worktree cleanliness', async () => {
    const outcomes = ['limit'];
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      listDirtyPaths: vi.fn(async () => ['tmp.out']),
      createWorkflow: vi.fn(({ notify }) => ({
        start(args) {
          const outcome = outcomes.shift() || 'complete';
          queueMicrotask(() => {
            if (outcome === 'limit') {
              notify({
                status: 'stopped',
                active: false,
                error: null,
                requestId: args.requestId,
                iteration: 3,
                limitReached: true,
              });
            } else {
              notify({
                status: 'complete',
                active: false,
                error: null,
                requestId: args.requestId,
                iteration: 1,
                limitReached: false,
              });
            }
          });
        },
        stop() {},
        snapshot: () => ({ status: 'stopped', limitReached: true }),
      })),
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({
        steps: [
          {
            kind: 'setup', role: '', askOwner: false, readOnly: false, approval: false,
            name: 'Setup',
            prompt: 'setup',
            repeat: { mode: 'until_complete', max: 3 },
            agent: {
              id: AGENT_ID,
              name: 'codex',
              launchCommand: 'codex',
              resetCommand: '/clear',
            },
          },
          {
            kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
            name: 'Develop',
            prompt: 'do it',
            repeat: { mode: 'once' },
            agent: {
              id: AGENT_ID,
              name: 'codex',
              launchCommand: 'codex',
              resetCommand: '/clear',
            },
          },
        ],
      }),
    }));

    await driveReady(ctx.engine.start(run.id));
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');
    expect(ctx.listDirtyPaths).not.toHaveBeenCalled();

    const afterContinue = await ctx.engine.continue(run.id);
    expect(afterContinue.status).toBe('error');
    expect(afterContinue.error).toMatch(/Setup left uncommitted changes/);
    expect(ctx.listDirtyPaths).toHaveBeenCalledTimes(1);
    expect(ctx.startSession).toHaveBeenCalledTimes(1);
  });

  it('transition failures from Setup dirty-path providers settle and error the run', async () => {
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      listDirtyPaths: vi.fn(async () => {
        throw new Error('git status failed');
      }),
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({
        steps: [{
          kind: 'setup', role: '', askOwner: false, readOnly: false, approval: false,
          name: 'Setup',
          prompt: 'setup',
          repeat: { mode: 'until_complete', max: 3 },
          agent: {
            id: AGENT_ID,
            name: 'haiku',
            launchCommand: 'claude',
            resetCommand: '/clear',
          },
        }],
      }),
    }));

    const rejections = [];
    const onUnhandled = (reason) => { rejections.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await driveReady(ctx.engine.start(run.id));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toMatch(/git status failed/);
    expect(rejections).toEqual([]);
  });

  it('notifySessionClosed fails the active run for that terminal', async () => {
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: vi.fn(({ notify }) => ({
        start() {
          // Stay running until session closed.
        },
        stop() {},
        snapshot: () => ({ status: 'running' }),
      })),
    });
    const run = ctx.runStore.create(validRun());
    const started = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.runStore.get(run.id).steps[0].sessionId).toBe('Demo-1');

    ctx.engine.notifySessionClosed('Demo-1');
    await started;

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toBe('The terminal for step Develop was closed.');
  });

  it('cleanup on not_created sets removed without calling git', async () => {
    const ctx = setupEngine();
    const run = ctx.runStore.create(validRun());
    ctx.runStore.update(run.id, {
      status: 'error',
      error: 'boom',
      finishedAt: new Date().toISOString(),
      worktreeState: 'not_created',
    });

    await ctx.engine.cleanup(run.id);
    expect(ctx.removeWorktree).not.toHaveBeenCalled();
    expect(ctx.runStore.get(run.id).worktreeState).toBe('removed');
  });

  it('Stop during worktree create records the worktree but does not start a session', async () => {
    let releaseCreate;
    const creating = new Promise(resolve => { releaseCreate = resolve; });
    const ctx = setupEngine({
      createWorktree: vi.fn(async () => {
        await creating;
        return { baseCommit: BASE_COMMIT };
      }),
    });
    const run = ctx.runStore.create(validRun());
    const started = ctx.engine.start(run.id);
    await Promise.resolve();
    await ctx.engine.stop(run.id);
    releaseCreate();
    await started;

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('stopped');
    expect(finished.worktreeState).toBe('present');
    expect(finished.baseCommit).toBe(BASE_COMMIT);
    expect(ctx.startSession).not.toHaveBeenCalled();
  });
});

describe('createRunEngine with an existing worktree', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const external = (overrides = {}) => validRun({
    worktreePath: '/tmp/worktrees/home-existing',
    worktreeBranch: 'feature/existing',
    baseCommit: BASE_COMMIT,
    worktreeState: 'external',
    ...overrides,
  });

  it('runs in the chosen worktree without creating one, and stays with it when complete until the owner closes the run', async () => {
    const ctx = setupEngine();
    const run = ctx.runStore.create(external());

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('complete');
    // The finished run stays open on its task, so the owner can see that it finished and what it left.
    expect(finished.worktreeState).toBe('external');
    expect(finished.worktreeDetail).toBeNull();
    expect(ctx.createWorktree).not.toHaveBeenCalled();
    expect((await ctx.engine.cleanup(run.id)).worktreeState).toBe('released');
    expect(ctx.removeWorktree).not.toHaveBeenCalled();
    expect(ctx.startSession).toHaveBeenCalledWith({ project: 'Demo', host:'local', cwd: '/tmp/worktrees/home-existing' });
    expect(ctx.attachBackground).toHaveBeenCalledWith('Demo-1', { cwd: '/tmp/worktrees/home-existing' });
  });

  it('cleanup of a stopped run releases the worktree without calling git', async () => {
    const ctx = setupEngine();
    const run = ctx.runStore.create(external());
    ctx.runStore.update(run.id, { status: 'stopped', stopReason: 'user', finishedAt: new Date().toISOString() });

    const released = await ctx.engine.cleanup(run.id);
    expect(released.worktreeState).toBe('released');
    expect(ctx.removeWorktree).not.toHaveBeenCalled();
    await expect(ctx.engine.cleanup(run.id)).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
    await expect(ctx.engine.resume(run.id)).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
  });

  it('reclaims a released task worktree before resuming the interrupted step', async () => {
    const canReclaim = vi.fn(() => true);
    const ctx = setupEngine({
      terminalAvailable: vi.fn(() => false),
      engineExtras: { canReclaimReleasedTaskWorktree: canReclaim },
    });
    const run = ctx.runStore.create(external({ taskId: '11111111-1111-4111-8111-111111111111' }));
    ctx.runStore.update(run.id, {
      status: 'interrupted',
      worktreeState: 'released',
      steps: [step({ status: 'interrupted', sessionId: 'Demo-9', attempt: 1 })],
    });

    const resumed = await ctx.engine.resume(run.id);
    expect(resumed.status).toBe('running');
    expect(ctx.runStore.get(run.id).worktreeState).toBe('external');
    expect(canReclaim).toHaveBeenCalledWith(expect.objectContaining({ id: run.id, worktreeState: 'released' }));
  });

  it('refuses Resume when the chosen worktree directory is gone', async () => {
    const ctx = setupEngine({ pathExists: vi.fn(async () => false) });
    const run = ctx.runStore.create(external());
    ctx.runStore.update(run.id, {
      status: 'interrupted',
      steps: [step({ status: 'interrupted', sessionId: 'Demo-9', attempt: 1 })],
    });

    await expect(ctx.engine.resume(run.id)).rejects.toMatchObject({ code: 'WORKTREE_MISSING' });
    expect(ctx.pathExists).toHaveBeenCalledWith('/tmp/worktrees/home-existing');
    expect(ctx.runStore.get(run.id).status).toBe('interrupted');
  });
});


describe('createRunEngine — what the agent needs, and answering it', () => {
  const ID = 'fd4ed49c-1';
  const SCREEN = [
    '• Phase 0 is complete.',
    `• [[CDW:${ID}:QUESTIONS]]`,
    '  1. Which schema should the migration target?',
    '     Recommended: the existing guardian schema.',
    `• [[CDW:${ID}:NEEDS_INPUT]]`,
    '› Ask Codex to do anything',
  ];
  const ASKED = {
    questions: '1. Which schema should the migration target?\nRecommended: the existing guardian schema.',
    truncated: false,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  // A loop that signals NEEDS_INPUT on start, returns to running on an answer and completes on demand.
  function askingWorkflow({ signalIdentifier = () => ID } = {}) {
    const state = { status: 'stopped', inputs: [], notify: null };
    const snap = status => ({ status, active: !['complete', 'stopped'].includes(status), error: null, requestId: 'r', iteration: 1, limitReached: false });
    const publish = (status) => { state.status = status; state.notify(snap(status)); };
    const createWorkflow = vi.fn(({ notify }) => {
      state.notify = notify;
      const workflow = {
        start() { queueMicrotask(() => publish('needs_input')); },
        stop() { state.status = 'stopped'; },
        snapshot: () => snap(state.status),
        answerText: text => text,
        input(data) { state.inputs.push(data); publish('running'); },
      };
      if (signalIdentifier !== undefined) workflow.signalIdentifier = signalIdentifier;
      return workflow;
    });
    return { createWorkflow, state, ask: () => publish('needs_input'), complete: () => publish('complete') };
  }

  async function startWaiting(overrides = {}, workflowOptions) {
    const loop = askingWorkflow(workflowOptions);
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: loop.createWorkflow,
      readScreen: vi.fn(async () => SCREEN),
      ...overrides,
    });
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100); // launch Enter
    await vi.advanceTimersByTimeAsync(1000); // ready → loop starts → NEEDS_INPUT
    await vi.advanceTimersByTimeAsync(0);
    return { ctx, loop, run, done };
  }

  it('requires a way to read the terminal screen', () => {
    expect(() => setupEngine({ engineExtras: { readScreen: undefined } })).toThrow('createRunEngine: readScreen is required');
  });

  it('stores the questions the agent printed before its NEEDS_INPUT signal', async () => {
    const { ctx, loop, run, done } = await startWaiting();
    const waiting = ctx.runStore.get(run.id);
    expect(waiting.status).toBe('needs_input');
    expect(ctx.setTerminalMuted).toHaveBeenCalledWith('Demo-1', false);
    expect(waiting.inputRequest).toEqual(ASKED);
    expect(ctx.readScreen).toHaveBeenCalledWith('Demo-1');

    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'complete', inputRequest: null });
  });

  it('stores a request without questions when the agent did not state any', async () => {
    const { ctx, run } = await startWaiting({ readScreen: vi.fn(async () => ['I am blocked.', `[[CDW:${ID}:NEEDS_INPUT]]`]) });
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'needs_input', inputRequest: { questions: null, truncated: false } });
  });

  it('types what the loop composes for the answer, and records the owner’s own words', async () => {
    const { ctx, loop, run, done } = await startWaiting();
    loop.createWorkflow.mock.results.at(-1).value.answerText = text => `${text}\n\nCodeDeck: use identifier next-2`;
    const before = ctx.writes.length;
    const answering = ctx.engine.answer(run.id, 'The login page');
    await vi.advanceTimersByTimeAsync(100);
    await answering;
    expect(ctx.writes.slice(before)).toEqual(['\x1b[200~The login page\n\nCodeDeck: use identifier next-2\x1b[201~', '\r']);
    expect(loop.state.inputs).toEqual(['The login page\n\nCodeDeck: use identifier next-2']);
    expect(ctx.answerStore.list(run.id).map(item => item.answer)).toEqual(['The login page']);
    loop.complete();
    await done;
  });

  it('types the answer into the agent terminal as one paste, submits it and returns the run to running', async () => {
    const { ctx, loop, run, done } = await startWaiting();
    const before = ctx.writes.length;

    const answering = ctx.engine.answer(run.id, '1. the existing schema\n2. yes');
    expect(ctx.writes.slice(before)).toEqual(['\x1b[200~1. the existing schema\n2. yes\x1b[201~']);
    await vi.advanceTimersByTimeAsync(100);
    const answered = await answering;

    expect(ctx.writes.slice(before)).toEqual(['\x1b[200~1. the existing schema\n2. yes\x1b[201~', '\r']);
    expect(loop.state.inputs).toEqual(['1. the existing schema\n2. yes']);
    expect(answered).toMatchObject({ status: 'running', inputRequest: null });
    expect(ctx.runStore.get(run.id).steps[0].status).toBe('running');
    // What was asked and answered is kept for the steps that come later.
    expect(ctx.answerStore.list(run.id)).toEqual([expect.objectContaining({ stepIndex: 0, stepName: 'Develop', pass: 1, answer: '1. the existing schema\n2. yes', questions: expect.stringContaining('1.') })]);

    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });

  async function startWaitingWithNotes(overrides = {}) {
    const loop = askingWorkflow();
    const readNote = vi.fn(async () => ({ status: 'present', content: '# Done' }));
    const ctx = setupEngine({ readinessQueue: [executionState()], createWorkflow: loop.createWorkflow, readScreen: vi.fn(async () => SCREEN),
      engineExtras: { prepareNotes: vi.fn(async () => {}), readNote }, ...overrides });
    const run = ctx.runStore.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    return { ctx, loop, run, done };
  }

  it('writes the brief when a step starts and again with each answer the owner gives', async () => {
    const { ctx, loop, run, done } = await startWaitingWithNotes();
    expect(ctx.writeBrief).toHaveBeenCalledTimes(1);
    expect(ctx.writeBrief).toHaveBeenLastCalledWith(expect.objectContaining({ input: run.input, entries: [], definition: expect.objectContaining({ notesDir: '.codedeck/runs/abcdef12' }) }));

    const answering = ctx.engine.answer(run.id, 'The login page');
    await vi.advanceTimersByTimeAsync(100);
    await answering;
    expect(ctx.writeBrief).toHaveBeenCalledTimes(2);
    const { entries } = ctx.writeBrief.mock.calls.at(-1)[0];
    expect(entries).toEqual([expect.objectContaining({ by: 'owner', stepName: 'Develop', pass: 1, answer: 'The login page', questions: expect.stringContaining('1.') })]);
    // The record exists before the answer is submitted to the agent.
    expect(ctx.writes.at(-1)).toBe('\r');
    loop.complete();
    await done;
  });

  it('still delivers the answer and keeps its record when the brief cannot be written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ctx, loop, run, done } = await startWaitingWithNotes({ writeBrief: vi.fn(async () => { throw new Error('disk full'); }) });
    const answering = ctx.engine.answer(run.id, 'Yes');
    await vi.advanceTimersByTimeAsync(100);
    expect(await answering).toMatchObject({ status: 'running' });
    expect(loop.state.inputs).toEqual(['Yes']);
    expect(ctx.answerStore.list(run.id)).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('brief could not be written'), expect.any(Error));
    error.mockRestore();
    loop.complete();
    await done;
  });

  it('writes no brief for a run without run notes, and requires somewhere to keep answers', async () => {
    const { ctx, loop, run, done } = await startWaiting();
    const answering = ctx.engine.answer(run.id, 'Yes');
    await vi.advanceTimersByTimeAsync(100);
    await answering;
    expect(ctx.writeBrief).not.toHaveBeenCalled();
    expect(ctx.answerStore.list(run.id)).toHaveLength(1);
    loop.complete();
    await done;
    expect(() => setupEngine({ engineExtras: { answerStore: undefined } })).toThrow('createRunEngine: answerStore is required');
    expect(() => setupEngine({ engineExtras: { writeBrief: null } })).toThrow('createRunEngine: writeBrief is required');
  });

  it('stores a second request when the agent asks again after an answer', async () => {
    const second = [`[[CDW:${ID}:QUESTIONS]]`, '1. And the index name?', `[[CDW:${ID}:NEEDS_INPUT]]`];
    const readScreen = vi.fn().mockResolvedValueOnce(SCREEN).mockResolvedValueOnce(second);
    const { ctx, loop, run } = await startWaiting({ readScreen });
    const answering = ctx.engine.answer(run.id, 'the existing schema');
    await vi.advanceTimersByTimeAsync(100);
    await answering;

    loop.ask();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.runStore.get(run.id)).toMatchObject({
      status: 'needs_input', inputRequest: { questions: '1. And the index name?', truncated: false },
    });
  });

  it('refuses a second answer while the first is still being typed', async () => {
    const { ctx, loop, run } = await startWaiting();
    const before = ctx.writes.length;
    const first = ctx.engine.answer(run.id, 'yes');
    await expect(ctx.engine.answer(run.id, 'yes')).rejects.toMatchObject({
      code: 'ANSWER_UNAVAILABLE', message: 'An answer is already being sent to this agent.',
    });
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(ctx.writes.slice(before)).toEqual(['\x1b[200~yes\x1b[201~', '\r']);
    expect(loop.state.inputs).toEqual(['yes']);
    // Once answered the run is running again, so the same answer is refused rather than typed twice.
    await expect(ctx.engine.answer(run.id, 'yes')).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
  });

  it('refuses an answer for a run that is not waiting, and for a run this backend is not driving', async () => {
    const ctx = setupEngine();
    const idle = ctx.runStore.create(validRun());
    await expect(ctx.engine.answer(idle.id, 'yes')).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
    await expect(ctx.engine.answer('0d9e4b1a-9999-4999-8999-999999999999', 'yes')).rejects.toThrow('not found');

    const orphan = ctx.runStore.create(validRun({
      requestId: 'orphan',
      status: 'needs_input',
      inputRequest: ASKED,
      steps: validRun().steps.map(step => ({ ...step, status: 'needs_input', sessionId: 'Demo-9', attempt: 1 })),
    }));
    await expect(ctx.engine.answer(orphan.id, 'yes')).rejects.toMatchObject({
      code: 'ANSWER_UNAVAILABLE', message: 'The agent is no longer waiting for an answer.',
    });
    expect(ctx.writes).toEqual([]);
  });

  it.each([undefined, null, '', 7])('fails loudly when the answer is %j', async (answer) => {
    const { ctx, run } = await startWaiting();
    await expect(ctx.engine.answer(run.id, answer)).rejects.toThrow('pipeline run: answer must be a non-empty string');
  });

  it('fails the run when the loop cannot say which iteration it is waiting on', async () => {
    const { ctx, run } = await startWaiting({}, { signalIdentifier: () => null });
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error' });
    expect(ctx.runStore.get(run.id).error).toContain('signal identifier');
  });

  it('fails the run when the screen cannot be read', async () => {
    const { ctx, run } = await startWaiting({ readScreen: vi.fn(async () => { throw new Error('tmux capture failed'); }) });
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error', error: 'tmux capture failed' });
  });
});

describe('createRunEngine — a loop of steps', () => {
  // Each step has an agent of its own, so each works in its own terminal.
  const AGENT_IDS = {
    Develop: 'c410a1b2-3456-4789-8abc-def012345610',
    Test: 'c410a1b2-3456-4789-8abc-def012345611',
    Review: 'c410a1b2-3456-4789-8abc-def012345612',
  };
  const defStep = (name, repeat = { mode: 'once' }) => ({
    kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
    name,
    prompt: `do ${name}`,
    repeat,
    agent: { id: AGENT_IDS[name], name: 'codex', launchCommand: 'codex', resetCommand: '/clear' },
  });
  // Develop → Test (back to Develop) → Review
  const looping = (max = 3) => definition({
    steps: [defStep('Develop'), defStep('Test', { mode: 'loop_back', toStepIndex: 0, max }), defStep('Review')],
  });
  const LOOP_GUIDANCE = 'This step closes a loop: CodeDeck repeats the steps from "Develop" to "Test" in order, round after round. Use COMPLETE only when the whole task is finished and no step of the loop has work left; use CONTINUE when another round is needed.';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** Each loop started ends at once with the next scripted outcome: 'complete', or 'continue' (one pass, work left). */
  function scriptedWorkflow(outcomes) {
    const starts = [];
    const createWorkflow = vi.fn(({ notify }) => ({
      start(args) {
        starts.push(args);
        const outcome = outcomes.shift();
        if (outcome === undefined) throw new Error('scripted workflow: no outcome left');
        queueMicrotask(() => notify({
          status: outcome === 'complete' ? 'complete' : 'stopped',
          active: false,
          error: null,
          requestId: args.requestId,
          iteration: 1,
          limitReached: outcome !== 'complete',
        }));
      },
      stop() {},
      snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
    }));
    return { createWorkflow, starts };
  }

  async function runLoop(outcomes, { max = 3, definition = looping(max), overrides = {} } = {}) {
    const script = scriptedWorkflow([...outcomes]);
    const sessions = [];
    const ctx = setupEngine({
      createWorkflow: script.createWorkflow,
      attachBackground: vi.fn((sessionId) => {
        sessions.push(sessionId);
        return { write: (data) => { ctx.writes.push(data); }, release: () => {} };
      }),
      ...overrides,
    });
    const run = ctx.runStore.create(validRun({ definition }));
    const done = ctx.engine.start(run.id);
    // Each step needs at most the launch Enter (100 ms) and one readiness poll (1 s).
    for (let i = 0; i < outcomes.length + 1; i += 1) await vi.advanceTimersByTimeAsync(1100);
    await done;
    return { ctx, script, sessions, run: ctx.runStore.get(run.id), done };
  }
  it('records a queued replacement only on the pass that actually runs it', async () => {
    const script = scriptedWorkflow(['complete', 'continue', 'complete', 'complete', 'complete']);
    const ctx = setupEngine({createWorkflow: script.createWorkflow});
    const def = looping(2);
    const team = {id: WORKFLOW_ID, name:'Builders', revision:1};
    for (const step of def.steps) {
      step.role = step.name;
      step.agent.assignment = {agentRevision:1, source:'team', teamId:team.id, teamRevision:1};
    }
    const run = ctx.runStore.create(validRun({definition:def}), {team, workload:'a'.repeat(64), mixed:false});
    const steps = [...def.steps];
    steps[0] = {...steps[0], nextAgent:{...steps[0].agent, launchCommand:'command codex --model replacement',
      assignment:{agentRevision:2, source:'override', teamId:null, teamRevision:null}}};
    ctx.runStore.update(run.id,{definition:{...def,steps}}, {mixed:true});
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(6600);
    await done;
    expect(ctx.runStore.attribution(run.id).attempts.filter(a => a.stepName === 'Develop')).toMatchObject([
      {attempt:1, source:'team', agentRevision:1, model:null},
      {attempt:2, source:'override', agentRevision:2, model:'replacement'},
    ]);
  });

  it('gates a step inside a loop in both rounds', async () => {
    const script = scriptedWorkflow(['complete', 'continue', 'complete', 'complete', 'complete']);
    const ctx = setupEngine({ createWorkflow: script.createWorkflow });
    const def = looping(2);
    def.steps[0].approval = true;
    const run = ctx.runStore.create(validRun({ definition: def }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100); await done;
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'awaiting_approval', currentStepIndex: 0 });
    await ctx.engine.approve(run.id);
    await vi.advanceTimersByTimeAsync(2200);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'awaiting_approval', currentStepIndex: 0 });
    await ctx.engine.approve(run.id);
    await vi.advanceTimersByTimeAsync(2200);
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(ctx.reviewStore.list(run.id).map(row => row.verdict)).toEqual(['approved', 'approved']);
  });

  it('runs the loop again when its last step reports work left, then moves on when it reports COMPLETE', async () => {
    const { ctx, script, run } = await runLoop(['continue', 'continue', 'complete', 'complete', 'complete']);
    expect(run.status).toBe('complete');
    expect(run.steps.map(s => s.status)).toEqual(['complete', 'complete', 'complete']);
    expect(script.starts).toHaveLength(5);
    expect(run.steps.map(s => s.roundsCompleted)).toEqual([0, 1, 0]);
    expect(ctx.runStore.get(run.id).currentStepIndex).toBe(2);
  });

  it('keeps each step in its own terminal: no new terminal and no second launch in a later round', async () => {
    const { ctx, sessions, run } = await runLoop(['continue', 'continue', 'complete', 'complete', 'complete']);
    expect(ctx.startSession).toHaveBeenCalledTimes(3);
    expect(sessions).toEqual(['Demo-1', 'Demo-2', 'Demo-1', 'Demo-2', 'Demo-3']);
    expect(ctx.writes.filter(data => data === 'codex')).toHaveLength(3);
    expect(run.steps.map(s => s.sessionId)).toEqual(['Demo-1', 'Demo-2', 'Demo-3']);
    expect(run.steps.every(s => s.priorSessionIds.length === 0)).toBe(true);
  });

  it('resets the agent before it works in a terminal it used in an earlier round', async () => {
    const { script } = await runLoop(['continue', 'continue', 'complete', 'complete', 'complete']);
    expect(script.starts.map(start => start.resetFirst)).toEqual([false, false, true, true, false]);
    expect(new Set(script.starts.map(start => start.requestId)).size).toBe(5);
  });

  it('gives the step that closes the loop one pass per round and tells it what the loop is', async () => {
    const { script } = await runLoop(['continue', 'continue', 'complete', 'complete', 'complete']);
    const [develop, test, , , review] = script.starts;
    expect(test).toMatchObject({ command: 'do Test', maxIterations: 1, guidance: `${BOUNDARY} ${LOOP_GUIDANCE}` });
    expect(develop.guidance).toBe(BOUNDARY);
    expect(review.guidance).toBe(BOUNDARY);
  });

  it('pauses at the round limit; Continue grants one more round at the loop target', async () => {
    const { ctx, script, run } = await runLoop(['continue', 'continue', 'continue', 'continue'], { max: 2 });
    expect(run.status).toBe('limit_paused');
    expect(run.currentStepIndex).toBe(1);
    expect(run.steps.map(s => s.status)).toEqual(['complete', 'limit_reached', 'pending']);
    expect(run.steps[1].roundsCompleted).toBe(1);
    expect(script.starts).toHaveLength(4);

    script.createWorkflow.mockClear();
    const scriptAfter = scriptedWorkflow(['complete', 'continue', 'complete', 'continue', 'complete', 'continue']);
    // The engine keeps its own createWorkflow; feed the remaining outcome through the same mock.
    script.createWorkflow.mockImplementation(scriptAfter.createWorkflow);
    const acknowledged = await ctx.engine.continue(run.id, { stepIndex: 1, roundsCompleted: 1 });
    expect(acknowledged.status).toBe('running');
    expect(acknowledged.currentStepIndex).toBe(0);
    expect(acknowledged.steps[1].extraRounds).toBe(1);
    for (let i = 0; i < 7; i += 1) await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);
    const after = ctx.runStore.get(run.id);
    // The granted round looped once more (rounds 2), then the cap paused again: no completion.
    expect(after.status).toBe('limit_paused');
    expect(after.currentStepIndex).toBe(1);
    expect(after.steps.map(s => s.status)).toEqual(['complete', 'limit_reached', 'pending']);
    expect(after.steps[1]).toMatchObject({ roundsCompleted: 2, extraRounds: 1 });
  });

  it('never loops when the limit is one round', async () => {
    const { script, run } = await runLoop(['continue', 'continue'], { max: 1 });
    expect(run.status).toBe('limit_paused');
    expect(run.steps[1]).toMatchObject({ status: 'limit_reached', roundsCompleted: 0 });
    expect(script.starts).toHaveLength(2);
  });

  it('stops before starting the next round after two measured rounds without progress', async () => {
    const readProgressCount = vi.fn(async () => ({ tasksDone: 2, tasksTotal: 5 }));
    const { script, run } = await runLoop(['continue', 'continue', 'continue', 'continue', 'continue', 'continue'], {
      max: 5, overrides: { readProgressCount },
    });
    expect(run).toMatchObject({ status: 'stopped', stopReason: 'no_progress', currentStepIndex: 0 });
    expect(run.steps[1].roundsCompleted).toBe(3);
    expect(run.steps[0].status).toBe('stopped');
    expect(script.starts).toHaveLength(6);
    expect(readProgressCount).toHaveBeenCalledTimes(3);
  });

  it('requires a progress-count reader at construction', () => {
    expect(() => setupEngine({ engineExtras: { readProgressCount: undefined } })).toThrow('createRunEngine: readProgressCount is required');
  });
  it('does not read progress for a workflow without a loop', async () => {
    const readProgressCount = vi.fn(async () => ({ tasksDone: 0, tasksTotal: 1 }));
    const ctx = setupEngine({ readProgressCount });
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(readProgressCount).not.toHaveBeenCalled();
  });
  it('blocks Test completion on the latest failed worker build receipt', async () => {
    const {run,ctx} = await runLoop(['complete','complete','complete'], {
      definition: {...looping(3),notesDir:'.codedeck/runs/abcdef12'},
      overrides:{engineExtras:{
        prepareNotes:vi.fn(),readNote:async()=>({status:'present',content:'All green'}),
        readGradleReceipts:async()=>[{cwd:'/tmp/worktrees/home-feature-abcd1234',tasks:['check'],exitCode:1,
          id:'a2d0b1c2-3456-4789-8abc-def012345678',startedAt:'2026-11-23T01:00:00Z',endedAt:'2026-11-23T01:00:01Z',executed:1,reused:0,skipped:0,outputDigest:'a'.repeat(64)}],
      }},
    });
    expect(run.status).toBe('error');
    expect(run.error).toMatch(/Gradle.*exit 1/);
    expect(ctx.runStore.lastAuditDetail(run.id,1,'build_receipt')).toContain('./gradlew --console=plain check');
  });

  it('resumes Develop with the original free-form Test note, then enforces the new Test prompt', async () => {
    const script = scriptedWorkflow(['complete', 'continue']);
    const ctx = setupEngine({createWorkflow: script.createWorkflow, engineExtras: {
      prepareNotes: vi.fn(), fingerprintSources: vi.fn(),
      readNote: async () => ({status: 'present', content: '# Still failing A5'}),
    }});
    const def = {...looping(8), notesDir: '.codedeck/runs/abcdef12'};
    const run = ctx.runStore.create(validRun({
      definition: def, status: 'error', error: 'Missing REPAIR 5', finishedAt: new Date().toISOString(), worktreeState: 'external', baseCommit: BASE_COMMIT,
      steps: [step({status: 'failed', attempt: 7}), step({attempt: 5, roundsCompleted: 5}), step()],
    }));
    ctx.noteStore.add({runId: run.id, stepIndex: 1, stepName: 'Test', attempt: 5, pass: 1,
      status:'written', summary:'Reopened A5', content:'# Reopened A5\nSee regression in the Test note.'});
    await ctx.engine.resume(run.id);
    await vi.advanceTimersByTimeAsync(4000);
    expect(script.starts).toHaveLength(2);
    expect(script.starts[0].command).toContain(notePath(def, 1));
    expect(script.starts[1].command).toContain('REPAIR 6 ');
    expect(script.starts[1].command).toContain('Keep each REPAIR line on one line: path at most 1024 characters, reason at most 1000.');
    expect(script.starts[1].command).toContain('Write REPAIR lines only for checks of the work this round built; tasks of later phases are not findings.');
    expect(ctx.runStore.get(run.id).error ?? '').not.toContain('REPAIR 6');
  });

  it('loops back to Develop when Test passes its phase with no REPAIR lines and later phases remain', async () => {
    let fingerprint = 0;
    const def = {...looping(8),notesDir:'.codedeck/runs/abcdef12'};
    const {run,script} = await runLoop(['continue','continue','complete','complete','complete'],{definition:def,overrides:{engineExtras:{
      prepareNotes:vi.fn(), fingerprintSources:async()=> String(++fingerprint).padStart(64,'0'),
      readNote:async ({stepIndex})=>({status:'present',content:stepIndex===1 ? '# Phase 5 passed\nThere are no repair findings for this round.':'# Built'}),
    }}});
    expect(run.status).toBe('complete');
    expect(script.starts.length).toBeGreaterThanOrEqual(4);
  });

  it('blocks an identical repair before a third developer launch', async () => {
    let attempt = 0;
    const def = {...looping(8),notesDir:'.codedeck/runs/abcdef12'};
    const {run,script,ctx} = await runLoop(Array(12).fill('continue'),{definition:def,overrides:{engineExtras:{
      prepareNotes:vi.fn(), fingerprintSources:async()=> 'a'.repeat(64),
      readNote:async ({stepIndex})=>({status:'present',content:stepIndex===1 ? `REPAIR ${++attempt} AC2 | Detector.kt | chord fails`:'# Changed'}),
    }}});
    const history = ctx.runStore.auditPage(run.id,{page:0,size:100,direction:'asc',stepIndex:1}).data;
    expect(history.filter(event => event.kind === 'verification_report')).toHaveLength(2);
    expect(history.find(event => event.kind === 'loop_back').detail).toContain('Detector.kt');
    expect(script.starts).toHaveLength(4);
    expect(run.status).toBe('stopped');
    expect(script.starts[2].command).toContain('AC2 | Detector.kt | chord fails');
  });

  it('resets the no-progress streak when a later round ticks a task', async () => {
    const counts = [1, 1, 2, 2];
    const readProgressCount = vi.fn(async () => ({ tasksDone: counts.shift(), tasksTotal: 5 }));
    const outcomes = [...Array(4).fill(['continue', 'continue']).flat(), 'complete', 'complete', 'complete'];
    const { run } = await runLoop(outcomes, { max: 6, overrides: { readProgressCount } });
    expect(run.status).toBe('complete');
    expect(readProgressCount).toHaveBeenCalledTimes(4);
  });

  it('counts a lower ticked total as no progress', async () => {
    const counts = [3, 2, 2];
    const { run } = await runLoop(Array(8).fill('continue'), { max: 5,
      overrides: { readProgressCount: vi.fn(async () => ({ tasksDone: counts.shift(), tasksTotal: 5 })) } });
    expect(run).toMatchObject({ status: 'stopped', stopReason: 'no_progress' });
  });

  it('clears its baseline when progress cannot be read', async () => {
    const counts = [1, 1, null, 1, 1];
    const readProgressCount = vi.fn(async () => {
      const tasksDone = counts.shift(); return tasksDone === null ? null : { tasksDone, tasksTotal: 5 };
    });
    const outcomes = [...Array(5).fill(['continue', 'continue']).flat(), 'complete', 'complete', 'complete'];
    const { run } = await runLoop(outcomes, { max: 7, overrides: { readProgressCount } });
    expect(run.status).toBe('complete');
  });

  it('warns once and keeps running when the reader throws', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const readProgressCount = vi.fn(async () => { throw new Error('read refused'); });
      const outcomes = [...Array(3).fill(['continue', 'continue']).flat(), 'complete', 'complete', 'complete'];
      const { run } = await runLoop(outcomes, { max: 5, overrides: { readProgressCount } });
      expect(run.status).toBe('complete');
      expect(warning.mock.calls.filter(call => String(call[0]).startsWith('[pipeline-progress-guard]'))).toHaveLength(1);
    } finally { warning.mockRestore(); }
  });

  it('leaves the last allowed round to the existing limit pause', async () => {
    const readProgressCount = vi.fn(async () => ({ tasksDone: 0, tasksTotal: 1 }));
    const { run } = await runLoop(Array(6).fill('continue'), { max: 3, overrides: { readProgressCount } });
    expect(run.status).toBe('limit_paused');
    expect(readProgressCount).toHaveBeenCalledTimes(2);
  });
  it('Resume starts the loop first step and grants a fresh two-round streak', async () => {
    const readProgressCount = vi.fn(async () => ({ tasksDone: 0, tasksTotal: 1 }));
    const { ctx, script, run } = await runLoop(Array(12).fill('continue'), { max: 9, overrides: { readProgressCount } });
    expect(run).toMatchObject({ status: 'stopped', stopReason: 'no_progress', currentStepIndex: 0 });
    expect(script.starts).toHaveLength(6);
    expect(readProgressCount).toHaveBeenCalledTimes(3);
    await ctx.engine.resume(run.id);
    for (let i = 0; i < 7; i += 1) await vi.advanceTimersByTimeAsync(1100);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'stopped', stopReason: 'no_progress', currentStepIndex: 0 });
    expect(script.starts).toHaveLength(12);
    expect(readProgressCount).toHaveBeenCalledTimes(6);
  });

  it('stops a note-keeping loop without a progress file after two repeat rounds, and tells repeat passes to focus on changes', async () => {
    const readProgressCount = vi.fn(async () => null);
    const { script, run } = await runLoop(Array(6).fill('continue'), {
      max: 6,
      definition: { ...looping(6), notesDir: '.codedeck/runs/abcdef12' },
      overrides: {
        readProgressCount,
        engineExtras: {
          prepareNotes: vi.fn(async () => {}),
          readNote: vi.fn(async () => ({ status: 'present', content: '# Verification' })),
        },
      },
    });
    expect(run).toMatchObject({ status: 'stopped', stopReason: 'no_progress', currentStepIndex: 0 });
    expect(run.steps[1].roundsCompleted).toBe(3);
    expect(script.starts).toHaveLength(6);
    expect(script.starts[0].guidance).not.toContain('in this loop: read your previous note');
    expect(script.starts[2].guidance).toContain('Pass 2 of Develop in this loop: read your previous note in .codedeck/runs/abcdef12');
  });

  it('opens a new terminal automatically when the terminal a step should return to is gone', async () => {
    let attaches = 0;
    const { ctx, run, script } = await runLoop(['continue', 'continue', 'complete', 'complete', 'complete'], {
      overrides: {
        terminalAvailable: vi.fn((sessionId) => !(attaches >= 2 && sessionId === 'Demo-1')),
        engineExtras: {
          terminalInFolder: vi.fn(async (sessionId) => {
            if (attaches >= 2 && sessionId === 'Demo-1') {
              throw new Error("Command failed: tmux list-panes -t Demo-1:0 -F #{pane_index}\ncan't find session: Demo-1");
            }
            return true;
          }),
        },
        attachBackground: vi.fn(() => {
          attaches += 1;
          return { write: () => {}, release: () => {} };
        }),
      },
    });
    expect(run.status).toBe('complete');
    expect(run.error).toBeNull();
    expect(run.steps[0]).toMatchObject({ status: 'complete', sessionId: 'Demo-3', priorSessionIds: ['Demo-1'] });
    expect(ctx.startSession).toHaveBeenCalledTimes(4);
    // Develop round 2 runs in a fresh terminal (no reset); Test returns to its own (reset).
    expect(script.starts.map(start => start.resetFirst)).toEqual([false, false, false, true, false]);
  });

  it('also opens a new terminal when attachBackground fails on a returning step whose terminal just disappeared', async () => {
    let attaches = 0;
    const { ctx, run, script } = await runLoop(['continue', 'continue', 'complete', 'complete', 'complete'], {
      overrides: {
        attachBackground: vi.fn((sessionId) => {
          attaches += 1;
          if (attaches === 3 && sessionId === 'Demo-1') throw new Error('Background attach refused: session is deleted.');
          return { write: () => {}, release: () => {} };
        }),
      },
    });
    expect(run.status).toBe('complete');
    expect(run.error).toBeNull();
    expect(run.steps[0]).toMatchObject({ status: 'complete', sessionId: 'Demo-3', priorSessionIds: ['Demo-1'] });
    expect(ctx.startSession).toHaveBeenCalledTimes(4);
    expect(script.starts.map(start => start.resetFirst)).toEqual([false, false, false, true, false]);
  });

  it('starts the agent again in the terminal a step returns to when it has exited there', async () => {
    const states = [executionState(), executionState(), executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh' })];
    const script = scriptedWorkflow(['continue', 'continue', 'complete', 'complete', 'complete']);
    const ctx = setupEngine({
      createWorkflow: script.createWorkflow,
      attachBackground: vi.fn(() => ({ write: (data) => { ctx.writes.push(data); }, release: () => {} })),
      readExecutionState: vi.fn(async () => states.shift() ?? executionState()),
    });
    const created = ctx.runStore.create(validRun({ definition: looping() }));
    const done = ctx.engine.start(created.id);
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(1100);
    await done;

    const run = ctx.runStore.get(created.id);
    expect(run.error).toBeNull();
    expect(run.status).toBe('complete');
    expect(ctx.startSession).toHaveBeenCalledTimes(3);
    expect(run.steps.map(s => s.sessionId)).toEqual(['Demo-1', 'Demo-2', 'Demo-3']);
    // Develop is launched a second time in its own terminal, so round 2 starts without a reset.
    expect(ctx.writes.filter(data => data === 'codex')).toHaveLength(4);
    expect(script.starts.map(start => start.resetFirst)).toEqual([false, false, false, true, false]);
  });

  it('Resume gives a step that failed when its terminal closed while launching a new terminal and launches its agent there', async () => {
    let pollCount = 0;
    const outcomes = ['continue', 'continue', 'complete', 'complete', 'complete'];
    const script = scriptedWorkflow(outcomes);
    const ctx = setupEngine({
      createWorkflow: script.createWorkflow,
      attachBackground: vi.fn(() => ({ write: (data) => { ctx.writes.push(data); }, release: () => {} })),
      readExecutionState: vi.fn(async () => {
        pollCount += 1;
        // On round 2 of Develop (3rd step execution), the terminal closes during readiness check.
        if (pollCount === 3) return executionState({ entryExists: false, ptyAlive: false });
        return executionState();
      }),
      terminalAvailable: vi.fn((sessionId) => !(pollCount >= 3 && sessionId === 'Demo-1')),
    });
    const created = ctx.runStore.create(validRun({ definition: looping(), worktreeState: 'external', baseCommit: BASE_COMMIT }));
    const done = ctx.engine.start(created.id);
    for (let i = 0; i < 4; i += 1) await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(ctx.runStore.get(created.id).status).toBe('error');

    await ctx.engine.resume(created.id);
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);
    const resumed = ctx.runStore.get(created.id);
    expect(resumed.status).toBe('complete');
    expect(resumed.steps[0]).toMatchObject({ sessionId: 'Demo-3', priorSessionIds: ['Demo-1'] });
    expect(resumed.steps[1]).toMatchObject({ sessionId: 'Demo-2', roundsCompleted: 1 });
    // Develop round 2 runs in a fresh terminal (no reset); Test returns to its own (reset).
    expect(script.starts.map(start => start.resetFirst)).toEqual([false, false, false, true, false]);
  });
});

describe('createRunEngine — agents decide', () => {
  const ID = 'fd4ed49c-1';
  const QUESTIONS = '1. Which schema should the migration target?\nRecommended: the existing guardian schema.';
  const SCREEN = [
    `• [[CDW:${ID}:QUESTIONS]]`,
    '  1. Which schema should the migration target?',
    '     Recommended: the existing guardian schema.',
    `• [[CDW:${ID}:NEEDS_INPUT]]`,
  ];
  const ANSWER = 'Proceed with your recommendations.';
  const DECIDE = 'The owner is not available during this run. Do not stop for a decision you can make yourself: choose the option you would recommend, write down the decision and your reason where this project keeps such notes, and continue. Use NEEDS_INPUT only when you cannot continue at all.';
  const all = { offset: 0, limit: 100, direction: 'asc' };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  // A loop that signals NEEDS_INPUT on start, returns to running on an answer and completes on demand.
  function askingWorkflow() {
    const state = { status: 'stopped', inputs: [], notify: null, identifier: ID, starts: [] };
    const snap = status => ({ status, active: !['complete', 'stopped'].includes(status), error: null, requestId: 'r', iteration: 1, limitReached: false });
    const publish = (status) => { state.status = status; state.notify(snap(status)); };
    const createWorkflow = vi.fn(({ notify }) => {
      state.notify = notify;
      return {
        start(args) { state.starts.push(args); queueMicrotask(() => publish('needs_input')); },
        stop() { state.status = 'stopped'; },
        snapshot: () => snap(state.status),
        answerText: text => text,
        input(data) { state.inputs.push(data); publish('running'); },
        signalIdentifier: () => state.identifier,
      };
    });
    return { createWorkflow, state, ask: () => publish('needs_input'), complete: () => publish('complete') };
  }

  async function startAsking({ agentsDecide = true, overrides = {}, kind = 'node', approval = false, askOwner = false } = {}) {
    const loop = askingWorkflow();
    const ctx = setupEngine({
      createWorkflow: loop.createWorkflow,
      readScreen: vi.fn(async () => SCREEN),
      ...overrides,
    });
    const def = definition({ agentsDecide });
    def.steps[0].kind = kind;
    def.steps[0].approval = approval;
    def.steps[0].askOwner = askOwner;
    const run = ctx.runStore.create(validRun({ definition: def, worktreeState: 'external', baseCommit: BASE_COMMIT }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100); // launch Enter
    await vi.advanceTimersByTimeAsync(1000); // ready → loop starts → NEEDS_INPUT → screen read
    await vi.advanceTimersByTimeAsync(0);
    return { ctx, loop, run, done };
  }

  it('requires somewhere to record decisions', () => {
    expect(() => setupEngine({ engineExtras: { decisionStore: undefined } })).toThrow('createRunEngine: decisionStore is required');
  });

  it('answers a listed request with the recommendations, without pausing the run', async () => {
    const { ctx, loop, run, done } = await startAsking();
    expect(ctx.writes.at(-1)).toBe(`\x1b[200~${ANSWER}\x1b[201~`);
    expect(ctx.runStore.get(run.id).status).toBe('running');

    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.writes.at(-1)).toBe('\r');
    expect(loop.state.inputs).toEqual([ANSWER]);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'running', inputRequest: null });

    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });
  it('leaves the questions of a step marked to always ask the owner for the owner, also when agents decide', async () => {
    const { ctx, loop, run } = await startAsking({ askOwner: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.state.inputs).toEqual([]);
    expect(ctx.decisionStore.count(run.id)).toBe(0);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'needs_input' });
    expect(ctx.runStore.get(run.id).inputRequest.questions).toContain('1.');
  });
  it('agents decide still auto-answers a question but waits for owner approval after completion', async () => {
    const { ctx, loop, run, done } = await startAsking({ approval: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.state.inputs).toEqual([ANSWER]);
    expect(ctx.decisionStore.count(run.id)).toBe(1);
    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('awaiting_approval');
    expect(ctx.reviewStore.list(run.id)).toEqual([]);
  });

  it('records what was asked and what was answered', async () => {
    const { ctx, run } = await startAsking();
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.decisionStore.list(run.id, all)).toEqual([expect.objectContaining({
      runId: run.id, stepIndex: 0, stepName: 'Develop', pass: 1, questions: QUESTIONS, truncated: false, answer: ANSWER,
    })]);
  });

  it('tells the agent to decide for itself', async () => {
    const { loop } = await startAsking();
    expect(loop.state.starts[0].guidance).toBe(`${BOUNDARY} ${DECIDE}`);
  });

  it('pauses for the owner when the agent asks again in the same pass', async () => {
    const { ctx, loop, run } = await startAsking();
    await vi.advanceTimersByTimeAsync(100);
    loop.ask();
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'needs_input', inputRequest: { questions: QUESTIONS, truncated: false } });
    expect(ctx.decisionStore.count(run.id)).toBe(1);
    expect(loop.state.inputs).toEqual([ANSWER]);
  });

  it('answers again in a later pass', async () => {
    const second = 'fd4ed49c-2';
    const readScreen = vi.fn()
      .mockResolvedValueOnce(SCREEN)
      .mockResolvedValueOnce([`[[CDW:${second}:QUESTIONS]]`, '1. And the index name?', 'Recommended: idx_guardian', `[[CDW:${second}:NEEDS_INPUT]]`]);
    const { ctx, loop, run } = await startAsking({ overrides: { readScreen } });
    await vi.advanceTimersByTimeAsync(100);
    loop.state.identifier = second;
    loop.ask();
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.runStore.get(run.id).status).toBe('running');
    expect(ctx.decisionStore.list(run.id, all).map(d => d.questions)).toEqual([QUESTIONS, '1. And the index name?\nRecommended: idx_guardian']);
    expect(loop.state.inputs).toEqual([ANSWER, ANSWER]);
  });

  it('pauses for the owner when the agent did not list what it needs', async () => {
    const { ctx, loop, run } = await startAsking({ overrides: { readScreen: vi.fn(async () => ['I am blocked.', `[[CDW:${ID}:NEEDS_INPUT]]`]) } });
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'needs_input', inputRequest: { questions: null, truncated: false } });
    expect(ctx.decisionStore.count(run.id)).toBe(0);
    expect(loop.state.inputs).toEqual([]);
  });

  it('pauses for the owner when the workflow leaves decisions to the owner', async () => {
    const { ctx, loop, run } = await startAsking({ agentsDecide: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.runStore.get(run.id).status).toBe('needs_input');
    expect(ctx.decisionStore.count(run.id)).toBe(0);
    expect(loop.state.starts[0].guidance).toBe(BOUNDARY);
  });

  it('pauses for the owner when Setup asks, even when agents decide', async () => {
    const { ctx, loop, run } = await startAsking({ kind: 'setup', role: '', askOwner: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.runStore.get(run.id).status).toBe('needs_input');
    expect(ctx.decisionStore.count(run.id)).toBe(0);
    expect(loop.state.starts[0]).not.toHaveProperty('guidance');
  });

  it('records that the list was cut when it was too long to keep whole', async () => {
    const long = [`[[CDW:${ID}:QUESTIONS]]`, `1. ${'x'.repeat(4100)}`, `[[CDW:${ID}:NEEDS_INPUT]]`];
    const { ctx, run } = await startAsking({ overrides: { readScreen: vi.fn(async () => long) } });
    await vi.advanceTimersByTimeAsync(100);
    const [decision] = ctx.decisionStore.list(run.id, all);
    expect(decision.truncated).toBe(true);
    expect(decision.questions).toHaveLength(4000);
  });

  it('sends no Enter and records nothing when the run is stopped while the answer is being typed', async () => {
    const { ctx, loop, run } = await startAsking();
    const before = ctx.writes.length;
    await ctx.engine.stop(run.id);
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.writes.slice(before)).toEqual([]);
    expect(ctx.decisionStore.count(run.id)).toBe(0);
    expect(loop.state.inputs).toEqual([]);
    expect(ctx.runStore.get(run.id).status).toBe('stopped');
  });

  it('fails the run, without submitting the answer, when the decision cannot be recorded', async () => {
    const decisionStore = { add: vi.fn(() => { throw new Error('disk full'); }), count: () => 0, list: () => [] };
    const { ctx, loop, run } = await startAsking({ overrides: { decisionStore } });
    const before = ctx.writes.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(ctx.writes.slice(before)).toEqual([]);
    expect(loop.state.inputs).toEqual([]);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error', error: 'disk full' });
  });
});

describe('createRunEngine — a dialog the agent shows during a pass', () => {
  const DIALOG = () => executionState({ executionReason: 'agent_needs_input' });
  const WORKING = () => executionState({ executionReason: 'agent_working', profile: { promptVisible: () => false } });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  // A loop that keeps running until told otherwise.
  function runningWorkflow() {
    const state = { status: 'stopped', notify: null };
    const snap = status => ({ status, active: !['complete', 'stopped'].includes(status), error: null, requestId: 'r', iteration: 1, limitReached: false });
    const publish = (status) => { state.status = status; state.notify(snap(status)); };
    const createWorkflow = vi.fn(({ notify }) => {
      state.notify = notify;
      return {
        start() { queueMicrotask(() => publish('running')); },
        stop() { state.status = 'stopped'; },
        snapshot: () => snap(state.status),
        signalIdentifier: () => 'abc-1',
        answerText: text => text,
        input() { publish('running'); },
      };
    });
    return { createWorkflow, ask: () => publish('needs_input'), complete: () => publish('complete') };
  }

  // The prompt has been sent and the agent is working; `afterReady` is what the terminal shows next.
  async function startWorking(afterReady, overrides = {}) {
    const loop = runningWorkflow();
    const ctx = setupEngine({
      readinessQueue: [executionState(), ...afterReady],
      createWorkflow: loop.createWorkflow,
      engineExtras: { dialogPollMs: 2000 },
      ...overrides,
    });
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100); // launch Enter
    await vi.advanceTimersByTimeAsync(1000); // ready → prompt sent
    await vi.advanceTimersByTimeAsync(0);
    return { ctx, loop, run, done };
  }

  it('pauses the run after two consecutive dialog readings and continues once it is answered in the terminal', async () => {
    const { ctx, loop, run, done } = await startWorking([DIALOG(), DIALOG(), DIALOG(), WORKING()]);
    expect(ctx.runStore.get(run.id).status).toBe('running');

    // First reading alone does not pause (debounces transient TUI redraws).
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.runStore.get(run.id).status).toBe('running');

    await vi.advanceTimersByTimeAsync(2000);
    const paused = ctx.runStore.get(run.id);
    expect(paused).toMatchObject({ status: 'needs_input', inputRequest: null });
    expect(paused.steps[0].status).toBe('needs_input');
    // Nothing the agent signalled: the dialog is answered in the terminal, not from the runs bar.
    await expect(ctx.engine.answer(run.id, 'yes')).rejects.toMatchObject({ code: 'ACTION_REFUSED' });

    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.runStore.get(run.id).status).toBe('needs_input');

    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'running', inputRequest: null });

    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });

  it('ignores a single transient dialog reading so TUI redraws do not flap needs_input', async () => {
    const { ctx, loop, run, done } = await startWorking([DIALOG(), WORKING(), DIALOG(), WORKING()]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(ctx.runStore.get(run.id).status).toBe('running');
    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });

  it('completes the step when the agent finishes while the run is still marked as showing a dialog', async () => {
    const { ctx, loop, run, done } = await startWorking([DIALOG(), DIALOG()]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(ctx.runStore.get(run.id).status).toBe('needs_input');

    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });

  it('replaces the dialog pause with what the agent asks when it signals NEEDS_INPUT', async () => {
    const screen = ['[[CDW:abc-1:QUESTIONS]]', '1. Which schema?', 'Recommended: guardian.', '[[CDW:abc-1:NEEDS_INPUT]]'];
    const { ctx, loop, run } = await startWorking([DIALOG(), DIALOG()], { readScreen: vi.fn(async () => screen) });
    await vi.advanceTimersByTimeAsync(4000);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'needs_input', inputRequest: null });

    loop.ask();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.runStore.get(run.id)).toMatchObject({
      status: 'needs_input',
      inputRequest: { questions: '1. Which schema?\nRecommended: guardian.', truncated: false },
    });
  });

  it('leaves a request the agent signalled alone, whatever the terminal shows', async () => {
    const screen = ['[[CDW:abc-1:QUESTIONS]]', '1. Which schema?', 'Recommended: guardian.', '[[CDW:abc-1:NEEDS_INPUT]]'];
    const { ctx, loop, run } = await startWorking([DIALOG(), WORKING()], { readScreen: vi.fn(async () => screen) });
    loop.ask();
    await vi.advanceTimersByTimeAsync(0);
    const asked = ctx.runStore.get(run.id);
    expect(asked.inputRequest).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2000); // terminal shows a dialog
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'needs_input', inputRequest: asked.inputRequest });
    await vi.advanceTimersByTimeAsync(2000); // dialog gone
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'needs_input', inputRequest: asked.inputRequest });
  });

  it('stops watching the terminal when the step ends', async () => {
    const { ctx, loop, run, done } = await startWorking([WORKING()]);
    await vi.advanceTimersByTimeAsync(2000);
    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');

    const reads = ctx.readExecutionState.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.readExecutionState.mock.calls.length).toBe(reads);
  });

  it('fails the run when the pause cannot be recorded', async () => {
    const { ctx, run, done } = await startWorking([DIALOG(), DIALOG()]);
    const update = ctx.runStore.update;
    ctx.runStore.update = vi.fn((id, patch) => {
      if (patch.status === 'needs_input') throw new Error('disk full');
      return update(id, patch);
    });
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error', error: 'disk full' });
  });
});

describe('createRunEngine — a prompt the agent never took', () => {
  const IDLE = () => executionState();
  const WORKING = () => executionState({ executionReason: 'agent_working', profile: { promptVisible: () => false } });
  const GAVE_UP = 'The agent codex did not start step Develop, also after it was started again in its terminal: it stays idle at an unchanged prompt and takes no input. Check the terminal, then Resume.';
  const SHELL = () => executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', profile: null, lines: ['me@host demo %'] });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  // A loop whose pass stays running until the test moves it on.
  function passLoop() {
    const state = { status: 'stopped', iteration: 0, notify: null };
    const snap = () => ({ status: state.status, active: !['complete', 'stopped'].includes(state.status), error: null, requestId: 'r', iteration: state.iteration, limitReached: false });
    const publish = (status) => { state.status = status; state.notify(snap()); };
    const resubmit = vi.fn();
    const submitDraft = vi.fn();
    const promptUntaken = vi.fn(() => true);
    const stop = vi.fn(() => publish('stopped'));
    const starts = [];
    const createWorkflow = vi.fn(({ notify }) => {
      state.notify = notify;
      return {
        start(args) { starts.push(args); state.iteration = 1; queueMicrotask(() => publish('running')); },
        stop,
        resubmit,
        submitDraft,
        promptUntaken,
        snapshot: snap,
        signalIdentifier: () => 'abc-1',
        answerText: text => text,
        input() { publish('running'); },
      };
    });
    return {
      createWorkflow, resubmit, submitDraft, promptUntaken, stop, starts,
      ask: () => publish('needs_input'),
      answered: () => publish('running'),
      nextPass: () => { state.iteration += 1; publish('running'); },
      complete: () => publish('complete'),
    };
  }

  async function startPass(screens = [], extras = {}) {
    const loop = passLoop();
    const ctx = setupEngine({
      readinessQueue: [executionState(), ...screens],
      createWorkflow: loop.createWorkflow,
      engineExtras: { dialogPollMs: 2000, promptPickupMs: 10_000, ...extras },
    });
    const run = ctx.runStore.create(validRun());
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100); // launch Enter
    await vi.advanceTimersByTimeAsync(1000); // ready → prompt sent
    await vi.advanceTimersByTimeAsync(0);
    return { ctx, loop, run, done };
  }

  const welcome = [
    '  Muse Code 1.4.25',
    '  warning: rules file at /tmp/project/CLAUDE.md is ignored this session because',
    '  AGENTS.md takes precedence in that directory',
    '  Skills: 101 loaded · 1 warning · 27 details hidden (ctrl+o to expand)',
    '  To continue this session, run muse resume 01a20581-0d86-77d1-88c4-79a45d747472',
    '── Voice input (alt(option)+v to start) ──────', '❯', '──────────────────',
    '  muse-spark-1.3 · high · ~/git/project · YOLO',
  ];
  const museScreens = lines => Array.from({length: 20}, () => executionState({lines, profile: muse, foregroundCommand: 'muse-bin-1.4.25'}));

  it('uses the live lost-prompt setting for a running pass', async () => {
    let timeouts = { ...TIMEOUTS, lostPromptSeconds: 30 };
    const { loop } = await startPass([], { promptPickupMs: undefined, readTimeouts: () => timeouts });
    await vi.advanceTimersByTimeAsync(8000);
    expect(loop.resubmit).not.toHaveBeenCalled();
    timeouts = { ...timeouts, lostPromptSeconds: 5 };
    await vi.advanceTimersByTimeAsync(2000);
    expect(loop.resubmit).toHaveBeenCalledTimes(1);
  });

  it('uses the configured stall-warning duration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const working = Array.from({ length: 40 }, () => WORKING());
      const { run } = await startPass(working, { promptPickupMs: undefined, readTimeouts: () => ({ ...TIMEOUTS, stallWarningMinutes: 1 }) });
      await vi.advanceTimersByTimeAsync(62_000);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${run.id}: step Develop has shown no screen change`));
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['with a resume hint', welcome],
    ['below the shell launch command', ['bash-3.2$ muse --model muse-spark-1.3-contributor --effort high --yolo', ...welcome]],
    ['without a warning or resume hint', welcome.filter((_, i) => ![1, 2, 4].includes(i))],
  ])('recovers a dropped prompt on an empty Muse welcome %s', async (_, lines) => {
    const restartAgentTerminal = vi.fn(async () => {});
    const {ctx, run, loop} = await startPass(museScreens(lines), {promptPickupMs: 30_000, restartAgentTerminal});
    await vi.advanceTimersByTimeAsync(4000);
    expect(loop.resubmit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(loop.resubmit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(restartAgentTerminal).toHaveBeenCalledTimes(1);
    const events = ctx.runStore.auditPage(run.id, {page:0, size:50, direction:'asc', stepIndex:0}).data;
    expect(events.filter(e => e.kind === 'prompt_unclaimed').map(e => e.detail)).toEqual([
      'Empty Muse welcome unchanged for 4000 ms. Retrying prompt delivery.',
      'Empty Muse welcome unchanged for 4000 ms. Restarting agent.',
    ]);
  });

  it('fails at once, naming the link, when the terminal connection waits at a Tailscale SSH check', async () => {
    const restartAgentTerminal = vi.fn(async () => {});
    const link = 'https://login.tailscale.com/a/0123456789abcd';
    const inspectTerminal = vi.fn(async () => ({ pane: {}, attachment: { alive: true, sshAuthCheck: link } }));
    const { ctx, run, loop } = await startPass(museScreens(welcome), { promptPickupMs: 30_000, restartAgentTerminal, inspectTerminal });
    await vi.advanceTimersByTimeAsync(6000);
    expect(inspectTerminal).toHaveBeenCalledWith('Demo-1');
    expect(loop.resubmit).not.toHaveBeenCalled();
    expect(restartAgentTerminal).not.toHaveBeenCalled();
    expect(ctx.runStore.get(run.id)).toMatchObject({
      status: 'error',
      error: `The prompt for step Develop cannot reach agent codex: the SSH connection to its terminal Demo-1 is waiting for Tailscale SSH authentication. Approve it at ${link}, reload the terminal, then Resume.`,
    });
  });

  it('retries as before when the terminal connection shows no SSH check', async () => {
    const inspectTerminal = vi.fn(async () => ({ pane: {}, attachment: { alive: true, sshAuthCheck: null } }));
    const { loop } = await startPass(museScreens(welcome), { promptPickupMs: 30_000, inspectTerminal });
    await vi.advanceTimersByTimeAsync(6000);
    expect(loop.resubmit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a staged draft', welcome.map(line => line === '❯' ? '❯ pending instructions' : line)],
    ['a prior turn', [...welcome.slice(0, 5), '◆ Worked for 23m 34s', ...welcome.slice(5)]],
    ['an unrecognized footer', [...welcome, 'Choose an action']],
    ['a partial screen', welcome.slice(3)],
  ])('keeps the regular pickup window for %s', async (_, lines) => {
    const {loop} = await startPass(museScreens(lines), {promptPickupMs: 30_000});
    await vi.advanceTimersByTimeAsync(12_000);
    expect(loop.resubmit).not.toHaveBeenCalled();
  });

  // Seen live: Muse took the Enter after a long paste as a newline, so the whole prompt sat
  // unsent in its input box, scrolled so that its `❯` line was off screen.
  it('presses Enter when the prompt sits unsent in a Muse input box taller than the screen', async () => {
    const rule = '─'.repeat(60);
    const draft = [
      '── Voice input (alt(option)+v to start) ──────',
      '  item-one | src/demo/one.py | Return each failed field.',
      '  [Pasted Content 2867 chars]',
      '  Iteration identifier: e2be7a47-1',
      '',
      rule,
      '  muse-spark-1.3 · medium · ~/work/demo · YOLO',
    ];
    const {ctx, run, loop} = await startPass(museScreens(draft), {promptPickupMs: 30_000});
    // An unsent draft is plain on screen, so it gets the short grace, not the lost-prompt window.
    await vi.advanceTimersByTimeAsync(4000);
    expect(loop.submitDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(loop.submitDraft).toHaveBeenCalledTimes(1);
    expect(loop.resubmit).not.toHaveBeenCalled();
    const events = ctx.runStore.auditPage(run.id, {page:0, size:50, direction:'asc', stepIndex:0}).data;
    expect(events.filter(e => e.kind === 'prompt_unclaimed').map(e => e.detail)[0])
      .toBe('Unsent draft unchanged for 4000 ms. Pressing Enter.');
  });

  it('leaves text in the Muse input box alone once the agent has taken its prompt', async () => {
    const draft = [
      '── Voice input (alt(option)+v to start) ──────', '❯ something the owner is typing', '',
      '─'.repeat(60), '  muse-spark-1.3 · medium · ~/work/demo · YOLO',
    ];
    const {loop} = await startPass(museScreens(draft), {promptPickupMs: 30_000});
    loop.promptUntaken.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(loop.submitDraft).not.toHaveBeenCalled();
  });

  it('sends the prompt again when the agent stays idle at an unchanged prompt after it was sent', async () => {
    const { ctx, loop, run, done } = await startPass();
    // The first look sets what the screen shows; ten seconds unchanged after it count.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loop.resubmit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(loop.resubmit).toHaveBeenCalledTimes(1);
    expect(ctx.runStore.get(run.id).status).toBe('running');

    ctx.setReadinessQueue(Array.from({ length: 40 }, WORKING));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loop.resubmit).toHaveBeenCalledTimes(1);
    expect(ctx.runStore.get(run.id).status).toBe('running');

    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });

  it('starts the agent again in its terminal when it does not take the prompt sent a second time', async () => {
    const restartAgentTerminal = vi.fn(async () => {});
    const { ctx, loop, run } = await startPass([], { restartAgentTerminal });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(loop.resubmit).toHaveBeenCalledTimes(1);
    const writesBefore = ctx.writes.length;
    // After the restart the terminal shows its shell, then the relaunched agent at its prompt.
    ctx.setReadinessQueue([...Array.from({ length: 5 }, IDLE), SHELL(), IDLE(), ...Array.from({ length: 40 }, WORKING)]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loop.stop).toHaveBeenCalled();
    expect(restartAgentTerminal).toHaveBeenCalledWith('Demo-1', '/tmp/worktrees/home-feature-abcd1234');
    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.writes.slice(writesBefore)).toContain('codex');
    expect(loop.createWorkflow).toHaveBeenCalledTimes(2);
    // A newly started agent has no context to clear: the prompt goes straight in.
    expect(loop.starts).toHaveLength(2);
    expect(loop.starts[1].resetFirst).toBe(false);
    expect(loop.starts[1].requestId).not.toBe(loop.starts[0].requestId);
    const after = ctx.runStore.get(run.id);
    expect(after.status).toBe('running');
    expect(after.steps[0]).toMatchObject({ status: 'running', sessionId: 'Demo-1', attempt: 2, iteration: 1 });
  });

  it('fails the run when the agent started again also takes no prompt', async () => {
    const restartAgentTerminal = vi.fn(async () => {});
    const { ctx, loop, run, done } = await startPass([], { restartAgentTerminal });
    await vi.advanceTimersByTimeAsync(12_000);
    ctx.setReadinessQueue([...Array.from({ length: 5 }, IDLE), SHELL()]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restartAgentTerminal).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ctx.runStore.get(run.id).steps[0]).toMatchObject({ status: 'running', attempt: 2 });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(loop.resubmit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(restartAgentTerminal).toHaveBeenCalledTimes(1);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error', error: GAVE_UP });
  });

  it('fails the run, naming the reason, when its terminal cannot be started again', async () => {
    const restartAgentTerminal = vi.fn(async () => { throw new Error('respawn-pane failed'); });
    const { ctx, run, done } = await startPass([], { restartAgentTerminal });
    await vi.advanceTimersByTimeAsync(22_000);
    await done;
    expect(ctx.runStore.get(run.id)).toMatchObject({
      status: 'error',
      error: 'The agent codex did not take the prompt of step Develop, and its terminal could not be started again: respawn-pane failed',
    });
  });

  it('does not start the agent again once the owner has stopped the run', async () => {
    const restartAgentTerminal = vi.fn(async () => {});
    const { ctx, loop, run } = await startPass([], { restartAgentTerminal });
    await vi.advanceTimersByTimeAsync(12_000);
    await ctx.engine.stop(run.id);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restartAgentTerminal).not.toHaveBeenCalled();
    expect(loop.resubmit).toHaveBeenCalledTimes(1);
    expect(ctx.runStore.get(run.id).status).toBe('stopped');
  });

  it('never sends the prompt again while the agent shows it is working between idle moments', async () => {
    const screens = [];
    for (let round = 0; round < 6; round += 1) screens.push(IDLE(), IDLE(), IDLE(), IDLE(), WORKING());
    const { ctx, loop, run } = await startPass(screens);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loop.resubmit).not.toHaveBeenCalled();
    expect(ctx.runStore.get(run.id).status).toBe('running');
  });

  it('never sends the prompt again while the screen keeps changing at an idle prompt', async () => {
    const screens = Array.from({ length: 30 }, (_, index) => executionState({ lines: [`line ${index}`, '› '] }));
    const { ctx, loop, run } = await startPass(screens);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loop.resubmit).not.toHaveBeenCalled();
    expect(ctx.runStore.get(run.id).status).toBe('running');
  });

  it('leaves a pass alone once its agent has asked for input, also after the answer', async () => {
    const screen = ['[[CDW:abc-1:QUESTIONS]]', '1. Which schema?', 'Recommended: guardian.', '[[CDW:abc-1:NEEDS_INPUT]]'];
    const loop = passLoop();
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: loop.createWorkflow,
      readScreen: vi.fn(async () => screen),
      engineExtras: { dialogPollMs: 2000, promptPickupMs: 10_000 },
    });
    const run = ctx.runStore.create(validRun());
    ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);
    loop.ask();
    await vi.advanceTimersByTimeAsync(30_000);
    loop.answered();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(loop.resubmit).not.toHaveBeenCalled();
    expect(ctx.runStore.get(run.id).status).not.toBe('error');
  });

  it('gives each new pass its own resend', async () => {
    const { ctx, loop, run } = await startPass();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(loop.resubmit).toHaveBeenCalledTimes(1);
    loop.nextPass();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(loop.resubmit).toHaveBeenCalledTimes(2);
    expect(ctx.runStore.get(run.id).status).toBe('running');
  });
});

// Opt-in, one real local model turn. Lose only the first task paste and its Enter.
it.skipIf(process.env.CODEDECK_MUSE_PICKUP_CANARY !== '1')('recovers one dropped paste in a live local Muse terminal', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-pickup-'));
  const socket = 'cd-' + randomUUID();
  const tmux = (args, input) => execFileSync('tmux', ['-L', socket, ...args], {input, encoding: 'utf8', timeout: 5000});
  let workflow;
  let pastes = 0;
  let skipEnter = false;
  const ctx = setupEngine({
    classifyReadiness,
    readinessPollMs: 500,
    createWorkflow: options => (workflow = createTerminalWorkflow({ ...options, resetTimeoutMs: 15000, handoffIdleMs: 24000 })),
    attachBackground: () => ({
      release() {},
      write(data) {
        if (data.startsWith('\x1b[200~')) {
          pastes++;
          if (pastes === 1) { skipEnter = true; return; }
          tmux(['load-buffer', '-'], data.slice(6, -6));
          tmux(['paste-buffer', '-dp', '-t', 'sample']);
        } else if (data === '\r') {
          if (!skipEnter) tmux(['send-keys', '-t', 'sample', 'Enter']);
          skipEnter = false;
        } else {
          tmux(['send-keys', '-t', 'sample', '-l', data]);
        }
      },
    }),
    readExecutionState: async () => {
      const foregroundCommand = tmux(['display', '-p', '-t', 'sample', '#{pane_current_command}']).trim();
      const snapshotText = tmux(['capture-pane', '-p', '-t', 'sample']);
      const lines = snapshotText.split('\n');
      const state = classifyTerminalExecution({paneCurrentCommand: foregroundCommand, paneDead: 0, snapshotText, subagentPanes: [], quietSeconds: 0});
      workflow?.replayScreen(snapshotText);
      return {...state, lines, profile: findAgentProfile({foregroundCommand, lines}), isAlive:true, entryExists:true};
    },
  });
  const def = definition();
  def.steps[0].prompt = 'Transport check. Use no tools. Reply immediately with the required COMPLETE signal.';
  def.steps[0].agent = {...def.steps[0].agent, name:'Muse', launchCommand:'muse --model muse-spark-1.3-contributor --effort high --yolo'};
  const run = ctx.runStore.create(validRun({definition:def, homePath:dir, worktreePath:dir}));
  let timeout;
  try {
    execFileSync('git', ['init', '-q', dir]);
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', 'sample', '-x', '150', '-y', '45', '-c', dir, '/bin/bash --noprofile --norc']);
    await Promise.race([ctx.engine.start(run.id), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Muse pickup canary timed out')), 60000);
    })]);
    const events = ctx.runStore.auditPage(run.id, {page:0, size:100, direction:'asc', stepIndex:0}).data;
    console.log(JSON.stringify(events.map(({kind, createdAt, detail}) => ({kind, createdAt, detail}))));
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(events.filter(e => e.kind === 'prompt_submitted')).toHaveLength(2);
    const retries = events.filter(e => e.kind === 'prompt_unclaimed');
    expect(retries).toHaveLength(1);
    expect(retries[0].detail).toMatch(/^Empty Muse welcome/);
    expect(Date.parse(retries[0].createdAt) - Date.parse(events.find(e => e.kind === 'prompt_submitted').createdAt)).toBeLessThan(8000);
    expect(events.some(e => e.kind === 'agent_restarted')).toBe(false);
  } finally {
    clearTimeout(timeout);
    try {
      if (ctx.runStore.get(run.id).status === 'running') await ctx.engine.stop(run.id);
    } finally {
      spawnSync('tmux', ['-L', socket, 'kill-server']);
    }
    rmSync(dir, {recursive:true, force:true});
  }
}, 70000);

describe('createRunEngine — a step reuses the terminal of its agent', () => {
  const CODEX = { id: AGENT_ID, name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };
  const FABLE = { id: 'c410a1b2-3456-4789-8abc-def0123456f0', name: 'fable', launchCommand: 'claude --model fable', resetCommand: '/clear' };
  const node = (name, agent) => ({ kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name, prompt: `do ${name}`, repeat: { mode: 'once' }, agent });
  const WORKTREE = '/tmp/worktrees/backend-specs';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  function completing() {
    const starts = [];
    const createWorkflow = vi.fn(({ notify }) => ({
      start(args) {
        starts.push(args);
        queueMicrotask(() => notify({ status: 'complete', active: false, error: null, requestId: args.requestId, iteration: 1, limitReached: false }));
      },
      stop() {},
      snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
    }));
    return { starts, createWorkflow };
  }

  function engineWith(overrides = {}) {
    const script = completing();
    const attached = [];
    const ctx = setupEngine({
      createWorkflow: script.createWorkflow,
      attachBackground: vi.fn((sessionId) => {
        attached.push(sessionId);
        return { write: (data) => { ctx.writes.push(data); }, release: () => {} };
      }),
      ...overrides,
    });
    return { ctx, script, attached };
  }

  async function runToEnd(ctx, runInput, polls = 6) {
    const created = ctx.runStore.create(validRun({ worktreeState: 'external', baseCommit: BASE_COMMIT, worktreePath: WORKTREE, ...runInput }));
    const done = ctx.engine.start(created.id);
    for (let i = 0; i < polls; i += 1) await vi.advanceTimersByTimeAsync(1100);
    await done;
    return ctx.runStore.get(created.id);
  }

  /** A run that already ended in the same worktree and left `sessionIds` open, one per step. */
  function earlierRun(ctx, steps, sessionIds, overrides = {}) {
    const created = ctx.runStore.create(validRun({
      requestId: `earlier-${sessionIds.join('-')}`,
      definition: definition({ steps }),
      worktreeState: 'external',
      baseCommit: BASE_COMMIT,
      worktreePath: WORKTREE,
      ...overrides.create,
    }));
    return ctx.runStore.update(created.id, {
      status: 'stopped',
      stopReason: 'user',
      finishedAt: new Date().toISOString(),
      worktreeState: 'released',
      steps: sessionIds.map(sessionId => step({ status: 'complete', sessionId, attempt: 1 })),
      ...overrides.update,
    });
  }

  it('runs the next step with the same agent in the same terminal, clearing the agent first', async () => {
    const { ctx, script, attached } = engineWith();
    const run = await runToEnd(ctx, { definition: definition({ steps: [node('Review', FABLE), node('Test', FABLE)] }) });

    expect(run.status).toBe('complete');
    expect(ctx.startSession).toHaveBeenCalledTimes(1);
    expect(run.steps.map(s => s.sessionId)).toEqual(['Demo-1', 'Demo-1']);
    expect(attached).toEqual(['Demo-1', 'Demo-1']);
    // The agent is launched once; the second step clears it and sends its own prompt.
    expect(ctx.writes.filter(data => data === 'claude --model fable')).toHaveLength(1);
    expect(script.starts.map(start => [start.command, start.resetFirst])).toEqual([['do Review', false], ['do Test', true]]);
  });

  it('gives a step that uses another agent its own terminal', async () => {
    const { ctx, script } = engineWith();
    const run = await runToEnd(ctx, {
      definition: definition({ steps: [node('Develop', CODEX), node('Review', FABLE), node('Test', FABLE)] }),
    });

    expect(run.status).toBe('complete');
    expect(run.steps.map(s => s.sessionId)).toEqual(['Demo-1', 'Demo-2', 'Demo-2']);
    expect(ctx.startSession).toHaveBeenCalledTimes(2);
    expect(script.starts.map(start => start.resetFirst)).toEqual([false, false, true]);
  });

  it('uses changed readiness settings for the next step without recreating the engine', async () => {
    let timeouts = TIMEOUTS;
    let firstStepComplete = false;
    const waiting = executionState({ executionReason: 'agent_marker_stale', foregroundCommand: 'claude', profile: { promptVisible: () => false } });
    const { ctx } = engineWith({
      readTimeouts: () => timeouts,
      readExecutionState: async () => firstStepComplete ? waiting : executionState(),
      createWorkflow: ({ notify }) => ({
        start(args) {
          timeouts = { ...TIMEOUTS, agentReadySeconds: 10 };
          firstStepComplete = true;
          queueMicrotask(() => notify({ status: 'complete', active: false, error: null, requestId: args.requestId, iteration: 1, limitReached: false }));
        },
        stop() {},
        snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
      }),
    });
    const run = await runToEnd(ctx, { definition: definition({ steps: [node('Develop', CODEX), node('Review', FABLE)] }) }, 15);
    expect(run.status).toBe('error');
    expect(run.error).toContain('within 10 seconds');
    expect(ctx.startSession).toHaveBeenCalledTimes(2);
  });

  it('applies current, sibling, finished and closed muting without touching an unrelated terminal', async () => {
    const calls = [];
    const { ctx } = engineWith({ setTerminalMuted: vi.fn((id, muted) => { calls.push([id, muted]); return true; }) });
    const run = await runToEnd(ctx, {
      definition: definition({ steps: [node('Develop', CODEX), node('Review', FABLE), node('Test', FABLE)] }),
    });
    expect(calls).toContainEqual(['Demo-1', false]);
    expect(calls).toContainEqual(['Demo-1', true]);
    expect(calls).toContainEqual(['Demo-2', false]);
    expect(calls).toContainEqual(['Demo-2', true]);
    // Finished and still shown on its task: every terminal of the run is muted.
    expect(calls.at(-2)).toEqual(['Demo-1', true]);
    expect(calls.at(-1)).toEqual(['Demo-2', true]);
    expect(run.worktreeState).toBe('external');
    // Closing the run lifts the muting.
    expect((await ctx.engine.cleanup(run.id)).worktreeState).toBe('released');
    expect(calls.at(-2)).toEqual(['Demo-1', false]);
    expect(calls.at(-1)).toEqual(['Demo-2', false]);
    expect(calls.some(([id]) => id === 'Other-1')).toBe(false);
  });

  it('retries an unobserved terminal on the next transition', async () => {
    const calls = [];
    const { ctx } = engineWith({ setTerminalMuted: vi.fn((id, muted) => { calls.push([id, muted]); return calls.length > 1; }) });
    await runToEnd(ctx, { definition: definition({ steps: [node('Develop', CODEX)] }) });
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]).toEqual(['Demo-1', false]);
    expect(calls[1]).toEqual(['Demo-1', false]);
  });

  it('warns once for a failing terminal and still finishes the run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { ctx } = engineWith({ setTerminalMuted: vi.fn(() => { throw new Error('tracker unavailable'); }) });
      const run = await runToEnd(ctx, { definition: definition({ steps: [node('Develop', CODEX)] }) });
      expect(run.status).toBe('complete');
      expect(warn.mock.calls.filter(([message]) => String(message).startsWith('[pipeline-terminal-muting]'))).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it('treats the same agent with another launch command as another agent', async () => {
    const { ctx } = engineWith();
    const run = await runToEnd(ctx, {
      definition: definition({ steps: [node('Review', FABLE), node('Test', { ...FABLE, launchCommand: 'claude --model opus' })] }),
    });
    expect(run.steps.map(s => s.sessionId)).toEqual(['Demo-1', 'Demo-2']);
  });

  it('a new run reuses the terminals an earlier run left in the same worktree', async () => {
    const { ctx, script } = engineWith();
    const steps = [node('Develop', CODEX), node('Review', FABLE), node('Test', FABLE)];
    earlierRun(ctx, steps, ['Demo-18', 'Demo-19', 'Demo-20']);

    const run = await runToEnd(ctx, { definition: definition({ steps }) });

    expect(run.status).toBe('complete');
    expect(ctx.startSession).not.toHaveBeenCalled();
    // The terminal that agent used last is taken; Test then shares the one Review took.
    expect(run.steps.map(s => s.sessionId)).toEqual(['Demo-18', 'Demo-20', 'Demo-20']);
    expect(ctx.writes).not.toContain('codex');
    expect(script.starts.map(start => start.resetFirst)).toEqual([true, true, true]);
  });

  it('takes the terminal of the most recent earlier run', async () => {
    let clock = Date.parse('2026-11-14T10:00:00.000Z');
    const { ctx } = engineWith({ now: () => new Date(clock += 1000).toISOString() });
    earlierRun(ctx, [node('Test', FABLE)], ['Demo-4']);
    earlierRun(ctx, [node('Test', FABLE)], ['Demo-7']);

    const run = await runToEnd(ctx, { definition: definition({ steps: [node('Test', FABLE)] }) });
    expect(run.steps[0].sessionId).toBe('Demo-7');
  });

  it('opens a new terminal when the one an earlier run left is gone', async () => {
    const { ctx, script } = engineWith({ terminalAvailable: vi.fn(sessionId => sessionId !== 'Demo-20') });
    earlierRun(ctx, [node('Test', FABLE)], ['Demo-20']);

    const run = await runToEnd(ctx, { definition: definition({ steps: [node('Test', FABLE)] }) });
    expect(run.steps[0].sessionId).toBe('Demo-1');
    expect(ctx.startSession).toHaveBeenCalledTimes(1);
    expect(script.starts[0].resetFirst).toBe(false);
  });

  it('does not take a terminal from a run in another worktree', async () => {
    const { ctx } = engineWith();
    earlierRun(ctx, [node('Test', FABLE)], ['Demo-20'], { create: { worktreePath: '/tmp/worktrees/other' } });

    const run = await runToEnd(ctx, { definition: definition({ steps: [node('Test', FABLE)] }) });
    expect(run.steps[0].sessionId).toBe('Demo-1');
  });

  it('does not take a terminal from a run of another project', async () => {
    const { ctx } = engineWith();
    earlierRun(ctx, [node('Test', FABLE)], ['Other-3'], { create: { project: 'Other' } });

    const run = await runToEnd(ctx, { definition: definition({ steps: [node('Test', FABLE)] }) });
    expect(run.steps[0].sessionId).toBe('Demo-1');
  });

  it.each(['pending', 'running', 'needs_input', 'limit_paused'])('does not take the terminal of a run that is %s', async (status) => {
    const { ctx } = engineWith();
    earlierRun(ctx, [node('Test', FABLE)], ['Demo-20'], {
      update: {
        status,
        stopReason: null,
        finishedAt: null,
        worktreeState: 'external',
        steps: [step({ status: status === 'pending' ? 'pending' : status === 'limit_paused' ? 'limit_reached' : status, sessionId: 'Demo-20', attempt: 1 })],
      },
    });

    const run = await runToEnd(ctx, { definition: definition({ steps: [node('Test', FABLE)] }) });
    expect(run.steps[0].sessionId).toBe('Demo-1');
  });

  it('Resume does not pick a closed shared terminal up again from the other step', async () => {
    // Review and Test shared Demo-9, which was closed.
    const { ctx } = engineWith({ terminalAvailable: vi.fn(sessionId => sessionId !== 'Demo-9') });
    const created = ctx.runStore.create(validRun({
      definition: definition({ steps: [node('Review', FABLE), node('Test', FABLE)] }),
      worktreeState: 'external',
      baseCommit: BASE_COMMIT,
      worktreePath: WORKTREE,
    }));
    ctx.runStore.update(created.id, {
      status: 'error',
      error: 'The terminal for step Test was closed.',
      currentStepIndex: 1,
      finishedAt: new Date().toISOString(),
      steps: [
        step({ status: 'complete', sessionId: 'Demo-9', attempt: 1 }),
        step({ status: 'failed', sessionId: 'Demo-9', attempt: 1 }),
      ],
    });

    await ctx.engine.resume(created.id);
    for (let i = 0; i < 3; i += 1) await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);

    const run = ctx.runStore.get(created.id);
    expect(run.status).toBe('complete');
    expect(ctx.startSession).toHaveBeenCalledTimes(1);
    expect(run.steps[1]).toMatchObject({ sessionId: 'Demo-1', priorSessionIds: ['Demo-9'] });
  });
});

describe('standard final Commit', () => {
  const outcome = '# Watch shows the missing-tag prompt\nBackend verified. Phone prompt deferred by the owner.';
  function prepareRun({ custom = false, approval = false, engineExtras = {}, marker = !custom } = {}) {
    const { backend, mobile } = groupFixture();
    const places = {
      current: 'backend', readOnly: [],
      worktrees: [['backend', backend], ['mobile', mobile]].map(([repository, path]) => ({ repository, path, repositoryPath: path, branch: 'main', baseCommit: git(path, ['rev-parse', 'HEAD']) })),
    };
    const ctx = setupEngine({ readinessPollMs: 1, launchEnterDelayMs: 1, engineExtras: { listRunPlaces: async () => places, ...engineExtras } });
    const test = { ...definition().steps[0], name: 'Test' };
    const commit = { ...test, name: 'Commit', prompt: custom ? 'Write release notes and commit.' : buildTemplateDraft('bug-fix').nodes.at(-1).prompt.replace('{input}', 'ship it'), approval, ...(marker ? { inspectCleanCommit: true } : {}) };
    const def = definition({ workflowName: 'Bug fix', notesDir: '.codedeck/runs/abcdef12', steps: [test, commit] });
    const taskId = '7a000000-0000-4000-8000-000000000001';
    const run = ctx.runStore.create(validRun({ taskId, definition: def, status: 'running', worktreeState: 'external', homePath: backend, worktreePath: backend, worktreeBranch: 'main', baseCommit: places.worktrees[0].baseCommit,
      steps: [step({ status: 'complete', attempt: 1, iteration: 1 }), step()], currentStepIndex: 1 }));
    ctx.noteStore.add({ runId: run.id, stepIndex: 0, stepName: 'Test', attempt: 1, pass: 1, status: 'written', summary: outcome.split('\n')[0].slice(2), content: outcome });
    return { ...ctx, run, places, backend, mobile, taskId };
  }

  it('keeps the verified outcome in one final Changes entry without opening or resetting a terminal', async () => {
    const ctx = prepareRun();
    await ctx.engine.start(ctx.run.id);
    expect(ctx.runStore.get(ctx.run.id)).toMatchObject({ status: 'complete', steps: [{}, { sessionId: null }] });
    expect(ctx.startSession).not.toHaveBeenCalled();
    expect(ctx.attachBackground).not.toHaveBeenCalled();
    expect(ctx.noteStore.count(ctx.run.id, 1)).toBe(1);
    const task = { id: ctx.taskId, title: 'Watch', project: 'Demo', worktrees: ctx.places.worktrees.map(w => ({ ...w, state: 'merged', finishedAt: '2026-11-19T12:00:00Z' })) };
    const changes = createTaskChanges({ taskStore: { list: () => [task] }, noteStore: ctx.noteStore, listRuns: () => ctx.runStore.list() }).list();
    expect(changes).toHaveLength(1);
    expect(changes[0].summary).toBe('Watch shows the missing-tag prompt');
    expect(changes[0].detail).toContain(outcome);
    for (const w of ctx.places.worktrees) {
      expect(changes[0].detail).toContain(w.repository);
      expect(changes[0].detail).toContain(w.baseCommit);
      expect(changes[0].detail).toContain(w.branch);
    }
  });

  it('carries the actual owner response into the final note when verification only summarised the deferral', async () => {
    const ctx = prepareRun();
    const answer = 'Release the backend today. I explicitly defer the paired-phone check until Monday.';
    ctx.answerStore.add({ runId: ctx.run.id, stepIndex: 0, stepName: 'Test', pass: 1, questions: 'Can you check the paired phone?', answer });
    await ctx.engine.start(ctx.run.id);
    expect(ctx.noteStore.lastContent(ctx.run.id, 1)).toContain(answer);
  });

  it('rejects an invalid inspection dependency before starting a run', () => {
    expect(() => setupEngine({ engineExtras: { inspectCommitWorktree: null } })).toThrow(/inspectCommitWorktree/);
  });

  it.each(['untracked', 'staged', 'unstaged', 'custom'])('runs the normal agent for %s work', async mode => {
    const ctx = prepareRun({ custom: mode === 'custom' });
    if (mode === 'untracked') {
      git(ctx.mobile, ['config', 'status.showUntrackedFiles', 'no']);
      writeFileSync(path.join(ctx.mobile, 'new-file'), 'untracked');
    }
    if (['staged', 'unstaged'].includes(mode)) writeFileSync(path.join(ctx.mobile, 'README.md'), 'modified');
    if (mode === 'staged') git(ctx.mobile, ['add', 'README.md']);
    await ctx.engine.start(ctx.run.id);
    expect(ctx.startSession).toHaveBeenCalledOnce();
    expect(ctx.runStore.get(ctx.run.id).status).toBe('complete');
  });

  it.each(['wrong branch', 'missing', 'nested path', 'failed status', 'other repository'])('stops with the repository and reason on %s, even if the first tree is dirty', async mode => {
    const ctx = prepareRun();
    writeFileSync(path.join(ctx.backend, 'pending'), 'work');
    const second = ctx.places.worktrees[1];
    if (mode === 'wrong branch') git(ctx.mobile, ['switch', '-c', 'unexpected']);
    if (mode === 'missing') second.path += '/gone';
    if (mode === 'nested path') { second.path += '/nested'; mkdirSync(second.path); }
    if (mode === 'failed status') writeFileSync(path.join(ctx.mobile, '.git/index'), 'corrupt');
    if (mode === 'other repository') second.repositoryPath = ctx.backend;
    await ctx.engine.start(ctx.run.id);
    expect(ctx.runStore.get(ctx.run.id)).toMatchObject({ status: 'error', steps: [{}, { status: 'failed', attempt: 1 }], error: expect.stringMatching(/mobile.+(branch|gone|root|index|repository)/is) });
    expect(ctx.startSession).not.toHaveBeenCalled();
  });

  it('preserves approval and executes owner feedback in a terminal', async () => {
    const ctx = prepareRun({ approval: true });
    await ctx.engine.start(ctx.run.id);
    expect(ctx.runStore.get(ctx.run.id).status).toBe('awaiting_approval');
    expect(ctx.startSession).not.toHaveBeenCalled();
    await ctx.engine.sendBack(ctx.run.id, 'Please explain the staged rollout');
    await vi.waitFor(() => expect(ctx.runStore.get(ctx.run.id).status).toBe('awaiting_approval'));
    expect(ctx.startSession).toHaveBeenCalledOnce();
  });

  it('discards an inspection stopped in flight and inspects again on resume', async () => {
    const inspected = Promise.withResolvers();
    const release = Promise.withResolvers();
    const inspect = vi.fn(async () => { inspected.resolve(); await release.promise; throw new Error('mobile changed during inspection'); });
    const ctx = prepareRun({ engineExtras: { inspectCommitWorktree: inspect } });
    const running = ctx.engine.start(ctx.run.id);
    await inspected.promise;
    await ctx.engine.stop(ctx.run.id);
    const resumed = ctx.engine.resume(ctx.run.id);
    release.resolve();
    await running;
    await resumed;
    await vi.waitFor(() => expect(ctx.runStore.get(ctx.run.id).status).toBe('error'));
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(ctx.noteStore.count(ctx.run.id, 1)).toBe(0);
    expect(ctx.startSession).not.toHaveBeenCalled();
  });
});

describe('Troubleshoot verification decisions through the runner', () => {
  const question = '1. Backend verified. Phone prompt pending. Can you confirm the missing-tag prompt on a paired phone?';
  const owner = 'Ship the verified backend and explicitly defer the paired-phone check.';
  async function exercise({ omitProof = false, historicalPrompt = false } = {}) {
    const { backend } = groupFixture();
    writeFileSync(path.join(backend, 'legacy.cjs'), 'console.error("E42"); process.exitCode = 1;');
    git(backend, ['add', 'legacy.cjs']);
    git(backend, ['commit', '-m', 'Existing unrelated failure']);
    const draft = buildTemplateDraft('troubleshoot');
    if (historicalPrompt) {
      const verify = draft.nodes.find(node => node.name === 'Verify');
      verify.prompt = verify.prompt.replace('Run focused checks during repair; run the final suite once per changed repository on the final revision. ', '');
    }
    const checkout = { repository: 'backend', path: backend, repositoryPath: backend, branch: 'main', baseCommit: git(backend, ['rev-parse', 'HEAD']) };
    writeFileSync(path.join(backend, 'watch.txt'), 'Backend detects missing tags.');
    git(backend, ['add', 'watch.txt']);
    git(backend, ['commit', '-m', 'Detect missing tags']);
    const head = git(backend, ['rev-parse', 'HEAD']);
    const comparison = [checkout.baseCommit, head].map(revision => spawnSync(process.execPath, ['-'], {
      cwd: backend, input: git(backend, ['show', revision + ':legacy.cjs']), encoding: 'utf8',
    }));
    for (const result of comparison) expect(result).toMatchObject({ status: 1, stderr: 'E42\n' });
    const def = definition({ workflowName: draft.name, agentsDecide: true, notesDir: '.codedeck/runs/abcdef12',
      steps: draft.nodes.map((node, index) => ({
        ...definition().steps[0], name: node.name, prompt: node.prompt, readOnly: node.readOnly, askOwner: node.askOwner, approval: node.approval,
        repeat: node.repeat.mode === 'loop_back' ? { mode: 'loop_back', toStepIndex: draft.nodes.findIndex(n => n.name === node.repeat.to), max: node.repeat.max } : node.repeat,
        ...(index === draft.nodes.length - 1 ? { inspectCleanCommit: true } : {}),
      })) });
    const starts = [];
    let rounds = 0;
    let run;
    const ctx = setupEngine({ readinessPollMs: 1, launchEnterDelayMs: 1,
      engineExtras: { listRunPlaces: async () => ({ current: 'backend', worktrees: [checkout], readOnly: [] }) },
      readScreen: async () => ['[[CDW:proof:QUESTIONS]]', question, 'Recommended: provide a device observation.', '[[CDW:proof:NEEDS_INPUT]]'],
      createWorkflow: ({ notify }) => {
        let state = 'stopped';
        const signal = (status, limitReached = false) => { state = status; notify({ status, iteration: 1, limitReached }); };
        const write = (index, note) => writeFileSync(path.join(backend, notePath(def, index)), note);
        return {
          start() {
            const index = ctx.runStore.get(run.id).currentStepIndex;
            const name = def.steps[index].name;
            starts.push(name);
            if (name !== 'Verify') { write(index, '# ' + name); signal('complete'); return; }
            if (omitProof) { write(index, ' '); signal('complete'); return; }
            if (++rounds === 1) {
              write(index, '# New regression: missing implementation\nReproduce with phone-prompt test. Fix the missing branch.');
              signal('stopped', true);
            } else { signal('needs_input'); }
          },
          signalIdentifier: () => 'proof', snapshot: () => ({ status: state, iteration: 1 }), answerText: text => text,
          input(text) {
            signal('running');
            write(4, '# Backend detects missing tags\nBackend check passed. Owner decision: ' + text
              + '\nUnrelated failure: same `git show REV:legacy.cjs | node -`, same runtime and fixture, matching E42 on base ' + checkout.baseCommit + ' and HEAD ' + git(backend, ['rev-parse', 'HEAD']) + '.');
            signal('complete');
          },
          stop() {},
        };
      },
    });
    run = ctx.runStore.create(validRun({ definition: def, homePath: backend, worktreePath: backend, worktreeBranch: 'main', baseCommit: checkout.baseCommit, worktreeState: 'external' }));
    await ctx.engine.start(run.id);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'awaiting_approval', currentStepIndex: 1 });
    expect(starts).toEqual(['Clarify', 'Investigate']);
    await ctx.engine.approve(run.id);
    return { ctx, run, starts };
  }

  it.each([false, true])('refuses COMPLETE without a verification note while Verify is still resumable (historical prompt: %s)', async historicalPrompt => {
    const { ctx, run } = await exercise({ omitProof: true, historicalPrompt });
    await vi.waitFor(() => expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error', currentStepIndex: 4, error: expect.stringMatching(/verification note/i) }));
  });

  it('returns a regression to Fix, pauses for device proof, and records the owner decision and matching baseline failure in the same run', async () => {
    const { ctx, run, starts } = await exercise();
    await vi.waitFor(() => expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'needs_input', inputRequest: { questions: expect.stringContaining(question) } }));
    expect(starts).toEqual(['Clarify', 'Investigate', 'Prove', 'Fix', 'Verify', 'Fix', 'Verify']);
    expect(ctx.decisionStore.count(run.id)).toBe(0);
    expect(ctx.noteStore.lastContent(run.id, 4)).toContain('New regression');
    await ctx.engine.answer(run.id, owner);
    await vi.waitFor(() => expect(ctx.runStore.get(run.id).status).toBe('complete'));
    const note = ctx.noteStore.lastContent(run.id, 5);
    expect(note).toContain(owner);
    expect(note).toMatch(/git show REV:legacy.cjs.*matching E42 on base [a-f0-9]{40} and HEAD [a-f0-9]{40}/);
    expect(ctx.answerStore.list(run.id)).toMatchObject([{ stepName: 'Verify', answer: owner }]);
    expect(starts).not.toContain('Commit');
  });
});

describe('createRunEngine attachment verification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  async function driveReady(done, steps = 1) {
    for (let i = 0; i < steps; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1000);
    }
    await done;
  }

  async function advanceReadiness(steps = 1) {
    for (let i = 0; i < steps; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1000);
    }
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  function interruptedAttached(ctx, runOverrides = {}) {
    const created = ctx.runStore.create(validRun({
      worktreeState: 'present',
      baseCommit: BASE_COMMIT,
      ...runOverrides,
    }));
    ctx.runStore.update(created.id, {
      status: 'interrupted',
      steps: [step({
        status: 'interrupted',
        sessionId: 'Demo-9',
        priorSessionIds: [],
        attempt: 1,
      })],
    });
    return created;
  }

  const NOTES = '.codedeck/runs/abcdef12';
  const attachment = {
    name: 'notes.md',
    path: `${NOTES}/attachments/01-notes.md`,
    sizeBytes: 5,
    digest: 'a'.repeat(64),
  };

  it('fails the run with a file-specific error and launches nothing when a copy fails verification', async () => {
    const verifyAttachments = vi.fn(async () => {
      const error = new Error('Attachment attachments[0] (notes.md) is missing and could not be read.');
      error.field = 'attachments[0]';
      throw error;
    });
    const prepareNotes = vi.fn(async () => {});
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      engineExtras: { verifyAttachments, prepareNotes },
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({ notesDir: NOTES }),
      attachments: [attachment],
      worktreeState: 'present',
      baseCommit: BASE_COMMIT,
    }));

    await driveReady(ctx.engine.start(run.id));
    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toMatch(/attachments\[0\].*notes\.md/i);
    expect(verifyAttachments).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: run.worktreePath,
      attachments: [attachment],
      notesDir: NOTES,
    }));
    expect(prepareNotes).not.toHaveBeenCalled();
    expect(ctx.startSession).not.toHaveBeenCalled();
    expect(ctx.attachBackground).not.toHaveBeenCalled();
    expect(ctx.getWorkflowStartArgs()).toBeNull();
  });

  it('verifies again on Resume and continues once the copies match', async () => {
    let failOnce = true;
    const verifyAttachments = vi.fn(async () => {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error('Attachment attachments[0] (notes.md) does not match the recorded size or digest.'), { field: 'attachments[0]' });
      }
    });
    const prepareNotes = vi.fn(async () => {});
    const readNote = vi.fn(async () => ({ status: 'missing', content: null }));
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      engineExtras: { verifyAttachments, prepareNotes, readNote },
    });
    const created = interruptedAttached(ctx, {
      definition: definition({ notesDir: NOTES }),
      attachments: [attachment],
    });

    await ctx.engine.resume(created.id);
    await advanceReadiness(1);
    expect(ctx.runStore.get(created.id)).toMatchObject({
      status: 'error',
      error: expect.stringMatching(/does not match/i),
    });
    expect(prepareNotes).not.toHaveBeenCalled();
    expect(ctx.getWorkflowStartArgs()).toBeNull();

    ctx.setReadinessQueue([executionState()]);
    await ctx.engine.resume(created.id);
    await advanceReadiness(2);
    expect(ctx.runStore.get(created.id).status).toBe('complete');
    expect(verifyAttachments).toHaveBeenCalledTimes(2);
    expect(prepareNotes).toHaveBeenCalled();
    expect(ctx.getWorkflowStartArgs()).toMatchObject({ command: 'Implement ship it' });
  });

  it('gives the terminal workflow a check that verifies the copies again before every repeat pass', async () => {
    const verifyAttachments = vi.fn(async () => {});
    const startOptions = [];
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      engineExtras: { verifyAttachments, prepareNotes: vi.fn(async () => {}) },
      createWorkflow: vi.fn(({ notify }) => ({
        start(args, options) {
          startOptions.push(options);
          queueMicrotask(() => notify({ status: 'complete', active: false, error: null, requestId: args.requestId, iteration: 1, limitReached: false }));
        },
        stop() {},
        snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
      })),
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({ notesDir: NOTES }),
      attachments: [attachment],
      worktreeState: 'present',
      baseCommit: BASE_COMMIT,
    }));
    await driveReady(ctx.engine.start(run.id));
    expect(startOptions).toHaveLength(1);
    expect(typeof startOptions[0]?.beforePass).toBe('function');
    expect(verifyAttachments).toHaveBeenCalledTimes(1);
    await startOptions[0].beforePass();
    expect(verifyAttachments).toHaveBeenCalledTimes(2);
    expect(verifyAttachments).toHaveBeenLastCalledWith(expect.objectContaining({
      worktreePath: run.worktreePath,
      attachments: [attachment],
      notesDir: NOTES,
    }));
    verifyAttachments.mockRejectedValueOnce(new Error('Attachment attachments[0] (notes.md) does not match the recorded size or digest.'));
    await expect(startOptions[0].beforePass()).rejects.toThrow(/attachments\[0\].*does not match/);
  });

  it('starts the terminal workflow of an attachment-free run without a check', async () => {
    const startOptions = [];
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow: vi.fn(({ notify }) => ({
        start(args, ...rest) {
          startOptions.push(rest);
          queueMicrotask(() => notify({ status: 'complete', active: false, error: null, requestId: args.requestId, iteration: 1, limitReached: false }));
        },
        stop() {},
        snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
      })),
    });
    const run = ctx.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    await driveReady(ctx.engine.start(run.id));
    // No attachment check; only the dispatch hook that applies a queued agent change.
    expect(startOptions).toEqual([[{ beforeDispatch: expect.any(Function) }]]);
  });

  it('keeps a run-owned checkout whose attachment copies no longer match, and names them', async () => {
    const listAttachmentsAtRisk = vi.fn(async () => [`${NOTES}/attachments/01-notes.md`]);
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      engineExtras: { verifyAttachments: vi.fn(async () => {}), prepareNotes: vi.fn(async () => {}), listAttachmentsAtRisk },
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({ notesDir: NOTES }),
      attachments: [attachment],
      worktreeState: 'present',
      baseCommit: BASE_COMMIT,
    }));
    await driveReady(ctx.engine.start(run.id));
    expect(listAttachmentsAtRisk).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: run.worktreePath,
      attachments: [attachment],
      notesDir: NOTES,
    }));
    expect(ctx.removeWorktree).not.toHaveBeenCalled();
    expect(ctx.runStore.get(run.id)).toMatchObject({
      worktreeState: 'removal_blocked',
      worktreeDetail: expect.stringContaining(`${NOTES}/attachments/01-notes.md`),
    });
  });

  it('removes a run-owned checkout whose only attachment content is verified', async () => {
    const listAttachmentsAtRisk = vi.fn(async () => []);
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      engineExtras: { verifyAttachments: vi.fn(async () => {}), prepareNotes: vi.fn(async () => {}), listAttachmentsAtRisk },
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({ notesDir: NOTES }),
      attachments: [attachment],
      worktreeState: 'present',
      baseCommit: BASE_COMMIT,
    }));
    await driveReady(ctx.engine.start(run.id));
    expect(ctx.removeWorktree).toHaveBeenCalledOnce();
    expect(ctx.runStore.get(run.id).worktreeState).toBe('removed');
  });

  it.each([
    ['verified', 'removed'],
    ['changed', 'removal_blocked'],
    ['unknown', 'removal_blocked'],
    ['unsafe folder', 'removal_blocked'],
    ['retained checkout', 'released'],
  ])('closes a real Git checkout with %s attachment content', async (scenario, expectedState) => {
    const { backend: homePath, base } = groupFixture();
    const worktreePath = path.join(base, 'run-checkout');
    const worktreeBranch = 'workflow/attachments';
    writeFileSync(path.join(homePath, '.gitignore'), '.codedeck/\n');
    git(homePath, ['add', '.gitignore']);
    git(homePath, ['commit', '-m', 'ignore run files']);
    git(homePath, ['worktree', 'add', '-b', worktreeBranch, worktreePath]);

    const folder = path.join(worktreePath, NOTES, 'attachments');
    const copy = path.join(worktreePath, attachment.path);
    const bytes = 'alpha';
    mkdirSync(folder, { recursive: true });
    writeFileSync(copy, scenario === 'changed' ? 'ALPHA' : bytes);
    let protectedPath = attachment.path;
    if (scenario === 'unknown') {
      protectedPath = `${NOTES}/attachments/foreign.txt`;
      writeFileSync(path.join(worktreePath, protectedPath), 'unknown');
    }
    if (scenario === 'unsafe folder') {
      protectedPath = `${NOTES}/attachments`;
      rmSync(folder, { recursive: true });
      symlinkSync(path.join(base, 'missing-target'), folder);
    }
    expect(git(worktreePath, ['status', '--porcelain'])).toBe('');

    const ctx = setupEngine({ removeWorktree: run => removeGitWorktree({ ...run, execFile }) });
    const run = ctx.runStore.create(validRun({
      homePath,
      worktreePath,
      worktreeBranch,
      worktreeState: scenario === 'retained checkout' ? 'external' : 'present',
      baseCommit: git(worktreePath, ['rev-parse', 'HEAD']),
      definition: definition({ notesDir: NOTES }),
      attachments: [{ ...attachment, digest: createHash('sha256').update(bytes).digest('hex') }],
    }));
    ctx.runStore.update(run.id, { status: 'stopped', stopReason: 'user', finishedAt: new Date().toISOString() });

    const closed = await ctx.engine.cleanup(run.id);
    expect({
      state: closed.worktreeState,
      checkoutExists: existsSync(worktreePath),
      protectedPathExists: lstatSync(path.join(worktreePath, protectedPath), { throwIfNoEntry: false }) !== undefined,
    }).toEqual({
      state: expectedState,
      checkoutExists: expectedState !== 'removed',
      protectedPathExists: expectedState !== 'removed',
    });
    if (expectedState === 'removal_blocked') expect(closed.worktreeDetail).toContain(protectedPath);
  });

  it('keeps the same attachment references on later steps and when the brief is refreshed', async () => {
    const POINT = `Attachments for this run are listed under Attachments in ${NOTES}/README.md and ${NOTES}/brief.md; open each checkout-relative path under ${NOTES}/attachments/.`;
    const second = {
      kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
      name: 'Review',
      prompt: 'Review ship it',
      repeat: { mode: 'once' },
      agent: {
        id: 'c410a1b2-3456-4789-8abc-def012345679',
        name: 'codex',
        launchCommand: 'codex',
        resetCommand: '/clear',
      },
    };
    const starts = [];
    const createWorkflow = vi.fn(({ notify }) => ({
      start(args) {
        starts.push(args);
        queueMicrotask(() => {
          notify({
            status: 'complete',
            active: false,
            error: null,
            requestId: args.requestId,
            iteration: 1,
            limitReached: false,
          });
        });
      },
      stop() {},
      snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
    }));
    const verifyAttachments = vi.fn(async () => {});
    const prepareNotes = vi.fn(async () => {});
    const readNote = vi.fn(async () => ({ status: 'present', content: '# Done' }));
    const writeBrief = vi.fn(async () => `${NOTES}/brief.md`);
    const ctx = setupEngine({
      readinessQueue: [executionState(), executionState()],
      createWorkflow,
      engineExtras: { verifyAttachments, prepareNotes, readNote, writeBrief },
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({ notesDir: NOTES, steps: [definition().steps[0], second] }),
      attachments: [attachment],
      worktreeState: 'present',
      baseCommit: BASE_COMMIT,
    }));

    await driveReady(ctx.engine.start(run.id), 2);
    expect(ctx.runStore.get(run.id).status).toBe('complete');
    expect(starts).toHaveLength(2);
    expect(starts[0].guidance).toContain(POINT);
    expect(starts[1].guidance).toContain(POINT);
    expect(starts[0].guidance).toContain(NOTES);
    expect(starts[1].guidance).toContain(NOTES);
    expect(verifyAttachments).toHaveBeenCalledTimes(2);
    expect(prepareNotes.mock.calls).toHaveLength(2);
    for (const [args] of prepareNotes.mock.calls) {
      expect(args).toMatchObject({ attachments: [attachment], definition: expect.objectContaining({ notesDir: NOTES }) });
    }
    expect(writeBrief.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [args] of writeBrief.mock.calls) {
      expect(args).toMatchObject({ attachments: [attachment], definition: expect.objectContaining({ notesDir: NOTES }) });
    }
  });

  it('refreshes the brief with the same attachments after an owner answer', async () => {
    const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const SCREEN = ['What should we ship?', `[[CDW:${ID}:NEEDS_INPUT]]`];
    const state = { status: 'stopped', inputs: [], notify: null };
    const snap = status => ({ status, active: !['complete', 'stopped'].includes(status), error: null, requestId: 'r', iteration: 1, limitReached: false });
    const publish = (status) => { state.status = status; state.notify(snap(status)); };
    const createWorkflow = vi.fn(({ notify }) => {
      state.notify = notify;
      return {
        start() { queueMicrotask(() => publish('needs_input')); },
        stop() { state.status = 'stopped'; },
        snapshot: () => snap(state.status),
        answerText: text => text,
        input(data) { state.inputs.push(data); publish('running'); },
        signalIdentifier: () => ID,
      };
    });
    const verifyAttachments = vi.fn(async () => {});
    const writeBrief = vi.fn(async () => `${NOTES}/brief.md`);
    const prepareNotes = vi.fn(async () => {});
    const readNote = vi.fn(async () => ({ status: 'present', content: '# Done' }));
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      createWorkflow,
      readScreen: vi.fn(async () => SCREEN),
      engineExtras: { verifyAttachments, prepareNotes, readNote, writeBrief },
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({ notesDir: NOTES }),
      attachments: [attachment],
      worktreeState: 'present',
      baseCommit: BASE_COMMIT,
    }));
    const done = ctx.engine.start(run.id);
    await advanceReadiness(1);
    expect(ctx.runStore.get(run.id).status).toBe('needs_input');
    expect(writeBrief).toHaveBeenCalledWith(expect.objectContaining({ attachments: [attachment] }));

    const answering = ctx.engine.answer(run.id, 'Ship the notes');
    await vi.advanceTimersByTimeAsync(100);
    await answering;
    expect(writeBrief).toHaveBeenLastCalledWith(expect.objectContaining({
      attachments: [attachment],
      entries: [expect.objectContaining({ answer: 'Ship the notes' })],
    }));
    publish('complete');
    await done;
  });
});

describe('CLI and UI sync — restart recovery & mid-pass exit detection', () => {
  beforeEach(() => vi.useFakeTimers());

  function realWorkflowSetup(db, overrides = {}) {
    const runStore = createRunStore(db, {
      now: overrides.now ?? (() => new Date().toISOString()),
      interruptOnStart: overrides.interruptOnStart ?? false,
    });
    const writes = [];
    let activeWorkflow = null;
    const attachBackground = overrides.attachBackground ?? vi.fn(() => ({
      write: (data) => { writes.push(data); },
      release: vi.fn(),
    }));
    const createWorkflow = vi.fn(({ write, notify }) => {
      activeWorkflow = createTerminalWorkflow({ write, notify, resetTimeoutMs: 15000, handoffIdleMs: 24000 });
      return activeWorkflow;
    });
    const engine = createRunEngine({
      readTimeouts: overrides.readTimeouts ?? (() => TIMEOUTS),
      runStore,
      createWorktree: vi.fn(async () => ({ baseCommit: BASE_COMMIT })),
      startSession: vi.fn(async () => 'Demo-1'),
      attachBackground,
      createWorkflow,
      classifyReadiness: (state) => {
        if (state.entryExists === false || state.isAlive === false) return 'closed';
        if (state.executionReason === 'agent_needs_input') return 'needs_input';
        if (state.executionReason === 'shell_prompt') return 'exited';
        if (state.executionReason === 'agent_prompt_idle' && state.profile?.promptVisible?.(state.lines)) return 'ready';
        return 'waiting';
      },
      readExecutionState: overrides.readExecutionState ?? vi.fn(async () => executionState({ executionReason: 'agent_working', lines: ['Editing files...'] })),
      readScreen: overrides.readScreen ?? vi.fn(async () => []),
      readProgressCount: vi.fn(async () => null),
      decisionStore: createDecisionStore(db),
      answerStore: createAnswerStore(db),
      writeBrief: vi.fn(async () => null),
      noteStore: createNoteStore(db),
      reviewStore: createReviewStore(db),
      removeWorktree: vi.fn(async () => ({ ok: true })),
      listDirtyPaths: vi.fn(async () => []),
      pathExists: vi.fn(async () => true),
      terminalAvailable: overrides.terminalAvailable ?? vi.fn(() => true),
      setTerminalMuted: vi.fn(() => true),
      restartAgentTerminal: vi.fn(async () => {}),
      typeIntoTerminal: vi.fn(async () => {}),
      inspectTerminal: vi.fn(async () => ({})),
      terminalInFolder: overrides.terminalInFolder ?? vi.fn(async () => true),
      setTimeout,
      now: overrides.now ?? (() => new Date().toISOString()),
      readinessPollMs: 1000,
      dialogPollMs: 2000,
      launchEnterDelayMs: 100,
      ...overrides.engineExtras,
    });
    return { runStore, engine, writes, attachBackground, getWorkflow: () => activeWorkflow };
  }

  it('asksForDisposition_whenMusePausesBetweenStepsForTwoReadings', async () => {
    // SOS run 4d9d8c06, Develop attempt 10: Muse showed no live status line between two steps of
    // its turn for two readings, was told "Do not redo any work", and signalled CONTINUE unbuilt.
    const db = new Database(':memory:');
    databases.push(db);
    let reading = 0;
    const between = n => executionState({ lines: ['◆ Ran 2 commands · Find owner and host definitions', `  Read ${n} files · ctrl+o`, '❯ '] });
    const states = [
      executionState({ executionReason: 'agent_working', lines: ['◈ Thinking (3s · esc to interrupt)'] }),
      between(1), between(2), between(3), between(4),
      executionState({ executionReason: 'agent_working', lines: ['◈ Thinking (1s · esc to interrupt)'] }),
    ];
    const finished = executionState({ lines: ['◆ Done.', '❯ '] });
    let setup;
    const prompted = () => setup?.writes.some(text => text.includes('Iteration identifier'));
    setup = realWorkflowSetup(db, { readExecutionState: async () => (prompted() ? states[reading++] : null) ?? finished });
    const run = setup.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    setup.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(14000);
    expect(setup.writes.filter(text => text.includes('Do not redo'))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(14000);
    expect(setup.writes.filter(text => text.includes('Do not redo'))).toHaveLength(1);
  });

  it('advancesOnce_whenPollingSeesACursorPositionedSignalForTheCurrentPass', async () => {
    // Finding 12: the engine poll must advance exactly once when the captured
    // screen renders the current pass signal at a cursor position, while plain
    // output, stale-iteration tokens, echoed prompt text and never-issued
    // identifiers leave the pass running, and a repeated screen after the
    // advance changes nothing.
    const db = new Database(':memory:');
    databases.push(db);
    let lines = ['› '];
    let setup;
    const prompted = () => setup?.writes.some(text => text.includes('Iteration identifier'));
    setup = realWorkflowSetup(db, {
      readExecutionState: async () => prompted()
        ? executionState({ executionReason: 'agent_working', lines })
        : executionState(),
    });
    const run = setup.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    const done = setup.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1500);
    expect(setup.runStore.get(run.id).status).toBe('running');
    const id = setup.getWorkflow().signalIdentifier();
    expect(id).toMatch(/^[\w-]+$/);
    const signal = (sid, status) => `[[CDW:${sid}:${status}]]`;

    // Plain output preserves the running pass.
    lines = ['Editing files...', '› '];
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.getWorkflow().snapshot()).toMatchObject({ status: 'running', iteration: 1 });

    // A stale signal for an earlier iteration is ignored.
    lines = ['old output', signal('deadbeef-1', 'COMPLETE')];
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.getWorkflow().snapshot()).toMatchObject({ status: 'running', iteration: 1 });

    // Echoed prompt text and a never-issued identifier are ignored.
    const echo = setup.writes.find(text => text.includes('Iteration identifier'));
    expect(echo).toContain('[[CDW:');
    lines = [echo, signal('ffffeeee-9', 'COMPLETE')];
    await vi.advanceTimersByTimeAsync(2000);
    expect(setup.getWorkflow().snapshot()).toMatchObject({ status: 'running', iteration: 1 });

    // A cursor-positioned signal for the current pass advances exactly once.
    lines = [`\x1b[24;1H${signal(id, 'COMPLETE')}`];
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(setup.runStore.get(run.id)).toMatchObject({ status: 'complete', error: null });
    expect(setup.getWorkflow().snapshot()).toMatchObject({ status: 'complete', iteration: 1 });

    // Duplicate polls of the same screen leave the completed run unchanged.
    await vi.advanceTimersByTimeAsync(4000);
    expect(setup.runStore.get(run.id)).toMatchObject({ status: 'complete', error: null });
    expect(setup.getWorkflow().snapshot()).toMatchObject({ status: 'complete', iteration: 1 });
  });

  it('accepts a reattached legacy Test handoff under the prompt that was sent', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const develop = definition().steps[0];
    const def = definition({notesDir: '.codedeck/runs/abcdef12', steps: [
      develop, {...develop, name: 'Test', agent: {...develop.agent, id: WORKFLOW_ID, launchCommand: 'muse'}, repeat: {mode: 'loop_back', toStepIndex: 0, max: 8}},
    ]});
    const opts = {readExecutionState: async () => executionState(), engineExtras: {
      prepareNotes: vi.fn(), readNote: async () => ({status: 'present', content: '# Reopened A5'}),
    }};
    const first = realWorkflowSetup(db, opts);
    const run = first.runStore.create(validRun({definition: def, worktreeState: 'present', baseCommit: BASE_COMMIT}));
    first.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1200);
    first.getWorkflow().output(`[[CDW:${first.getWorkflow().signalIdentifier()}:COMPLETE]]`);
    await vi.advanceTimersByTimeAsync(1400);
    const saved = first.runStore.get(run.id);
    expect(saved.currentStepIndex).toBe(1);
    expect(saved.workflowState.identifier).toBeTruthy();
    expect(saved.workflowState.request.command).not.toContain('REPAIR');
    const restarted = realWorkflowSetup(db, {...opts, engineExtras: {...opts.engineExtras, fingerprintSources:vi.fn()}});
    await restarted.engine.reconcileOnStartup();
    restarted.getWorkflow().output(`[[CDW:${saved.workflowState.identifier}:CONTINUE]]`);
    await vi.advanceTimersByTimeAsync(100);
    expect(restarted.runStore.get(run.id)).toMatchObject({status:'running', currentStepIndex:0});
  });

  it('reattaches to a still-working CLI after backend restart without marking interrupted or resending the prompt', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const first = realWorkflowSetup(db, {
      readExecutionState: vi.fn()
        .mockResolvedValueOnce(executionState())
        .mockResolvedValue(executionState({ executionReason: 'agent_working', lines: ['Editing files...'] })),
    });
    const run = first.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    first.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1200);

    const beforeRestart = first.runStore.get(run.id);
    expect(beforeRestart.status).toBe('running');
    expect(beforeRestart.workflowState).not.toBeNull();
    const activeId = beforeRestart.workflowState.identifier;
    expect(activeId).toBeTruthy();

    // Simulate backend restart on the same SQLite DB while tmux session Demo-1 keeps working.
    const restarted = realWorkflowSetup(db, {
      readExecutionState: vi.fn(async () => executionState({ executionReason: 'agent_working', lines: ['Editing files...'] })),
      readScreen: vi.fn(async () => ['Editing files...']),
    });
    const reconciled = await restarted.engine.reconcileOnStartup();
    expect(reconciled).toEqual({ reattached: [run.id], interrupted: [] });
    expect(restarted.writes).toHaveLength(0);
    expect(restarted.runStore.get(run.id).status).toBe('running');

    // When the CLI finishes its pass later, the reattached engine catches the signal and completes the run.
    restarted.getWorkflow().output(`[[CDW:${activeId}:COMPLETE]]`);
    await vi.advanceTimersByTimeAsync(100);
    expect(restarted.runStore.get(run.id).status).toBe('complete');
    expect(restarted.runStore.get(run.id).workflowState).toBeNull();
  });

  it('catches a signal that appeared on screen while the backend was restarting, ignoring older scrollback signals', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const first = realWorkflowSetup(db, {
      readExecutionState: vi.fn()
        .mockResolvedValueOnce(executionState())
        .mockResolvedValue(executionState({ executionReason: 'agent_working', lines: ['Working...'] })),
    });
    const run = first.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    first.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1200);
    const activeId = first.runStore.get(run.id).workflowState.identifier;

    // During downtime, the CLI finished and printed its signal; scrollback also has an earlier step's signal.
    const restarted = realWorkflowSetup(db, {
      readExecutionState: vi.fn(async () => executionState()),
      readScreen: vi.fn(async () => [
        '[[CDW:oldstep1-1:COMPLETE]]',
        'All tests passed.',
        `[[CDW:${activeId}:COMPLETE]]`,
        '> ',
      ]),
    });
    const reconciled = await restarted.engine.reconcileOnStartup();
    expect(reconciled).toEqual({ reattached: [run.id], interrupted: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(restarted.runStore.get(run.id).status).toBe('complete');
    expect(restarted.writes).toHaveLength(0);
  });

  it('marks a run interrupted on startup when its terminal is gone or the agent exited with no signal', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const first = realWorkflowSetup(db, {
      readExecutionState: vi.fn()
        .mockResolvedValueOnce(executionState())
        .mockResolvedValue(executionState({ executionReason: 'agent_working', lines: ['Working...'] })),
    });
    const run = first.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    first.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(1200);

    const restarted = realWorkflowSetup(db, {
      readExecutionState: vi.fn(async () => executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', lines: ['user@host ~ %'] })),
      readScreen: vi.fn(async () => ['user@host ~ %']),
    });
    const reconciled = await restarted.engine.reconcileOnStartup();
    expect(reconciled).toEqual({ reattached: [], interrupted: [run.id] });
    expect(restarted.runStore.get(run.id).status).toBe('interrupted');
    expect(restarted.runStore.get(run.id).workflowState).toBeNull();
  });

  it('fails a running step when the CLI exits to the shell mid-pass across two consecutive polls', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    const readExecutionState = vi.fn()
      .mockResolvedValueOnce(executionState())
      // Single transient exit blip recovers on next poll
      .mockResolvedValueOnce(executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', lines: ['%'] }))
      .mockResolvedValueOnce(executionState({ executionReason: 'agent_working', lines: ['Working...'] }))
      // Two consecutive exited readings fail the run
      .mockResolvedValue(executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh', lines: ['%'] }));
    const ctx = realWorkflowSetup(db, { readExecutionState });
    const run = ctx.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(5200);
    // Still running after the single transient blip + recovery
    expect(ctx.runStore.get(run.id).status).toBe('running');

    await vi.advanceTimersByTimeAsync(4500);
    await done;
    const failed = ctx.runStore.get(run.id);
    expect(failed.status).toBe('error');
    expect(failed.error).toMatch(/exited during step Develop/i);
  });
});

describe('createRunEngine cross-host forwarding', () => {
  it('forwards run.host to startSession, notes, dirty check, and resume pathExists for remote runs', async () => {
    const startSession = vi.fn(async () => 'Demo-99');
    const prepareNotes = vi.fn(async () => {});
    const writeBrief = vi.fn(async () => '.codedeck/runs/abcd1234/brief.md');
    const readNote = vi.fn(async () => ({ status: 'missing', content: null }));
    const pathExists = vi.fn(async () => true);
    const createWorkflow = vi.fn(() => ({
      start() {},
      stop() {},
      snapshot: () => ({ status: 'running', active: true, error: null, requestId: 'req-1', iteration: 1, limitReached: false }),
    }));
    const ctx = setupEngine({
      startSession,
      writeBrief,
      pathExists,
      createWorkflow,
      engineExtras: { prepareNotes, readNote },
    });
    const run = ctx.runStore.create(validRun({
      host: 'devbox',
      homePath: '/home/dev/git/demo',
      worktreePath: '/home/dev/git/worktrees/demo-abcd1234',
      worktreeState: 'external',
      baseCommit: BASE_COMMIT,
      definition: definition({ notesDir: '.codedeck/runs/abcd1234' }),
    }));

    const running = ctx.engine.start(run.id);
    await vi.waitFor(() => expect(startSession).toHaveBeenCalled());
    expect(startSession).toHaveBeenCalledWith({
      project: 'Demo',
      cwd: '/home/dev/git/worktrees/demo-abcd1234',
      host: 'devbox',
    });
    expect(prepareNotes).toHaveBeenCalledWith(expect.objectContaining({ host: 'devbox' }));
    expect(writeBrief).toHaveBeenCalledWith(expect.objectContaining({ host: 'devbox' }));

    await ctx.engine.stop(run.id);
    await running;

    await ctx.engine.resume(run.id);
    expect(pathExists).toHaveBeenCalledWith('/home/dev/git/worktrees/demo-abcd1234', 'devbox');
    await ctx.engine.stop(run.id);
  });
});

describe('createRunEngine — one more bounded round after the cap (limit recovery)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  // The reported incident: Develop -> Review -> Test, seven loop-backs at cap eight,
  // and a fresh finding after the granted round. Each Test attempt writes its own
  // REPAIR lines so the no-progress guard never mistakes the incident for a stall.
  const noteForTestAttempt = attempt => {
    if (attempt >= 9) {
      return '# Test note\nREPAIR 9 PH1 | src/batch.js | batch-size-one probe fails after the granted round\nREPAIR 9 PH2 | test/batch.test.js | add regression for the granted round\n';
    }
    if (attempt === 8) {
      return '# Test note\nREPAIR 8 PH1 | src/batch.js | batch-size-one probe still fails\nREPAIR 8 PH2 | test/batch.test.js | regression for the stalled queue still missing\n';
    }
    if (attempt === 7) {
      return '# Test note\nREPAIR 7 PH1 | src/batch.js | batch-size-one probe fails\nREPAIR 7 PH2 | test/batch.test.js | add regression for a stalled queue\n';
    }
    return `# Test note\nREPAIR ${attempt} PH1 | src/older.js | earlier probe ${attempt} fails\nREPAIR ${attempt} PH2 | test/older.test.js | earlier regression ${attempt} missing\n`;
  };

  async function drive(steps = 1) {
    for (let i = 0; i < steps; i += 1) {
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1000);
    }
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  function incidentRun({ passedAt = null } = {}) {
    const commands = [];
    const args = [];
    const outcomes = [];
    const createWorkflow = withTimeouts(vi.fn(({ notify }) => {
      const workflow = {
        start(request) {
          args.push(request);
          commands.push(request.command);
          const outcome = outcomes.shift();
          if (outcome === undefined) throw new Error('scripted workflow: no outcome left');
          queueMicrotask(() => notify({
            status: outcome === 'complete' ? 'complete' : 'stopped',
            active: false,
            error: null,
            requestId: request.requestId,
            iteration: 1,
            limitReached: outcome !== 'complete',
          }));
        },
        stop() {},
        snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
      };
      return giveTimeouts(workflow);
    }));
    let runId = null;
    let stores = null;
    const readNote = vi.fn(async ({ stepIndex }) => {
      if (stepIndex === 2 && runId) {
        const attempt = Math.max(1, stores.runStore.get(runId).steps[2].attempt);
        return { status: 'present', content: attempt === passedAt ? '# Phase passed; later work remains' : noteForTestAttempt(attempt) };
      }
      return { status: 'present', content: '# Develop note\nDid the work.\n' };
    });
    // Task counts rise often enough to keep the no-progress guard quiet; the run still
    // caps at eight rounds because the probe keeps failing.
    const counts = [0, 1, 1, 2, 2, 3, 3];
    const ctx = setupEngine({
      createWorkflow,
      readProgressCount: vi.fn(async () => ({ tasksDone: counts.shift() ?? 3, tasksTotal: 4 })),
      engineExtras: {
        prepareNotes: vi.fn(async () => {}),
        readNote,
        fingerprintSources: vi.fn(async () => 'a'.repeat(64)),
        readProgress: vi.fn(async () => ({ phase: { number: 9, title: 'Readiness', tasksDone: 0, tasksTotal: 2 } })),
      },
    });
    stores = ctx;
    const agent = { id: AGENT_ID, name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };
    const def = definition({
      notesDir: '.codedeck/runs/abcdef12',
      steps: [
        {
          kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
          name: 'Develop', prompt: 'do Develop',
          repeat: { mode: 'once' },
          agent,
        },
        {
          kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
          name: 'Review', prompt: 'do Review',
          repeat: { mode: 'once' },
          agent,
        },
        {
          kind: 'node', role: '', askOwner: false, readOnly: false, approval: false,
          name: 'Test', prompt: 'do Test',
          repeat: { mode: 'loop_back', toStepIndex: 0, max: 8 },
          agent,
        },
      ],
    });
    const run = ctx.runStore.create(validRun({ definition: def }));
    runId = run.id;
    return { ctx, run, commands, args, outcomes };
  }

  it('replays the capped incident: one click dispatches Develop with the current findings and stays active', async () => {
    const { ctx, run, commands, args, outcomes } = incidentRun();
    for (let round = 0; round < 7; round += 1) outcomes.push('complete', 'complete', 'continue');
    outcomes.push('complete', 'complete', 'limit');
    outcomes.push('complete', 'complete', 'limit');
    const done = ctx.engine.start(run.id);
    await drive(60);
    await done;
    const paused = ctx.runStore.get(run.id);
    expect(paused.status).toBe('limit_paused');
    expect(paused.steps[2]).toMatchObject({ status: 'limit_reached', roundsCompleted: 7 });
    expect(commands).toHaveLength(24);

    // The round before the cap ran on the previous attempt's finding, not the current one.
    expect(commands[21]).toContain('PH1 | src/batch.js | batch-size-one probe fails');
    expect(commands[21]).not.toContain('still fails');

    const acknowledged = await ctx.engine.continue(run.id, { stepIndex: 2, roundsCompleted: 7, extraRounds: 0 });
    expect(acknowledged.status).toBe('running');
    expect(acknowledged.currentStepIndex).toBe(0);
    expect(acknowledged.steps[2].extraRounds).toBe(1);
    expect(acknowledged.status).not.toBe('complete');

    await drive(20);
    const second = ctx.runStore.get(run.id);
    expect(second.status).toBe('limit_paused');
    // Exactly one more round (Develop, Review, Test), then the cap pauses again: no tenth launch.
    expect(second.steps[2]).toMatchObject({ status: 'limit_reached', roundsCompleted: 8, extraRounds: 1 });
    expect(commands).toHaveLength(27);
    expect(args.at(-1)).toMatchObject({ maxIterations: 1 });

    // The granted round carries the two findings from the capped attempt.
    const developAfterGrant = commands[24];
    expect(developAfterGrant).toContain('PH1 | src/batch.js | batch-size-one probe still fails');
    expect(developAfterGrant).toContain('PH2 | test/batch.test.js | regression for the stalled queue still missing');
    // The second pause shows the new round-nine finding, archived on the capped attempt.
    expect(ctx.noteStore.lastContent(run.id, 2)).toContain('REPAIR 9');
    expect(ctx.runStore.lastAuditDetail(run.id, 2, 'limit_reached')).toContain('batch-size-one probe fails after the granted round');

    await drive(10);
    expect(commands).toHaveLength(27);
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');
  });

  it('refuses a stale grant from an earlier pause without launching anything', async () => {
    const { ctx, run, commands, outcomes } = incidentRun();
    for (let round = 0; round < 7; round += 1) outcomes.push('complete', 'complete', 'continue');
    outcomes.push('complete', 'complete', 'limit');
    const done = ctx.engine.start(run.id);
    await drive(60);
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');
    await expect(ctx.engine.continue(run.id, { stepIndex: 2, roundsCompleted: 6, extraRounds: 0 })).rejects.toThrow(/pause|current/i);
    await expect(ctx.engine.continue(run.id, { stepIndex: 2, roundsCompleted: 7, extraRounds: 1 })).rejects.toThrow(/pause|current/i);
    expect(commands).toHaveLength(24);
    expect(ctx.runStore.get(run.id).status).toBe('limit_paused');
  });

  it('routes capped repairs through Review and Test, then dispatches a passed cap to the next unfinished phase', async () => {
    const { ctx, run, commands, outcomes } = incidentRun({ passedAt: 9 });
    for (let round = 0; round < 7; round += 1) outcomes.push('complete', 'complete', 'continue');
    outcomes.push('complete', 'complete', 'limit', 'complete', 'complete', 'limit', 'complete', 'complete', 'limit');
    const done = ctx.engine.start(run.id);
    await drive(60); await done;
    await ctx.engine.continue(run.id, { stepIndex: 2, roundsCompleted: 7, extraRounds: 0 });
    await drive(20);
    expect(commands.slice(24, 27).map(command => command.split('\n')[0])).toEqual(['do Develop', 'do Review', 'do Test']);
    expect(commands[24]).toContain('batch-size-one probe still fails');
    expect(commands[25]).toMatch(/Review only the changes.*batch-size-one probe still fails/s);
    expect(commands[26]).toMatch(/Rerun each failing probe plus its affected regressions/);
    expect(commands[26]).toMatch(/relevant source, inputs and environment still match/);
    expect(commands[26]).toMatch(/final suite once per changed repository/);
    await ctx.engine.continue(run.id, { stepIndex: 2, roundsCompleted: 8, extraRounds: 1 });
    await drive(20);
    expect(commands.slice(27, 30).map(command => command.split('\n')[0])).toEqual(['do Develop', 'do Review', 'do Test']);
    expect(commands[27]).toContain('Phase 9: Readiness (0/2 tasks done)');
    expect(commands[27]).not.toContain('batch-size-one');
  });

  // A seeded pause for the durability probes below: Develop is done, Test capped at two.
  function pausedSeed(ctx, { extraRounds = 0, roundsCompleted = 1 } = {}) {
    const agent = { id: AGENT_ID, name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };
    const def = definition({
      notesDir: '.codedeck/runs/abcdef12',
      steps: [
        { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Develop', prompt: 'do it', repeat: { mode: 'once' }, agent },
        { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Test', prompt: 'do it', repeat: { mode: 'loop_back', toStepIndex: 0, max: 2 }, agent },
      ],
    });
    return ctx.runStore.create(validRun({
      definition: def,
      status: 'limit_paused',
      currentStepIndex: 1,
      steps: [
        step({ status: 'complete', sessionId: 'Demo-1', attempt: 1, iteration: 1 }),
        step({ status: 'limit_reached', sessionId: 'Demo-2', attempt: 2, iteration: 2, roundsCompleted, extraRounds }),
      ],
    }));
  }

  it('grants and launches at most once when Continue is double-clicked', async () => {
    const starts = [];
    const ctx = setupEngine({
      createWorkflow: vi.fn(() => {
        starts.push(1);
        return { start() {}, stop() {}, snapshot: () => ({ status: 'running' }) };
      }),
      engineExtras: {
        prepareNotes: vi.fn(async () => {}),
        readNote: vi.fn(async () => ({ status: 'present', content: '# Test note\nREPAIR 8 PH1 | src/batch.js | batch-size-one probe still fails\n' })),
        fingerprintSources: vi.fn(async () => 'a'.repeat(64)),
      },
    });
    const run = pausedSeed(ctx);
    const grant = { stepIndex: 1, roundsCompleted: 1, extraRounds: 0 };
    const [first, second] = await Promise.allSettled([ctx.engine.continue(run.id, grant), ctx.engine.continue(run.id, grant)]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(second.status === 'rejected' && second.reason?.code).toBe('ACTION_REFUSED');
    await drive(10);
    // Exactly one grant spent and one dispatch launched, however the clicks overlapped.
    expect(ctx.runStore.get(run.id).steps[1].extraRounds).toBe(1);
    expect(starts).toHaveLength(1);
  });

  it('refuses a stale round-eight grant delivered at the round-nine pause', async () => {
    const { ctx, run, commands, outcomes } = incidentRun();
    for (let round = 0; round < 7; round += 1) outcomes.push('complete', 'complete', 'continue');
    outcomes.push('complete', 'complete', 'limit');
    outcomes.push('complete', 'complete', 'limit');
    const done = ctx.engine.start(run.id);
    await drive(60);
    await done;
    await ctx.engine.continue(run.id, { stepIndex: 2, roundsCompleted: 7, extraRounds: 0 });
    await drive(20);
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'limit_paused' });
    expect(commands).toHaveLength(27);
    // The round-eight grant was already spent: delivering it again cannot grant a tenth round.
    await expect(ctx.engine.continue(run.id, { stepIndex: 2, roundsCompleted: 7, extraRounds: 0 })).rejects.toMatchObject({ code: 'ACTION_REFUSED' });
    expect(commands).toHaveLength(27);
    expect(ctx.runStore.get(run.id).steps[2]).toMatchObject({ status: 'limit_reached', roundsCompleted: 8, extraRounds: 1 });
  });

  it('keeps the cap, the grant, and the audit across a store/engine restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codedeck-restart-'));
    const databasePath = path.join(dir, 'runs.db');
    const OLDER = '# Test note\nREPAIR 1 PH1 | src/batch.js | batch-size-one probe fails\nREPAIR 1 PH2 | test/batch.test.js | add regression for a stalled queue\n';
    const CAPPED = '# Test note\nREPAIR 2 PH1 | src/batch.js | batch-size-one probe still fails\nREPAIR 2 PH2 | test/batch.test.js | regression for the stalled queue still missing\n';
    const reads = [];
    const extras = {
      prepareNotes: vi.fn(async () => {}),
      readNote: vi.fn(async ({ stepIndex }) => {
        if (stepIndex === 1) {
          reads.push(1);
          return { status: 'present', content: reads.length === 1 ? OLDER : CAPPED };
        }
        return { status: 'present', content: '# Develop note\nDid the work.\n' };
      }),
      fingerprintSources: vi.fn(async () => 'a'.repeat(64)),
    };
    const agent = { id: AGENT_ID, name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };
    const def = definition({
      notesDir: '.codedeck/runs/abcdef12',
      steps: [
        { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Develop', prompt: 'do it', repeat: { mode: 'once' }, agent },
        { kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Test', prompt: 'do it', repeat: { mode: 'loop_back', toStepIndex: 0, max: 2 }, agent },
      ],
    });
    const first = setupEngine({
      databasePath,
      createWorkflow: withTimeouts(vi.fn(({ notify }) => {
        const outcome = firstOutcomes.shift();
        const workflow = {
          start(request) {
            queueMicrotask(() => notify({
              status: outcome === 'complete' ? 'complete' : 'stopped',
              active: false,
              error: null,
              requestId: request.requestId,
              iteration: 1,
              limitReached: outcome !== 'complete',
            }));
          },
          stop() {},
          snapshot: () => ({ status: 'stopped', active: false, error: null, requestId: null, iteration: 0, limitReached: false }),
        };
        return giveTimeouts(workflow);
      })),
      readProgressCount: vi.fn(async () => ({ tasksDone: 0, tasksTotal: 4 })),
      engineExtras: extras,
    });
    const firstOutcomes = ['complete', 'continue', 'complete', 'limit'];
    const run = first.runStore.create(validRun({ definition: def }));
    const done = first.engine.start(run.id);
    await drive(15);
    await done;
    expect(first.runStore.get(run.id).status).toBe('limit_paused');

    // The grant is accepted; the restart lands across the grant and its dispatch.
    const acknowledged = await first.engine.continue(run.id, { stepIndex: 1, roundsCompleted: 1, extraRounds: 0 });
    expect(acknowledged.steps[1].extraRounds).toBe(1);

    // A fresh store and engine over the same file, then the startup recovery path.
    const relaunched = [];
    const second = setupEngine({
      databasePath,
      createWorkflow: vi.fn(() => {
        relaunched.push(1);
        return { start() {}, stop() {}, snapshot: () => ({ status: 'running' }) };
      }),
      engineExtras: extras,
    });
    await second.engine.reconcileOnStartup();
    const kept = second.runStore.get(run.id);
    // The original maximum, the single spent grant, and the capped attempt survive the reload.
    expect(kept.definition.steps[1].repeat.max).toBe(2);
    expect(kept.steps[1].extraRounds).toBe(1);
    expect(second.runStore.lastAuditDetail(run.id, 1, 'limit_reached')).toContain('PH1 | src/batch.js | batch-size-one probe still fails');
    expect(second.noteStore.lastContent(run.id, 1)).toContain('REPAIR 2');
    // The restart itself grants nothing and launches nothing.
    expect(relaunched).toHaveLength(0);
  });

  it('stops a limit_paused run without launching and keeps its notes and unfinished progress', async () => {
    const starts = [];
    const ctx = setupEngine({
      createWorkflow: vi.fn(() => {
        starts.push(1);
        return { start() {}, stop() {}, snapshot: () => ({ status: 'running' }) };
      }),
    });
    const run = pausedSeed(ctx);
    ctx.noteStore.add({ runId: run.id, stepIndex: 1, stepName: 'Test', attempt: 2, pass: 1,
      status: 'written', summary: 'Batch-size-one probe still fails', content: '# Test note\nREPAIR 8 PH1 | src/batch.js | batch-size-one probe still fails\n' });
    const stopped = await ctx.engine.stop(run.id);
    expect(stopped.status).toBe('stopped');
    expect(starts).toHaveLength(0);
    const kept = ctx.runStore.get(run.id);
    expect(kept.steps[1]).toMatchObject({ status: 'limit_reached', roundsCompleted: 1, extraRounds: 0 });
    expect(kept.steps[0].status).toBe('complete');
    expect(ctx.noteStore.lastContent(run.id, 1)).toContain('batch-size-one probe still fails');
  });
});
