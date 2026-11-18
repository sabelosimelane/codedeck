import { isUuid } from '../../shared/pipeline-definitions.mjs';

/**
 * What agents were asked to settle for themselves during a run: the questions an agent
 * listed before pausing and the answer CodeDeck typed for it. Rows are only ever added.
 */

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const SINGLE_LINE = /[\x00-\x1f\x7f]/;
// Questions keep their line breaks and tabs; an answer is pasted into a terminal, so only new lines.
const QUESTIONS_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;
const ANSWER_CONTROL = /[\x00-\x09\x0b-\x1f\x7f]/;
const TEXT_MAX = 4000;
const FIELDS = ['runId', 'stepIndex', 'stepName', 'pass', 'questions', 'truncated', 'answer'];

/** The first violated expectation of a decision's fields, as [field, message], or null. */
function firstViolation(record) {
  if (!isUuid(record.runId)) return ['runId', 'must be a UUID'];
  if (!Number.isInteger(record.stepIndex) || record.stepIndex < 0 || record.stepIndex > 32) {
    return ['stepIndex', 'must be an integer from 0 to 32'];
  }
  const { stepName, questions, answer } = record;
  if (typeof stepName !== 'string' || !stepName.trim() || stepName.length > 64 || SINGLE_LINE.test(stepName)) {
    return ['stepName', 'must be 1–64 characters on one line'];
  }
  if (!Number.isInteger(record.pass) || record.pass < 1 || record.pass > 100) return ['pass', 'must be an integer from 1 to 100'];
  if (typeof questions !== 'string' || !questions.trim() || questions.length > TEXT_MAX || QUESTIONS_CONTROL.test(questions)) {
    return ['questions', `must be 1–${TEXT_MAX} characters without control characters`];
  }
  if (typeof record.truncated !== 'boolean') return ['truncated', 'must be true or false'];
  if (typeof answer !== 'string' || !answer.trim() || answer.length > TEXT_MAX || ANSWER_CONTROL.test(answer)) {
    return ['answer', `must be 1–${TEXT_MAX} characters; new lines are the only control characters allowed`];
  }
  return null;
}

const COLUMN = {
  runId: 'run_id', stepIndex: 'step_index', stepName: 'step_name', pass: 'pass',
  questions: 'questions', truncated: 'truncated', answer: 'answer',
};

function hydrate(row) {
  const fail = (column, message) => {
    throw new Error(`pipeline_run_decisions row ${row.id} field ${column}: ${message}`);
  };
  if (!Number.isInteger(row.id) || row.id < 1) throw new Error('pipeline_run_decisions row field id: must be an integer ≥ 1');
  if (row.truncated !== 0 && row.truncated !== 1) fail('truncated', 'must be 0 or 1');
  const record = {
    runId: row.run_id,
    stepIndex: row.step_index,
    stepName: row.step_name,
    pass: row.pass,
    questions: row.questions,
    truncated: row.truncated === 1,
    answer: row.answer,
  };
  const violation = firstViolation(record);
  if (violation) fail(COLUMN[violation[0]], violation[1]);
  if (typeof row.created_at !== 'string' || !ISO_TIMESTAMP.test(row.created_at) || Number.isNaN(Date.parse(row.created_at))) {
    fail('created_at', 'must be an ISO-8601 timestamp');
  }
  return { id: row.id, ...record, createdAt: row.created_at };
}

function requireRunId(runId) {
  if (!isUuid(runId)) throw new Error('pipeline_run_decisions: runId must be a UUID');
}

export function createDecisionStore(db, { now = () => new Date().toISOString() } = {}) {
  if (!db) throw new Error('pipeline_run_decisions: a database handle is required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_run_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      pass INTEGER NOT NULL,
      questions TEXT NOT NULL,
      truncated INTEGER NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pipeline_run_decisions_run ON pipeline_run_decisions (run_id, id);
  `);

  const insert = db.prepare(`
    INSERT INTO pipeline_run_decisions
      (run_id, step_index, step_name, pass, questions, truncated, answer, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const readOne = db.prepare('SELECT * FROM pipeline_run_decisions WHERE id = ?');
  const countRun = db.prepare('SELECT COUNT(*) AS total FROM pipeline_run_decisions WHERE run_id = ? AND (? IS NULL OR step_index = ?)');
  // The id grows with every record, so it is also the order in which decisions were made.
  const page = {
    asc: db.prepare('SELECT * FROM pipeline_run_decisions WHERE run_id = ? AND (? IS NULL OR step_index = ?) ORDER BY id ASC LIMIT ? OFFSET ?'),
    desc: db.prepare('SELECT * FROM pipeline_run_decisions WHERE run_id = ? AND (? IS NULL OR step_index = ?) ORDER BY id DESC LIMIT ? OFFSET ?'),
  };
  const requireStep = stepIndex => {
    if (stepIndex !== null && (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 32)) throw new Error('pipeline_run_decisions: stepIndex must be null or an integer from 0 to 32');
  };

  return {
    add(decision) {
      if (decision === null || typeof decision !== 'object' || Array.isArray(decision)) {
        throw new Error('pipeline_run_decisions: a decision object is required');
      }
      for (const field of Object.keys(decision)) {
        if (!FIELDS.includes(field)) throw new Error(`pipeline_run_decisions: ${field} is an unknown field`);
      }
      const violation = firstViolation(decision);
      if (violation) throw new Error(`pipeline_run_decisions: ${violation[0]} ${violation[1]}`);
      const { lastInsertRowid } = insert.run(
        decision.runId, decision.stepIndex, decision.stepName, decision.pass,
        decision.questions, decision.truncated ? 1 : 0, decision.answer, now(),
      );
      return hydrate(readOne.get(lastInsertRowid));
    },
    /** `stepIndex` narrows to one step; null counts the whole run. */
    count(runId, stepIndex = null) {
      requireRunId(runId);
      requireStep(stepIndex);
      return countRun.get(runId, stepIndex, stepIndex).total;
    },
    list(runId, { offset, limit, direction, stepIndex = null } = {}) {
      requireRunId(runId);
      requireStep(stepIndex);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('pipeline_run_decisions: offset must be an integer ≥ 0');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('pipeline_run_decisions: limit must be an integer from 1 to 100');
      if (direction !== 'asc' && direction !== 'desc') throw new Error('pipeline_run_decisions: direction must be asc or desc');
      return page[direction].all(runId, stepIndex, stepIndex, limit, offset).map(hydrate);
    },
  };
}
