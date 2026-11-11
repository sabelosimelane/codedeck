import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createMobileStore } from '../mobile-store.js';
const opened = [];
function setup() { const db = new Database(':memory:'); opened.push(db); return { db, store: createMobileStore(db) }; }
afterEach(() => opened.splice(0).forEach(db => db.close()));
const id = 'ab140f48-1848-4330-8723-940c478e7267';
const device = { token: 'test-token', notificationsEnabled: true, permission: 'granted' };
it('persists instance identity and incarnation across restart, retires reused IDs', () => {
  const { db, store } = setup();
  const incarnation = store.ensureIncarnation('Demo-1');
  const reopened = createMobileStore(db);
  expect(reopened.instanceId).toBe(store.instanceId);
  expect(reopened.ensureIncarnation('Demo-1')).toBe(incarnation);
  store.retireSession('Demo-1');
  expect(store.currentIncarnation('Demo-1')).toBeNull();
  expect(store.ensureIncarnation('Demo-1')).not.toBe(incarnation);
});
it('registers idempotently, rotates tokens and never invalidates a newer token', () => {
  const { store } = setup();
  store.registerDevice(id, device); store.registerDevice(id, device);
  expect(store.listDevices()).toHaveLength(1);
  store.registerDevice(id, { ...device, token: 'new-token' });
  store.invalidateToken(id, 'test-token');
  expect(store.listDevices()[0].token).toBe('new-token');
  store.invalidateToken(id, 'new-token');
  expect(store.listDevices()[0].token).toBeNull();
  store.unregisterDevice(id); store.unregisterDevice(id);
  expect(store.listDevices()).toEqual([]);
});
it.each([
  ['installationId', null, device], ['installationId', 'bad', device],
  ['token', id, { ...device, token: undefined }], ['token', id, { ...device, token: '' }],
  ['token', id, { ...device, token: 'x'.repeat(4097) }],
  ['notificationsEnabled', id, { ...device, notificationsEnabled: null }],
  ['permission', id, { ...device, permission: 'invalid' }], ['device', id, null],
  ['unknown', id, { ...device, extra: true }],
])('validates %s without disclosing token contents', (field, installationId, input) => {
  const { store } = setup();
  expect(() => store.registerDevice(installationId, input)).toThrow();
});
it('accepts explicit permission denial and nullable token', () => {
  const { store } = setup();
  store.registerDevice(id, { token: null, notificationsEnabled: false, permission: 'denied' });
  expect(store.listDevices()[0].permission).toBe('denied');
});
it('adopts the durable tmux incarnation and rotates a reused registry key', () => {
  const { store } = setup();
  const previous = store.ensureIncarnation('Demo-1');
  expect(store.adoptIncarnation('Demo-1', id)).toBe(id);
  expect(store.currentIncarnation('Demo-1')).toBe(id);
  expect(store.currentIncarnation('Demo-1')).not.toBe(previous);
  expect(() => store.adoptIncarnation('Demo-1', 'bad')).toThrow();
});
it('validates every device field on database hydration', () => {
  const { db, store } = setup();
  store.registerDevice(id, device);
  for (const [column, value] of [['installation_id', 'bad'], ['token', ''], ['notifications_enabled', 7], ['permission', 'bad'], ['updated_at', 'bad']]) {
    const original = db.prepare(`SELECT ${column} AS value FROM mobile_devices`).get().value;
    db.prepare(`UPDATE mobile_devices SET ${column}=?`).run(value);
    expect(() => store.listDevices()).toThrow();
    db.prepare(`UPDATE mobile_devices SET ${column}=?`).run(original);
  }
});
it.each([null, '', ' ', 3, 'x'.repeat(257)])('rejects invalid session identity %s', value => {
  expect(() => setup().store.ensureIncarnation(value)).toThrow();
});
