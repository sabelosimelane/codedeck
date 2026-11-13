import { validateSettingsBody, isUuid } from '../../shared/pipeline-definitions.mjs';

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
    revision: requireRevision(id, row.revision),
  };
}

export function createSettingsStore(db) {
  if (!db) throw new Error('pipeline_settings: a database handle is required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      setup_agent_id TEXT,
      revision INTEGER NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO pipeline_settings (id, setup_agent_id, revision)
    VALUES (1, NULL, 1)
    ON CONFLICT(id) DO NOTHING
  `).run();

  const read = db.prepare('SELECT * FROM pipeline_settings WHERE id = 1');
  const updateStmt = db.prepare(`
    UPDATE pipeline_settings
    SET setup_agent_id = ?, revision = ?
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
      const result = updateStmt.run(body.setupAgentId, current.revision + 1, body.revision);
      if (result.changes !== 1) {
        throw new Error('pipeline_settings row 1: revision conflict');
      }
      return get();
    },
  };
}
