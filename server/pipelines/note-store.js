import { isUuid } from '../../shared/pipeline-definitions.mjs';

const STATUSES = new Set(['written', 'unchanged', 'missing', 'unreadable', 'too_large']);
const FIELDS = ['runId', 'stepIndex', 'stepName', 'attempt', 'pass', 'status', 'summary', 'content'];
const COLUMNS = ['run_id', 'step_index', 'step_name', 'attempt', 'pass', 'status', 'summary', 'content'];
const COLUMN = Object.fromEntries(FIELDS.map((field, index) => [field, COLUMNS[index]]));
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/;

function violation(record) {
  if (!isUuid(record.runId)) return 'runId';
  if (!Number.isInteger(record.stepIndex) || record.stepIndex < 0 || record.stepIndex > 32) return 'stepIndex';
  if (typeof record.stepName !== 'string' || !record.stepName.trim() || record.stepName.length > 64 || /[\r\n]/.test(record.stepName)) return 'stepName';
  if (!Number.isInteger(record.attempt) || record.attempt < 1) return 'attempt';
  if (!Number.isInteger(record.pass) || record.pass < 1 || record.pass > 100) return 'pass';
  if (!STATUSES.has(record.status)) return 'status';
  if (record.status === 'written') {
    if (typeof record.summary !== 'string' || record.summary.length > 200 || /[\r\n]/.test(record.summary)) return 'summary';
    if (typeof record.content !== 'string' || Buffer.byteLength(record.content) > 262_144) return 'content';
  } else {
    if (record.summary !== null) return 'summary';
    if (record.content !== null) return 'content';
  }
  return null;
}

function hydrate(row) {
  if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Error('pipeline_run_notes row field id');
  const record = Object.fromEntries(FIELDS.map((field, index) => [field, row[COLUMNS[index]]]));
  const bad = violation(record);
  if (bad) throw new Error(`pipeline_run_notes row ${row.id} field ${COLUMN[bad]}`);
  if (typeof row.created_at !== 'string' || !ISO.test(row.created_at) || Number.isNaN(Date.parse(row.created_at))) throw new Error(`pipeline_run_notes row ${row.id} field created_at`);
  return { id: row.id, ...record, createdAt: row.created_at };
}

function hydrateMetadata(row) {
  if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Error('pipeline_run_notes row field id');
  const record = { runId: row.run_id, stepIndex: row.step_index, stepName: row.step_name, attempt: row.attempt, pass: row.pass, status: row.status, summary: row.summary };
  const bad = violation({ ...record, content: record.status === 'written' ? '' : null });
  if (bad) throw new Error(`pipeline_run_notes row ${row.id} field ${COLUMN[bad]}`);
  if (typeof row.created_at !== 'string' || !ISO.test(row.created_at) || Number.isNaN(Date.parse(row.created_at))) throw new Error(`pipeline_run_notes row ${row.id} field created_at`);
  return { id: row.id, ...record, createdAt: row.created_at };
}

function runIdGuard(runId) {
  if (!isUuid(runId)) throw new TypeError('runId must be a UUID');
}

export function createNoteStore(db, { now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new TypeError('db must be a database handle');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_run_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL, step_index INTEGER NOT NULL, step_name TEXT NOT NULL,
    attempt INTEGER NOT NULL, pass INTEGER NOT NULL, status TEXT NOT NULL,
    summary TEXT, content TEXT, created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS pipeline_run_notes_run ON pipeline_run_notes (run_id, id);`);
  const add = db.prepare('INSERT INTO pipeline_run_notes (run_id, step_index, step_name, attempt, pass, status, summary, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const byId = db.prepare('SELECT * FROM pipeline_run_notes WHERE id = ?');
  const count = db.prepare('SELECT COUNT(*) AS total FROM pipeline_run_notes WHERE run_id = ? AND (? IS NULL OR step_index = ?)');
  const lists = {};
  for (const direction of ['asc', 'desc']) lists[direction] = db.prepare(`SELECT * FROM pipeline_run_notes WHERE run_id = ? AND (? IS NULL OR step_index = ?) ORDER BY created_at ${direction.toUpperCase()}, id ${direction.toUpperCase()} LIMIT ? OFFSET ?`);
  const latest = db.prepare('SELECT id, run_id, step_index, step_name, attempt, pass, status, summary, created_at FROM pipeline_run_notes WHERE run_id = ? AND id IN (SELECT MAX(id) FROM pipeline_run_notes WHERE run_id = ? GROUP BY step_index) ORDER BY step_index ASC');
  const passExists = db.prepare('SELECT 1 FROM pipeline_run_notes WHERE run_id = ? AND step_index = ? AND attempt = ? AND pass = ? LIMIT 1');
  const lastWritten = db.prepare("SELECT * FROM pipeline_run_notes WHERE run_id = ? AND step_index = ? AND status = 'written' ORDER BY id DESC LIMIT 1");
  const stepGuard = stepIndex => { if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32) throw new TypeError('stepIndex must be an integer from 0 to 32'); };
  return {
    add(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('note must be an object');
      for (const key of Object.keys(record)) if (!FIELDS.includes(key)) throw new TypeError(`${key} is an unknown field`);
      const bad = violation(record);
      if (bad) throw new TypeError(`pipeline_run_notes: ${bad} is invalid`);
      const stamp = now();
      if (typeof stamp !== 'string' || !ISO.test(stamp) || Number.isNaN(Date.parse(stamp))) throw new TypeError('createdAt must be an ISO timestamp');
      const result = add.run(...FIELDS.map(field => record[field]), stamp);
      return hydrate(byId.get(result.lastInsertRowid));
    },
    count(runId, stepIndex = null) {
      runIdGuard(runId);
      if (stepIndex !== null) stepGuard(stepIndex);
      return count.get(runId, stepIndex, stepIndex).total;
    },
    list(runId, { offset, limit, direction, stepIndex = null } = {}) {
      runIdGuard(runId);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('offset must be a non-negative integer');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be 1 to 100');
      if (!lists[direction]) throw new TypeError('direction must be asc or desc');
      if (stepIndex !== null) stepGuard(stepIndex);
      return lists[direction].all(runId, stepIndex, stepIndex, limit, offset).map(hydrate);
    },
    latestByStep(runId) {
      runIdGuard(runId);
      const map = new Map();
      for (const row of latest.all(runId, runId)) { const note = hydrateMetadata(row); map.set(note.stepIndex, note); }
      return map;
    },
    hasPass(runId, stepIndex, attempt, pass) {
      runIdGuard(runId);
      stepGuard(stepIndex);
      if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive integer');
      if (!Number.isInteger(pass) || pass < 1 || pass > 100) throw new TypeError('pass must be an integer from 1 to 100');
      return Boolean(passExists.get(runId, stepIndex, attempt, pass));
    },
    lastContent(runId, stepIndex) {
      runIdGuard(runId);
      stepGuard(stepIndex);
      const row = lastWritten.get(runId, stepIndex);
      return row ? hydrate(row).content : null;
    },
  };
}
