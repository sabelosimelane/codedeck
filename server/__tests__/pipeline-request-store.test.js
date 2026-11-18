import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createRequestStore } from '../pipelines/request-store.js';

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
