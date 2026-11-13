import { randomUUID } from 'node:crypto';
import { isUuid } from '../../shared/pipeline-definitions.mjs';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const SINGLE_LINE = /[\x00-\x1f\x7f]/;
const MULTI_LINE = /[\x00-\x08\x0b-\x1f\x7f]/;
const REQUEST_ID_RE = /^[\w-]{1,128}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const ABS_PATH_RE = /^\//;

const RUN_STATUSES = new Set([
  'pending', 'running', 'needs_input', 'limit_paused',
  'interrupted', 'stopped', 'error', 'complete',
]);
const STEP_STATUSES = new Set([
  'pending', 'launching', 'running', 'needs_input',
  'complete', 'limit_reached', 'failed', 'stopped', 'interrupted',
]);
const WORKTREE_STATES = new Set(['not_created', 'present', 'removed', 'removal_blocked']);
const STOP_REASONS = new Set(['user', 'terminal']);
const INTERRUPTIBLE = new Set(['pending', 'running', 'needs_input']);

function fieldError(id, field, message) {
  throw new Error(`pipeline_runs row ${id} field ${field}: ${message}`);
}

function requireIso(id, field, value, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fieldError(id, field, 'must be an ISO-8601 timestamp');
  }
  return value;
}

function requireString(id, field, value, { min = 1, max, singleLine = true, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fieldError(id, field, 'must be a string');
  if (allowEmpty && value.length === 0) {
    if (singleLine && SINGLE_LINE.test(value)) fieldError(id, field, 'invalid');
    return value;
  }
  const pattern = singleLine ? SINGLE_LINE : MULTI_LINE;
  if ((!allowEmpty && !value.trim()) || value.length < min || (max != null && value.length > max) || pattern.test(value)) {
    fieldError(id, field, 'invalid');
  }
  return value;
}

function requireAbsPath(id, field, value) {
  if (typeof value !== 'string' || !ABS_PATH_RE.test(value) || SINGLE_LINE.test(value) || !value.trim()) {
    fieldError(id, field, 'must be an absolute path');
  }
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateRepeat(id, prefix, repeat) {
  if (!isPlainObject(repeat)) fieldError(id, prefix, 'must be an object');
  for (const key of Object.keys(repeat)) {
    if (!['mode', 'max'].includes(key)) fieldError(id, `${prefix}.${key}`, 'unknown field');
  }
  if (repeat.mode === 'once') {
    if (repeat.max !== undefined) fieldError(id, `${prefix}.max`, 'forbidden for once');
    return { mode: 'once' };
  }
  if (repeat.mode === 'until_complete') {
    if (!Number.isInteger(repeat.max) || repeat.max < 1 || repeat.max > 100) {
      fieldError(id, `${prefix}.max`, 'must be 1–100');
    }
    return { mode: 'until_complete', max: repeat.max };
  }
  fieldError(id, `${prefix}.mode`, 'invalid');
}

function validateDefinitionAgent(id, prefix, agent) {
  if (!isPlainObject(agent)) fieldError(id, prefix, 'must be an object');
  for (const key of Object.keys(agent)) {
    if (!['id', 'name', 'launchCommand', 'resetCommand'].includes(key)) {
      fieldError(id, `${prefix}.${key}`, 'unknown field');
    }
  }
  if (!isUuid(agent.id)) fieldError(id, `${prefix}.id`, 'must be a UUID');
  requireString(id, `${prefix}.name`, agent.name, { max: 64 });
  requireString(id, `${prefix}.launchCommand`, agent.launchCommand, { max: 2048 });
  requireString(id, `${prefix}.resetCommand`, agent.resetCommand, { max: 256 });
  return {
    id: agent.id,
    name: agent.name.trim(),
    launchCommand: agent.launchCommand,
    resetCommand: agent.resetCommand,
  };
}

function validateDefinitionStep(id, index, step) {
  const prefix = `definition.steps[${index}]`;
  if (!isPlainObject(step)) fieldError(id, prefix, 'must be an object');
  for (const key of Object.keys(step)) {
    if (!['kind', 'name', 'prompt', 'repeat', 'agent'].includes(key)) {
      fieldError(id, `${prefix}.${key}`, 'unknown field');
    }
  }
  if (step.kind !== 'setup' && step.kind !== 'node') {
    fieldError(id, `${prefix}.kind`, 'must be setup or node');
  }
  return {
    kind: step.kind,
    name: requireString(id, `${prefix}.name`, step.name, { max: 64 }).trim(),
    prompt: requireString(id, `${prefix}.prompt`, step.prompt, { max: 16384, singleLine: false }),
    repeat: validateRepeat(id, `${prefix}.repeat`, step.repeat),
    agent: validateDefinitionAgent(id, `${prefix}.agent`, step.agent),
  };
}

function validateDefinition(id, definition) {
  if (!isPlainObject(definition)) fieldError(id, 'definition', 'must be an object');
  for (const key of Object.keys(definition)) {
    if (!['workflowId', 'workflowName', 'workflowRevision', 'steps'].includes(key)) {
      fieldError(id, `definition.${key}`, 'unknown field');
    }
  }
  if (!isUuid(definition.workflowId)) fieldError(id, 'definition.workflowId', 'must be a UUID');
  requireString(id, 'definition.workflowName', definition.workflowName, { max: 64 });
  if (!Number.isInteger(definition.workflowRevision) || definition.workflowRevision < 1) {
    fieldError(id, 'definition.workflowRevision', 'must be ≥ 1');
  }
  if (!Array.isArray(definition.steps) || definition.steps.length < 1 || definition.steps.length > 33) {
    fieldError(id, 'definition.steps', 'must contain 1–33 steps');
  }
  return {
    workflowId: definition.workflowId,
    workflowName: definition.workflowName.trim(),
    workflowRevision: definition.workflowRevision,
    steps: definition.steps.map((step, index) => validateDefinitionStep(id, index, step)),
  };
}

function validateSessionId(id, field, sessionId, project) {
  if (sessionId === null) return null;
  if (typeof sessionId !== 'string' || !new RegExp(`^${escapeRegExp(project)}-\\d+$`).test(sessionId)) {
    fieldError(id, field, 'must match project-N');
  }
  return sessionId;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateStepProgress(id, index, step, project) {
  const prefix = `steps[${index}]`;
  if (!isPlainObject(step)) fieldError(id, prefix, 'must be an object');
  for (const key of Object.keys(step)) {
    if (!['status', 'sessionId', 'priorSessionIds', 'attempt', 'iteration', 'detail', 'startedAt', 'finishedAt'].includes(key)) {
      fieldError(id, `${prefix}.${key}`, 'unknown field');
    }
  }
  if (!STEP_STATUSES.has(step.status)) fieldError(id, `${prefix}.status`, 'invalid');
  if (!Array.isArray(step.priorSessionIds)) fieldError(id, `${prefix}.priorSessionIds`, 'must be an array');
  const priorSessionIds = step.priorSessionIds.map((sid, i) => {
    if (typeof sid !== 'string' || !new RegExp(`^${escapeRegExp(project)}-\\d+$`).test(sid)) {
      fieldError(id, `${prefix}.priorSessionIds[${i}]`, 'must match project-N');
    }
    return sid;
  });
  if (!Number.isInteger(step.attempt) || step.attempt < 0) {
    fieldError(id, `${prefix}.attempt`, 'must be ≥ 0');
  }
  if (!Number.isInteger(step.iteration) || step.iteration < 0) {
    fieldError(id, `${prefix}.iteration`, 'must be ≥ 0');
  }
  let detail = step.detail;
  if (detail !== null) {
    detail = requireString(id, `${prefix}.detail`, detail, { max: 2000, singleLine: false, min: 0, allowEmpty: false });
  }
  return {
    status: step.status,
    sessionId: validateSessionId(id, `${prefix}.sessionId`, step.sessionId, project),
    priorSessionIds,
    attempt: step.attempt,
    iteration: step.iteration,
    detail,
    startedAt: requireIso(id, `${prefix}.startedAt`, step.startedAt, { allowNull: true }),
    finishedAt: requireIso(id, `${prefix}.finishedAt`, step.finishedAt, { allowNull: true }),
  };
}

function validateRunRecord(id, record) {
  if (!isUuid(id)) fieldError(id ?? 'unknown', 'id', 'must be a UUID');
  if (typeof record.requestId !== 'string' || !REQUEST_ID_RE.test(record.requestId)) {
    fieldError(id, 'request_id', 'invalid');
  }
  if (!isUuid(record.workflowId)) fieldError(id, 'workflow_id', 'must be a UUID');
  requireString(id, 'project', record.project, { max: 256 });
  if (typeof record.input !== 'string' || record.input.length > 4096 || SINGLE_LINE.test(record.input)) {
    fieldError(id, 'input', 'invalid');
  }
  if (!RUN_STATUSES.has(record.status)) fieldError(id, 'status', 'invalid');

  const stopReason = record.stopReason;
  if (record.status === 'stopped') {
    if (!STOP_REASONS.has(stopReason)) fieldError(id, 'stop_reason', 'required when stopped');
  } else if (stopReason !== null) {
    fieldError(id, 'stop_reason', 'must be null unless stopped');
  }

  const error = record.error;
  if (record.status === 'error') {
    if (typeof error !== 'string' || !error.trim() || error.length > 2000 || MULTI_LINE.test(error)) {
      fieldError(id, 'error', 'required when status is error');
    }
  } else if (error !== null) {
    fieldError(id, 'error', 'must be null unless status is error');
  }

  const definition = validateDefinition(id, record.definition);
  if (!Array.isArray(record.steps) || record.steps.length !== definition.steps.length) {
    fieldError(id, 'steps', 'length must match definition steps');
  }
  if (!Number.isInteger(record.currentStepIndex)
    || record.currentStepIndex < 0
    || record.currentStepIndex >= record.steps.length) {
    fieldError(id, 'current_step_index', 'out of range');
  }

  const steps = record.steps.map((step, index) => validateStepProgress(id, index, step, record.project));
  requireAbsPath(id, 'home_path', record.homePath);
  requireAbsPath(id, 'worktree_path', record.worktreePath);
  requireString(id, 'worktree_branch', record.worktreeBranch, { max: 256 });

  let baseCommit = record.baseCommit;
  if (baseCommit !== null) {
    if (typeof baseCommit !== 'string' || !COMMIT_RE.test(baseCommit)) {
      fieldError(id, 'base_commit', 'must be null or a 40-hex commit id');
    }
  }
  if (!WORKTREE_STATES.has(record.worktreeState)) fieldError(id, 'worktree_state', 'invalid');
  let worktreeDetail = record.worktreeDetail;
  if (worktreeDetail !== null) {
    worktreeDetail = requireString(id, 'worktree_detail', worktreeDetail, {
      max: 2000,
      singleLine: false,
    });
  }

  const finishedAt = requireIso(id, 'finished_at', record.finishedAt, { allowNull: true });
  if (['complete', 'stopped', 'error'].includes(record.status)) {
    if (finishedAt === null) fieldError(id, 'finished_at', 'required for terminal statuses');
  }

  return {
    id,
    requestId: record.requestId,
    workflowId: record.workflowId,
    project: record.project,
    input: record.input,
    status: record.status,
    stopReason,
    currentStepIndex: record.currentStepIndex,
    error,
    definition,
    steps,
    homePath: record.homePath,
    worktreePath: record.worktreePath,
    worktreeBranch: record.worktreeBranch,
    baseCommit,
    worktreeState: record.worktreeState,
    worktreeDetail,
    createdAt: requireIso(id, 'created_at', record.createdAt),
    updatedAt: requireIso(id, 'updated_at', record.updatedAt),
    finishedAt,
  };
}

function rowToRecord(row) {
  let definition;
  let steps;
  try {
    definition = JSON.parse(row.definition);
  } catch {
    fieldError(row.id, 'definition', 'must be valid JSON');
  }
  try {
    steps = JSON.parse(row.steps);
  } catch {
    fieldError(row.id, 'steps', 'must be valid JSON');
  }
  return validateRunRecord(row.id, {
    requestId: row.request_id,
    workflowId: row.workflow_id,
    project: row.project,
    input: row.input,
    status: row.status,
    stopReason: row.stop_reason,
    currentStepIndex: row.current_step_index,
    error: row.error,
    definition,
    steps,
    homePath: row.home_path,
    worktreePath: row.worktree_path,
    worktreeBranch: row.worktree_branch,
    baseCommit: row.base_commit,
    worktreeState: row.worktree_state,
    worktreeDetail: row.worktree_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  });
}

function persistValues(record) {
  return [
    record.id,
    record.requestId,
    record.workflowId,
    record.project,
    record.input,
    record.status,
    record.stopReason,
    record.currentStepIndex,
    record.error,
    JSON.stringify(record.definition),
    JSON.stringify(record.steps),
    record.homePath,
    record.worktreePath,
    record.worktreeBranch,
    record.baseCommit,
    record.worktreeState,
    record.worktreeDetail,
    record.createdAt,
    record.updatedAt,
    record.finishedAt,
  ];
}

function isUniqueConflict(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err.message));
}

export function createRunStore(db, { now = () => new Date().toISOString() } = {}) {
  if (!db) throw new Error('pipeline_runs: a database handle is required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      workflow_id TEXT NOT NULL,
      project TEXT NOT NULL,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      stop_reason TEXT,
      current_step_index INTEGER NOT NULL,
      error TEXT,
      definition TEXT NOT NULL,
      steps TEXT NOT NULL,
      home_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      worktree_branch TEXT NOT NULL,
      base_commit TEXT,
      worktree_state TEXT NOT NULL,
      worktree_detail TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
  `);

  const read = db.prepare('SELECT * FROM pipeline_runs WHERE id = ?');
  const readByRequest = db.prepare('SELECT * FROM pipeline_runs WHERE request_id = ?');
  const readAll = db.prepare('SELECT * FROM pipeline_runs ORDER BY created_at DESC, id DESC');
  const insert = db.prepare(`
    INSERT INTO pipeline_runs (
      id, request_id, workflow_id, project, input, status, stop_reason, current_step_index,
      error, definition, steps, home_path, worktree_path, worktree_branch, base_commit,
      worktree_state, worktree_detail, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE pipeline_runs SET
      request_id = ?, workflow_id = ?, project = ?, input = ?, status = ?, stop_reason = ?,
      current_step_index = ?, error = ?, definition = ?, steps = ?, home_path = ?,
      worktree_path = ?, worktree_branch = ?, base_commit = ?, worktree_state = ?,
      worktree_detail = ?, created_at = ?, updated_at = ?, finished_at = ?
    WHERE id = ?
  `);

  const get = id => {
    if (!isUuid(id)) throw new Error('pipeline_runs: id must be a UUID');
    const row = read.get(id);
    if (!row) return null;
    const record = rowToRecord(row);
    if (record.id !== id) {
      throw new Error(`pipeline_runs row ${id} field id: persisted identity does not match key`);
    }
    return record;
  };

  const write = record => {
    const values = persistValues(record);
    updateStmt.run(...values.slice(1), record.id);
    return get(record.id);
  };

  const interruptUnfinished = db.transaction(() => {
    const rows = db.prepare('SELECT id, status, current_step_index, steps, updated_at FROM pipeline_runs').all();
    const stamp = now();
    for (const row of rows) {
      if (!INTERRUPTIBLE.has(row.status)) continue;
      let steps;
      try {
        steps = JSON.parse(row.steps);
      } catch {
        fieldError(row.id, 'steps', 'must be valid JSON');
      }
      if (!Array.isArray(steps) || row.current_step_index < 0 || row.current_step_index >= steps.length) {
        fieldError(row.id, 'current_step_index', 'out of range');
      }
      const nextSteps = steps.map((step, index) => (
        index === row.current_step_index ? { ...step, status: 'interrupted' } : step
      ));
      db.prepare(`
        UPDATE pipeline_runs
        SET status = 'interrupted', steps = ?, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(nextSteps), stamp, row.id);
    }
  });
  interruptUnfinished();

  return {
    get,
    getByRequestId(requestId) {
      if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) {
        throw new Error('pipeline_runs: requestId is invalid');
      }
      const row = readByRequest.get(requestId);
      if (!row) return null;
      return rowToRecord(row);
    },
    list() {
      return readAll.all().map(rowToRecord);
    },
    create(input) {
      const requestedId = input?.id;
      const id = requestedId === undefined ? randomUUID() : requestedId;
      if (!isUuid(id)) throw new Error('pipeline_runs: id must be a UUID');
      const stamp = now();
      const { id: _ignoredId, createdAt: _ignoredCreated, updatedAt: _ignoredUpdated, ...rest } = input ?? {};
      const record = validateRunRecord(id, {
        ...rest,
        createdAt: stamp,
        updatedAt: stamp,
      });
      try {
        insert.run(...persistValues(record));
      } catch (err) {
        if (isUniqueConflict(err)) {
          throw new Error('pipeline_runs: requestId already exists');
        }
        throw err;
      }
      return get(id);
    },
    update(id, patch) {
      const current = get(id);
      if (!current) throw new Error(`pipeline_runs row ${id}: not found`);
      const next = validateRunRecord(id, {
        ...current,
        ...patch,
        id,
        createdAt: current.createdAt,
        updatedAt: now(),
      });
      return write(next);
    },
  };
}
