import { randomUUID } from 'node:crypto';
import { validateWorkflowBody, isProgressFileTemplate, isUuid, loopTargetIndex, WORKFLOW_KINDS, DESCRIPTION_MAX } from '../../shared/pipeline-definitions.mjs';

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

function requireFlag(id, field, value) {
  if (value !== 0 && value !== 1) fieldError(id, field, 'must be 0 or 1');
  return value === 1;
}

function requireProgressFile(id, value) {
  if (value === null) return null;
  if (!isProgressFileTemplate(value) || value.trim() !== value) fieldError(id, 'progress_file', 'must be a trimmed relative Markdown path');
  return value;
}

function requireKind(id, value) {
  if (!WORKFLOW_KINDS.includes(value)) fieldError(id, 'kind', `must be one of ${WORKFLOW_KINDS.join(', ')}`);
  return value;
}

function requireDescription(id, value) {
  if (typeof value !== 'string' || value.length > DESCRIPTION_MAX || SINGLE_LINE.test(value) || value.trim() !== value) {
    fieldError(id, 'description', `must be up to ${DESCRIPTION_MAX} trimmed single-line characters`);
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
  const errors = validateWorkflowBody({ name: 'x', agentsDecide: false, nodes });
  const nodeErrors = errors.filter(e => e.field === 'nodes' || e.field.startsWith('nodes['));
  if (nodeErrors.length) {
    fieldError(id, 'nodes', nodeErrors[0].message);
  }
  nodes.forEach((node, index) => {
    if (typeof node.role !== 'string') fieldError(id, `nodes[${index}].role`, 'must be a string');
    if (typeof node.askOwner !== 'boolean') fieldError(id, `nodes[${index}].askOwner`, 'must be true or false');
  });
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
    description: requireDescription(id, row.description),
    kind: requireKind(id, row.kind),
    agentsDecide: requireFlag(id, 'agents_decide', row.agents_decide),
    progressFile: requireProgressFile(id, row.progress_file),
    nodes: parseNodes(id, row.nodes),
    revision: requireRevision(id, row.revision),
    createdAt: requireIso(id, 'created_at', row.created_at),
    updatedAt: requireIso(id, 'updated_at', row.updated_at),
  };
}

function isUniqueConflict(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err.message));
}

function normalizeRepeat(nodes, index) {
  const { repeat } = nodes[index];
  if (repeat.mode === 'once') return { mode: 'once' };
  if (repeat.mode === 'until_complete') return { mode: 'until_complete', max: repeat.max };
  // A loop is stored under the name of the node it returns to, as that node is stored.
  return { mode: 'loop_back', to: nodes[loopTargetIndex(nodes, index)].name.trim(), max: repeat.max };
}

function normalizeNodes(nodes) {
  return nodes.map((node, index) => ({
    name: node.name.trim(),
    role: (node.role ?? '').trim(),
    agentId: node.agentId,
    prompt: node.prompt,
    repeat: normalizeRepeat(nodes, index),
    readOnly: node.readOnly ?? false,
    approval: node.approval ?? false,
    askOwner: node.askOwner ?? false,
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
      updated_at TEXT NOT NULL,
      agents_decide INTEGER NOT NULL DEFAULT 0,
      progress_file TEXT,
      kind TEXT NOT NULL DEFAULT 'other',
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pipeline_workflows_name_ci
      ON pipeline_workflows (lower(name));
  `);
  // Workflows saved before agents could decide for themselves left every decision to the owner.
  if (!db.prepare('PRAGMA table_info(pipeline_workflows)').all().some(column => column.name === 'agents_decide')) {
    db.exec('ALTER TABLE pipeline_workflows ADD COLUMN agents_decide INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare('PRAGMA table_info(pipeline_workflows)').all().some(column => column.name === 'progress_file')) {
    db.exec('ALTER TABLE pipeline_workflows ADD COLUMN progress_file TEXT');
  }

  // Workflows saved before kinds and descriptions existed have neither.
  if (!db.prepare('PRAGMA table_info(pipeline_workflows)').all().some(column => column.name === 'kind')) {
    db.exec("ALTER TABLE pipeline_workflows ADD COLUMN kind TEXT NOT NULL DEFAULT 'other'");
  }
  if (!db.prepare('PRAGMA table_info(pipeline_workflows)').all().some(column => column.name === 'description')) {
    db.exec("ALTER TABLE pipeline_workflows ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  }

  const STOCK_PROMPT_UPGRADES = new Map([
    [
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown.',
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown.',
    ],
    [
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown. Record the agreed acceptance checks in your note, including how each outcome will be verified and which checks need external evidence.',
      'Read {input} and restate the problem in your own words. Change nothing. Check that you know what happens, what was expected, where and when it happens, how to reproduce it, and what changed recently. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the logs and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the problem as you now understand it, what you found yourself, what the owner told you, and what is still unknown. Record the agreed acceptance checks in your note, including how each outcome will be verified and which checks need external evidence.',
    ],
    [
      'Read {input} and restate what is being asked for in your own words. Change nothing. Check that you know who it is for and what they need to do with it, what it must do in each case including errors and empty states, what is out of scope, what existing behaviour must stay the same, and how it will be shown to work. First look for each of these yourself in the code, the documents and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the requirements as you now understand them, what you found yourself, what the owner told you, and what is still open.',
      'Read {input} and restate what is being asked for in your own words. Change nothing. Check that you know who it is for and what they need to do with it, what it must do in each case including errors and empty states, what is out of scope, what existing behaviour must stay the same, and how it will be shown to work. Check whether any referenced or read-only repository must change; if a repository is missing from this task\'s worktrees, ask to add it in this same NEEDS_INPUT pass. First look for each of these yourself in the code, the documents and the history. For anything you could not find and cannot safely assume, ask the owner: use NEEDS_INPUT with one short question per item, each with the assumption you would otherwise make as its recommendation. Ask nothing you could find out yourself, and when nothing is missing ask nothing. In your run note record the requirements as you now understand them, what you found yourself, what the owner told you, and what is still open.',
    ],
    [
      'Review all changes on this branch (both uncommitted changes and any commits since the base commit) against the Specify note. Fix every defect you find and record your findings and fixes.',
      'Review the changes on this branch (both uncommitted changes and any commits since the base commit) against the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified work. Fix every defect you find and record your findings and fixes.',
    ],
    [
      'Review all feature changes on this branch (both uncommitted changes and any commits since the base commit) against plan.md and the task. Fix every defect and record findings and fixes.',
      'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the task. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect and record findings and fixes.',
    ],
    [
      'Review all feature changes on this branch (both uncommitted changes and any commits since the base commit) against plan.md and the specification named in the Specify note. Fix every defect and record findings and fixes.',
      'Review the feature changes for the phase or fix just built (both uncommitted changes and any commits since the base commit) against plan.md and the specification named in the Specify note. On a repeat pass, read your previous Review and Test notes and review only what changed since that pass instead of re-auditing already-verified phases. Fix every defect and record findings and fixes.',
    ],
  ]);

  const upgradeNodes = db.transaction(() => {
    const save = db.prepare('UPDATE pipeline_workflows SET nodes = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, kind, nodes FROM pipeline_workflows').all()) {
      let nodes;
      try { nodes = JSON.parse(row.nodes); } catch { fieldError(row.id, 'nodes', 'must be valid JSON'); }
      if (!Array.isArray(nodes)) fieldError(row.id, 'nodes', 'must be an array');
      let changed = false;
      const upgraded = nodes.map(node => {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
        const missingProps = !Object.hasOwn(node, 'readOnly') || !Object.hasOwn(node, 'approval') || !Object.hasOwn(node, 'role') || !Object.hasOwn(node, 'askOwner');
        const nextPrompt = STOCK_PROMPT_UPGRADES.get(node.prompt);
        const capUntrackedLoop = ['bugfix', 'troubleshoot'].includes(row.kind)
          && ['Test', 'Verify'].includes(node.name)
          && node.repeat?.mode === 'loop_back'
          && node.repeat?.max === 5;
        if (!missingProps && !nextPrompt && !capUntrackedLoop) return node;
        changed = true;
        return {
          ...node,
          ...(!Object.hasOwn(node, 'readOnly') ? { readOnly: false } : {}),
          ...(!Object.hasOwn(node, 'approval') ? { approval: false } : {}),
          ...(!Object.hasOwn(node, 'role') ? { role: '' } : {}),
          ...(!Object.hasOwn(node, 'askOwner') ? { askOwner: false } : {}),
          ...(nextPrompt ? { prompt: nextPrompt } : {}),
          ...(capUntrackedLoop ? { repeat: { ...node.repeat, max: 3 } } : {}),
        };
      });
      if (changed) {
        save.run(JSON.stringify(upgraded), row.id);
      }
    }
  });
  upgradeNodes();

  const read = db.prepare('SELECT * FROM pipeline_workflows WHERE id = ?');
  const readAll = db.prepare('SELECT * FROM pipeline_workflows ORDER BY lower(name), id');
  const insert = db.prepare(`
    INSERT INTO pipeline_workflows
      (id, name, nodes, revision, created_at, updated_at, agents_decide, progress_file, kind, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE pipeline_workflows
    SET name = ?, nodes = ?, revision = ?, updated_at = ?, agents_decide = ?, progress_file = ?, kind = ?, description = ?
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
        insert.run(id, name, JSON.stringify(nodes), 1, stamp, stamp, body.agentsDecide ? 1 : 0, body.progressFile?.trim() ?? null, body.kind ?? 'other', (body.description ?? '').trim());
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
        result = updateStmt.run(name, JSON.stringify(nodes), current.revision + 1, stamp, body.agentsDecide ? 1 : 0, body.progressFile?.trim() ?? null, body.kind ?? 'other', (body.description ?? '').trim(), id, body.revision);
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
