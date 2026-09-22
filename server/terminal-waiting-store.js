// Per-terminal "waiting" marks: the user has delegated work in a tab to an agent
// and wants it to stop competing for attention until it finishes. SQLite is the
// source of truth — a mark must survive reloads and server restarts, because the
// tmux-backed session it describes does.

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error(`terminal waiting: sessionId must be a nonempty string, received ${typeof sessionId}`);
  }
  return sessionId;
}

function requireWaitingAt(waitingAt, sessionId) {
  if (typeof waitingAt !== 'string' || !ISO_TIMESTAMP.test(waitingAt) || Number.isNaN(Date.parse(waitingAt))) {
    throw new Error(`terminal waiting: waitingAt must be an ISO-8601 timestamp for session ${sessionId}`);
  }
  return waitingAt;
}

export function createTerminalWaitingStore(db) {
  if (!db) throw new Error('terminal waiting: a database handle is required');
  db.exec('CREATE TABLE IF NOT EXISTS terminal_waiting (session_id TEXT PRIMARY KEY, waiting_at TEXT NOT NULL)');

  const read = db.prepare('SELECT session_id, waiting_at FROM terminal_waiting WHERE session_id = ?');
  const readAll = db.prepare('SELECT session_id, waiting_at FROM terminal_waiting ORDER BY session_id');
  const insert = db.prepare('INSERT INTO terminal_waiting (session_id, waiting_at) VALUES (?, ?) ON CONFLICT(session_id) DO NOTHING');
  const remove = db.prepare('DELETE FROM terminal_waiting WHERE session_id = ?');

  // Rows are validated on the way out as well as in: a value that was valid when
  // written can still be corrupted on disk, and a silently-tolerated bad row
  // would mark the wrong tab quiet.
  const hydrate = row => ({
    sessionId: requireSessionId(row.session_id),
    waitingAt: requireWaitingAt(row.waiting_at, row.session_id),
  });

  const get = sessionId => {
    requireSessionId(sessionId);
    const row = read.get(sessionId);
    if (!row) return null;
    const record = hydrate(row);
    if (record.sessionId !== sessionId) {
      throw new Error(`terminal waiting: persisted identity ${record.sessionId} does not match key ${sessionId}`);
    }
    return record;
  };

  return {
    get,
    mark(sessionId, waitingAt) {
      requireSessionId(sessionId);
      requireWaitingAt(waitingAt, sessionId);
      insert.run(sessionId, waitingAt);
      return get(sessionId);
    },
    clear(sessionId) {
      requireSessionId(sessionId);
      remove.run(sessionId);
    },
    list() {
      return readAll.all().map(hydrate);
    },
  };
}
