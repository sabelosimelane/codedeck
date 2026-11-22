import { isRunRequestId, isUuid, validateRunStartBody } from '../../shared/pipeline-definitions.mjs';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, isSafeAttachmentName } from './attachments.js';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export const PROVISIONING_STATES = Object.freeze({
  RESERVED: 'reserved',
  PUBLISHED: 'published',
  FAILED: 'failed',
  CLOSED: 'closed',
});

const PROVISIONING_STATE_SET = new Set(Object.values(PROVISIONING_STATES));

/** Allowed durable transitions. Closed reservations cannot publish or reopen. */
const ALLOWED_TRANSITIONS = new Map([
  [`${PROVISIONING_STATES.RESERVED}->${PROVISIONING_STATES.PUBLISHED}`, true],
  [`${PROVISIONING_STATES.RESERVED}->${PROVISIONING_STATES.FAILED}`, true],
  [`${PROVISIONING_STATES.RESERVED}->${PROVISIONING_STATES.CLOSED}`, true],
  [`${PROVISIONING_STATES.FAILED}->${PROVISIONING_STATES.RESERVED}`, true],
  [`${PROVISIONING_STATES.FAILED}->${PROVISIONING_STATES.CLOSED}`, true],
  [`${PROVISIONING_STATES.FAILED}->${PROVISIONING_STATES.PUBLISHED}`, true],
]);

/**
 * Ordered attachment identities for start-request replay (name, size, digest only).
 * Omitted from the canonical JSON when empty so legacy attachment-free reservations match.
 */
export function serializeAttachmentIdentities(attachments) {
  if (attachments === undefined || attachments === null) return undefined;
  if (!Array.isArray(attachments)) {
    throw new Error('attachments: must be an array');
  }
  if (attachments.length === 0) return undefined;
  if (attachments.length > ATTACHMENT_MAX_COUNT) {
    throw new Error(`attachments: at most ${ATTACHMENT_MAX_COUNT} files`);
  }
  return attachments.map((entry, index) => {
    const field = `attachments[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${field}: must be an object`);
    }
    const { name, sizeBytes, digest } = entry;
    if (!isSafeAttachmentName(name)) throw new Error(`${field}.name: invalid`);
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > ATTACHMENT_MAX_BYTES) {
      throw new Error(`${field}.sizeBytes: invalid`);
    }
    if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) throw new Error(`${field}.digest: invalid`);
    return { name, sizeBytes, digest };
  });
}

/**
 * The ordered attachment identities recorded in a reservation's params, or undefined when it has none.
 * Params that cannot be read are a bug surfacing, never an attachment-free start.
 */
export function reservedAttachmentIdentities(params) {
  if (typeof params !== 'string') throw new TypeError('reservation params: must be a JSON string');
  let parsed;
  try {
    parsed = JSON.parse(params);
  } catch (error) {
    throw new Error(`reservation params: must be valid JSON (${error.message})`);
  }
  return serializeAttachmentIdentities(parsed?.attachments);
}

/**
 * The canonical form of what a run was started with. `startIn` and a new task's `repositories` are
 * written only when the request names them, so a request recorded before they existed reads the same.
 * Ordered attachment identities are included only when the start carries files.
 */
export function serializeStartParams({
  workflowId, project, input, newTask, taskId, worktreePath, startIn, teamId, stepOverrides, disabledSteps, attachments,
}) {
  let place = { kind: 'new' };
  if (newTask !== undefined) place = { kind: 'newTask', title: newTask.title === undefined ? null : newTask.title.trim(), repositories: newTask.repositories };
  else if (taskId !== undefined) place = { kind: 'task', taskId };
  else if (worktreePath !== undefined) place = { kind: 'worktree', worktreePath };
  const body = { workflowId, project, input, place, startIn, teamId,
    stepOverrides: stepOverrides && Object.fromEntries(Object.keys(stepOverrides).sort().map(name => [name, stepOverrides[name]])),
    ...(disabledSteps !== undefined ? { disabledSteps: [...disabledSteps].map(name => name.trim()).sort() } : {}),
  };
  const identities = serializeAttachmentIdentities(attachments);
  if (identities !== undefined) body.attachments = identities;
  return JSON.stringify(body);
}

const fail = (id, field, expectation) => {
  throw new Error(`pipeline_run_requests row ${id} field ${field}: ${expectation}`);
};

function requireRequestId(id) {
  if (!isRunRequestId(id)) fail('(invalid identity)', 'request_id', 'must be a valid run request id');
}

function validateAttachmentParams(requestId, attachments) {
  if (attachments === undefined) return;
  try {
    serializeAttachmentIdentities(attachments);
  } catch (err) {
    const message = String(err?.message || err);
    const field = message.startsWith('attachments') ? message.split(':')[0] : 'attachments';
    fail(requestId, `params.${field}`, message.includes(':') ? message.slice(message.indexOf(':') + 2) : message);
  }
  // Round-trip through serializer so only the identity fields are accepted.
  if (JSON.stringify(serializeAttachmentIdentities(attachments)) !== JSON.stringify(attachments)) {
    fail(requestId, 'params.attachments', 'must use canonical attachment identities');
  }
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
  const { workflowId, project, input, place, attachments } = parsed;
  if (!place || typeof place !== 'object' || Array.isArray(place)) fail(requestId, 'params.place', 'must be an object');

  const body = { requestId, workflowId, project, input };
  const fields = { 'newTask.title': 'place.title', 'newTask.repositories': 'place.repositories', taskId: 'place.taskId', worktreePath: 'place.worktreePath' };
  for (const key of ['startIn', 'teamId', 'stepOverrides', 'disabledSteps']) {
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
  // Attachment identities are reservation fingerprint only — not an HTTP start-body field.
  if (Object.hasOwn(parsed, 'attachments')) {
    validateAttachmentParams(requestId, attachments);
  }
  const [error] = validateRunStartBody(body);
  if (error) fail(requestId, `params.${fields[error.field] ?? error.field}`, error.message);
  if (Object.hasOwn(parsed, 'attachments')) body.attachments = attachments;
  if (serializeStartParams(body) !== params) fail(requestId, 'params', 'must use the canonical start parameters');
  return place.kind;
}

function validateTimestamp(id, timestamp) {
  if (typeof timestamp !== 'string' || !ISO_TIMESTAMP.test(timestamp) || Number.isNaN(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp) {
    fail(id, 'created_at', 'must be an ISO timestamp');
  }
}

function validateProvisioningState(id, state) {
  if (!PROVISIONING_STATE_SET.has(state)) fail(id, 'provisioning_state', 'must be a known provisioning state');
}

function validatePlacement(id, placement) {
  if (placement === null || placement === undefined) return null;
  if (typeof placement !== 'object' || Array.isArray(placement)) fail(id, 'placement', 'must be an object or null');
  for (const key of ['worktreePath', 'homePath', 'startRepository']) {
    if (typeof placement[key] !== 'string' || placement[key].trim() === '') {
      fail(id, `placement.${key}`, 'must be a nonempty string');
    }
  }
  return {
    worktreePath: placement.worktreePath,
    homePath: placement.homePath,
    startRepository: placement.startRepository,
  };
}

function ensureColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(pipeline_run_requests)').all().map(row => row.name));
  if (!columns.has('run_id')) {
    db.exec('ALTER TABLE pipeline_run_requests ADD COLUMN run_id TEXT');
  }
  if (!columns.has('provisioning_state')) {
    db.exec(`ALTER TABLE pipeline_run_requests ADD COLUMN provisioning_state TEXT NOT NULL DEFAULT '${PROVISIONING_STATES.RESERVED}'`);
  }
  if (!columns.has('placement')) {
    db.exec('ALTER TABLE pipeline_run_requests ADD COLUMN placement TEXT');
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
      run_id TEXT,
      provisioning_state TEXT NOT NULL DEFAULT '${PROVISIONING_STATES.RESERVED}',
      placement TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureColumns(db);

  // Keep this SELECT on one line so test doubles that match `sql.startsWith('SELECT')` still wrap it.
  const select = db.prepare('SELECT request_id, params, task_id, run_id, provisioning_state, placement, created_at FROM pipeline_run_requests WHERE request_id = ?');
  const insert = db.prepare(`
    INSERT INTO pipeline_run_requests (request_id, params, created_at, provisioning_state)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (request_id) DO NOTHING
  `);
  const updateTask = db.prepare('UPDATE pipeline_run_requests SET task_id = ? WHERE request_id = ?');
  const updateRunId = db.prepare(`
    UPDATE pipeline_run_requests SET run_id = ?
    WHERE request_id = ? AND (run_id IS NULL OR run_id = ?)
  `);
  const updatePlacement = db.prepare(`
    UPDATE pipeline_run_requests SET placement = ?
    WHERE request_id = ? AND provisioning_state = ?
  `);
  const updateState = db.prepare(`
    UPDATE pipeline_run_requests SET provisioning_state = ?
    WHERE request_id = ? AND provisioning_state = ?
  `);
  const remove = db.prepare('DELETE FROM pipeline_run_requests WHERE request_id = ?');
  const selectByRunId = db.prepare('SELECT request_id FROM pipeline_run_requests WHERE run_id = ?');
  const selectUnpublished = db.prepare(`
    SELECT request_id FROM pipeline_run_requests WHERE provisioning_state IN (?, ?) ORDER BY request_id
  `);

  function read(requestId) {
    const row = select.get(requestId);
    if (row === undefined) return null;
    if (!isRunRequestId(row.request_id) || row.request_id !== requestId) fail(requestId, 'request_id', 'must match the request id');
    const kind = validateParams(requestId, row.params);
    if (row.task_id !== null && (kind !== 'newTask' || !isUuid(row.task_id))) {
      fail(requestId, 'task_id', 'must be null or a task UUID for a newTask request');
    }
    if (row.run_id !== null && !isUuid(row.run_id)) fail(requestId, 'run_id', 'must be null or a UUID');
    const provisioningState = row.provisioning_state ?? PROVISIONING_STATES.RESERVED;
    validateProvisioningState(requestId, provisioningState);
    let placement = null;
    if (row.placement !== null && row.placement !== undefined) {
      let parsed;
      try {
        parsed = JSON.parse(row.placement);
      } catch {
        fail(requestId, 'placement', 'must be valid JSON');
      }
      placement = validatePlacement(requestId, parsed);
      if (JSON.stringify(placement) !== row.placement) fail(requestId, 'placement', 'must use the canonical placement');
    }
    validateTimestamp(requestId, row.created_at);
    return {
      record: {
        requestId,
        params: row.params,
        taskId: row.task_id,
        runId: row.run_id,
        provisioningState,
        placement,
        createdAt: row.created_at,
      },
      kind,
    };
  }

  return {
    get(requestId) {
      requireRequestId(requestId);
      return read(requestId)?.record ?? null;
    },
    getByRunId(runId) {
      if (!isUuid(runId)) fail('(lookup)', 'run_id', 'must be a UUID');
      const row = selectByRunId.get(runId);
      return row === undefined ? null : read(row.request_id).record;
    },
    /** Reservations that never published: in flight, interrupted, or failed and awaiting retry or Close. */
    listUnpublished() {
      return selectUnpublished.all(PROVISIONING_STATES.RESERVED, PROVISIONING_STATES.FAILED)
        .map(row => read(row.request_id).record);
    },
    reserve(requestId, params) {
      requireRequestId(requestId);
      validateParams(requestId, params);
      const existing = read(requestId);
      if (existing) return existing.record;
      const createdAt = now();
      validateTimestamp(requestId, createdAt);
      insert.run(requestId, params, createdAt, PROVISIONING_STATES.RESERVED);
      return read(requestId).record;
    },
    assertMatchingParams(requestId, params) {
      requireRequestId(requestId);
      validateParams(requestId, params);
      const existing = read(requestId);
      if (!existing) fail(requestId, 'request_id', 'must already be reserved');
      if (existing.record.params !== params) {
        const err = new Error('This requestId was already used with a different body');
        err.code = 'request_conflict';
        throw err;
      }
      return existing.record;
    },
    setTaskId(requestId, taskId) {
      requireRequestId(requestId);
      if (!isUuid(taskId)) fail(requestId, 'task_id', 'must be a UUID');
      if (read(requestId)?.kind !== 'newTask' || updateTask.run(taskId, requestId).changes !== 1) {
        fail(requestId, 'task_id', 'requires a newTask reservation');
      }
    },
    assignRunId(requestId, runId) {
      requireRequestId(requestId);
      if (!isUuid(runId)) fail(requestId, 'run_id', 'must be a UUID');
      const existing = read(requestId);
      if (!existing) fail(requestId, 'run_id', 'requires a reservation');
      if (existing.record.runId !== null && existing.record.runId !== runId) {
        fail(requestId, 'run_id', 'must keep the durable run identity');
      }
      if (updateRunId.run(runId, requestId, runId).changes !== 1 && existing.record.runId !== runId) {
        fail(requestId, 'run_id', 'must keep the durable run identity');
      }
      return read(requestId).record;
    },
    setPlacement(requestId, placement, { from } = {}) {
      requireRequestId(requestId);
      if (!PROVISIONING_STATE_SET.has(from)) fail(requestId, 'provisioning_state', 'must be a known provisioning state');
      const canonical = validatePlacement(requestId, placement);
      const encoded = JSON.stringify(canonical);
      if (updatePlacement.run(encoded, requestId, from).changes !== 1) {
        fail(requestId, 'placement', `requires provisioning state ${from}`);
      }
      return read(requestId).record;
    },
    transition(requestId, { from, to }) {
      requireRequestId(requestId);
      validateProvisioningState(requestId, from);
      validateProvisioningState(requestId, to);
      if (!ALLOWED_TRANSITIONS.has(`${from}->${to}`)) return null;
      if (updateState.run(to, requestId, from).changes !== 1) return null;
      return read(requestId).record;
    },
    release(requestId) {
      requireRequestId(requestId);
      remove.run(requestId);
    },
  };
}
