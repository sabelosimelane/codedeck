import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import CircuitBreaker from 'opossum';

export const NOTIFICATION_TTL_MS = 15 * 60 * 1000;
export const DESKTOP_PRESENCE_MS = 120000;
const WORDING = Object.freeze({ completed: 'Work completed', input_requested: 'Input requested', idle: 'Session became idle', ended: 'Session ended', test: 'CodeDeck notification test' });
class OutboxCapacityError extends Error {}
const WORKFLOWS = [null, 'stopped', 'running', 'resetting', 'needs_input', 'complete', 'error'];
function requireValue(valid, field) { if (!valid) throw new Error(`Notification ${field} violates its expected type or range.`); }
function text(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value); }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }
function object(value, name) { requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), name); }
function observation(record) {
  object(record, 'observation');
  requireValue(text(record.sessionId), 'sessionId'); requireValue(text(record.incarnationId), 'incarnationId');
  requireValue(['running', 'idle', 'dead', 'unknown'].includes(record.executionStatus), 'executionStatus');
  requireValue(WORKFLOWS.includes(record.workflowStatus), 'workflowStatus');
  requireValue(typeof record.needsInput === 'boolean', 'needsInput');
  requireValue(integer(record.observedAt), 'observedAt'); requireValue(typeof record.reachable === 'boolean', 'reachable');
  return record;
}
function device(record) {
  object(record, 'device'); requireValue(text(record.installationId), 'installationId');
  requireValue(record.token === null || (typeof record.token === 'string' && record.token.length > 0 && record.token.length <= 4096), 'token');
  requireValue(typeof record.notificationsEnabled === 'boolean', 'notificationsEnabled');
  requireValue(['granted', 'denied', 'prompt', 'prompt-with-rationale'].includes(record.permission), 'permission');
  return record;
}
function event(record) {
  object(record, 'event'); requireValue(text(record.id), 'event.id'); requireValue(text(record.instanceId), 'event.instanceId');
  requireValue(Object.hasOwn(WORDING, record.kind), 'event.kind');
  requireValue(record.kind === 'test' ? record.sessionId === null : text(record.sessionId), 'event.sessionId');
  requireValue(record.kind === 'test' ? record.incarnationId === null : text(record.incarnationId), 'event.incarnationId');
  requireValue(['active', 'ended', 'obsolete'].includes(record.status), 'event.status'); requireValue(integer(record.createdAt), 'event.createdAt');
  return record;
}
function delivery(record) {
  object(record, 'delivery'); requireValue(text(record.id), 'delivery.id'); requireValue(text(record.eventId), 'delivery.eventId');
  requireValue(text(record.installationId), 'delivery.installationId'); requireValue(['pending', 'sent', 'failed', 'expired', 'obsolete'].includes(record.status), 'delivery.status');
  for (const field of ['attempts', 'nextAttemptAt', 'expiresAt']) requireValue(integer(record[field]), `delivery.${field}`);
  return record;
}
function eligible(record) { return record.notificationsEnabled && record.permission === 'granted' && record.token !== null; }

/** Owns only notification tables. Call after backing up the database, before starting the monitor. */
export function createMobileNotifications({ db, instanceId, listObservations, listDevices, invalidateToken, isDesktopActive, provider, now = Date.now, maxPending = 1000, maxRecords = 10000, intervalMs = 5000, freshnessMs = 30000, logger = console }) {
  requireValue(db && typeof db.prepare === 'function' && typeof db.transaction === 'function', 'db'); requireValue(text(instanceId), 'instanceId');
  for (const [field, value] of Object.entries({ listObservations, listDevices, invalidateToken, isDesktopActive, now })) requireValue(typeof value === 'function', field);
  requireValue(provider === null || (provider && typeof provider.send === 'function'), 'provider');
  for (const [field, value] of Object.entries({ maxPending, maxRecords, intervalMs, freshnessMs })) requireValue(Number.isSafeInteger(value) && value > 0, field);
  requireValue(logger && typeof logger.warn === 'function', 'logger');
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_attention_observations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mobile_attention_events (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mobile_attention_deliveries (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  // Observations stored before CLI dialog detection have no needsInput; no
  // dialog was ever detected for them, so the recorded value is false.
  db.prepare(`UPDATE mobile_attention_observations SET value = json_set(value, '$.needsInput', json('false'))
    WHERE json_type(value, '$.needsInput') IS NULL`).run();
  const tables = { observations: ['mobile_attention_observations', observation], events: ['mobile_attention_events', event], deliveries: ['mobile_attention_deliveries', delivery] };
  function read(kind, id) {
    const [table, validate] = tables[kind]; const row = db.prepare(`SELECT id, value FROM ${table} WHERE id = ?`).get(id);
    if (!row) return null;
    requireValue(typeof row.value === 'string' && row.id === id, `${kind}.row`);
    const record = validate(JSON.parse(row.value));
    requireValue((kind === 'observations' ? record.incarnationId : record.id) === id, `${kind}.identity`);
    return record;
  }
  function list(kind) {
    const [table] = tables[kind];
    return db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => { requireValue(text(row.id), `${kind}.id`); return read(kind, row.id); });
  }
  function write(kind, id, record) {
    const [table, validate] = tables[kind]; validate(record);
    db.prepare(`INSERT INTO ${table}(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id, JSON.stringify(record));
  }
  function devices() { const values = listDevices(); requireValue(Array.isArray(values), 'devices'); return values.map(device); }
  function pending() { return list('deliveries').filter(d => d.status === 'pending'); }
  function obsolete(incarnationId) {
    for (const e of list('events')) if (e.incarnationId === incarnationId && e.status !== 'obsolete') write('events', e.id, { ...e, status: 'obsolete' });
    for (const d of pending()) if (read('events', d.eventId).incarnationId === incarnationId) write('deliveries', d.id, { ...d, status: 'obsolete' });
  }
  function queue(kind, record, recipients, time) {
    if (pending().length + recipients.length > maxPending) throw new OutboxCapacityError('Notification outbox capacity exceeded.');
    const e = event({ id: randomUUID(), instanceId, sessionId: record?.sessionId ?? null, incarnationId: record?.incarnationId ?? null, kind, status: kind === 'ended' ? 'ended' : 'active', createdAt: time });
    write('events', e.id, e);
    for (const d of recipients) {
      const id = randomUUID(); write('deliveries', id, { id, eventId: e.id, installationId: d.installationId, status: 'pending', attempts: 0, nextAttemptAt: time, expiresAt: time + NOTIFICATION_TTL_MS });
    }
    return e;
  }
  const observe = db.transaction((records, time) => {
    let capacityError = null;
    const recipients = devices().filter(eligible);
    const present = new Set(records.map(r => r.incarnationId));
    for (const previous of list('observations')) if (!present.has(previous.incarnationId)) {
      obsolete(previous.incarnationId);
      write('observations', previous.incarnationId, { ...previous, executionStatus: 'unknown', workflowStatus: null, needsInput: false, reachable: false });
    }
    for (const record of records) {
      const previous = read('observations', record.incarnationId);
      const fresh = record.reachable && time - record.observedAt <= freshnessMs && record.observedAt <= time;
      const current = fresh ? record : { ...record, executionStatus: 'unknown', workflowStatus: null, needsInput: false };
      if (current.executionStatus === 'running' && !current.needsInput && current.workflowStatus !== 'complete') obsolete(record.incarnationId);
      let kind = null;
      if (previous && fresh && previous.reachable && current.executionStatus !== 'unknown') {
        if (current.executionStatus === 'dead' && previous.executionStatus !== 'dead' && previous.executionStatus !== 'unknown') kind = 'ended';
        else if (current.workflowStatus === 'complete' && previous.workflowStatus !== 'complete') kind = 'completed';
        else if (current.needsInput && !previous.needsInput) kind = 'input_requested';
        else if (current.executionStatus === 'idle' && previous.executionStatus === 'running' && !['complete', 'needs_input'].includes(current.workflowStatus)) kind = 'idle';
      }
      if (kind) {
        try { queue(kind, current, recipients, time); }
        catch (error) {
          if (!(error instanceof OutboxCapacityError)) throw error;
          capacityError = error;
          // Keep the previous transition state so the next tick can retry after
          // dispatch has drained the queue. Other observations still commit.
          continue;
        }
      }
      write('observations', current.incarnationId, current);
    }
    return capacityError;
  });
  const prune = db.transaction(() => {
    const deliveries = list('deliveries');
    const protectedEvents = new Set(deliveries.filter(d => d.status === 'pending').map(d => d.eventId));
    const completedEvents = list('events').filter(e => !protectedEvents.has(e.id)).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const removeEvent = db.prepare('DELETE FROM mobile_attention_events WHERE id = ?');
    const removeDelivery = db.prepare('DELETE FROM mobile_attention_deliveries WHERE id = ?');
    const removed = new Set();
    for (const e of completedEvents.slice(maxRecords)) { removeEvent.run(e.id); removed.add(e.id); }
    const terminal = deliveries.filter(d => d.status !== 'pending').sort((a, b) => b.expiresAt - a.expiresAt || a.id.localeCompare(b.id));
    for (let index = 0; index < terminal.length; index += 1) {
      const d = terminal[index];
      if (index >= maxRecords || removed.has(d.eventId)) removeDelivery.run(d.id);
    }
  });
  let activeTick = null; let timer = null; let lastSuccessAt = null; let failureCount = 0;
  async function performTick() {
    const records = await listObservations(); requireValue(Array.isArray(records), 'observations'); records.forEach(observation);
    const time = now(); requireValue(integer(time), 'now');
    const desktopActive = isDesktopActive(); requireValue(typeof desktopActive === 'boolean', 'isDesktopActive');
    requireValue(new Set(records.map(r => r.incarnationId)).size === records.length, 'observations.uniqueIncarnations');
    const capacityError = observe(records, time);
    for (const d of pending()) {
      const e = read('events', d.eventId); requireValue(e !== null, 'delivery.event');
      if (time >= d.expiresAt) { write('deliveries', d.id, { ...d, status: 'expired' }); continue; }
      if (e.status === 'obsolete') { write('deliveries', d.id, { ...d, status: 'obsolete' }); continue; }
      if (desktopActive && e.kind !== 'test') continue;
      if (d.nextAttemptAt > time || provider === null) continue;
      const recipient = devices().find(v => v.installationId === d.installationId);
      if (!recipient || !eligible(recipient)) { write('deliveries', d.id, { ...d, status: 'obsolete' }); continue; }
      try {
        await provider.send({ token: recipient.token, notification: { title: 'CodeDeck', body: WORDING[e.kind] }, data: { instanceId, eventId: e.id }, android: { ttl: d.expiresAt - time, notification: { tag: e.id } } });
        write('deliveries', d.id, { ...d, attempts: d.attempts + 1, status: 'sent' });
      } catch (error) {
        const invalidToken = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error?.code);
        if (invalidToken) invalidateToken(recipient.installationId, recipient.token);
        write('deliveries', d.id, { ...d, status: invalidToken ? 'failed' : 'pending', attempts: d.attempts + 1, nextAttemptAt: time + Math.min(300000, 1000 * 2 ** Math.min(d.attempts, 8)) });
        failureCount += 1;
      }
    }
    prune();
    lastSuccessAt = time;
    if (capacityError) throw capacityError;
  }
  const tick = () => {
    if (!activeTick) activeTick = performTick().finally(() => { activeTick = null; });
    return activeTick;
  };
  return {
    tick,
    start() { if (timer) return; timer = setInterval(() => { tick().catch(() => { failureCount += 1; logger.warn('[mobile-notifications] monitor_failed'); }); }, intervalMs); timer.unref?.(); },
    async stop() { clearInterval(timer); timer = null; if (activeTick) await activeTick; },
    queueTest: db.transaction(installationId => {
      requireValue(text(installationId), 'installationId'); const recipient = devices().find(d => d.installationId === installationId);
      requireValue(recipient && eligible(recipient), 'test notification permission'); const time = now(); requireValue(integer(time), 'now');
      return queue('test', null, [recipient], time);
    }),
    resolveEvent(id) { requireValue(text(id), 'eventId'); return read('events', id); },
    metrics() {
      const all = list('deliveries');
      return { pending: all.filter(d => d.status === 'pending').length, failed: all.filter(d => d.status === 'failed').length, expired: all.filter(d => d.status === 'expired').length, sent: all.filter(d => d.status === 'sent').length, lastSuccessAt, failureCount };
    },
  };
}

/** Circuit surrounds the entire Admin SDK send, including token acquisition. No provider error text is logged. */
export function createFcmProvider({ messaging, logger = console, timeoutMs = 10000, resetTimeoutMs = 30000 }) {
  requireValue(messaging && typeof messaging.send === 'function', 'messaging'); requireValue(logger && typeof logger.info === 'function', 'logger');
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'timeoutMs'); requireValue(Number.isSafeInteger(resetTimeoutMs) && resetTimeoutMs > 0, 'resetTimeoutMs');
  const breaker = new CircuitBreaker(async message => {
    object(message, 'message'); requireValue(typeof message.token === 'string' && message.token.length > 0 && message.token.length <= 4096, 'message.token');
    object(message.notification, 'message.notification'); requireValue(message.notification.title === 'CodeDeck', 'message.notification.title'); requireValue(Object.values(WORDING).includes(message.notification.body), 'message.notification.body');
    object(message.data, 'message.data'); requireValue(text(message.data.instanceId), 'message.data.instanceId'); requireValue(text(message.data.eventId), 'message.data.eventId');
    requireValue(Object.keys(message.data).length === 2, 'message.data.fields'); object(message.android, 'message.android'); requireValue(integer(message.android.ttl) && message.android.ttl > 0 && message.android.ttl <= NOTIFICATION_TTL_MS, 'message.android.ttl');
    object(message.android.notification, 'message.android.notification'); requireValue(message.android.notification.tag === message.data.eventId, 'message.android.notification.tag');
    const result = await messaging.send(message); requireValue(typeof result === 'string' && /^projects\/[^/]+\/messages\/[^/]+$/.test(result), 'provider response'); return result;
  }, { timeout: timeoutMs, resetTimeout: resetTimeoutMs, errorThresholdPercentage: 50, volumeThreshold: 1, rollingCountTimeout: 10000, errorFilter: error => ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error?.code) });
  for (const state of ['open', 'halfOpen', 'close']) breaker.on(state, () => logger.info(`[mobile-notifications] provider_circuit=${state}`));
  return {
    async send(message) {
      try { return await breaker.fire(message); }
      catch (error) { const safe = new Error('Notification provider unavailable'); if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(error?.code)) safe.code = error.code; throw safe; }
    },
    state: () => breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
    shutdown: () => breaker.shutdown(),
  };
}

/** Service-account file stays outside the APK and source tree. Missing configuration is handled by the caller as not ready. */
export async function initializeFcmProvider({ credentialPath, logger = console }) {
  requireValue(typeof credentialPath === 'string' && credentialPath.startsWith('/'), 'credentialPath');
  let credentials;
  try { credentials = JSON.parse(await readFile(credentialPath, 'utf8')); } catch { throw new Error('Notification credential file could not be read.'); }
  object(credentials, 'credentials'); requireValue(credentials.type === 'service_account', 'credentials.type');
  for (const field of ['project_id', 'private_key', 'client_email']) requireValue(typeof credentials[field] === 'string' && credentials[field].length > 0, `credentials.${field}`);
  const { initializeApp, cert } = await import('firebase-admin/app'); const { getMessaging } = await import('firebase-admin/messaging');
  const app = initializeApp({ credential: cert(credentials) }, `codedeck-${randomUUID()}`);
  return createFcmProvider({ messaging: getMessaging(app), logger });
}
