import { loopbackTestServer } from './helpers/loopback-test-server.js';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMobileRouter } from '../routes/mobile.js';
import { createMobileStore } from '../mobile-store.js';
import { createMobileNotifications } from '../mobile-notifications.js';
import { createPrivateAccess } from '../mobile-access.js';
const opened = [];
const installationId = 'ab140f48-1848-4330-8723-940c478e7267';
const BASE = '/api/mobile/v1';
const store2 = () => '8d7f3a7e-8a54-4d5b-9d5e-7f4b6a0c2e11';
const startedView = (projectId, n = 2) => ({ id: `${projectId}-${n}`, incarnationId: '8d7f3a7e-8a54-4d5b-9d5e-7f4b6a0c2e11', projectId, title: `${projectId}-${n}`, status: 'idle', live: true, cwd: '/a', host: 'local', runtimeType: 'tmux', finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: 1000 });
const body = { token: 'private-token', permission: 'granted', notificationsEnabled: true };
async function setup(overrides = {}) {
  const db = new Database(':memory:'); opened.push(db);
  const store = createMobileStore(db);
  const notifications = { queueTest: vi.fn(() => ({ eventId: installationId })), resolveEvent: vi.fn(() => null), metrics: () => ({ pending: 0, failed: 0, lastSuccessAt: null }) };
  const app = express();
  app.use(createMobileRouter({ store, notifications, notificationsReady: () => true, terminalMetrics: () => ({ attachments: 2, controlConflicts: 1 }),
    listProjects: () => [{ id: 'B', name: 'same', state: 'shelved', stateChangedAt: '2026-11-01T10:00:00.000Z' }, { id: 'A', name: 'same', state: 'active', stateChangedAt: null }],
    startSession: vi.fn(async projectId => startedView(projectId)),
    setSessionState: vi.fn((sessionId, patch) => ({ sessionId, finished: false, muted: patch.muted ?? false, waiting: patch.waiting ?? false, lastActivityAt: 1000 })),
    listSessions: () => [{ id: 'A-1', incarnationId: store.ensureIncarnation('A-1'), projectId: 'A', title: 'one', status: 'running', live: true, cwd: '/a', host: 'local', runtimeType: 'tmux', finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: 1000 }],
    ...overrides,
  }));
  return { app: await loopbackTestServer(app), routerApp: app, db, store, notifications };
}
afterEach(() => opened.splice(0).forEach(db => db.close()));
it('advertises protocol compatibility and instance identity', async () => {
  const { app, store } = await setup();
  const res = await request(app).get(`${BASE}/capabilities`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ instanceId: store.instanceId, protocolVersion: 2, notificationsReady: true });
  expect(res.body.diagnostics).toMatchObject({ terminals: { attachments: 2, controlConflicts: 1 }, notifications: { pending: 0, failed: 0, lastSuccessAt: null } });
});
it('refreshes runtime incarnations before resolving an old event after downtime', async () => {
  let currentStore;
  const { app, store, notifications } = await setup({ listSessions: async () => { currentStore.retireSession('A-1'); currentStore.ensureIncarnation('A-1'); return []; } });
  currentStore = store;
  const old = store.ensureIncarnation('A-1');
  notifications.resolveEvent.mockReturnValue({ id: installationId, sessionId: 'A-1', incarnationId: old, status: 'active' });
  expect((await request(app).get(`${BASE}/events/${installationId}`)).body.status).toBe('ended');
});
it('paginates projects with deterministic identity tiebreaker and allow-listed filters', async () => {
  const { app } = await setup();
  const first = await request(app).get(`${BASE}/projects?size=1&sort=name,asc`);
  const second = await request(app).get(`${BASE}/projects?size=1&page=1&sort=name,asc`);
  expect(first.body).toEqual({ data: [{ id: 'A', name: 'same', state: 'active', stateChangedAt: null }], page: { currentPage: 0, size: 1, totalElements: 2, totalPages: 2, hasNextPage: true } });
  expect(second.body.data[0].id).toBe('B');
  expect((await request(app).get(`${BASE}/projects?name=missing`)).body.data).toEqual([]);
});
it('filters sessions by project/status without changing legacy endpoints', async () => {
  const { app } = await setup();
  const res = await request(app).get(`${BASE}/sessions?projectId=A&status=running`);
  expect(res.status).toBe(200);
  expect(res.body.page.size).toBe(20);
  expect(res.body.data[0]).toMatchObject({ id: 'A-1', projectId: 'A', status: 'running', live: true });
  expect((await request(app).get(`${BASE}/sessions?projectId=B`)).body.data).toEqual([]);
  expect((await request(app).get(`${BASE}/sessions?id=A-1`)).body.data).toHaveLength(1);
  expect((await request(app).get(`${BASE}/sessions?id=B-1`)).body.data).toEqual([]);
});
it.each(['page=-1', 'page=', 'page=null', 'page=1.1', 'size=0', 'size=101', 'size=', 'size[]=2', 'sort=token,asc', 'sort=name,wrong', 'unknown=x', 'name=', 'name=null', 'name=%3Cscript%3E', 'name=%27%20OR%201%3D1', `name=${'x'.repeat(257)}`])('rejects invalid query %s with field details', async query => {
  const res = await request((await setup()).app).get(`${BASE}/projects?${query}`);
  expect(res.status).toBe(400);
  expect(res.headers['content-type']).toContain('application/problem+json');
  expect(res.body).toMatchObject({ status: 400, path: `${BASE}/projects`, traceId: expect.any(String), errors: expect.any(Array) });
});
it.each(['size=1', 'size=100', 'page=0', 'page=100000'])('accepts query boundary %s', async query => expect((await request((await setup()).app).get(`${BASE}/projects?${query}`)).status).toBe(200));
it('registers concurrently and rotates tokens without disclosing them', async () => {
  const { app, store } = await setup();
  const results = await Promise.all([1, 2].map(() => request(app).put(`${BASE}/devices/${installationId}`).send(body)));
  results.forEach(res => { expect(res.status).toBe(200); expect(JSON.stringify(res.body)).not.toContain('private-token'); });
  expect(store.listDevices()).toHaveLength(1);
  expect((await request(app).put(`${BASE}/devices/${installationId}`).send({ ...body, token: 'rotated' })).status).toBe(200);
  expect(store.listDevices()[0].token).toBe('rotated');
  expect((await request(app).delete(`${BASE}/devices/${installationId}`)).status).toBe(204);
  expect((await request(app).delete(`${BASE}/devices/${installationId}`)).status).toBe(204);
});
it.each([{}, [], { ...body, token: '' }, { ...body, token: null, permission: null }, { ...body, notificationsEnabled: 1 }, { ...body, extra: true }])('validates device fields %j', async input => {
  const res = await request((await setup()).app).put(`${BASE}/devices/${installationId}`).send(input);
  expect(res.status).toBe(400); expect(res.body.errors.length).toBeGreaterThan(0);
});
it('rejects malformed, null, oversized bodies and invalid installation identities', async () => {
  const { app } = await setup();
  for (const input of ['{', 'null']) {
    const res = await request(app).put(`${BASE}/devices/${installationId}`).set('Content-Type', 'application/json').send(input);
    expect(res.status).toBe(400); expect(res.body.errors).toBeDefined();
  }
  expect((await request(app).put(`${BASE}/devices/bad`).send(body)).status).toBe(400);
  expect((await request(app).put(`${BASE}/devices/${installationId}`).send({ ...body, token: 'x'.repeat(20000) })).status).toBe(413);
});
it('queues identifiable tests and privately resolves only a current session incarnation', async () => {
  const { app, store, notifications } = await setup();
  expect((await request(app).post(`${BASE}/devices/${installationId}/test-notification`)).status).toBe(404);
  store.registerDevice(installationId, body);
  expect((await request(app).post(`${BASE}/devices/${installationId}/test-notification`)).status).toBe(202);
  const incarnationId = store.ensureIncarnation('A-1');
  notifications.resolveEvent.mockReturnValue({ id: installationId, sessionId: 'A-1', incarnationId, status: 'active' });
  const resolved = await request(app).get(`${BASE}/events/${installationId}`);
  expect(resolved.status, resolved.text).toBe(200);
  expect(resolved.body.status).toBe('active');
  store.retireSession('A-1'); store.ensureIncarnation('A-1');
  expect((await request(app).get(`${BASE}/events/${installationId}`)).body.status).toBe('ended');
});
it('returns problem details for missing events and routes', async () => {
  for (const path of [`events/${installationId}`, 'missing']) {
    const res = await request((await setup()).app).get(`${BASE}/${path}`);
    expect(res.status).toBe(404); expect(res.body.traceId).toBeTruthy();
  }
});
it('rejects denied notifications and unavailable provider without enqueueing', async () => {
  const denied = await setup(); denied.store.registerDevice(installationId, { token: null, notificationsEnabled: false, permission: 'denied' });
  const deniedResult = await request(denied.app).post(`${BASE}/devices/${installationId}/test-notification`);
  expect(deniedResult.status).toBe(409); expect(deniedResult.body.traceId).toBeTruthy(); expect(denied.notifications.queueTest).not.toHaveBeenCalled();
  const unconfigured = await setup({ notificationsReady: () => false }); unconfigured.store.registerDevice(installationId, body);
  const unavailable = await request(unconfigured.app).post(`${BASE}/devices/${installationId}/test-notification`);
  expect(unavailable.status).toBe(503); expect(unavailable.body.traceId).toBeTruthy(); expect(unconfigured.notifications.queueTest).not.toHaveBeenCalled();
});
it.each([1, 4096])('accepts token boundary length %i and hides token on output', async length => {
  const { app } = await setup(); const token = 'z'.repeat(length);
  const res = await request(app).put(`${BASE}/devices/${installationId}`).send({ ...body, token });
  expect(res.status).toBe(200); expect(res.body).not.toHaveProperty('token');
});
it('rejects oversized token below JSON body limit and reports all bad fields together', async () => {
  const { app } = await setup();
  const res = await request(app).put(`${BASE}/devices/${installationId}`).send({ token: 'x'.repeat(4097), notificationsEnabled: null, permission: 'invalid' });
  expect(res.status).toBe(400); expect(res.body.errors.map(e => e.field)).toEqual(expect.arrayContaining(['token', 'notificationsEnabled', 'permission']));
});
it.each(['status=complete', 'status[]=running', 'projectId=', 'id=%3Cscript%3E', 'sort=host,asc', 'page=100001', 'page=0&page=1'])('rejects malformed session query %s', async query => {
  const res = await request((await setup()).app).get(`${BASE}/sessions?${query}`);
  expect(res.status).toBe(400); expect(res.body.errors.length).toBeGreaterThan(0);
});
it('rejects invalid delete/test/event identities without invoking notification service', async () => {
  const { app, notifications } = await setup();
  for (const operation of [request(app).delete(`${BASE}/devices/not-a-uuid`), request(app).post(`${BASE}/devices/not-a-uuid/test-notification`), request(app).get(`${BASE}/events/not-a-uuid`)]) {
    const res = await operation; expect(res.status).toBe(400); expect(res.body.errors.length).toBeGreaterThan(0);
  }
  expect(notifications.queueTest).not.toHaveBeenCalled(); expect(notifications.resolveEvent).not.toHaveBeenCalled();
});
it('fails loudly on corrupted persisted notification event without returning internal contents', async () => {
  const { db, store } = await setup(); store.registerDevice(installationId, body);
  const notifications = createMobileNotifications({ db, instanceId: store.instanceId, listDevices: store.listDevices, invalidateToken: store.invalidateToken, listObservations: async () => [], isDesktopActive: () => false, provider: null });
  const event = notifications.queueTest(installationId);
  db.prepare('UPDATE mobile_attention_events SET value = ? WHERE id = ?').run(JSON.stringify({ ...event, createdAt: 'private-invalid-value' }), event.id);
  const app = express(); app.use(createMobileRouter({ store, notifications, notificationsReady: () => false, listProjects: () => [], listSessions: () => [], startSession: vi.fn(), setSessionState: vi.fn(), terminalMetrics: () => ({ attachments: 0, controlConflicts: 0 }) }));
  const res = await request(await loopbackTestServer(app)).get(`${BASE}/events/${event.id}`);
  expect(res.status).toBe(500); expect(res.body.traceId).toBeTruthy(); expect(JSON.stringify(res.body)).not.toContain('private-invalid-value');
});
it('allows independent simultaneous test requests with distinct persistent event identities', async () => {
  const { db, store } = await setup(); store.registerDevice(installationId, body);
  const notifications = createMobileNotifications({ db, instanceId: store.instanceId, listDevices: store.listDevices, invalidateToken: store.invalidateToken, listObservations: async () => [], isDesktopActive: () => false, provider: null });
  const app = express(); app.use(createMobileRouter({ store, notifications, notificationsReady: () => true, listProjects: () => [], listSessions: () => [], startSession: vi.fn(), setSessionState: vi.fn(), terminalMetrics: () => ({ attachments: 0, controlConflicts: 0 }) }));
  const server = await loopbackTestServer(app);
  const responses = await Promise.all([1, 2].map(() => request(server).post(`${BASE}/devices/${installationId}/test-notification`)));
  expect(responses.map(r => r.status)).toEqual([202, 202]); expect(new Set(responses.map(r => r.body.id)).size).toBe(2); expect(notifications.metrics().pending).toBe(2);
});
it('protects the HTTP router using the same owner/origin policy as upgrades', async () => {
  const access = createPrivateAccess({ owner: 'owner@example.test', serveOrigin: 'https://deck.tail.test' }); const { routerApp } = await setup();
  const app = express(); app.use(access.middleware); app.use(routerApp);
  const server = await loopbackTestServer(app);
  const validHeaders = { Host: 'deck.tail.test', Origin: 'https://localhost', 'Tailscale-User-Login': 'owner@example.test' };
  expect((await request(server).get(`${BASE}/capabilities`).set(validHeaders)).status).toBe(200);
  for (const overrides of [{ Origin: 'https://attacker.test' }, { 'Tailscale-User-Login': 'attacker@example.test' }, { Host: 'attacker.test' }]) {
    const headers = { ...validHeaders, ...overrides }; const res = await request(server).get(`${BASE}/capabilities`).set(headers);
    expect(res.status).toBe(403); expect(res.body.traceId).toBeTruthy();
    expect(access.authorize({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), socket: { remoteAddress: '127.0.0.1' } }, { upgrade: true })).toMatchObject({ status: 403 });
  }
});

describe('POST /projects/:projectId/sessions', () => {
  const start = (app, projectId, payload) => {
    const req = request(app).post(`${BASE}/projects/${projectId}/sessions`);
    return payload === undefined ? req : req.set('Content-Type', 'application/json').send(payload);
  };
  it('starts a session in the project and returns it with its location', async () => {
    const { app } = await setup();
    const res = await start(app, 'A', {});
    expect(res.status).toBe(201);
    expect(res.body).toEqual(startedView('A'));
    expect(res.headers.location).toBe(`${BASE}/sessions?id=A-2`);
  });
  it('accepts a request with no body and project names with spaces and unicode', async () => {
    const startSession = vi.fn(async projectId => startedView(projectId));
    const { app } = await setup({ startSession });
    expect((await start(app, encodeURIComponent('Customer Platform - Local'))).status).toBe(201);
    expect((await start(app, encodeURIComponent('Ündërwëar'))).status).toBe(201);
    expect(startSession.mock.calls.map(([id]) => id)).toEqual(['Customer Platform - Local', 'Ündërwëar']);
  });
  it('reports an unknown project as a 404 problem with a trace id', async () => {
    const { MobileError } = await import('../mobile-store.js');
    const { app } = await setup({ startSession: vi.fn(async () => { throw new MobileError('Project not found', 404); }) });
    const res = await start(app, 'missing', {});
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, message: 'Project not found', path: `${BASE}/projects/missing/sessions` });
    expect(res.body.traceId).toBe(res.headers['x-trace-id']);
    expect(res.body.timestamp).toEqual(expect.any(String));
  });
  it.each(['%3Cscript%3E', '%27%20OR%201%3D1', '%00', 'null', '%20', 'x'.repeat(257)])('rejects project id %s before starting anything', async projectId => {
    const startSession = vi.fn();
    const { app } = await setup({ startSession });
    const res = await start(app, projectId, {});
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual([{ field: 'projectId', message: expect.any(String) }]);
    expect(startSession).not.toHaveBeenCalled();
  });
  it('accepts a project id of exactly 256 characters', async () => {
    const startSession = vi.fn(async projectId => startedView(projectId));
    const { app } = await setup({ startSession });
    expect((await start(app, 'x'.repeat(256), {})).status).toBe(201);
  });
  it.each([
    ['an unknown field', { projectName: 'A' }, 'projectName'],
    ['an array body', [], 'body'],
    ['a null body', 'null', 'body'],
    ['a string body', '"A"', 'body'],
  ])('rejects %s with field-level errors', async (_label, payload, field) => {
    const startSession = vi.fn();
    const { app } = await setup({ startSession });
    const res = await start(app, 'A', payload);
    expect(res.status).toBe(400);
    expect(res.body.errors.map(error => error.field)).toContain(field);
    expect(startSession).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON and oversized bodies without starting a session', async () => {
    const startSession = vi.fn();
    const { app } = await setup({ startSession });
    expect((await start(app, 'A', '{"broken"')).status).toBe(400);
    expect((await start(app, 'A', { note: 'x'.repeat(13000) })).status).toBe(413);
    expect(startSession).not.toHaveBeenCalled();
  });
  it('gives each of two rapid identical requests its own session', async () => {
    let n = 1;
    const { app } = await setup({ startSession: vi.fn(async projectId => startedView(projectId, ++n)) });
    const [first, second] = await Promise.all([start(app, 'A', {}), start(app, 'A', {})]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(new Set([first.body.id, second.body.id]).size).toBe(2);
  });
  it('passes through an unreachable host as 503 and hides internal failures', async () => {
    const { MobileError } = await import('../mobile-store.js');
    const unreachable = await setup({ startSession: vi.fn(async () => { throw new MobileError('Host media-server is unreachable', 503); }) });
    expect((await start(unreachable.app, 'A', {})).body).toMatchObject({ status: 503, message: 'Host media-server is unreachable' });
    const broken = await setup({ startSession: vi.fn(async () => { throw new Error('ENOENT /Users/secret/path'); }) });
    const res = await start(broken.app, 'A', {});
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/Users/secret');
  });
  it('validates the started session before returning it', async () => {
    const { app } = await setup({ startSession: vi.fn(async () => ({ ...startedView('A'), incarnationId: 'not-a-uuid' })) });
    expect((await start(app, 'A', {})).status).not.toBe(201);
  });
});

describe('project state', () => {
  it('advertises session start and project state support', async () => {
    const { app } = await setup();
    expect((await request(app).get(`${BASE}/capabilities`)).body.capabilities).toEqual(expect.arrayContaining(['session-start', 'project-state']));
  });
  it('filters projects by state, including shelved ones', async () => {
    const { app } = await setup();
    const res = await request(app).get(`${BASE}/projects?state=shelved`);
    expect(res.body.data).toEqual([{ id: 'B', name: 'same', state: 'shelved', stateChangedAt: '2026-11-01T10:00:00.000Z' }]);
    expect((await request(app).get(`${BASE}/projects?state=archived`)).status).toBe(400);
  });
  it.each([
    [{ id: 'A', name: 'A', state: 'archived', stateChangedAt: null }],
    [{ id: 'A', name: 'A', state: 'shelved', stateChangedAt: 'yesterday' }],
    [{ id: 'A', name: 'A', state: 'active' }],
  ])('refuses to publish an invalid stored project %#', async row => {
    const { app } = await setup({ listProjects: () => [row] });
    expect((await request(app).get(`${BASE}/projects`)).status).not.toBe(200);
  });
});

describe('session attention state', () => {
  const put = (app, id, body) => request(app).put(`${BASE}/sessions/${encodeURIComponent(id)}/state`).set('Content-Type', 'application/json').send(body);
  it('advertises shared session state support', async () => {
    const { app } = await setup();
    expect((await request(app).get(`${BASE}/capabilities`)).body.capabilities).toContain('session-state');
  });
  it('lists each session with its finished, muted, waiting, needs-input and activity fields', async () => {
    const { app } = await setup();
    expect((await request(app).get(`${BASE}/sessions`)).body.data[0]).toMatchObject({ id: 'A-1', finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: 1000 });
  });
  it.each([['finished', 'yes'], ['muted', undefined], ['waiting', 1], ['needsInput', null], ['lastActivityAt', -1], ['lastActivityAt', '5'], ['lastActivityAt', undefined]])('refuses to publish a session whose %s is %j', async (field, value) => {
    const { app, store } = await setup({ listSessions: () => [{ id: 'A-1', incarnationId: store2(), projectId: 'A', title: 'one', status: 'running', live: true, cwd: '/a', host: 'local', runtimeType: 'tmux', finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: 1000, [field]: value }] });
    expect((await request(app).get(`${BASE}/sessions`)).status).not.toBe(200);
  });
  it('sorts sessions by last activity', async () => {
    const row = (id, lastActivityAt) => ({ id, incarnationId: store2(), projectId: 'A', title: id, status: 'idle', live: true, cwd: '/a', host: 'local', runtimeType: 'tmux', finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt });
    const { app } = await setup({ listSessions: () => [row('A-1', 5), row('A-2', 900), row('A-3', 20)] });
    expect((await request(app).get(`${BASE}/sessions?sort=lastActivityAt,desc`)).body.data.map(item => item.id)).toEqual(['A-2', 'A-3', 'A-1']);
  });
  it('accepts an unknown activity time and sorts it after every known one', async () => {
    const row = (id, lastActivityAt) => ({ id, incarnationId: store2(), projectId: 'A', title: id, status: 'unknown', live: false, cwd: null, host: 'remote', runtimeType: 'tmux', finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt });
    const { app } = await setup({ listSessions: () => [row('A-1', null), row('A-2', 900), row('A-3', 20)] });
    const res = await request(app).get(`${BASE}/sessions?sort=lastActivityAt,desc`);
    expect(res.status).toBe(200);
    expect(res.body.data.map(item => item.id)).toEqual(['A-2', 'A-3', 'A-1']);
  });
  it('changes waiting and muted through the shared service and returns the new state', async () => {
    const setSessionState = vi.fn((sessionId, patch) => ({ sessionId, finished: false, muted: true, waiting: true, lastActivityAt: 7 }));
    const { app } = await setup({ setSessionState });
    const res = await put(app, 'Equinox Local-15', { waiting: true, muted: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 'Equinox Local-15', finished: false, muted: true, waiting: true, lastActivityAt: 7 });
    expect(setSessionState).toHaveBeenCalledWith('Equinox Local-15', { waiting: true, muted: true });
  });
  it('relays validation, missing-session and not-ready outcomes as problems', async () => {
    const { SessionStateError } = await import('../session-state-service.js');
    const failing = error => setup({ setSessionState: vi.fn(() => { throw error; }) });
    const invalid = await put((await failing(new SessionStateError('One or more fields failed validation.', 400, [{ field: 'muted', message: 'Use true or false' }]))).app, 'A-1', { muted: 'x' });
    expect(invalid.status).toBe(400); expect(invalid.body.errors).toEqual([{ field: 'muted', message: 'Use true or false' }]); expect(invalid.body.traceId).toBe(invalid.headers['x-trace-id']);
    expect((await put((await failing(new SessionStateError('Terminal session not found', 404))).app, 'A-9', { muted: true })).status).toBe(404);
    expect((await put((await failing(new SessionStateError('Not observed', 409))).app, 'A-1', { muted: true })).status).toBe(409);
  });
  it.each([['{"muted"', 400], ['null', 400], [JSON.stringify({ note: 'x'.repeat(13000) }), 413]])('rejects body %s with %i before reaching the service', async (body, status) => {
    const setSessionState = vi.fn();
    const { app } = await setup({ setSessionState });
    expect((await put(app, 'A-1', body)).status).toBe(status);
    expect(setSessionState).not.toHaveBeenCalled();
  });
  it('validates the state it returns', async () => {
    const { app } = await setup({ setSessionState: vi.fn(() => ({ sessionId: 'A-1', finished: 'no', muted: false, waiting: false, lastActivityAt: 1 })) });
    expect((await put(app, 'A-1', { muted: true })).status).not.toBe(200);
  });
});
