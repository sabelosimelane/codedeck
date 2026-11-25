import { validateSettingsBody, isBranchName, isUuid, RUN_TIMEOUT_LIMITS } from '../../shared/pipeline-definitions.mjs';

const timeoutColumns = {
  agentReadySeconds: 'agent_ready_seconds',
  resetSettleSeconds: 'reset_settle_seconds',
  finalSignalIdleSeconds: 'final_signal_idle_seconds',
  lostPromptSeconds: 'lost_prompt_seconds',
  stallWarningMinutes: 'stall_warning_minutes',
};

function fieldError(id, field, message) {
  throw new Error(`pipeline_settings row ${id} field ${field}: ${message}`);
}

function requireRevision(id, value) {
  if (!Number.isInteger(value) || value < 1) {
    fieldError(id, 'revision', 'must be an integer ≥ 1');
  }
  return value;
}

function requireSetupAgentId(id, value) {
  if (value === null) return null;
  if (!isUuid(value)) fieldError(id, 'setup_agent_id', 'must be null or a UUID');
  return value;
}

function requireDefaultBaseBranch(id, value) {
  if (value === null) return null;
  if (!isBranchName(value)) fieldError(id, 'default_base_branch', 'must be null or a Git branch name');
  return value;
}

function requireTimeout(id, column, value, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fieldError(id, column, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

function assertValidBody(body) {
  const errors = validateSettingsBody(body);
  if (errors.length) {
    const first = errors[0];
    throw new Error(`pipeline_settings: ${first.field}: ${first.message}`);
  }
}

function hydrate(row) {
  const id = row.id;
  if (id !== 1) fieldError(id, 'id', 'must be 1');
  return {
    setupAgentId: requireSetupAgentId(id, row.setup_agent_id),
    defaultBaseBranch: requireDefaultBaseBranch(id, row.default_base_branch),
    timeouts: Object.fromEntries(Object.entries(timeoutColumns).map(([field, column]) =>
      [field, requireTimeout(id, column, row[column], RUN_TIMEOUT_LIMITS[field])])),
    revision: requireRevision(id, row.revision),
  };
}

export function createSettingsStore(db) {
  if (!db) throw new Error('pipeline_settings: a database handle is required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      setup_agent_id TEXT,
      default_base_branch TEXT,
      revision INTEGER NOT NULL
    );
  `);
  // A table made before the default base branch existed gets the column, empty: tasks start from what Main is on.
  if (!db.prepare('PRAGMA table_info(pipeline_settings)').all().some(column => column.name === 'default_base_branch')) {
    db.exec('ALTER TABLE pipeline_settings ADD COLUMN default_base_branch TEXT');
  }
  const columns = new Set(db.prepare('PRAGMA table_info(pipeline_settings)').all().map(column => column.name));
  for (const [field, column] of Object.entries(timeoutColumns)) {
    if (!columns.has(column)) db.exec(`ALTER TABLE pipeline_settings ADD COLUMN ${column} INTEGER NOT NULL DEFAULT ${RUN_TIMEOUT_LIMITS[field].default}`);
  }
  db.prepare(`
    INSERT INTO pipeline_settings (id, setup_agent_id, revision)
    VALUES (1, NULL, 1)
    ON CONFLICT(id) DO NOTHING
  `).run();

  const read = db.prepare('SELECT * FROM pipeline_settings WHERE id = 1');
  const updateStmt = db.prepare(`
    UPDATE pipeline_settings
    SET setup_agent_id = ?, default_base_branch = ?, ${Object.values(timeoutColumns).map(column => `${column} = ?`).join(', ')}, revision = ?
    WHERE id = 1 AND revision = ?
  `);

  const get = () => {
    const row = read.get();
    if (!row) throw new Error('pipeline_settings row 1: missing');
    return hydrate(row);
  };

  return {
    get,
    update(body) {
      assertValidBody(body);
      const current = get();
      if (current.revision !== body.revision) {
        throw new Error('pipeline_settings row 1: revision conflict');
      }
      const result = updateStmt.run(body.setupAgentId, body.defaultBaseBranch,
        ...Object.keys(timeoutColumns).map(field => body.timeouts[field]), current.revision + 1, body.revision);
      if (result.changes !== 1) {
        throw new Error('pipeline_settings row 1: revision conflict');
      }
      return get();
    },
  };
}
