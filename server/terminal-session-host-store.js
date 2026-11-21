/**
 * Persisted session-to-host registry (`terminal_session_hosts`).
 *
 * Because a cross-host project can have terminals open on multiple hosts
 * simultaneously, every allocated session records which host owns it so
 * reconnects, status polling, deletion, GC, and uploads always route to the
 * exact host.
 */

function nonempty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`terminal session host: ${field} must be a nonempty string`);
  }
  return value.trim();
}

function validate(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('terminal session host: record must be an object');
  }
  const sessionId = nonempty(record.sessionId, 'sessionId');
  const project = nonempty(record.project, 'project');
  const host = nonempty(record.host, 'host');
  const repository = record.repository === undefined || record.repository === null || record.repository === ''
    ? null
    : nonempty(record.repository, 'repository');
  const createdAt = record.createdAt
    ? nonempty(record.createdAt, 'createdAt')
    : new Date().toISOString();
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`terminal session host: createdAt must be an ISO timestamp for ${sessionId}`);
  }
  return { sessionId, project, host, repository, createdAt };
}

export function createTerminalSessionHostStore(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new Error('terminal session host: database handle required');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_session_hosts (
      session_id TEXT PRIMARY KEY,
      project    TEXT NOT NULL,
      host       TEXT NOT NULL,
      repository TEXT,
      created_at TEXT NOT NULL
    )
  `);

  const read = db.prepare(
    'SELECT session_id, project, host, repository, created_at FROM terminal_session_hosts WHERE session_id = ?'
  );
  const readByProject = db.prepare(
    'SELECT session_id, project, host, repository, created_at FROM terminal_session_hosts WHERE project = ? ORDER BY session_id'
  );
  const readAll = db.prepare(
    'SELECT session_id, project, host, repository, created_at FROM terminal_session_hosts ORDER BY session_id'
  );
  const write = db.prepare(`
    INSERT INTO terminal_session_hosts (session_id, project, host, repository, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      project = excluded.project,
      host = excluded.host,
      repository = excluded.repository,
      created_at = excluded.created_at
  `);
  const del = db.prepare('DELETE FROM terminal_session_hosts WHERE session_id = ?');
  const rewriteHostStmt = db.prepare('UPDATE terminal_session_hosts SET host = ? WHERE lower(host) = lower(?)');

  const hydrate = row => ({
    sessionId: row.session_id,
    project: row.project,
    host: row.host,
    repository: row.repository ?? null,
    createdAt: row.created_at,
  });

  return {
    set(record) {
      const value = validate(record);
      write.run(value.sessionId, value.project, value.host, value.repository, value.createdAt);
      return value;
    },
    get(sessionId) {
      nonempty(sessionId, 'sessionId');
      const row = read.get(sessionId);
      return row ? hydrate(row) : null;
    },
    remove(sessionId) {
      nonempty(sessionId, 'sessionId');
      del.run(sessionId);
    },
    listByProject(project) {
      nonempty(project, 'project');
      return readByProject.all(project).map(hydrate);
    },
    rewriteHost(previousName, nextName) {
      if (previousName === nextName) return;
      rewriteHostStmt.run(nextName, previousName);
    },
    all() {
      return readAll.all().map(hydrate);
    },
  };
}
