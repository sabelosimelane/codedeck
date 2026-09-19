import { validateSettings, validateRecord, requireField, isText } from './session-naming-validation.js';

export function createNamingStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS session_naming_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS terminal_titles (session_id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const get = id => {
    const row = db.prepare('SELECT value FROM terminal_titles WHERE session_id = ?').get(id);
    if (!row) return null;
    const value = validateRecord(JSON.parse(row.value));
    requireField(value.sessionId === id, 'sessionId', 'Persisted identity must match its key');
    return value;
  };
  const write = r => {
    validateRecord(r);
    db.prepare('INSERT INTO terminal_titles VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET value=excluded.value').run(r.sessionId, JSON.stringify(r));
    return r;
  };
  const store = {
    get,
    settings() {
      const row = db.prepare('SELECT value FROM session_naming_settings WHERE id=1').get();
      return row ? validateSettings(JSON.parse(row.value)) : null;
    },
    saveSettings(value) {
      if (value === null) { db.prepare('DELETE FROM session_naming_settings').run(); return; }
      const valid = validateSettings(value);
      db.prepare('INSERT INTO session_naming_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(valid));
    },
    ensure(id) {
      requireField(isText(id), 'sessionId', 'A session ID is required');
      return get(id) ?? write({ sessionId: id, title: null, state: 'waiting', source: null, revision: 0, error: null });
    },
    update(id, changes, expectedRevision) {
      const current = get(id);
      if (!current || (expectedRevision !== undefined && current.revision !== expectedRevision)) return null;
      return write({ ...current, ...changes, sessionId: id, revision: current.revision + 1 });
    },
    remove(id) { db.prepare('DELETE FROM terminal_titles WHERE session_id = ?').run(id); },
    list() { return db.prepare('SELECT session_id FROM terminal_titles ORDER BY session_id').all().map(r => get(r.session_id)); },
  };
  for (const record of store.list()) if (['queued', 'generating'].includes(record.state)) {
    store.update(record.sessionId, { state: 'failed', error: 'Naming was interrupted. Retry to use fresh terminal context.' });
  }
  return store;
}
