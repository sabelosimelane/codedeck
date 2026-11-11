import { randomUUID } from 'node:crypto';

export class MobileError extends Error {
  constructor(message, status = 400, errors = []) { super(message); this.status = status; this.errors = errors; }
}
export function requireField(valid, field, expectation) {
  if (!valid) throw new MobileError('One or more fields failed validation.', 400, [{ field, message: expectation }]);
}
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const sessionKey = value => requireField(typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value), 'sessionId', 'Use a nonempty session identity of at most 256 characters');
function validateDevice(installationId, value) {
  requireField(isUuid(installationId), 'installationId', 'Use a UUID installation identity');
  requireField(value !== null && typeof value === 'object' && !Array.isArray(value), 'device', 'A device object is required');
  const errors = [];
  const check = (valid, field, message) => { if (!valid) errors.push({ field, message }); };
  check(Object.keys(value).every(key => ['token', 'notificationsEnabled', 'permission'].includes(key)), 'device', 'Unknown field');
  check(value.token === null || (typeof value.token === 'string' && value.token.length >= 1 && value.token.length <= 4096 && !/\s/.test(value.token)), 'token', 'Use null or a nonblank token of at most 4096 characters');
  check(typeof value.notificationsEnabled === 'boolean', 'notificationsEnabled', 'Use a boolean');
  check(['granted', 'denied', 'prompt'].includes(value.permission), 'permission', 'Use granted, denied or prompt');
  if (errors.length) throw new MobileError('One or more fields failed validation.', 400, errors);
}
function hydrate(row) {
  requireField(row.notifications_enabled === 0 || row.notifications_enabled === 1, 'notificationsEnabled', 'Stored preference must be boolean');
  requireField(typeof row.updated_at === 'string' && Number.isFinite(Date.parse(row.updated_at)), 'updatedAt', 'Stored timestamp must be valid');
  const value = { token: row.token, notificationsEnabled: row.notifications_enabled === 1, permission: row.permission };
  validateDevice(row.installation_id, value);
  return { installationId: row.installation_id, ...value };
}

// Callers back up a persistent database before constructing this additive store.
export function createMobileStore(db) {
  requireField(db && typeof db.prepare === 'function' && typeof db.transaction === 'function', 'db', 'SQLite database is required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS mobile_instance (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mobile_incarnations (session_id TEXT PRIMARY KEY, incarnation_id TEXT NOT NULL, active INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mobile_devices (installation_id TEXT PRIMARY KEY, token TEXT, notifications_enabled INTEGER NOT NULL, permission TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO mobile_instance VALUES (1, ?)').run(randomUUID());
  const instanceId = db.prepare('SELECT instance_id FROM mobile_instance WHERE singleton=1').get().instance_id;
  requireField(isUuid(instanceId), 'instanceId', 'Stored instance identity must be a UUID');
  function currentIncarnation(sessionId) {
    sessionKey(sessionId);
    const row = db.prepare('SELECT * FROM mobile_incarnations WHERE session_id=?').get(sessionId);
    if (!row) return null;
    sessionKey(row.session_id);
    requireField(isUuid(row.incarnation_id), 'incarnationId', 'Stored incarnation must be a UUID');
    requireField(row.active === 0 || row.active === 1, 'active', 'Stored active flag must be boolean');
    return row.active ? row.incarnation_id : null;
  }
  return {
    instanceId, currentIncarnation,
    adoptIncarnation(sessionId, incarnationId) {
      sessionKey(sessionId);
      requireField(isUuid(incarnationId), 'incarnationId', 'Durable session incarnation must be a UUID');
      db.prepare('INSERT INTO mobile_incarnations VALUES (?, ?, 1) ON CONFLICT(session_id) DO UPDATE SET incarnation_id=excluded.incarnation_id, active=1').run(sessionId, incarnationId);
      return incarnationId;
    },
    ensureIncarnation: db.transaction(sessionId => {
      const existing = currentIncarnation(sessionId);
      if (existing) return existing;
      const incarnationId = randomUUID();
      db.prepare('INSERT INTO mobile_incarnations VALUES (?, ?, 1) ON CONFLICT(session_id) DO UPDATE SET incarnation_id=excluded.incarnation_id, active=1').run(sessionId, incarnationId);
      return incarnationId;
    }),
    retireSession(sessionId) { sessionKey(sessionId); db.prepare('UPDATE mobile_incarnations SET active=0 WHERE session_id=?').run(sessionId); },
    registerDevice(installationId, value) {
      validateDevice(installationId, value);
      db.prepare(`INSERT INTO mobile_devices VALUES (?, ?, ?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET token=excluded.token, notifications_enabled=excluded.notifications_enabled, permission=excluded.permission, updated_at=excluded.updated_at`)
        .run(installationId, value.token, Number(value.notificationsEnabled), value.permission, new Date().toISOString());
      return { installationId, notificationsEnabled: value.notificationsEnabled, permission: value.permission };
    },
    listDevices: () => db.prepare('SELECT * FROM mobile_devices ORDER BY installation_id').all().map(hydrate),
    unregisterDevice(installationId) { requireField(isUuid(installationId), 'installationId', 'Use a UUID'); db.prepare('DELETE FROM mobile_devices WHERE installation_id=?').run(installationId); },
    invalidateToken(installationId, expectedToken) {
      validateDevice(installationId, { token: expectedToken, notificationsEnabled: true, permission: 'granted' });
      db.prepare('UPDATE mobile_devices SET token=NULL WHERE installation_id=? AND token=?').run(installationId, expectedToken);
    },
  };
}
