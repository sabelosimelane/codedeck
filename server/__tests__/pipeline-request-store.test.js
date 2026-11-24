import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  createRequestStore,
  PROVISIONING_STATES,
  reservedAttachmentIdentities,
  serializeStartParams,
} from '../pipelines/request-store.js';

const REQUEST_ID = 'run-request-1';
const TASK_ID = '7a000000-0000-4000-8000-000000000001';
const RUN_ID = '8b000000-0000-4000-8000-000000000002';
const STAMP = '2026-11-18T23:00:00.000Z';
const DIGEST_A = '8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8';
const DIGEST_B = '73ab66a033c267e00b7429bb256f6deb2734ebc4cd4ff5b564a8c9f9b2c8a719';
const params = { workflowId: TASK_ID, project: 'Demo', input: 'Fix login', place: { kind: 'newTask', title: null } };
const serialized = JSON.stringify(params);
const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function setup(now = () => STAMP) {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, store: createRequestStore(db, { now }) };
}

function attachmentParams(files) {
  return serializeStartParams({
    workflowId: TASK_ID,
    project: 'Demo',
    input: 'Fix login',
    newTask: {},
    attachments: files,
  });
}

describe('pipeline request store', () => {
  describe('reservedAttachmentIdentities', () => {
    it('returns the ordered identities a reservation recorded', () => {
      const attachments = [{ name: 'a.txt', sizeBytes: 1, digest: DIGEST_A }, { name: 'a.txt', sizeBytes: 2, digest: DIGEST_B }];
      expect(reservedAttachmentIdentities(serializeStartParams({ ...params, newTask: {}, attachments }))).toEqual(attachments);
    });

    it('returns undefined for an attachment-free or legacy reservation', () => {
      expect(reservedAttachmentIdentities(serialized)).toBeUndefined();
    });

    it('throws loudly instead of treating unreadable params as attachment-free', () => {
      expect(() => reservedAttachmentIdentities('{not json')).toThrow(/params/);
      expect(() => reservedAttachmentIdentities(null)).toThrow(/params/);
      expect(() => reservedAttachmentIdentities(JSON.stringify({ attachments: 'x' }))).toThrow(/attachments/);
    });
  });

  describe('the repositories a run is started with', () => {
    const start = { workflowId: TASK_ID, project: 'Demo', input: 'Fix login' };

    it('records a request without them exactly as before they existed', () => {
      expect(serializeStartParams({ ...start, newTask: {} })).toBe(serialized);
      expect(serializeStartParams({ ...start, taskId: TASK_ID })).toBe(JSON.stringify({ ...start, place: { kind: 'task', taskId: TASK_ID } }));
    });

    it('records the base branch a new task is asked to start from only when the request names one', () => {
      const plain = serializeStartParams({ ...start, newTask: { title: 'Replies' } });
      const based = serializeStartParams({ ...start, newTask: { title: 'Replies', baseBranch: 'develop' } });
      expect(plain).toBe(JSON.stringify({ ...start, place: { kind: 'newTask', title: 'Replies' } }));
      expect(JSON.parse(based).place).toEqual({ kind: 'newTask', title: 'Replies', baseBranch: 'develop' });
    });

    it('reads a reservation with a base branch back as the request it was', () => {
      const { store } = setup();
      const recorded = serializeStartParams({ ...start, newTask: { title: 'Replies', baseBranch: 'develop' } });
      expect(store.reserve('based', recorded).params).toBe(recorded);
      expect(store.get('based').params).toBe(recorded);
      const bad = JSON.stringify({ ...start, place: { kind: 'newTask', title: 'Replies', baseBranch: '-x' } });
      expect(() => store.reserve('bad-base', bad)).toThrow(/field params\.place\.baseBranch: /);
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
    const record = {
      requestId: REQUEST_ID,
      params: serialized,
      taskId: null,
      runId: null,
      provisioningState: PROVISIONING_STATES.RESERVED,
      placement: null,
      createdAt: STAMP,
    };
    expect(store.get(REQUEST_ID)).toBeNull();
    expect(store.reserve(REQUEST_ID, serialized)).toEqual(record);
    expect(store.reserve(REQUEST_ID, JSON.stringify({ ...params, input: 'Different' }))).toEqual(record);
    store.setTaskId(REQUEST_ID, TASK_ID);
    expect(createRequestStore(db).get(REQUEST_ID)).toEqual({ ...record, taskId: TASK_ID });
    store.release(REQUEST_ID);
    expect(store.get(REQUEST_ID)).toBeNull();
  });

  it('reserves and replays descriptive multiline input exactly', () => {
    const { store } = setup();
    const start = { workflowId: TASK_ID, project: 'Demo', input: 'First\n\nSecond with trailing.  \n' };
    const recorded = serializeStartParams({ ...start, newTask: {} });
    expect(JSON.parse(recorded).input).toBe(start.input);
    expect(store.reserve(REQUEST_ID, recorded).params).toBe(recorded);
    expect(store.reserve(REQUEST_ID, recorded).params).toBe(recorded);
    expect(store.get(REQUEST_ID).params).toBe(recorded);
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

  describe('attachment identities and durable provisioning', () => {
    const fileA = { name: 'a.txt', sizeBytes: 5, digest: DIGEST_A };
    const fileB = { name: 'b.txt', sizeBytes: 5, digest: DIGEST_B };
    const sameSizeDifferentBytes = { name: 'a.txt', sizeBytes: 5, digest: DIGEST_B };

    it('omits attachments from canonical legacy JSON and includes ordered identities when present', () => {
      expect(serializeStartParams({ workflowId: TASK_ID, project: 'Demo', input: 'Fix login', newTask: {} }))
        .toBe(serialized);
      expect(JSON.parse(attachmentParams([fileA, fileB])).attachments).toEqual([fileA, fileB]);
      expect(attachmentParams([fileA, fileB])).not.toBe(attachmentParams([fileB, fileA]));
      expect(attachmentParams([fileA])).not.toBe(attachmentParams([sameSizeDifferentBytes]));
      expect(attachmentParams([])).toBe(serialized);
    });

    it('reserves attached params and rejects a replay with changed order, bytes or launch fields', () => {
      const { store } = setup();
      const recorded = attachmentParams([fileA, fileB]);
      const first = store.reserve(REQUEST_ID, recorded);
      expect(first).toMatchObject({
        requestId: REQUEST_ID,
        params: recorded,
        taskId: null,
        runId: null,
        provisioningState: PROVISIONING_STATES.RESERVED,
        placement: null,
      });
      expect(store.reserve(REQUEST_ID, recorded)).toEqual(first);
      expect(() => store.assertMatchingParams(REQUEST_ID, attachmentParams([fileB, fileA]))).toThrow(/conflict|different/i);
      expect(() => store.assertMatchingParams(REQUEST_ID, attachmentParams([sameSizeDifferentBytes, fileB]))).toThrow(/conflict|different/i);
      expect(() => store.assertMatchingParams(REQUEST_ID, serializeStartParams({
        workflowId: TASK_ID, project: 'Demo', input: 'Other', newTask: {}, attachments: [fileA, fileB],
      }))).toThrow(/conflict|different/i);
    });

    it('assigns a durable run identity once and records placement under conditional transitions', () => {
      const { db, store } = setup();
      store.reserve(REQUEST_ID, serialized);
      expect(store.assignRunId(REQUEST_ID, RUN_ID)).toMatchObject({ runId: RUN_ID, provisioningState: PROVISIONING_STATES.RESERVED });
      expect(store.assignRunId(REQUEST_ID, RUN_ID)).toMatchObject({ runId: RUN_ID });
      expect(() => store.assignRunId(REQUEST_ID, '9c000000-0000-4000-8000-000000000003')).toThrow(/run_id/);
      const placement = { worktreePath: '/tmp/wt', homePath: '/tmp/home', startRepository: 'Demo' };
      expect(store.setPlacement(REQUEST_ID, placement, { from: PROVISIONING_STATES.RESERVED })).toMatchObject({ placement });
      expect(createRequestStore(db).get(REQUEST_ID)).toMatchObject({ runId: RUN_ID, placement, provisioningState: PROVISIONING_STATES.RESERVED });
      expect(store.transition(REQUEST_ID, { from: PROVISIONING_STATES.RESERVED, to: PROVISIONING_STATES.PUBLISHED }))
        .toMatchObject({ provisioningState: PROVISIONING_STATES.PUBLISHED });
      expect(store.transition(REQUEST_ID, { from: PROVISIONING_STATES.RESERVED, to: PROVISIONING_STATES.FAILED })).toBeNull();
      expect(store.get(REQUEST_ID).provisioningState).toBe(PROVISIONING_STATES.PUBLISHED);
    });

    it('marks a recoverable failure and fences a closed reservation against further publication', () => {
      const { store } = setup();
      store.reserve(REQUEST_ID, attachmentParams([fileA]));
      store.assignRunId(REQUEST_ID, RUN_ID);
      expect(store.transition(REQUEST_ID, { from: PROVISIONING_STATES.RESERVED, to: PROVISIONING_STATES.FAILED }))
        .toMatchObject({ provisioningState: PROVISIONING_STATES.FAILED, runId: RUN_ID });
      expect(store.transition(REQUEST_ID, { from: PROVISIONING_STATES.FAILED, to: PROVISIONING_STATES.RESERVED }))
        .toMatchObject({ provisioningState: PROVISIONING_STATES.RESERVED });
      expect(store.transition(REQUEST_ID, { from: PROVISIONING_STATES.RESERVED, to: PROVISIONING_STATES.CLOSED }))
        .toMatchObject({ provisioningState: PROVISIONING_STATES.CLOSED });
      expect(store.transition(REQUEST_ID, { from: PROVISIONING_STATES.CLOSED, to: PROVISIONING_STATES.PUBLISHED })).toBeNull();
      expect(store.get(REQUEST_ID).provisioningState).toBe(PROVISIONING_STATES.CLOSED);
    });

    it('reads legacy rows without the new columns as reserved with null run and placement', () => {
      const { db } = setup();
      db.exec(`DROP TABLE pipeline_run_requests`);
      db.exec(`
        CREATE TABLE pipeline_run_requests (
          request_id TEXT PRIMARY KEY,
          params TEXT NOT NULL,
          task_id TEXT,
          created_at TEXT NOT NULL
        );
      `);
      db.prepare('INSERT INTO pipeline_run_requests (request_id, params, task_id, created_at) VALUES (?, ?, NULL, ?)')
        .run(REQUEST_ID, serialized, STAMP);
      const store = createRequestStore(db);
      expect(store.get(REQUEST_ID)).toMatchObject({
        requestId: REQUEST_ID,
        params: serialized,
        taskId: null,
        runId: null,
        provisioningState: PROVISIONING_STATES.RESERVED,
        placement: null,
        createdAt: STAMP,
      });
      expect(store.reserve(REQUEST_ID, serialized).params).toBe(serialized);
    });

    it('releases a reservation that never received a task and refuses invalid attachment params', () => {
      const { store } = setup();
      store.reserve(REQUEST_ID, attachmentParams([fileA]));
      store.release(REQUEST_ID);
      expect(store.get(REQUEST_ID)).toBeNull();
      expect(() => store.reserve(REQUEST_ID, attachmentParams([{ name: 'a.txt', sizeBytes: 5, digest: 'not-hex' }])))
        .toThrow(/attachments/);
      expect(() => store.reserve(REQUEST_ID, attachmentParams([{ name: '../x', sizeBytes: 1, digest: DIGEST_A }])))
        .toThrow(/attachments/);
    });

    it('finds a reservation by its durable run identity', () => {
      const { store } = setup();
      store.reserve(REQUEST_ID, attachmentParams([fileA]));
      expect(store.getByRunId(RUN_ID)).toBeNull();
      store.assignRunId(REQUEST_ID, RUN_ID);
      expect(store.getByRunId(RUN_ID)).toMatchObject({ requestId: REQUEST_ID, runId: RUN_ID });
      expect(() => store.getByRunId('not-a-uuid')).toThrow(/run_id/);
    });

    it('lists reserved and failed reservations but not published or closed ones', () => {
      const { store } = setup();
      const ids = ['req-reserved', 'req-failed', 'req-published', 'req-closed'];
      for (const id of ids) store.reserve(id, attachmentParams([fileA]));
      store.transition('req-failed', { from: PROVISIONING_STATES.RESERVED, to: PROVISIONING_STATES.FAILED });
      store.transition('req-published', { from: PROVISIONING_STATES.RESERVED, to: PROVISIONING_STATES.PUBLISHED });
      store.transition('req-closed', { from: PROVISIONING_STATES.RESERVED, to: PROVISIONING_STATES.CLOSED });
      expect(store.listUnpublished().map(record => [record.requestId, record.provisioningState])).toEqual([
        ['req-failed', PROVISIONING_STATES.FAILED],
        ['req-reserved', PROVISIONING_STATES.RESERVED],
      ]);
    });
  });
});
