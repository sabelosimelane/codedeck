import { isUuid } from '../../shared/pipeline-definitions.mjs';

const FIELDS = ['runId', 'stepIndex', 'stepName', 'attempt', 'verdict', 'comment'];
const COLUMNS = ['run_id', 'step_index', 'step_name', 'attempt', 'verdict', 'comment'];
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/;
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/;

function invalid(record) {
  if (!isUuid(record.runId)) return 'runId';
  if (!Number.isInteger(record.stepIndex) || record.stepIndex < 0 || record.stepIndex > 32) return 'stepIndex';
  if (typeof record.stepName !== 'string' || !record.stepName.trim() || record.stepName.length > 64 || /[\r\n\x00-\x1f\x7f]/.test(record.stepName)) return 'stepName';
  if (!Number.isInteger(record.attempt) || record.attempt < 1) return 'attempt';
  if (!['approved', 'sent_back'].includes(record.verdict)) return 'verdict';
  if (record.verdict === 'approved' ? record.comment !== null
    : typeof record.comment !== 'string' || !record.comment.trim() || record.comment.length > 4000 || CONTROL.test(record.comment)) return 'comment';
  return null;
}

function hydrate(row) {
  if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Error('pipeline_run_reviews row field id');
  const record = Object.fromEntries(FIELDS.map((field, index) => [field, row[COLUMNS[index]]]));
  const bad = invalid(record);
  if (bad) throw new Error(`pipeline_run_reviews row ${row.id} field ${COLUMNS[FIELDS.indexOf(bad)]}`);
  if (typeof row.created_at !== 'string' || !ISO.test(row.created_at) || Number.isNaN(Date.parse(row.created_at))) throw new Error(`pipeline_run_reviews row ${row.id} field created_at`);
  return { id: row.id, ...record, createdAt: row.created_at };
}

export function createReviewStore(db, { now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new TypeError('review store: database handle is required');
  if (typeof now !== 'function') throw new TypeError('review store: now must be a function');
  db.exec(`CREATE TABLE IF NOT EXISTS pipeline_run_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, step_index INTEGER NOT NULL,
    step_name TEXT NOT NULL, attempt INTEGER NOT NULL, verdict TEXT NOT NULL
      CHECK (verdict IN ('approved', 'sent_back')), comment TEXT, created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS pipeline_run_reviews_run ON pipeline_run_reviews (run_id, id);`);
  const insert = db.prepare('INSERT INTO pipeline_run_reviews (run_id, step_index, step_name, attempt, verdict, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const byId = db.prepare('SELECT * FROM pipeline_run_reviews WHERE id = ?');
  const all = db.prepare('SELECT * FROM pipeline_run_reviews WHERE run_id = ? ORDER BY id ASC');
  const sentBack = db.prepare("SELECT * FROM pipeline_run_reviews WHERE run_id = ? AND step_index = ? AND verdict = 'sent_back' ORDER BY id ASC");
  const guardRun = runId => { if (!isUuid(runId)) throw new TypeError('runId must be a UUID'); };
  const guardStep = stepIndex => { if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32) throw new TypeError('stepIndex must be an integer from 0 to 32'); };
  return {
    get(id) {
      if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('review id must be a positive integer');
      const row = byId.get(id);
      return row ? hydrate(row) : null;
    },
    add(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new TypeError('review must be an object');
      for (const field of Object.keys(record)) if (!FIELDS.includes(field)) throw new TypeError(`${field} is an unknown review field`);
      const bad = invalid(record);
      if (bad) throw new TypeError(`review ${bad} is invalid`);
      const stamp = now();
      if (typeof stamp !== 'string' || !ISO.test(stamp) || Number.isNaN(Date.parse(stamp))) throw new TypeError('review createdAt must be an ISO timestamp');
      return hydrate(byId.get(insert.run(...FIELDS.map(field => record[field]), stamp).lastInsertRowid));
    },
    list(runId) { guardRun(runId); return all.all(runId).map(hydrate); },
    listSentBack(runId, stepIndex) { guardRun(runId); guardStep(stepIndex); return sentBack.all(runId, stepIndex).map(hydrate); },
  };
}
