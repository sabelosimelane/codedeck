import { isUuid } from '../../shared/pipeline-definitions.mjs';

const clockStatuses = new Set([
  'pending',
  'running',
  'needs_input',
  'limit_paused',
  'awaiting_approval',
  'interrupted',
  'stopped',
  'error',
  'complete',
]);

function requireField(runId, field, condition) {
  if (!condition) throw new Error(`Invalid run clock ${field} for ${runId}`);
}

// Workflow and team scoring share this clock. Null attempt numbers denote historical
// boundaries recorded before CodeDeck could identify which attempt was running.
export function createRunClock(db) {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS improvement_clock (
      seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, step INTEGER NOT NULL, status TEXT NOT NULL,
      at TEXT NOT NULL, first INTEGER NOT NULL, attempt INTEGER);
      CREATE INDEX IF NOT EXISTS improvement_clock_run ON improvement_clock(run_id,seq);`);
    if (
      !db
        .prepare('PRAGMA table_info(improvement_clock)')
        .all()
        .some((c) => c.name === 'attempt')
    ) {
      db.exec('ALTER TABLE improvement_clock ADD COLUMN attempt INTEGER');
      db.exec(
        'DROP TRIGGER IF EXISTS improvement_run_created; DROP TRIGGER IF EXISTS improvement_run_changed',
      );
    }
    const attempt = (row) =>
      `CASE WHEN json_valid(${row}.steps) THEN json_extract(${row}.steps, '$[' || ${row}.current_step_index || '].attempt') END`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS improvement_run_created AFTER INSERT ON pipeline_runs BEGIN
      INSERT INTO improvement_clock(run_id,step,status,at,first,attempt)
      VALUES(NEW.id,NEW.current_step_index,NEW.status,NEW.updated_at,1,${attempt('NEW')}); END;
      CREATE TRIGGER IF NOT EXISTS improvement_run_changed AFTER UPDATE ON pipeline_runs
      WHEN OLD.status<>NEW.status OR OLD.current_step_index<>NEW.current_step_index
        OR (NEW.status='running' AND ${attempt('OLD')} IS NOT ${attempt('NEW')}) BEGIN
      INSERT INTO improvement_clock(run_id,step,status,at,first,attempt)
      VALUES(NEW.id,NEW.current_step_index,NEW.status,NEW.updated_at,0,${attempt('NEW')}); END;`);
  })();
  const read = db.prepare('SELECT * FROM improvement_clock WHERE run_id=? ORDER BY seq');
  return (id) => {
    requireField('query', 'id', isUuid(id));
    const rows = read.all(id);
    for (const row of rows) {
      requireField(id, 'run_id', row.run_id === id);
      requireField(id, 'seq', Number.isSafeInteger(row.seq) && row.seq >= 1);
      requireField(id, 'step', Number.isInteger(row.step) && row.step >= 0 && row.step <= 32);
      requireField(id, 'status', clockStatuses.has(row.status));
      requireField(id, 'at', typeof row.at === 'string' && Number.isFinite(Date.parse(row.at)));
      requireField(id, 'first', row.first === 0 || row.first === 1);
      requireField(
        id,
        'attempt',
        row.attempt === null || (Number.isSafeInteger(row.attempt) && row.attempt >= 0),
      );
    }
    return rows;
  };
}

export function attemptDurations(runId, boundaries) {
  const durations = new Map();
  for (let i = 1; i < boundaries.length; i++) {
    const previous = boundaries[i - 1];
    if (previous.status !== 'running' || previous.attempt === null) continue;
    const key = previous.step + ':' + previous.attempt;
    const ms = Date.parse(boundaries[i].at) - Date.parse(previous.at);
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Invalid attempt clock for run ' + runId);
    durations.set(key, (durations.get(key) ?? 0) + ms);
  }
  return durations;
}
