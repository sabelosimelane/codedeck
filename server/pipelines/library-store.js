/**
 * Reusable definitions for teams, workflow templates and saved steps.
 * Each record is checked every time it is read.
 */

import { randomUUID } from 'node:crypto';
import { isUuid, teamMemberFallbackId, validateTeamBody, validateWorkflowBody, validateStepPresetBody } from '../../shared/pipeline-definitions.mjs';

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const isIso = value => typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
const isUniqueConflict = err => err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err.message));

/** `validate(body, { revisionRequired })` returns field errors; `normalize(body)` returns exactly the stored fields. */
function createLibraryStore(db, { table, validate, normalize, now }) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error(`${table}: a database handle is required`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ${table}_name_ci ON ${table} (lower(name));
  `);
  const read = db.prepare(`SELECT * FROM ${table} WHERE id = ?`);
  const readAll = db.prepare(`SELECT * FROM ${table} ORDER BY lower(name), id`);
  const insert = db.prepare(`INSERT INTO ${table} (id, name, body, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`);
  const updateStmt = db.prepare(`UPDATE ${table} SET name = ?, body = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`);
  const removeStmt = db.prepare(`DELETE FROM ${table} WHERE id = ?`);

  const rowError = (id, field, message) => { throw new Error(`${table} row ${id} field ${field}: ${message}`); };
  const hydrate = (row) => {
    const id = row.id;
    if (!isUuid(id)) rowError(id ?? 'unknown', 'id', 'must be a UUID');
    let body;
    try { body = JSON.parse(row.body); } catch { rowError(id, 'body', 'must be valid JSON'); }
    const errors = validate(body, { revisionRequired: false, allowFallbackClear: false });
    if (errors.length) rowError(id, `body.${errors[0].field}`, errors[0].message);
    const fields = normalize(body);
    if (fields.name !== row.name) rowError(id, 'name', 'does not match the stored definition');
    if (!Number.isInteger(row.revision) || row.revision < 1) rowError(id, 'revision', 'must be an integer ≥ 1');
    if (!isIso(row.created_at)) rowError(id, 'created_at', 'must be an ISO-8601 timestamp');
    if (!isIso(row.updated_at)) rowError(id, 'updated_at', 'must be an ISO-8601 timestamp');
    return { id, ...fields, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
  };
  const requireValid = (body, revisionRequired, current) => {
    const errors = validate(body, { revisionRequired, current });
    if (errors.length) throw new Error(`${table}: ${errors[0].field}: ${errors[0].message}`);
  };
  const get = (id) => {
    if (!isUuid(id)) throw new Error(`${table}: id must be a UUID`);
    const row = read.get(id);
    return row ? hydrate(row) : null;
  };

  return {
    get,
    list() { return readAll.all().map(hydrate); },
    create(body) {
      requireValid(body, false);
      const fields = normalize(body);
      const id = randomUUID();
      const stamp = now();
      try { insert.run(id, fields.name, JSON.stringify(fields), stamp, stamp); }
      catch (err) { if (isUniqueConflict(err)) throw new Error(`${table}: name already exists`); throw err; }
      return get(id);
    },
    update(id, body) {
      const current = get(id);
      if (!current) throw new Error(`${table} row ${id}: not found`);
      if (current.revision !== body?.revision) {
        requireValid(body, true);
        throw new Error(`${table} row ${id}: revision conflict`);
      }
      requireValid(body, true, current);
      const fields = normalize(body, current);
      let result;
      try { result = updateStmt.run(fields.name, JSON.stringify(fields), now(), id, body.revision); }
      catch (err) { if (isUniqueConflict(err)) throw new Error(`${table}: name already exists`); throw err; }
      if (result.changes !== 1) throw new Error(`${table} row ${id}: revision conflict`);
      return get(id);
    },
    remove(id) {
      if (!isUuid(id)) throw new Error(`${table}: id must be a UUID`);
      removeStmt.run(id);
    },
  };
}

const normalizeRepeat = repeat => (repeat.mode === 'once' ? { mode: 'once' }
  : repeat.mode === 'until_complete' ? { mode: 'until_complete', max: repeat.max }
    : { mode: 'loop_back', to: repeat.to.trim(), max: repeat.max });

/** A saved workflow template: a workflow definition with no agents. */
export function createTemplateStore(db, { now = () => new Date().toISOString() } = {}) {
  return createLibraryStore(db, {
    table: 'pipeline_workflow_templates',
    now,
    validate: (body, options) => validateWorkflowBody(body, { ...options, template: true }),
    normalize: body => ({
      name: body.name.trim(),
      description: (body.description ?? '').trim(),
      kind: body.kind ?? 'other',
      agentsDecide: body.agentsDecide,
      progressFile: body.progressFile?.trim() ?? null,
      nodes: body.nodes.map(node => ({
        name: node.name.trim(), role: (node.role ?? '').trim(), prompt: node.prompt, repeat: normalizeRepeat(node.repeat),
        readOnly: node.readOnly ?? false, approval: node.approval ?? false, askOwner: node.askOwner ?? false,
        ...(node.enabled === false ? { enabled: false } : {}),
      })),
    }),
  });
}

/** A saved step: a named prompt with its options, with no agent and no loop. */
export function createStepPresetStore(db, { now = () => new Date().toISOString() } = {}) {
  return createLibraryStore(db, {
    table: 'pipeline_step_presets',
    now,
    validate: validateStepPresetBody,
    normalize: body => ({
      name: body.name.trim(), role: (body.role ?? '').trim(), prompt: body.prompt, repeat: normalizeRepeat(body.repeat),
      readOnly: body.readOnly ?? false, approval: body.approval ?? false, askOwner: body.askOwner ?? false,
    }),
  });
}

export function createTeamStore(db, { now = () => new Date().toISOString() } = {}) {
  return createLibraryStore(db, {
    table: 'pipeline_teams', now, validate: validateTeamBody,
    normalize: (body, current) => ({
      name: body.name.trim(),
      members: body.members.map(member => {
        const fallbackAgentId = teamMemberFallbackId(member, current?.members);
        return { role: member.role.trim(), agentId: member.agentId, ...(fallbackAgentId && { fallbackAgentId }) };
      }),
    }),
  });
}
