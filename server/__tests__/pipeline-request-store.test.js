import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createRequestStore, serializeStartParams } from '../pipelines/request-store.js';

const REQUEST_ID = 'run-request-1';
const TASK_ID = '7a000000-0000-4000-8000-000000000001';
const STAMP = '2026-11-18T23:00:00.000Z';
const params = { workflowId: TASK_ID, project: 'Demo', input: 'Fix login', place: { kind: 'newTask', title: null } };
const serialized = JSON.stringify(params);
const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function setup(now = () => STAMP) {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, store: createRequestStore(db, { now }) };
}

describe('pipeline request store', () => {
  describe('the repositories a run is started with', () => {
    const start = { workflowId: TASK_ID, project: 'Demo', input: 'Fix login' };

    it('records a request without them exactly as before they existed', () => {
      expect(serializeStartParams({ ...start, newTask: {} })).toBe(serialized);
      expect(serializeStartParams({ ...start, taskId: TASK_ID })).toBe(JSON.stringify({ ...start, place: { kind: 'task', taskId: TASK_ID } }));
    });

    it('records the repository the run starts in and the ones a new task includes', () => {
      const plain = serializeStartParams({ ...start, newTask: { title: ' Replies ' } });
      const withStart = serializeStartParams({ ...start, newTask: { title: ' Replies ' }, startIn: 'backend' });
      const withList = serializeStartParams({ ...start, newTask: { title: ' Replies ', repositories: ['backend', 'mobile-app'] }, startIn: 'backend' });
      expect(new Set([plain, withStart, withList]).size).toBe(3);
      expect(JSON.parse(withList)).toEqual({ ...start, place: { kind: 'newTask', title: 'Replies', repositories: ['backend', 'mobile-app'] }, startIn: 'backend' });
      expect(serializeStartParams({ ...start, taskId: TASK_ID, startIn: 'backend' }))
        .not.toBe(serializeStartParams({ ...start, taskId: TASK_ID, startIn: 'mobile-app' }));
      // The order of a new task's repositories is part of the request: the first is where it starts when no other is named.
      expect(serializeStartParams({ ...start, newTask: { repositories: ['mobile-app', 'backend'] } }))
        .not.toBe(serializeStartParams({ ...start, newTask: { repositories: ['backend', 'mobile-app'] } }));
    });

    it('reserves and reads back a request that names them', () => {
      const { db, store } = setup();
      const recorded = serializeStartParams({ ...start, newTask: { repositories: ['backend', 'mobile-app'] }, startIn: 'mobile-app' });
      expect(store.reserve(REQUEST_ID, recorded).params).toBe(recorded);
      store.setTaskId(REQUEST_ID, TASK_ID);
      expect(createRequestStore(db).get(REQUEST_ID)).toMatchObject({ params: recorded, taskId: TASK_ID });
      const inTask = serializeStartParams({ ...start, taskId: TASK_ID, startIn: 'backend' });
      expect(store.reserve('run-request-2', inTask).params).toBe(inTask);
    });

    it('refuses recorded parameters whose repositories are not valid', () => {
      const { store } = setup();
      const bad = extra => JSON.stringify({ ...start, place: { kind: 'newTask', title: null, ...extra.place }, ...extra.top });
      expect(() => store.reserve(REQUEST_ID, bad({ place: { repositories: 'backend' } }))).toThrow(/pipeline_run_requests row run-request-1 field params\.place\.repositories: /);
      expect(() => store.reserve(REQUEST_ID, bad({ place: { repositories: null } }))).toThrow(/field params\.place\.repositories: /);
      expect(() => store.reserve(REQUEST_ID, bad({ top: { startIn: '../backend' } }))).toThrow(/field params\.startIn: /);
      expect(() => store.reserve(REQUEST_ID, bad({ top: { startIn: null } }))).toThrow(/field params\.startIn: /);
      // A request with no place of its own has no task to start in.
      expect(() => store.reserve(REQUEST_ID, JSON.stringify({ ...start, place: { kind: 'new' }, startIn: 'backend' }))).toThrow(/field params\.startIn: /);
    });
  });

  it('persists the first canonical parameters and releases the reservation by id', () => {
    const { db, store } = setup();
    const record = { requestId: REQUEST_ID, params: serialized, taskId: null, createdAt: STAMP };
    expect(store.get(REQUEST_ID)).toBeNull();
    expect(store.reserve(REQUEST_ID, serialized)).toEqual(record);
    expect(store.reserve(REQUEST_ID, JSON.stringify({ ...params, input: 'Different' }))).toEqual(record);
    store.setTaskId(REQUEST_ID, TASK_ID);
    expect(createRequestStore(db).get(REQUEST_ID)).toEqual({ ...record, taskId: TASK_ID });
    store.release(REQUEST_ID);
    expect(store.get(REQUEST_ID)).toBeNull();
  });

  it('rejects invalid request_id arguments for each operation', () => {
    const { store } = setup();
    expect(() => store.reserve('bad id', serialized)).toThrow('request_id');
    expect(() => store.get(null)).toThrow('request_id');
    expect(() => store.setTaskId(null, TASK_ID)).toThrow('request_id');
    expect(() => store.release(null)).toThrow('request_id');
  });

  it.each([
    [null, 'params'],
    ['{', 'params'],
    ['null', 'params'],
    [JSON.stringify({ ...params, workflowId: 'bad' }), 'workflowId'],
    [JSON.stringify({ ...params, project: null }), 'project'],
    [JSON.stringify({ ...params, input: null }), 'input'],
    [JSON.stringify({ ...params, place: null }), 'place'],
    [JSON.stringify({ ...params, place: { kind: 'bad' } }), 'place.kind'],
    [JSON.stringify({ ...params, place: { kind: 'newTask', title: ' untrimmed ' } }), 'place.title'],
    [JSON.stringify({ ...params, place: { kind: 'newTask' } }), 'place.title'],
    [JSON.stringify({ ...params, place: { kind: 'task', taskId: 'bad' } }), 'place.taskId'],
    [JSON.stringify({ ...params, place: { kind: 'worktree', worktreePath: 'bad' } }), 'place.worktreePath'],
    [JSON.stringify({ ...params, place: { kind: 'new', title: 'Unexpected' } }), 'params'],
  ])('rejects invalid parameters %j on write and read, identifying %s', (badParams, field) => {
    const { db, store } = setup();
    expect(() => store.reserve(REQUEST_ID, badParams)).toThrow(field);
    expect(store.get(REQUEST_ID)).toBeNull();
    if (badParams === null) return; // SQLite prevents a NULL params column.
    store.reserve(REQUEST_ID, serialized);
    db.prepare('UPDATE pipeline_run_requests SET params = ? WHERE request_id = ?').run(badParams, REQUEST_ID);
    const read = () => store.get(REQUEST_ID);
    expect(read).toThrow(field);
    expect(read).toThrow(REQUEST_ID);
  });

  it('rejects invalid task_id and forbids assigning a task_id to other selectors', () => {
    const { db, store } = setup();
    expect(() => store.setTaskId(REQUEST_ID, TASK_ID)).toThrow('task_id');
    store.reserve(REQUEST_ID, serialized);
    expect(() => store.setTaskId(REQUEST_ID, 'bad')).toThrow('task_id');
    db.prepare("UPDATE pipeline_run_requests SET task_id = 'bad' WHERE request_id = ?").run(REQUEST_ID);
    expect(() => store.get(REQUEST_ID)).toThrow(/run-request-1.*task_id/);
    store.release(REQUEST_ID);
    store.reserve(REQUEST_ID, JSON.stringify({ ...params, place: { kind: 'new' } }));
    expect(() => store.setTaskId(REQUEST_ID, TASK_ID)).toThrow(/run-request-1.*task_id/);
    db.prepare('UPDATE pipeline_run_requests SET task_id = ? WHERE request_id = ?').run(TASK_ID, REQUEST_ID);
    expect(() => store.get(REQUEST_ID)).toThrow(/run-request-1.*task_id/);
  });

  it('rejects invalid created_at on write and read', () => {
    const { db, store } = setup();
    expect(() => createRequestStore(db, { now: () => 'yesterday' }).reserve(REQUEST_ID, serialized)).toThrow('created_at');
    store.reserve(REQUEST_ID, serialized);
    db.prepare("UPDATE pipeline_run_requests SET created_at = 'yesterday' WHERE request_id = ?").run(REQUEST_ID);
    expect(() => store.get(REQUEST_ID)).toThrow(/run-request-1.*created_at/);
  });

  it('rejects a corrupt request_id returned by the database', () => {
    const { db, store } = setup();
    store.reserve(REQUEST_ID, serialized);
    const handle = {
      exec: sql => db.exec(sql),
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith('SELECT')) return statement;
        return { get: id => ({ ...statement.get(id), request_id: null }) };
      },
    };
    expect(() => createRequestStore(handle).get(REQUEST_ID)).toThrow(/run-request-1.*request_id/);
  });
});
