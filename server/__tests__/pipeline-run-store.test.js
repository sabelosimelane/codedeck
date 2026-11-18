import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createRunStore } from '../pipelines/run-store.js';

const WORKFLOW_ID = 'a2d0b1c2-3456-4789-8abc-def012345678';
const AGENT_ID = 'c410a1b2-3456-4789-8abc-def012345678';
const databases = [];

function setup(opts) {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, store: createRunStore(db, opts) };
}

afterEach(() => {
  databases.splice(0).forEach(db => db.close());
});

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
        kind: 'node', role: '', readOnly: false, approval: false,
        name: 'Develop',
        prompt: 'Implement the feature',
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
    worktreePath: '/tmp/home/.codedeck/runs/x',
    worktreeBranch: 'codedeck/run-abcd',
    baseCommit: null,
    worktreeState: 'not_created',
    worktreeDetail: null,
    inputRequest: null,
    taskId: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('pipeline run store', () => {
  it('stores a step whose limit the owner accepted', () => {
    const { store } = setup();
    const created = store.create(validRun({ status: 'complete', finishedAt: '2026-11-18T10:00:00.000Z', steps: [step({ status: 'limit_accepted', attempt: 1 })] }));
    expect(created.steps[0].status).toBe('limit_accepted');
  });

  it('rewrites limits accepted before that was recorded, and leaves a limit still waiting alone', () => {
    const { db, store } = setup();
    const two = definition();
    two.steps = [two.steps[0], { ...two.steps[0], name: 'Second' }];
    const done = store.create(validRun({ requestId: 'done', status: 'complete', finishedAt: '2026-11-18T10:00:00.000Z', steps: [step({ status: 'limit_reached', attempt: 1 })] }));
    const moved = store.create(validRun({ requestId: 'moved', definition: two, status: 'running', currentStepIndex: 1,
      steps: [step({ status: 'limit_reached', attempt: 1 }), step({ status: 'running', attempt: 1, sessionId: 'Demo-1' })] }));
    const paused = store.create(validRun({ requestId: 'paused', status: 'limit_paused', steps: [step({ status: 'limit_reached', attempt: 1 })] }));
    const stoppedAtLimit = store.create(validRun({ requestId: 'stopped', status: 'stopped', stopReason: 'user', finishedAt: '2026-11-18T10:00:00.000Z', steps: [step({ status: 'limit_reached', attempt: 1 })] }));

    const reopened = createRunStore(db);
    expect(reopened.get(done.id).steps[0].status).toBe('limit_accepted');
    expect(reopened.get(moved.id).steps[0].status).toBe('limit_accepted');
    expect(reopened.get(paused.id).steps[0].status).toBe('limit_reached');
    expect(reopened.get(stoppedAtLimit.id).steps[0].status).toBe('limit_reached');
  });

  it('keeps the task a run belongs to, and null for a run outside any task', () => {
    const { store } = setup();
    const taskId = '7a000000-0000-4000-8000-000000000001';
    expect(store.create(validRun({ requestId: 'in-task', taskId })).taskId).toBe(taskId);
    expect(store.create(validRun({ requestId: 'no-task' })).taskId).toBeNull();
    expect(store.list().map(run => run.taskId)).toEqual(expect.arrayContaining([taskId, null]));
  });

  it.each([[undefined], ['not-a-uuid'], [12], ['']])('refuses a run whose task is %j', taskId => {
    const { store } = setup();
    expect(() => store.create(validRun({ taskId }))).toThrow(/field task_id/);
  });

  it('reads runs stored before tasks existed as belonging to no task', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, workflow_id TEXT NOT NULL, project TEXT NOT NULL,
      input TEXT NOT NULL, status TEXT NOT NULL, stop_reason TEXT, current_step_index INTEGER NOT NULL, error TEXT,
      definition TEXT NOT NULL, steps TEXT NOT NULL, home_path TEXT NOT NULL, worktree_path TEXT NOT NULL,
      worktree_branch TEXT NOT NULL, base_commit TEXT, worktree_state TEXT NOT NULL, worktree_detail TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT, input_request TEXT)`);
    const store = createRunStore(db);
    expect(store.create(validRun()).taskId).toBeNull();
    expect(() => db.prepare("UPDATE pipeline_runs SET task_id = 'bogus'").run()).not.toThrow();
    expect(() => store.list()).toThrow(/field task_id/);
    db.close();
  });

  it('leaves an approval wait untouched while interrupting a running run on the same restart', () => {
    const { db, store } = setup();
    const waiting = store.create(validRun({ requestId: 'approval-restart', status: 'awaiting_approval',
      steps: [step({ status: 'awaiting_approval', attempt: 1, sessionId: 'Demo-1' })] }));
    const running = store.create(validRun({ requestId: 'running-restart', status: 'running',
      steps: [step({ status: 'running', attempt: 1, sessionId: 'Demo-2' })] }));
    const reopened = createRunStore(db);
    expect(reopened.get(waiting.id).steps[0]).toMatchObject({ status: 'awaiting_approval', sessionId: 'Demo-1' });
    expect(reopened.get(waiting.id).status).toBe('awaiting_approval');
    expect(reopened.get(running.id).status).toBe('interrupted');
    expect(reopened.get(running.id).steps[0].status).toBe('interrupted');
  });
  it('validates and backfills snapshot flags and retains an approval wait across restart', () => {
    const { db, store } = setup();
    const flagged = definition({ steps: [{ ...definition().steps[0], readOnly: true, approval: true }] });
    const waiting = store.create(validRun({ status: 'awaiting_approval', definition: flagged, steps: [step({ status: 'awaiting_approval', attempt: 1 })] }));
    expect(waiting.definition.steps[0]).toMatchObject({ readOnly: true, approval: true });
    expect(createRunStore(db).get(waiting.id).status).toBe('awaiting_approval');
    db.prepare('UPDATE pipeline_runs SET definition = json_remove(definition, ?, ?) WHERE id = ?').run('$.steps[0].readOnly', '$.steps[0].approval', waiting.id);
    expect(createRunStore(db).get(waiting.id).definition.steps[0]).toMatchObject({ readOnly: false, approval: false });
    db.prepare('UPDATE pipeline_runs SET definition = json_set(definition, ?, ?) WHERE id = ?').run('$.steps[0].approval', 'wrong', waiting.id);
    expect(() => store.get(waiting.id)).toThrow(/definition.steps\[0\].approval/);
  });
  it('validates notesDir and backfills absent stored values on reopen', () => {
    const { db, store } = setup();
    expect(() => store.create(validRun({ definition: definition({ notesDir: '../bad' }) }))).toThrow(/definition.notesDir/);
    const created = store.create(validRun({ definition: definition({ notesDir: '.codedeck/runs/abcdef12' }) }));
    expect(created.definition.notesDir).toBe('.codedeck/runs/abcdef12');
    db.prepare('UPDATE pipeline_runs SET definition = json_remove(definition, ?) WHERE id = ?').run('$.notesDir', created.id);
    expect(createRunStore(db).get(created.id).definition.notesDir).toBeNull();
  });
  it('creates a run with a UUID and timestamps', () => {
    const { store } = setup();
    const created = store.create(validRun());
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(created).toMatchObject({
      requestId: 'req-1',
      workflowId: WORKFLOW_ID,
      project: 'Demo',
      input: 'ship it',
      status: 'pending',
      stopReason: null,
      currentStepIndex: 0,
      error: null,
      worktreeState: 'not_created',
      baseCommit: null,
      finishedAt: null,
    });
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.updatedAt).toBe(created.createdAt);
    expect(store.get(created.id)).toEqual(created);
  });

  it('looks up a run by requestId', () => {
    const { store } = setup();
    const created = store.create(validRun({ requestId: 'idem-42' }));
    expect(store.getByRequestId('idem-42')).toEqual(created);
    expect(store.getByRequestId('missing')).toBeNull();
  });

  it('rejects a duplicate requestId', () => {
    const { store } = setup();
    store.create(validRun({ requestId: 'same' }));
    expect(() => store.create(validRun({ requestId: 'same' }))).toThrow(/requestId|request_id/i);
  });

  it('lists runs newest first', () => {
    const { store } = setup({ now: (() => {
      let t = 0;
      return () => new Date(Date.UTC(2026, 10, 13, 12, 0, t++)).toISOString();
    })() });
    const first = store.create(validRun({ requestId: 'a' }));
    const second = store.create(validRun({ requestId: 'b' }));
    expect(store.list().map(r => r.id)).toEqual([second.id, first.id]);
  });

  it('updates mutable run fields and bumps updatedAt', () => {
    const times = ['2026-11-13T12:00:00.000Z', '2026-11-13T12:00:01.000Z'];
    let i = 0;
    const { store } = setup({ now: () => times[Math.min(i++, times.length - 1)] });
    const created = store.create(validRun());
    const updated = store.update(created.id, {
      status: 'running',
      currentStepIndex: 0,
      steps: [step({ status: 'running', sessionId: 'Demo-1', attempt: 1, startedAt: times[1] })],
      worktreeState: 'present',
      baseCommit: 'a'.repeat(40),
    });
    expect(updated).toMatchObject({
      id: created.id,
      status: 'running',
      worktreeState: 'present',
      baseCommit: 'a'.repeat(40),
      createdAt: created.createdAt,
      updatedAt: times[1],
    });
    expect(updated.steps[0].sessionId).toBe('Demo-1');
  });

  it('requires error exactly when status is error', () => {
    const { store } = setup();
    const created = store.create(validRun());
    expect(() => store.update(created.id, { status: 'error', error: null })).toThrow(/error/i);
    expect(() => store.update(created.id, {
      status: 'running',
      error: 'should not be set',
    })).toThrow(/error/i);
    const errored = store.update(created.id, {
      status: 'error',
      error: 'worktree failed',
      finishedAt: '2026-11-13T12:00:00.000Z',
      steps: [step({ status: 'failed', detail: 'worktree failed', finishedAt: '2026-11-13T12:00:00.000Z' })],
    });
    expect(errored.error).toBe('worktree failed');
  });

  it('requires stopReason exactly when status is stopped', () => {
    const { store } = setup();
    const created = store.create(validRun());
    expect(() => store.update(created.id, {
      status: 'stopped',
      stopReason: null,
      finishedAt: '2026-11-13T12:00:00.000Z',
    })).toThrow(/stopReason|stop_reason/i);
    expect(() => store.update(created.id, {
      status: 'running',
      stopReason: 'user',
    })).toThrow(/stopReason|stop_reason/i);
    const stopped = store.update(created.id, {
      status: 'stopped',
      stopReason: 'user',
      finishedAt: '2026-11-13T12:00:00.000Z',
      steps: [step({ status: 'stopped', finishedAt: '2026-11-13T12:00:00.000Z' })],
    });
    expect(stopped.stopReason).toBe('user');
  });
  it('persists no_progress and rejects an unknown stop reason', () => {
    const { store } = setup();
    const created = store.create(validRun());
    expect(() => store.update(created.id, { status: 'stopped', stopReason: 'mystery', finishedAt: '2026-11-13T12:00:00.000Z' })).toThrow(/stopReason|stop_reason/i);
    const stopped = store.update(created.id, { status: 'stopped', stopReason: 'no_progress', finishedAt: '2026-11-13T12:00:00.000Z' });
    expect(store.get(stopped.id).stopReason).toBe('no_progress');
  });

  it('accepts a multi-step run whose steps match the definition length', () => {
    const { store } = setup();
    const def = definition({
      steps: [
        {
          kind: 'node', role: '', readOnly: false, approval: false,
          name: 'One',
          prompt: 'one',
          repeat: { mode: 'once' },
          agent: {
            id: AGENT_ID,
            name: 'codex',
            launchCommand: 'codex',
            resetCommand: '/clear',
          },
        },
        {
          kind: 'node', role: '', readOnly: false, approval: false,
          name: 'Two',
          prompt: 'two',
          repeat: { mode: 'until_complete', max: 3 },
          agent: {
            id: AGENT_ID,
            name: 'codex',
            launchCommand: 'codex',
            resetCommand: '/clear',
          },
        },
      ],
    });
    const created = store.create(validRun({
      requestId: 'multi',
      definition: def,
      steps: [step(), step()],
    }));
    expect(created.steps).toHaveLength(2);
    expect(created.definition.steps).toHaveLength(2);
  });

  it('rejects steps whose length differs from the definition', () => {
    const { store } = setup();
    expect(() => store.create(validRun({ steps: [step(), step()] }))).toThrow(/steps/i);
  });

  it('marks pending, running and needs_input runs interrupted on construction', () => {
    const { db } = setup();
    const seed = createRunStore(db);
    const pending = seed.create(validRun({ requestId: 'p', status: 'pending' }));
    const running = seed.create(validRun({
      requestId: 'r',
      status: 'running',
      steps: [step({ status: 'running', sessionId: 'Demo-1', attempt: 1 })],
    }));
    const needsInput = seed.create(validRun({
      requestId: 'n',
      status: 'needs_input',
      steps: [step({ status: 'needs_input', sessionId: 'Demo-2', attempt: 1 })],
    }));
    const paused = seed.create(validRun({
      requestId: 'l',
      status: 'limit_paused',
      steps: [step({ status: 'limit_reached', attempt: 1, iteration: 3 })],
    }));
    const complete = seed.create(validRun({
      requestId: 'c',
      status: 'complete',
      finishedAt: '2026-11-13T12:00:00.000Z',
      steps: [step({ status: 'complete', finishedAt: '2026-11-13T12:00:00.000Z' })],
      worktreeState: 'present',
      baseCommit: 'b'.repeat(40),
    }));

    const reopened = createRunStore(db);
    expect(reopened.get(pending.id).status).toBe('interrupted');
    expect(reopened.get(pending.id).steps[0].status).toBe('interrupted');
    expect(reopened.get(running.id).status).toBe('interrupted');
    expect(reopened.get(running.id).steps[0].status).toBe('interrupted');
    expect(reopened.get(needsInput.id).status).toBe('interrupted');
    expect(reopened.get(needsInput.id).steps[0].status).toBe('interrupted');
    expect(reopened.get(paused.id).status).toBe('limit_paused');
    expect(reopened.get(paused.id).steps[0].status).toBe('limit_reached');
    expect(reopened.get(complete.id).status).toBe('complete');
  });

  it('leaves limit_paused untouched and only interrupts the current step', () => {
    const { db } = setup();
    const def = definition({
      steps: [
        {
          kind: 'node', role: '', readOnly: false, approval: false,
          name: 'One',
          prompt: 'one',
          repeat: { mode: 'once' },
          agent: {
            id: AGENT_ID,
            name: 'codex',
            launchCommand: 'codex',
            resetCommand: '/clear',
          },
        },
        {
          kind: 'node', role: '', readOnly: false, approval: false,
          name: 'Two',
          prompt: 'two',
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
    const seed = createRunStore(db);
    const run = seed.create(validRun({
      requestId: 'cur',
      status: 'running',
      currentStepIndex: 1,
      definition: def,
      steps: [
        step({ status: 'complete', finishedAt: '2026-11-13T12:00:00.000Z' }),
        step({ status: 'running', sessionId: 'Demo-9', attempt: 1 }),
      ],
    }));

    const reopened = createRunStore(db);
    const interrupted = reopened.get(run.id);
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.steps[0].status).toBe('complete');
    expect(interrupted.steps[1].status).toBe('interrupted');
  });

  it('throws naming table/row/field when a persisted field is corrupt', () => {
    const { db, store } = setup();
    const created = store.create(validRun());
    db.prepare('UPDATE pipeline_runs SET status = ? WHERE id = ?').run('bogus', created.id);
    expect(() => store.get(created.id)).toThrow(
      new RegExp(`pipeline_runs.*${created.id}.*status`, 'i'),
    );
  });

  it('throws when error is set while status is not error on read', () => {
    const { db, store } = setup();
    const created = store.create(validRun());
    db.prepare('UPDATE pipeline_runs SET error = ? WHERE id = ?').run('leak', created.id);
    expect(() => store.get(created.id)).toThrow(
      new RegExp(`pipeline_runs.*${created.id}.*error`, 'i'),
    );
  });

  it('throws when stop_reason is set while status is not stopped on read', () => {
    const { db, store } = setup();
    const created = store.create(validRun());
    db.prepare('UPDATE pipeline_runs SET stop_reason = ? WHERE id = ?').run('user', created.id);
    expect(() => store.get(created.id)).toThrow(
      new RegExp(`pipeline_runs.*${created.id}.*stop_reason`, 'i'),
    );
  });

  it.each(['external', 'released'])('stores the %s worktree state of a run in an existing worktree', (worktreeState) => {
    const { store } = setup();
    const created = store.create(validRun({ worktreeState, baseCommit: 'a'.repeat(40) }));
    expect(store.get(created.id).worktreeState).toBe(worktreeState);
  });

  it('rejects an unknown worktree state', () => {
    const { store } = setup();
    expect(() => store.create(validRun({ worktreeState: 'borrowed' }))).toThrow(/worktree_state/);
  });

  it('rejects invalid create payloads', () => {
    const { store } = setup();
    expect(() => store.create(validRun({ requestId: '' }))).toThrow();
    expect(() => store.create(validRun({ homePath: 'relative' }))).toThrow();
    expect(() => store.create(validRun({ baseCommit: 'short' }))).toThrow();
  });
});

describe('pipeline run store — input request', () => {
  const asked = { questions: '1. Which schema?\nRecommended: the existing one.', truncated: false };
  const waiting = (overrides = {}) => validRun({
    status: 'needs_input',
    steps: [step({ status: 'needs_input', sessionId: 'Demo-1', attempt: 1 })],
    inputRequest: asked,
    ...overrides,
  });

  it('persists what the agent asked and reads it back', () => {
    const { store } = setup();
    const created = store.create(waiting());
    expect(created.inputRequest).toEqual(asked);
    expect(store.get(created.id).inputRequest).toEqual(asked);
    expect(store.list()[0].inputRequest).toEqual(asked);
    expect(store.create(waiting({ requestId: 'none', inputRequest: { questions: null, truncated: false } })).inputRequest)
      .toEqual({ questions: null, truncated: false });
    expect(store.create(waiting({ requestId: 'dialog', inputRequest: null })).inputRequest).toBeNull();
  });

  it('clears it through update when the run leaves needs_input', () => {
    const { store } = setup();
    const created = store.create(waiting());
    const answered = store.update(created.id, {
      status: 'running', inputRequest: null, steps: [step({ status: 'running', sessionId: 'Demo-1', attempt: 1 })],
    });
    expect(answered.inputRequest).toBeNull();
  });

  it.each([
    ['a missing field', { inputRequest: undefined }, 'input_request'],
    ['a request on a run that is not waiting', { status: 'running', steps: [step({ status: 'running', sessionId: 'Demo-1', attempt: 1 })] }, 'input_request'],
    ['an unknown key', { inputRequest: { ...asked, extra: 1 } }, 'inputRequest.extra'],
    ['blank questions', { inputRequest: { questions: ' ', truncated: false } }, 'inputRequest.questions'],
    ['a non-boolean truncated', { inputRequest: { questions: 'One?', truncated: 0 } }, 'inputRequest.truncated'],
  ])('refuses %s', (_label, overrides, field) => {
    const { store } = setup();
    expect(() => store.create(waiting(overrides))).toThrow(field);
  });

  it('refuses a stored value that is not valid JSON', () => {
    const { db, store } = setup();
    const created = store.create(waiting());
    db.prepare('UPDATE pipeline_runs SET input_request = ? WHERE id = ?').run('{not json', created.id);
    expect(() => store.get(created.id)).toThrow('input_request');
  });

  it('adds the column to a database created before it existed and reads those runs as not asked', () => {
    const { db, store } = setup();
    const old = store.create(validRun());
    db.exec('ALTER TABLE pipeline_runs DROP COLUMN input_request');
    expect(db.prepare('PRAGMA table_info(pipeline_runs)').all().map(column => column.name)).not.toContain('input_request');

    const reopened = createRunStore(db);
    expect(db.prepare('PRAGMA table_info(pipeline_runs)').all().map(column => column.name)).toContain('input_request');
    // A run that was pending is interrupted on reopen; its request stays null.
    expect(reopened.get(old.id).inputRequest).toBeNull();
    // Reopening again does not try to add the column twice.
    expect(() => createRunStore(db)).not.toThrow();
  });

  it('drops the request when a waiting run is interrupted by a restart', () => {
    const { db, store } = setup();
    const created = store.create(waiting());
    const reopened = createRunStore(db);
    expect(reopened.get(created.id)).toMatchObject({ status: 'interrupted', inputRequest: null });
  });
});

describe('pipeline run store — loops and who decides', () => {
  const agent = { id: AGENT_ID, name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };
  const defStep = (name, repeat = { mode: 'once' }, kind = 'node') => ({ kind, role: '', readOnly: false, approval: false, name, prompt: `do ${name}`, repeat, agent });
  const loop = (toStepIndex, max = 20) => ({ mode: 'loop_back', toStepIndex, max });
  const looping = (overrides = {}) => {
    const def = definition({
      agentsDecide: true,
      steps: [defStep('Setup', { mode: 'until_complete', max: 3 }, 'setup'), defStep('Develop'), defStep('Test', loop(1))],
      ...overrides,
    });
    return validRun({ definition: def, steps: def.steps.map(() => step()) });
  };

  it('persists who decides, a loop back to an earlier step and the rounds it has completed', () => {
    const { store } = setup();
    const created = store.create(looping());
    expect(created.definition.agentsDecide).toBe(true);
    expect(created.definition.steps[2].repeat).toEqual({ mode: 'loop_back', toStepIndex: 1, max: 20 });
    expect(created.steps.map(s => s.roundsCompleted)).toEqual([0, 0, 0]);

    const steps = created.steps.map((s, index) => (index === 2 ? { ...s, roundsCompleted: 19 } : s));
    expect(store.update(created.id, { steps }).steps[2].roundsCompleted).toBe(19);
  });

  it.each([undefined, null, 'yes', 1])('rejects a definition whose agentsDecide is %s', (agentsDecide) => {
    const { store } = setup();
    expect(() => store.create(looping({ agentsDecide }))).toThrow('field definition.agentsDecide: must be true or false');
  });

  it.each([
    ['its own index', loop(2), 'definition.steps[2].repeat.toStepIndex'],
    ['a later index', loop(3), 'definition.steps[2].repeat.toStepIndex'],
    ['a negative index', loop(-1), 'definition.steps[2].repeat.toStepIndex'],
    ['a fractional index', loop(0.5), 'definition.steps[2].repeat.toStepIndex'],
    ['no index', { mode: 'loop_back', max: 5 }, 'definition.steps[2].repeat.toStepIndex'],
    ['the Setup step', loop(0), 'definition.steps[2].repeat.toStepIndex'],
    ['no maximum', { mode: 'loop_back', toStepIndex: 1 }, 'definition.steps[2].repeat.max'],
    ['a maximum of 0', loop(1, 0), 'definition.steps[2].repeat.max'],
    ['a maximum of 101', loop(1, 101), 'definition.steps[2].repeat.max'],
    ['a node name instead of an index', { mode: 'loop_back', to: 'Develop', toStepIndex: 1, max: 5 }, 'definition.steps[2].repeat.to'],
  ])('rejects a loop back with %s', (_label, repeat, field) => {
    const { store } = setup();
    const steps = [defStep('Setup', { mode: 'until_complete', max: 3 }, 'setup'), defStep('Develop'), defStep('Test', repeat)];
    expect(() => store.create(looping({ steps }))).toThrow(`field ${field}`);
  });

  it.each([
    [{ mode: 'once', toStepIndex: 0 }],
    [{ mode: 'until_complete', max: 3, toStepIndex: 0 }],
  ])('rejects toStepIndex on %o', (repeat) => {
    const { store } = setup();
    const steps = [defStep('Develop'), defStep('Test', repeat)];
    expect(() => store.create(looping({ steps }))).toThrow('field definition.steps[1].repeat.toStepIndex');
  });

  it('rejects loops that share a step', () => {
    const { store } = setup();
    const steps = [defStep('Plan'), defStep('Develop'), defStep('Test', loop(1)), defStep('Review', loop(0))];
    expect(() => store.create(looping({ steps }))).toThrow('field definition.steps[3].repeat.toStepIndex: overlaps the loop that ends at step 2');
  });

  it.each([undefined, null, -1, 1.5, '0'])('rejects a step whose roundsCompleted is %s', (roundsCompleted) => {
    const { store } = setup();
    const run = looping();
    run.steps[2] = { ...step(), roundsCompleted };
    expect(() => store.create(run)).toThrow('field steps[2].roundsCompleted: must be an integer ≥ 0');
  });

  it('accepts completed rounds only on a step that loops back, and fewer than its maximum', () => {
    const { store } = setup();
    const onPlainStep = looping();
    onPlainStep.steps[1] = step({ roundsCompleted: 1 });
    expect(() => store.create(onPlainStep)).toThrow('field steps[1].roundsCompleted: must be 0 for a step that does not loop back');

    const atMaximum = looping();
    atMaximum.steps[2] = step({ roundsCompleted: 20 });
    expect(() => store.create(atMaximum)).toThrow('field steps[2].roundsCompleted: must be less than the maximum of 20 rounds');
  });

  it('upgrades runs stored before loops and agent decisions: the owner decided and no round was completed', () => {
    const { db, store } = setup();
    const created = store.create(validRun());
    const { agentsDecide: _dropped, progressFile: _progress, ...oldDefinition } = created.definition;
    const oldSteps = created.steps.map(({ roundsCompleted: _rounds, ...rest }) => rest);
    db.prepare('UPDATE pipeline_runs SET definition = ?, steps = ?, status = ?, finished_at = ?, stop_reason = ? WHERE id = ?')
      .run(JSON.stringify(oldDefinition), JSON.stringify(oldSteps), 'stopped', '2026-11-14T08:00:00.000Z', 'user', created.id);
    expect(() => store.get(created.id)).toThrow('definition.agentsDecide');

    const reopened = createRunStore(db);
    const upgraded = reopened.get(created.id);
    expect(upgraded.definition.agentsDecide).toBe(false);
    expect(upgraded.definition.progressFile).toBeNull();
    expect(upgraded.steps.map(s => s.roundsCompleted)).toEqual([0]);
    expect(upgraded.updatedAt).toBe(created.updatedAt);
    const stored = db.prepare('SELECT definition, steps FROM pipeline_runs WHERE id = ?').get(created.id);
    expect(JSON.parse(stored.definition).agentsDecide).toBe(false);
    expect(JSON.parse(stored.steps)[0].roundsCompleted).toBe(0);
  });

  it('leaves a run that already has both fields exactly as stored', () => {
    const { db, store } = setup();
    // A stopped run is not touched by the restart that marks unfinished runs interrupted.
    const created = store.create({ ...looping(), status: 'stopped', stopReason: 'user', finishedAt: '2026-11-14T08:00:00.000Z' });
    const before = db.prepare('SELECT definition, steps FROM pipeline_runs WHERE id = ?').get(created.id);
    createRunStore(db);
    expect(db.prepare('SELECT definition, steps FROM pipeline_runs WHERE id = ?').get(created.id)).toEqual(before);
  });
  it.each([undefined, '', '../bad.md', '/bad.md', 'a//b.md', 2])('rejects definition.progressFile %s', progressFile => {
    const { store } = setup();
    expect(() => store.create(validRun({ definition: definition({ progressFile }) }))).toThrow('definition.progressFile');
  });
  it('round trips a composed progress file', () => {
    const { store } = setup();
    const created = store.create(validRun({ definition: definition({ progressFile: 'docs/room.md' }) }));
    expect(store.get(created.id).definition.progressFile).toBe('docs/room.md');
  });
});
