import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRunStore } from '../pipelines/run-store.js';
import { createRunEngine } from '../pipelines/run-engine.js';
import { createDecisionStore } from '../pipelines/decision-store.js';

const WORKFLOW_ID = 'a2d0b1c2-3456-4789-8abc-def012345678';
const AGENT_ID = 'c410a1b2-3456-4789-8abc-def012345678';
const BASE_COMMIT = 'a'.repeat(40);
const databases = [];

function definition(overrides = {}) {
  return {
    workflowId: WORKFLOW_ID,
    workflowName: 'Feature',
    workflowRevision: 1,
    agentsDecide: false,
    progressFile: null,
    steps: [
      {
        kind: 'node',
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

function setupEngine(overrides = {}) {
  const db = new Database(':memory:');
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
  const readScreen = overrides.readScreen ?? vi.fn(async () => []);
  const decisionStore = overrides.decisionStore ?? createDecisionStore(db);

  const engine = createRunEngine({
    runStore,
    createWorktree,
    startSession,
    attachBackground,
    createWorkflow,
    classifyReadiness,
    readExecutionState,
    readScreen,
    decisionStore,
    removeWorktree,
    listDirtyPaths,
    pathExists,
    terminalAvailable,
    setTimeout: overrides.setTimeout ?? setTimeout,
    clearTimeout: overrides.clearTimeout ?? clearTimeout,
    now: overrides.now ?? (() => new Date().toISOString()),
    readinessPollMs: overrides.readinessPollMs ?? 1000,
    readinessTimeoutMs: overrides.readinessTimeoutMs ?? 120_000,
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
    readScreen,
    decisionStore,
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
  beforeEach(() => {
    vi.useFakeTimers();
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
      project: 'Demo',
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
    expect(finished.error).toMatch(/codex/i);
    expect(finished.error).toMatch(/agent_working/);
    expect(finished.error).toMatch(/codex/);
    expect(finished.error).toMatch(/120/);
    expect(finished.steps[0].status).toBe('failed');
    expect(ctx.releases).toEqual([true]);
    expect(ctx.createWorkflow).not.toHaveBeenCalled();
  });

  it('errors when the launch command exited', async () => {
    const ctx = setupEngine({
      readinessQueue: [
        executionState({
          executionReason: 'shell_prompt',
          foregroundCommand: 'zsh',
          profile: null,
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
          kind: 'node',
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
          kind: 'node',
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
          kind: 'node',
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
    expect(acknowledged.currentStepIndex).toBe(1);
    await advanceReadiness(1);
    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('complete');
    expect(finished.currentStepIndex).toBe(1);
    expect(finished.steps[0].status).toBe('limit_reached');
    expect(finished.steps[1].status).toBe('complete');
  });

  it('Continue on the last limit_paused step completes the run', async () => {
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
          kind: 'node',
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

    await ctx.engine.continue(run.id);
    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('complete');
    expect(finished.steps[0].status).toBe('limit_reached');
    expect(finished.worktreeState).toBe('removed');
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

  it('Setup leaving dirty paths errors the run', async () => {
    const ctx = setupEngine({
      readinessQueue: [executionState()],
      listDirtyPaths: vi.fn(async () => ['node_modules/.cache', 'tmp.out']),
    });
    const run = ctx.runStore.create(validRun({
      definition: definition({
        steps: [{
          kind: 'setup',
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

  function interruptedRun(ctx, stepOverrides = {}) {
    const created = ctx.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
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
    const exited = executionState({ executionReason: 'shell_prompt', foregroundCommand: 'zsh' });
    const ctx = setupEngine({ readinessQueue: [exited, exited] });
    const created = interruptedRun(ctx);

    await ctx.engine.resume(created.id);
    await advanceReadiness(2);

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('error');
    expect(finished.error).toBe('The launch command for agent codex exited.');
    expect(ctx.writes.filter(data => data === 'codex')).toHaveLength(1);
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
            kind: 'setup',
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
            kind: 'node',
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
          kind: 'setup',
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

  it('runs in the chosen worktree without creating one, and releases it on completion without removing it', async () => {
    const ctx = setupEngine();
    const run = ctx.runStore.create(external());

    const done = ctx.engine.start(run.id);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1000);
    await done;

    const finished = ctx.runStore.get(run.id);
    expect(finished.status).toBe('complete');
    expect(finished.worktreeState).toBe('released');
    expect(finished.worktreeDetail).toBeNull();
    expect(ctx.createWorktree).not.toHaveBeenCalled();
    expect(ctx.removeWorktree).not.toHaveBeenCalled();
    expect(ctx.startSession).toHaveBeenCalledWith({ project: 'Demo', cwd: '/tmp/worktrees/home-existing' });
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

    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
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
    kind: 'node',
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

  async function runLoop(outcomes, { max = 3, overrides = {} } = {}) {
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
    const run = ctx.runStore.create(validRun({ definition: looping(max) }));
    const done = ctx.engine.start(run.id);
    // Each step needs at most the launch Enter (100 ms) and one readiness poll (1 s).
    for (let i = 0; i < outcomes.length + 1; i += 1) await vi.advanceTimersByTimeAsync(1100);
    await done;
    return { ctx, script, sessions, run: ctx.runStore.get(run.id), done };
  }

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
    expect(test).toMatchObject({ command: 'do Test', maxIterations: 1, guidance: LOOP_GUIDANCE });
    expect(develop).not.toHaveProperty('guidance');
    expect(review).not.toHaveProperty('guidance');
  });

  it('pauses at the round limit; Continue moves past the loop', async () => {
    const { ctx, script, run } = await runLoop(['continue', 'continue', 'continue', 'continue'], { max: 2 });
    expect(run.status).toBe('limit_paused');
    expect(run.currentStepIndex).toBe(1);
    expect(run.steps.map(s => s.status)).toEqual(['complete', 'limit_reached', 'pending']);
    expect(run.steps[1].roundsCompleted).toBe(1);
    expect(script.starts).toHaveLength(4);

    script.createWorkflow.mockClear();
    const scriptAfter = scriptedWorkflow(['complete']);
    // The engine keeps its own createWorkflow; feed the remaining outcome through the same mock.
    script.createWorkflow.mockImplementation(scriptAfter.createWorkflow);
    await ctx.engine.continue(run.id);
    for (let i = 0; i < 2; i += 1) await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(0);
    const after = ctx.runStore.get(run.id);
    expect(after.status).toBe('complete');
    expect(after.steps.map(s => s.status)).toEqual(['complete', 'limit_reached', 'complete']);
  });

  it('never loops when the limit is one round', async () => {
    const { script, run } = await runLoop(['continue', 'continue'], { max: 1 });
    expect(run.status).toBe('limit_paused');
    expect(run.steps[1]).toMatchObject({ status: 'limit_reached', roundsCompleted: 0 });
    expect(script.starts).toHaveLength(2);
  });

  it('fails the run when the terminal a step should return to is gone', async () => {
    let attaches = 0;
    const { ctx, run } = await runLoop(['continue', 'continue', 'complete'], {
      overrides: {
        attachBackground: vi.fn(() => {
          attaches += 1;
          if (attaches === 3) throw new Error('Background attach refused: session is deleted.');
          return { write: () => {}, release: () => {} };
        }),
      },
    });
    expect(run.status).toBe('error');
    expect(run.error).toBe('The terminal of step Develop is no longer available. Resume the run to continue in a new terminal.');
    expect(run.steps[0].status).toBe('failed');
    expect(ctx.startSession).toHaveBeenCalledTimes(2);
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

  it('Resume gives the failed step a new terminal and launches its agent there', async () => {
    let attaches = 0;
    const outcomes = ['continue', 'continue', 'complete', 'complete', 'complete'];
    const script = scriptedWorkflow(outcomes);
    const ctx = setupEngine({
      createWorkflow: script.createWorkflow,
      attachBackground: vi.fn(() => {
        attaches += 1;
        if (attaches === 3) throw new Error('Background attach refused: session is deleted.');
        return { write: (data) => { ctx.writes.push(data); }, release: () => {} };
      }),
      // Once the attach to Develop's terminal has failed, that terminal is gone.
      terminalAvailable: vi.fn(() => attaches < 3),
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
        input(data) { state.inputs.push(data); publish('running'); },
        signalIdentifier: () => state.identifier,
      };
    });
    return { createWorkflow, state, ask: () => publish('needs_input'), complete: () => publish('complete') };
  }

  async function startAsking({ agentsDecide = true, overrides = {}, kind = 'node' } = {}) {
    const loop = askingWorkflow();
    const ctx = setupEngine({
      createWorkflow: loop.createWorkflow,
      readScreen: vi.fn(async () => SCREEN),
      ...overrides,
    });
    const def = definition({ agentsDecide });
    def.steps[0].kind = kind;
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

  it('records what was asked and what was answered', async () => {
    const { ctx, run } = await startAsking();
    await vi.advanceTimersByTimeAsync(100);
    expect(ctx.decisionStore.list(run.id, all)).toEqual([expect.objectContaining({
      runId: run.id, stepIndex: 0, stepName: 'Develop', pass: 1, questions: QUESTIONS, truncated: false, answer: ANSWER,
    })]);
  });

  it('tells the agent to decide for itself', async () => {
    const { loop } = await startAsking();
    expect(loop.state.starts[0].guidance).toBe(DECIDE);
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
    expect(loop.state.starts[0]).not.toHaveProperty('guidance');
  });

  it('pauses for the owner when Setup asks, even when agents decide', async () => {
    const { ctx, loop, run } = await startAsking({ kind: 'setup' });
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

  it('pauses the run while the dialog is shown and continues once it is answered in the terminal', async () => {
    const { ctx, loop, run, done } = await startWorking([DIALOG(), DIALOG(), WORKING()]);
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

  it('completes the step when the agent finishes while the run is still marked as showing a dialog', async () => {
    const { ctx, loop, run, done } = await startWorking([DIALOG()]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.runStore.get(run.id).status).toBe('needs_input');

    loop.complete();
    await done;
    expect(ctx.runStore.get(run.id).status).toBe('complete');
  });

  it('replaces the dialog pause with what the agent asks when it signals NEEDS_INPUT', async () => {
    const screen = ['[[CDW:abc-1:QUESTIONS]]', '1. Which schema?', 'Recommended: guardian.', '[[CDW:abc-1:NEEDS_INPUT]]'];
    const { ctx, loop, run } = await startWorking([DIALOG()], { readScreen: vi.fn(async () => screen) });
    await vi.advanceTimersByTimeAsync(2000);
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
    const { ctx, run, done } = await startWorking([DIALOG()]);
    const update = ctx.runStore.update;
    ctx.runStore.update = vi.fn((id, patch) => {
      if (patch.status === 'needs_input') throw new Error('disk full');
      return update(id, patch);
    });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(ctx.runStore.get(run.id)).toMatchObject({ status: 'error', error: 'disk full' });
  });
});

describe('createRunEngine — a step reuses the terminal of its agent', () => {
  const CODEX = { id: AGENT_ID, name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };
  const FABLE = { id: 'c410a1b2-3456-4789-8abc-def0123456f0', name: 'fable', launchCommand: 'claude --model fable', resetCommand: '/clear' };
  const node = (name, agent) => ({ kind: 'node', name, prompt: `do ${name}`, repeat: { mode: 'once' }, agent });
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
