import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createMobileNotifications, createFcmProvider } from '../mobile-notifications.js';

const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });
function fixture(options = {}) {
  const db = options.db ?? new Database(':memory:');
  if (!options.db) databases.push(db);
  let now = 100000;
  let observations = [];
  let devices = [{ installationId: 'phone', token: 'secret-token', notificationsEnabled: true, permission: 'granted' }];
  const provider = { send: vi.fn().mockResolvedValue('projects/test/messages/1') };
  const invalidateToken = vi.fn();
  const service = createMobileNotifications({ db, instanceId: 'instance', listObservations: async () => observations, listDevices: () => devices, invalidateToken, provider, now: () => now, isDesktopActive: () => false, ...options });
  return { db, service, provider, invalidateToken, set: v => { observations = v; }, devices: v => { devices = v; }, advance: ms => { now += ms; } };
}
const observation = (executionStatus, workflowStatus = null, changes = {}) => ({ sessionId: 'project-1', incarnationId: 'incarnation', executionStatus, workflowStatus, needsInput: workflowStatus === 'needs_input', observedAt: 100000, reachable: true, ...changes });

describe('durable mobile notifications', () => {
  it('holds a pending delivery without attempts and sends it after desktop activity lapses', async () => {
    let active = true;
    const isDesktopActive = vi.fn(() => active);
    const f = fixture({ isDesktopActive });
    f.set([observation('running')]); await f.service.tick();
    f.set([observation('idle')]); await f.service.tick();
    expect(f.provider.send).not.toHaveBeenCalled();
    expect(f.service.metrics().pending).toBe(1);
    expect(JSON.parse(f.db.prepare('SELECT value FROM mobile_attention_deliveries').get().value)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(isDesktopActive).toHaveBeenCalledTimes(2);
    active = false; f.advance(1000); await f.service.tick();
    expect(f.provider.send).toHaveBeenCalledTimes(1);
    expect(f.service.metrics().sent).toBe(1);
  });
  it('expires a held delivery after its original deadline', async () => {
    const f = fixture({ isDesktopActive: () => true });
    f.set([observation('running')]); await f.service.tick();
    f.set([observation('idle')]); await f.service.tick();
    f.advance(900001); await f.service.tick();
    expect(f.provider.send).not.toHaveBeenCalled();
    expect(f.service.metrics().expired).toBe(1);
  });
  it('sends test notifications while desktop is active', async () => {
    const f = fixture({ isDesktopActive: () => true }); f.service.queueTest('phone');
    await f.service.tick();
    expect(f.provider.send).toHaveBeenCalledTimes(1);
  });
  it('requires an isDesktopActive function and a boolean result', async () => {
    const f = fixture({ isDesktopActive: () => 'yes' });
    await expect(f.service.tick()).rejects.toThrow(/isDesktopActive/);
    expect(() => fixture({ isDesktopActive: undefined })).toThrow(/isDesktopActive/);
  });
  it('rejects every tick when stored observations predate the needsInput field', async () => {
    const db = new Database(':memory:'); databases.push(db);
    db.exec('CREATE TABLE mobile_attention_observations (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const legacy = { sessionId: 'project-1', incarnationId: 'incarnation', executionStatus: 'running', workflowStatus: null, observedAt: 100000, reachable: true };
    db.prepare('INSERT INTO mobile_attention_observations (id, value) VALUES (?, ?)').run('incarnation', JSON.stringify(legacy));
    const f = fixture({ db });
    f.set([observation('idle')]);
    await expect(f.service.tick()).resolves.not.toThrow();
    expect(f.provider.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(db.prepare('SELECT value FROM mobile_attention_observations WHERE id = ?').get('incarnation').value).needsInput).toBe(false);
  });
  it('requests input once when the CLI dialog appears during a running reading', async () => {
    const f = fixture(); f.set([observation('running')]); await f.service.tick();
    f.set([observation('running', null, { needsInput: true })]); await f.service.tick();
    expect(f.provider.send).toHaveBeenCalledTimes(1);
    const message = f.provider.send.mock.calls[0][0];
    expect(f.service.resolveEvent(message.data.eventId).kind).toBe('input_requested');
    await f.service.tick(); expect(f.provider.send).toHaveBeenCalledTimes(1);
  });
  it('seeds initial observations without alerts and emits generic idle event only on running to idle', async () => {
    const f = fixture(); f.set([observation('running')]); await f.service.tick();
    expect(f.provider.send).not.toHaveBeenCalled();
    f.set([observation('idle')]); await f.service.tick();
    expect(f.provider.send).toHaveBeenCalledTimes(1);
    const message = f.provider.send.mock.calls[0][0];
    expect(message.notification.body).toBe('Session became idle');
    expect(message.data).toEqual({ instanceId: 'instance', eventId: expect.any(String) });
    expect(JSON.stringify(message)).not.toContain('project-1');
    expect(f.service.resolveEvent(message.data.eventId)).toMatchObject({ sessionId: 'project-1', incarnationId: 'incarnation', kind: 'idle', status: 'active' });
    await f.service.tick(); expect(f.provider.send).toHaveBeenCalledTimes(1);
  });
  it.each([['complete', 'completed', 'Work completed'], ['needs_input', 'input_requested', 'Input requested']])('observes explicit %s transitions and suppresses redundant idle events', async (workflowStatus, kind, wording) => {
    const f = fixture(); f.set([observation('running', 'running')]); await f.service.tick();
    f.set([observation('idle', workflowStatus)]); await f.service.tick();
    const message = f.provider.send.mock.calls[0][0]; expect(message.notification.body).toBe(wording);
    expect(f.service.resolveEvent(message.data.eventId).kind).toBe(kind);
  });
  it('reports definite dead but never disappearance, unknown, stale or unreachable as completion', async () => {
    const f = fixture(); f.set([observation('running')]); await f.service.tick();
    f.set([observation('unknown')]); await f.service.tick();
    f.set([observation('idle')]); await f.service.tick();
    f.set([observation('running')]); await f.service.tick();
    f.set([observation('idle', 'complete', { reachable: false })]); await f.service.tick();
    f.set([]); await f.service.tick();
    expect(f.provider.send).not.toHaveBeenCalled();
    f.set([observation('running')]); await f.service.tick();
    f.advance(60000); f.set([observation('idle', 'complete')]); await f.service.tick();
    expect(f.provider.send).not.toHaveBeenCalled();
    f.set([observation('running', null, { observedAt: 160000 })]); await f.service.tick();
    f.set([observation('dead', null, { observedAt: 160000 })]); await f.service.tick();
    expect(f.provider.send.mock.calls[0][0].notification.body).toBe('Session ended');
  });
  it('does not emit a stale workflow completion alongside an unknown execution state', async () => {
    const f = fixture(); f.set([observation('running', 'running')]); await f.service.tick();
    f.set([observation('unknown', 'complete')]); await f.service.tick(); expect(f.provider.send).not.toHaveBeenCalled();
  });
  it('deduplicates after restart and never maps an old event to a reused session id', async () => {
    const f = fixture(); f.set([observation('running')]); await f.service.tick(); f.set([observation('idle')]); await f.service.tick();
    const id = f.provider.send.mock.calls[0][0].data.eventId;
    const restarted = fixture({ db: f.db }); restarted.set([observation('idle')]); await restarted.service.tick();
    expect(restarted.provider.send).not.toHaveBeenCalled();
    restarted.set([observation('running', null, { incarnationId: 'new-incarnation' })]); await restarted.service.tick();
    expect(restarted.service.resolveEvent(id)).toMatchObject({ incarnationId: 'incarnation', status: 'obsolete' });
  });
  it('suppresses pending events on resume or disappearance', async () => {
    const f = fixture(); f.provider.send.mockRejectedValue(new Error('outage')); f.set([observation('running')]); await f.service.tick();
    f.set([observation('idle')]); await f.service.tick(); expect(f.service.metrics().pending).toBe(1);
    f.set([observation('running')]); await f.service.tick(); expect(f.service.metrics().pending).toBe(0);
    f.set([observation('idle')]); await f.service.tick(); f.set([]); await f.service.tick(); expect(f.service.metrics().pending).toBe(0);
  });
  it('retries transient failures with expiry and resolves current rotated tokens', async () => {
    const f = fixture(); f.provider.send.mockRejectedValueOnce(new Error('outage')); const event = f.service.queueTest('phone');
    await f.service.tick(); expect(f.service.metrics().pending).toBe(1);
    await f.service.tick(); expect(f.provider.send).toHaveBeenCalledTimes(1);
    f.devices([{ installationId: 'phone', token: 'rotated', permission: 'granted', notificationsEnabled: true }]);
    f.advance(2000); await f.service.tick(); expect(f.provider.send.mock.calls[1][0].token).toBe('rotated');
    expect(f.service.resolveEvent(event.id).kind).toBe('test');
    f.service.queueTest('phone'); f.advance(900001); await f.service.tick(); expect(f.provider.send).toHaveBeenCalledTimes(2);
    expect(f.service.metrics().expired).toBe(1);
  });
  it('conditionally invalidates bad tokens and respects denied permission or unregistration', async () => {
    const f = fixture(); f.service.queueTest('phone'); f.provider.send.mockRejectedValue({ code: 'messaging/registration-token-not-registered' });
    await f.service.tick(); expect(f.invalidateToken).toHaveBeenCalledWith('phone', 'secret-token'); expect(f.service.metrics().failed).toBe(1);
    f.devices([{ installationId: 'phone', token: 'token', permission: 'denied', notificationsEnabled: false }]);
    expect(() => f.service.queueTest('phone')).toThrow(/permission/);
  });
  it('bounds pending outbox and coalesces concurrent monitor ticks', async () => {
    const f = fixture({ maxPending: 2 }); f.service.queueTest('phone'); f.service.queueTest('phone');
    expect(() => f.service.queueTest('phone')).toThrow(/capacity/);
    await Promise.all([f.service.tick(), f.service.tick()]); expect(f.provider.send).toHaveBeenCalledTimes(2);
  });
  it('drains existing deliveries even when a new transition exceeds queue capacity, then retries the transition', async () => {
    const f = fixture({ maxPending: 1 }); f.set([observation('running')]); await f.service.tick();
    f.service.queueTest('phone'); f.set([observation('idle')]);
    await expect(f.service.tick()).rejects.toThrow(/capacity/);
    expect(f.provider.send).toHaveBeenCalledTimes(1); expect(f.service.metrics().pending).toBe(0);
    await f.service.tick(); expect(f.provider.send).toHaveBeenCalledTimes(2); expect(f.provider.send.mock.calls[1][0].notification.body).toBe('Session became idle');
  });
  it('samples notification freshness after awaited observations complete', async () => {
    let clock = 1000; let executionStatus = 'running';
    const f = fixture({ now: () => clock, listObservations: async () => { clock += 100; return [observation(executionStatus, null, { observedAt: clock })]; } });
    await f.service.tick(); executionStatus = 'idle'; await f.service.tick();
    expect(f.provider.send).toHaveBeenCalledTimes(1); expect(f.provider.send.mock.calls[0][0].notification.body).toBe('Session became idle');
  });
  it('bounds completed delivery and event retention without removing pending work', async () => {
    const f = fixture({ maxRecords: 2 }); const oldest = f.service.queueTest('phone'); await f.service.tick();
    for (let i = 0; i < 4; i += 1) { f.advance(1); f.service.queueTest('phone'); await f.service.tick(); }
    expect(f.db.prepare('SELECT count(*) AS n FROM mobile_attention_events').get().n).toBeLessThanOrEqual(2);
    expect(f.db.prepare('SELECT count(*) AS n FROM mobile_attention_deliveries').get().n).toBeLessThanOrEqual(2);
    expect(f.service.resolveEvent(oldest.id)).toBeNull();
    f.provider.send.mockRejectedValue(new Error('outage')); const pending = f.service.queueTest('phone'); await f.service.tick();
    expect(f.service.resolveEvent(pending.id)).toMatchObject({ id: pending.id }); expect(f.service.metrics().pending).toBe(1);
  });
  it.each(['sessionId', 'incarnationId', 'executionStatus', 'workflowStatus', 'needsInput', 'observedAt', 'reachable'])('rejects missing observation %s at boundary', async field => {
    const f = fixture(); const record = observation('running'); delete record[field]; f.set([record]);
    await expect(f.service.tick()).rejects.toThrow(field);
  });
  it.each(['installationId', 'token', 'notificationsEnabled', 'permission'])('rejects missing device %s without exposing token data', async field => {
    const f = fixture(); const d = { installationId: 'phone', token: 'secret-token', notificationsEnabled: true, permission: 'granted' }; delete d[field]; f.devices([d]);
    await expect(f.service.tick()).rejects.toThrow(field);
    try { await f.service.tick(); } catch (error) { expect(error.message).not.toContain('secret-token'); }
  });
  it('expires queued work even when FCM is not configured', async () => {
    const f = fixture({ provider: null }); f.service.queueTest('phone'); await f.service.tick(); expect(f.service.metrics().pending).toBe(1);
    f.advance(900001); await f.service.tick(); expect(f.service.metrics().expired).toBe(1);
  });
  it('runs independently of frontends and continues after a monitor failure', async () => {
    vi.useFakeTimers(); const listObservations = vi.fn().mockRejectedValueOnce(new Error('private host details')).mockResolvedValue([]); const logger = { warn: vi.fn() };
    const f = fixture({ listObservations, logger }); f.service.start(); f.service.start(); await vi.advanceTimersByTimeAsync(5001);
    expect(logger.warn).toHaveBeenCalledWith('[mobile-notifications] monitor_failed');
    await vi.advanceTimersByTimeAsync(5000); expect(f.service.metrics().lastSuccessAt).toBe(100000);
    await f.service.stop(); await vi.advanceTimersByTimeAsync(10000); expect(listObservations).toHaveBeenCalledTimes(2);
  });
  it('rejects corrupt persisted event fields during hydration', async () => {
    const f = fixture(); const event = f.service.queueTest('phone');
    f.db.prepare('UPDATE mobile_attention_events SET value = ? WHERE id = ?').run(JSON.stringify({ ...event, createdAt: null }), event.id);
    expect(() => f.service.resolveEvent(event.id)).toThrow(/createdAt/);
  });
});

describe('FCM provider circuit', () => {
  it('opens on failure, closes after recovery, validates response, and never logs provider secrets', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new Error('secret details'));
    const logger = { info: vi.fn() };
    const provider = createFcmProvider({ messaging: { send }, logger, timeoutMs: 100, resetTimeoutMs: 1000 });
    const message = { token: 'private-token', notification: { title: 'CodeDeck', body: 'Input requested' }, data: { instanceId: 'instance', eventId: 'event' }, android: { ttl: 1000, notification: { tag: 'event' } } };
    await expect(provider.send(message)).rejects.toThrow('Notification provider unavailable');
    await expect(provider.send(message)).rejects.toThrow('Notification provider unavailable'); expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue('projects/test/messages/1'); await vi.advanceTimersByTimeAsync(1001);
    await expect(provider.send(message)).resolves.toBe('projects/test/messages/1'); expect(provider.state()).toBe('closed');
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('secret'); provider.shutdown();
  });
  it('does not open the provider circuit for a single invalid registration token', async () => {
    const send = vi.fn().mockRejectedValueOnce({ code: 'messaging/registration-token-not-registered' }).mockResolvedValue('projects/test/messages/1');
    const provider = createFcmProvider({ messaging: { send } });
    const message = { token: 't', notification: { title: 'CodeDeck', body: 'Work completed' }, data: { instanceId: 'i', eventId: 'e' }, android: { ttl: 1000, notification: { tag: 'e' } } };
    await expect(provider.send(message)).rejects.toMatchObject({ code: 'messaging/registration-token-not-registered' });
    expect(provider.state()).toBe('closed'); await expect(provider.send(message)).resolves.toBe('projects/test/messages/1'); provider.shutdown();
  });
  it('rejects malformed provider responses', async () => {
    const provider = createFcmProvider({ messaging: { send: async () => ({ secret: 'bad-response' }) } });
    await expect(provider.send({ token: 't', notification: { title: 'CodeDeck', body: 'Work completed' }, data: { instanceId: 'i', eventId: 'e' }, android: { ttl: 1000, notification: { tag: 'e' } } })).rejects.toThrow('Notification provider unavailable'); provider.shutdown();
  });
  it('times out stalled sends and rejects invalid provider response', async () => {
    vi.useFakeTimers(); const send = vi.fn(() => new Promise(() => {}));
    const provider = createFcmProvider({ messaging: { send }, timeoutMs: 100, resetTimeoutMs: 1000 });
    const pending = expect(provider.send({ token: 't', notification: { title: 'CodeDeck', body: 'Work completed' }, data: { instanceId: 'i', eventId: 'e' }, android: { ttl: 1000, notification: { tag: 'e' } } })).rejects.toThrow(/unavailable/);
    await vi.advanceTimersByTimeAsync(101); await pending; provider.shutdown();
  });
});
