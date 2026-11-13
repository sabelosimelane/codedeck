import { randomUUID } from 'node:crypto';
import { validateWorkflowBody, isUuid } from '../../shared/pipeline-definitions.mjs';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const SINGLE_LINE = /[\x00-\x1f\x7f]/;

function fieldError(id, field, message) {
  throw new Error(`pipeline_workflows row ${id} field ${field}: ${message}`);
}

function requireIso(id, field, value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fieldError(id, field, 'must be an ISO-8601 timestamp');
  }
  return value;
}

function requireName(id, value) {
  if (typeof value !== 'string') fieldError(id, 'name', 'must be a string');
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 64 || SINGLE_LINE.test(value) || trimmed !== value) {
    fieldError(id, 'name', 'must be 1–64 trimmed single-line characters');
  }
  return trimmed;
}

function requireRevision(id, value) {
  if (!Number.isInteger(value) || value < 1) {
    fieldError(id, 'revision', 'must be an integer ≥ 1');
  }
  return value;
}

function parseNodes(id, raw) {
  let nodes;
  try {
    nodes = JSON.parse(raw);
  } catch {
    fieldError(id, 'nodes', 'must be valid JSON');
  }
  const errors = validateWorkflowBody({ name: 'x', nodes });
  const nodeErrors = errors.filter(e => e.field === 'nodes' || e.field.startsWith('nodes['));
  if (nodeErrors.length) {
    fieldError(id, 'nodes', nodeErrors[0].message);
  }
  return nodes;
}

function assertValidBody(body, { revisionRequired }) {
  const errors = validateWorkflowBody(body, { revisionRequired });
  if (errors.length) {
    const first = errors[0];
    throw new Error(`pipeline_workflows: ${first.field}: ${first.message}`);
  }
}

function hydrate(row) {
  const id = row.id;
  if (!isUuid(id)) fieldError(id ?? 'unknown', 'id', 'must be a UUID v4');
  return {
    id,
    name: requireName(id, row.name),
    nodes: parseNodes(id, row.nodes),
    revision: requireRevision(id, row.revision),
    createdAt: requireIso(id, 'created_at', row.created_at),
    updatedAt: requireIso(id, 'updated_at', row.updated_at),
  };
}

function isUniqueConflict(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err.message));
}

function normalizeNodes(nodes) {
  return nodes.map(node => ({
    name: node.name.trim(),
    agentId: node.agentId,
    prompt: node.prompt,
    repeat: node.repeat.mode === 'once'
      ? { mode: 'once' }
      : { mode: 'until_complete', max: node.repeat.max },
  }));
}

export function createWorkflowStore(db, { now = () => new Date().toISOString() } = {}) {
  if (!db) throw new Error('pipeline_workflows: a database handle is required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      nodes TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pipeline_workflows_name_ci
      ON pipeline_workflows (lower(name));
  `);

  const read = db.prepare('SELECT * FROM pipeline_workflows WHERE id = ?');
  const readAll = db.prepare('SELECT * FROM pipeline_workflows ORDER BY lower(name), id');
  const insert = db.prepare(`
    INSERT INTO pipeline_workflows
      (id, name, nodes, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE pipeline_workflows
    SET name = ?, nodes = ?, revision = ?, updated_at = ?
    WHERE id = ? AND revision = ?
  `);
  const removeStmt = db.prepare('DELETE FROM pipeline_workflows WHERE id = ?');

  const get = id => {
    if (!isUuid(id)) throw new Error('pipeline_workflows: id must be a UUID');
    const row = read.get(id);
    if (!row) return null;
    const record = hydrate(row);
    if (record.id !== id) {
      throw new Error(`pipeline_workflows row ${id} field id: persisted identity does not match key`);
    }
    return record;
  };

  return {
    get,
    list() {
      return readAll.all().map(hydrate);
    },
    create(body) {
      assertValidBody(body, { revisionRequired: false });
      const id = randomUUID();
      const stamp = now();
      const name = body.name.trim();
      const nodes = normalizeNodes(body.nodes);
      try {
        insert.run(id, name, JSON.stringify(nodes), 1, stamp, stamp);
      } catch (err) {
        if (isUniqueConflict(err)) {
          throw new Error('pipeline_workflows: name already exists');
        }
        throw err;
      }
      return get(id);
    },
    update(id, body) {
      if (!isUuid(id)) throw new Error('pipeline_workflows: id must be a UUID');
      assertValidBody(body, { revisionRequired: true });
      const current = get(id);
      if (!current) throw new Error(`pipeline_workflows row ${id}: not found`);
      if (current.revision !== body.revision) {
        throw new Error(`pipeline_workflows row ${id}: revision conflict`);
      }
      const name = body.name.trim();
      const nodes = normalizeNodes(body.nodes);
      const stamp = now();
      let result;
      try {
        result = updateStmt.run(name, JSON.stringify(nodes), current.revision + 1, stamp, id, body.revision);
      } catch (err) {
        if (isUniqueConflict(err)) {
          throw new Error('pipeline_workflows: name already exists');
        }
        throw err;
      }
      if (result.changes !== 1) {
        throw new Error(`pipeline_workflows row ${id}: revision conflict`);
      }
      return get(id);
    },
    remove(id) {
      if (!isUuid(id)) throw new Error('pipeline_workflows: id must be a UUID');
      removeStmt.run(id);
    },
  };
}
