import { isRunRequestId, isUuid, validateRunStartBody } from '../../shared/pipeline-definitions.mjs';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The canonical form of what a run was started with. `startIn` and a new task's `repositories` are
 * written only when the request names them, so a request recorded before they existed reads the same.
 */
export function serializeStartParams({ workflowId, project, input, newTask, taskId, worktreePath, startIn, teamId, stepOverrides }) {
  let place = { kind: 'new' };
  if (newTask !== undefined) place = { kind: 'newTask', title: newTask.title === undefined ? null : newTask.title.trim(), repositories: newTask.repositories };
  else if (taskId !== undefined) place = { kind: 'task', taskId };
  else if (worktreePath !== undefined) place = { kind: 'worktree', worktreePath };
  return JSON.stringify({ workflowId, project, input, place, startIn, teamId,
    stepOverrides: stepOverrides && Object.fromEntries(Object.keys(stepOverrides).sort().map(name => [name, stepOverrides[name]])),
  });
}

const fail = (id, field, expectation) => {
  throw new Error(`pipeline_run_requests row ${id} field ${field}: ${expectation}`);
};

function requireRequestId(id) {
  if (!isRunRequestId(id)) fail('(invalid identity)', 'request_id', 'must be a valid run request id');
}

function validateParams(requestId, params) {
  if (typeof params !== 'string') fail(requestId, 'params', 'must be a JSON string');
  let parsed;
  try {
    parsed = JSON.parse(params);
  } catch {
    fail(requestId, 'params', 'must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(requestId, 'params', 'must encode an object');
  const { workflowId, project, input, place } = parsed;
  if (!place || typeof place !== 'object' || Array.isArray(place)) fail(requestId, 'params.place', 'must be an object');

  const body = { requestId, workflowId, project, input };
  const fields = { 'newTask.title': 'place.title', 'newTask.repositories': 'place.repositories', taskId: 'place.taskId', worktreePath: 'place.worktreePath' };
  for (const key of ['startIn', 'teamId', 'stepOverrides']) {
    if (Object.hasOwn(parsed, key)) body[key] = parsed[key];
  }
  switch (place.kind) {
    case 'newTask':
      if (place.title !== null && (typeof place.title !== 'string' || place.title.trim() !== place.title)) {
        fail(requestId, 'params.place.title', 'must be a trimmed title or null');
      }
      body.newTask = place.title === null ? {} : { title: place.title };
      if (Object.hasOwn(place, 'repositories')) body.newTask.repositories = place.repositories;
      break;
    case 'task':
      if (place.taskId === undefined) fail(requestId, 'params.place.taskId', 'must be a UUID');
      body.taskId = place.taskId;
      break;
    case 'worktree':
      if (place.worktreePath === undefined) fail(requestId, 'params.place.worktreePath', 'must be an absolute path');
      body.worktreePath = place.worktreePath;
      break;
    case 'new':
      break;
    default:
      fail(requestId, 'params.place.kind', 'must be newTask, task, worktree or new');
  }
  const [error] = validateRunStartBody(body);
  if (error) fail(requestId, `params.${fields[error.field] ?? error.field}`, error.message);
  if (serializeStartParams(body) !== params) fail(requestId, 'params', 'must use the canonical start parameters');
  return place.kind;
}

function validateTimestamp(id, timestamp) {
  if (typeof timestamp !== 'string' || !ISO_TIMESTAMP.test(timestamp) || Number.isNaN(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp) {
    fail(id, 'created_at', 'must be an ISO timestamp');
  }
}

export function createRequestStore(db, { now = () => new Date().toISOString() } = {}) {
  if (typeof db?.exec !== 'function' || typeof db?.prepare !== 'function') throw new TypeError('pipeline_run_requests: a database handle is required');
  if (typeof now !== 'function') throw new TypeError('pipeline_run_requests: now must be a function');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_run_requests (
      request_id TEXT PRIMARY KEY,
      params TEXT NOT NULL,
      task_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const select = db.prepare('SELECT request_id, params, task_id, created_at FROM pipeline_run_requests WHERE request_id = ?');
  const insert = db.prepare(`
    INSERT INTO pipeline_run_requests (request_id, params, created_at) VALUES (?, ?, ?)
    ON CONFLICT (request_id) DO NOTHING
  `);
  const update = db.prepare('UPDATE pipeline_run_requests SET task_id = ? WHERE request_id = ?');
  const remove = db.prepare('DELETE FROM pipeline_run_requests WHERE request_id = ?');

  function read(requestId) {
    const row = select.get(requestId);
    if (row === undefined) return null;
    if (!isRunRequestId(row.request_id) || row.request_id !== requestId) fail(requestId, 'request_id', 'must match the request id');
    const kind = validateParams(requestId, row.params);
    if (row.task_id !== null && (kind !== 'newTask' || !isUuid(row.task_id))) {
      fail(requestId, 'task_id', 'must be null or a task UUID for a newTask request');
    }
    validateTimestamp(requestId, row.created_at);
    return { record: { requestId, params: row.params, taskId: row.task_id, createdAt: row.created_at }, kind };
  }

  return {
    get(requestId) {
      requireRequestId(requestId);
      return read(requestId)?.record ?? null;
    },
    reserve(requestId, params) {
      requireRequestId(requestId);
      validateParams(requestId, params);
      const existing = read(requestId);
      if (existing) return existing.record;
      const createdAt = now();
      validateTimestamp(requestId, createdAt);
      insert.run(requestId, params, createdAt);
      return read(requestId).record;
    },
    setTaskId(requestId, taskId) {
      requireRequestId(requestId);
      if (!isUuid(taskId)) fail(requestId, 'task_id', 'must be a UUID');
      if (read(requestId)?.kind !== 'newTask' || update.run(taskId, requestId).changes !== 1) {
        fail(requestId, 'task_id', 'requires a newTask reservation');
      }
    },
    release(requestId) {
      requireRequestId(requestId);
      remove.run(requestId);
    },
  };
}
