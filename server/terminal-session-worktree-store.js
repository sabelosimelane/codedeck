import path from 'node:path';

function nonempty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`terminal session worktree: ${field} must be a nonempty string`);
  return value;
}

function validate(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('terminal session worktree: record must be an object');
  const sessionId = nonempty(record.sessionId, 'sessionId');
  const project = nonempty(record.project, 'project');
  const worktreePath = nonempty(record.worktreePath, 'worktreePath');
  if (!path.isAbsolute(worktreePath) || worktreePath.includes('\0')) throw new Error(`terminal session worktree: worktreePath must be absolute for ${sessionId}`);
  const createdAt = nonempty(record.createdAt, 'createdAt');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`terminal session worktree: createdAt must be an ISO timestamp for ${sessionId}`);
  }
  return { sessionId, project, worktreePath, createdAt };
}

export function createTerminalSessionWorktreeStore(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error('terminal session worktree: database handle required');
  db.exec('CREATE TABLE IF NOT EXISTS terminal_session_worktree (session_id TEXT PRIMARY KEY, project TEXT NOT NULL, worktree_path TEXT NOT NULL, created_at TEXT NOT NULL)');
  const read = db.prepare('SELECT session_id, project, worktree_path, created_at FROM terminal_session_worktree WHERE session_id = ?');
  const readAll = db.prepare('SELECT session_id, project, worktree_path, created_at FROM terminal_session_worktree ORDER BY session_id');
  const write = db.prepare('INSERT INTO terminal_session_worktree (session_id, project, worktree_path, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET project = excluded.project, worktree_path = excluded.worktree_path, created_at = excluded.created_at');
  const remove = db.prepare('DELETE FROM terminal_session_worktree WHERE session_id = ?');
  const hydrate = row => validate({ sessionId: row.session_id, project: row.project, worktreePath: row.worktree_path, createdAt: row.created_at });
  return {
    set(record) { const value = validate(record); write.run(value.sessionId, value.project, value.worktreePath, value.createdAt); return value; },
    get(sessionId) { nonempty(sessionId, 'sessionId'); const row = read.get(sessionId); return row ? hydrate(row) : null; },
    clear(sessionId) { nonempty(sessionId, 'sessionId'); remove.run(sessionId); },
    all() { return readAll.all().map(hydrate); },
  };
}

