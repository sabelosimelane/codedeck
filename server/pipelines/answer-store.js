import { isUuid } from '../../shared/pipeline-definitions.mjs';

/**
 * What the owner answered when an agent asked: the questions the agent listed (null when
 * it listed none) and the answer typed into its terminal. Rows are only ever added. With
 * the run's input and the agents' own decisions, they make up the run's brief.
 */

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const QUESTIONS_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;
const ANSWER_CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/;
const TEXT_MAX = 4000;
const FIELDS = ['runId', 'stepIndex', 'stepName', 'pass', 'questions', 'answer'];

function violation(record) {
  if (!isUuid(record.runId)) return 'runId';
  if (!Number.isInteger(record.stepIndex) || record.stepIndex < 0 || record.stepIndex > 32) return 'stepIndex';
  if (typeof record.stepName !== 'string' || !record.stepName.trim() || record.stepName.length > 64 || /[\x00-\x1f\x7f]/.test(record.stepName)) return 'stepName';
  if (!Number.isInteger(record.pass) || record.pass < 1 || record.pass > 100) return 'pass';
  if (record.questions !== null && (typeof record.questions !== 'string' || !record.questions.trim() || record.questions.length > TEXT_MAX || QUESTIONS_CONTROL.test(record.questions))) return 'questions';
  if (typeof record.answer !== 'string' || !record.answer.trim() || record.answer.length > TEXT_MAX || ANSWER_CONTROL.test(record.answer)) return 'answer';
  return null;
}

function hydrate(row) {
  if (!Number.isInteger(row.id) || row.id < 1) throw new Error('pipeline_run_answers row field id: must be an integer ≥ 1');
  const record = { runId: row.run_id, stepIndex: row.step_index, stepName: row.step_name, pass: row.pass, questions: row.questions, answer: row.answer };
  const bad = violation(record);
  if (bad) throw new Error(`pipeline_run_answers row ${row.id} field ${bad}: invalid`);
  if (typeof row.created_at !== 'string' || !ISO_TIMESTAMP.test(row.created_at) || Number.isNaN(Date.parse(row.created_at))) {
    throw new Error(`pipeline_run_answers row ${row.id} field created_at: must be an ISO-8601 timestamp`);
  }
  return { id: row.id, ...record, createdAt: row.created_at };
}

export function createAnswerStore(db, { now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error('pipeline_run_answers: a database handle is required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_run_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      pass INTEGER NOT NULL,
      questions TEXT,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pipeline_run_answers_run ON pipeline_run_answers (run_id, id);
  `);
  const insert = db.prepare('INSERT INTO pipeline_run_answers (run_id, step_index, step_name, pass, questions, answer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const readOne = db.prepare('SELECT * FROM pipeline_run_answers WHERE id = ?');
  // The id grows with every record, so it is also the order in which answers were given.
  const readRun = db.prepare('SELECT * FROM pipeline_run_answers WHERE run_id = ? AND (? IS NULL OR step_index = ?) ORDER BY id ASC');
  return {
    add(record) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('pipeline_run_answers: an answer object is required');
      for (const field of Object.keys(record)) if (!FIELDS.includes(field)) throw new Error(`pipeline_run_answers: ${field} is an unknown field`);
      const bad = violation(record);
      if (bad) throw new Error(`pipeline_run_answers: ${bad} is invalid`);
      const stamp = now();
      if (typeof stamp !== 'string' || !ISO_TIMESTAMP.test(stamp)) throw new Error('pipeline_run_answers: the clock must return an ISO-8601 timestamp');
      return hydrate(readOne.get(insert.run(record.runId, record.stepIndex, record.stepName, record.pass, record.questions, record.answer, stamp).lastInsertRowid));
    },
    /** Every answer of a run, oldest first; `stepIndex` narrows it to one step. */
    list(runId, { stepIndex = null } = {}) {
      if (!isUuid(runId)) throw new Error('pipeline_run_answers: runId must be a UUID');
      if (stepIndex !== null && (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32)) throw new Error('pipeline_run_answers: stepIndex must be null or an integer from 0 to 32');
      return readRun.all(runId, stepIndex, stepIndex).map(hydrate);
    },
  };
}
