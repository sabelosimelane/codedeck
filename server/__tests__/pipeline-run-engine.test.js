import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createRunStore } from '../pipelines/run-store.js';
import { createRunEngine } from '../pipelines/run-engine.js';

const WORKFLOW_ID = 'a2d0b1c2-3456-4789-8abc-def012345678';
const AGENT_ID = 'c410a1b2-3456-4789-8abc-def012345678';
const BASE_COMMIT = 'a'.repeat(40);
const databases = [];

function definition(overrides = {}) {
  return {
    workflowId: WORKFLOW_ID,
    workflowName: 'Feature',
    workflowRevision: 1,
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
    finishedAt: null,
    ...overrides,
  };
}

function executionState(overrides = {}) {
  return {
    executionReason: 'agent_prompt_idle',
    foregroundCommand: 'node',
    lines: ['› '],
    profile: { promptVisible: () => true },
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

  const engine = createRunEngine({
    runStore,
    createWorktree,
    startSession,
    attachBackground,
    createWorkflow,
    classifyReadiness,
    readExecutionState,
    removeWorktree,
    listDirtyPaths,
    pathExists,
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
        agent: {
          id: AGENT_ID,
          name: 'codex',
          launchCommand: 'codex',
          resetCommand: '/clear',
        },
      })),
    });
  }

  it('advances through three steps with a new terminal each', async () => {
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

  it('Resume increments attempt and moves sessionId to priorSessionIds', async () => {
    const ctx = setupEngine({ readinessQueue: [executionState()] });
    const created = ctx.runStore.create(validRun({ worktreeState: 'present', baseCommit: BASE_COMMIT }));
    ctx.runStore.update(created.id, {
      status: 'interrupted',
      steps: [step({
        status: 'interrupted',
        sessionId: 'Demo-9',
        priorSessionIds: [],
        attempt: 1,
      })],
    });

    const acknowledged = await ctx.engine.resume(created.id);
    expect(acknowledged.status).toBe('running');
    expect(acknowledged.steps[0].attempt).toBe(2);
    expect(acknowledged.steps[0].priorSessionIds).toEqual(['Demo-9']);
    await advanceReadiness(1);

    const finished = ctx.runStore.get(created.id);
    expect(finished.status).toBe('complete');
    expect(finished.steps[0].attempt).toBe(2);
    expect(finished.steps[0].priorSessionIds).toEqual(['Demo-9']);
    expect(finished.steps[0].sessionId).toBe('Demo-1');
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
