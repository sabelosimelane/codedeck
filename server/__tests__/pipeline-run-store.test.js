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
    steps: [
      {
        kind: 'node',
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
    finishedAt: null,
    ...overrides,
  };
}

describe('pipeline run store', () => {
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

  it('accepts a multi-step run whose steps match the definition length', () => {
    const { store } = setup();
    const def = definition({
      steps: [
        {
          kind: 'node',
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
          kind: 'node',
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
          kind: 'node',
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
          kind: 'node',
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

  it('rejects invalid create payloads', () => {
    const { store } = setup();
    expect(() => store.create(validRun({ requestId: '' }))).toThrow();
    expect(() => store.create(validRun({ homePath: 'relative' }))).toThrow();
    expect(() => store.create(validRun({ baseCommit: 'short' }))).toThrow();
  });
});
