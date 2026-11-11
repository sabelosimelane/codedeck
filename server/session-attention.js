// Per-session attention state shared by the desktop and the phone: whether work
// has finished and not been looked at, whether its status colours are muted, and
// when it last did something meaningful. SQLite is the source of truth — these
// used to live in one desktop browser tab, where no other client could honour them.

const STATUSES = ['running', 'idle', 'dead', 'unknown'];
const TOUCH_INTERVAL_MS = 30_000;

/** The desktop's getTerminalStatus, for rows that carry an explicit execution status. */
export function attentionStatus({ alive, executionStatus, reachability, executionReason }) {
  if (reachability === 'unreachable' || executionReason === 'host_unreachable') return 'unknown';
  if (!alive) return 'dead';
  if (!STATUSES.includes(executionStatus)) throw new Error(`session attention: unclassifiable executionStatus ${String(executionStatus)}`);
  return executionStatus;
}

function requireSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256 || /[\x00-\x1f]/.test(sessionId)) {
    throw new Error(`session attention: sessionId must be nonempty text of at most 256 characters, received ${typeof sessionId}`);
  }
  return sessionId;
}
const isTimestamp = value => Number.isSafeInteger(value) && value >= 0;

export function createSessionAttention({ db, now, onLanded }) {
  if (!db) throw new Error('session attention: db handle is required');
  if (typeof now !== 'function') throw new Error('session attention: now must be a clock function');
  if (typeof onLanded !== 'function') throw new Error('session attention: onLanded handler is required');
  db.exec('CREATE TABLE IF NOT EXISTS session_attention (session_id TEXT PRIMARY KEY, status TEXT NOT NULL, finished INTEGER NOT NULL, muted INTEGER NOT NULL, activity_at INTEGER NOT NULL)');
  const read = db.prepare('SELECT session_id, status, finished, muted, activity_at FROM session_attention WHERE session_id = ?');
  const write = db.prepare('INSERT INTO session_attention (session_id, status, finished, muted, activity_at) VALUES (@sessionId, @status, @finished, @muted, @activityAt) ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, finished = excluded.finished, muted = excluded.muted, activity_at = excluded.activity_at');
  const remove = db.prepare('DELETE FROM session_attention WHERE session_id = ?');
  const lastTouch = new Map();

  // Validated on the way out too: a row that was valid when written can still be
  // corrupted on disk, and a tolerated bad row would mis-signal a session.
  function load(sessionId) {
    const row = read.get(requireSessionId(sessionId));
    if (!row) return null;
    if (row.session_id !== sessionId) throw new Error(`session attention: stored identity does not match key ${sessionId}`);
    if (!STATUSES.includes(row.status)) throw new Error(`session attention: stored status is invalid for ${sessionId}`);
    if (row.finished !== 0 && row.finished !== 1) throw new Error(`session attention: stored finished flag is invalid for ${sessionId}`);
    if (row.muted !== 0 && row.muted !== 1) throw new Error(`session attention: stored muted flag is invalid for ${sessionId}`);
    if (!isTimestamp(row.activity_at)) throw new Error(`session attention: stored activity time is invalid for ${sessionId}`);
    return { sessionId, status: row.status, finished: row.finished === 1, muted: row.muted === 1, activityAt: row.activity_at };
  }
  const save = record => write.run({ sessionId: record.sessionId, status: record.status, finished: record.finished ? 1 : 0, muted: record.muted ? 1 : 0, activityAt: record.activityAt });
  function known(sessionId) {
    const record = load(sessionId);
    if (!record) throw new Error(`session attention: session ${sessionId} has not observed status yet`);
    return record;
  }
  const clock = () => { const time = now(); if (!isTimestamp(time)) throw new Error('session attention: clock must return a nonnegative integer'); return time; };

  return {
    knows: sessionId => load(sessionId) !== null,
    state(sessionId) {
      const record = load(sessionId);
      return record && { finished: record.finished, muted: record.muted, lastActivityAt: record.activityAt };
    },
    /**
     * Apply one status reading. Finished follows the desktop rule (running work
     * going idle or unknown). A parked session "lands" only on a real transition
     * into idle while finished, or on death — never on a state that was already true.
     */
    observe({ sessionId, status, activityHint }) {
      requireSessionId(sessionId);
      if (!STATUSES.includes(status)) throw new Error(`session attention: status must be one of ${STATUSES.join(', ')} for ${sessionId}`);
      const previous = load(sessionId);
      if (!previous) {
        if (!isTimestamp(activityHint)) throw new Error(`session attention: activityHint must be a nonnegative integer for new session ${sessionId}`);
        save({ sessionId, status, finished: false, muted: false, activityAt: activityHint });
        return;
      }
      if (previous.status === status) return;
      const next = { ...previous, status };
      // A dead id that comes back is a different terminal: nothing carries over.
      if (previous.status === 'dead') { next.finished = false; next.muted = false; }
      if (status === 'running') { next.finished = false; next.activityAt = clock(); }
      else if (previous.status === 'running' && status !== 'dead') { next.finished = true; next.activityAt = clock(); }
      else if (status === 'dead') { next.finished = false; next.activityAt = clock(); }
      save(next);
      if ((status === 'idle' && next.finished) || status === 'dead') onLanded(sessionId);
    },
    acknowledge(sessionId) { const record = known(sessionId); if (record.finished) save({ ...record, finished: false }); },
    setMuted(sessionId, muted) {
      requireSessionId(sessionId);
      if (typeof muted !== 'boolean') throw new Error(`session attention: muted must be a boolean for ${sessionId}`);
      const record = known(sessionId);
      if (record.muted !== muted) save({ ...record, muted });
    },
    /** The user typed here. Keystrokes arrive constantly, so this moves at most twice a minute. */
    touch(sessionId) {
      const time = clock();
      if (time - (lastTouch.get(sessionId) ?? -Infinity) < TOUCH_INTERVAL_MS) return;
      const record = load(sessionId);
      if (!record) return;
      lastTouch.set(sessionId, time);
      save({ ...record, activityAt: time });
    },
    forget(sessionId) { remove.run(requireSessionId(sessionId)); lastTouch.delete(sessionId); },
  };
}
