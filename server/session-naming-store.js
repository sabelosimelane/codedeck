import { validateRecord, requireField, isText } from './session-naming-validation.js';
import { validateCliSettings } from './cli-naming-client.js';
import { parseLaunchCommand } from '../shared/agent-presets.mjs';

export function createNamingStore(db, { agentStore } = {}) {
  requireField(typeof agentStore?.get === 'function' && typeof agentStore.list === 'function', 'agentStore', 'An agent store is required');
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
      if (!row) return null;
      const value = JSON.parse(row.value);
      // Conduit connections are intentionally unset until an agent is selected.
      if (value && Object.hasOwn(value, 'baseUrl')) return null;
      if (value && Object.hasOwn(value, 'provider')) {
        const matches = agentStore.list().filter(agent => {
          const selection = parseLaunchCommand(agent.launchCommand);
          return selection?.provider === value.provider && selection.model === value.model;
        });
        if (matches.length === 1) {
          try {
            const migrated = validateCliSettings({ agentId: matches[0].id, effort: value.effort }, agentStore);
            db.prepare('UPDATE session_naming_settings SET value=? WHERE id=1').run(JSON.stringify(migrated));
            return migrated;
          } catch (error) {
            console.warn(`[session-naming] the saved ${value.provider}/${value.model} selection was not moved to agent ${matches[0].id}: ${error.message}`);
          }
        }
        db.prepare('DELETE FROM session_naming_settings WHERE id=1').run();
        return null;
      }
      return validateCliSettings(value, agentStore);
    },
    saveSettings(value) {
      if (value === null) { db.prepare('DELETE FROM session_naming_settings').run(); return; }
      const valid = validateCliSettings(value, agentStore);
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
