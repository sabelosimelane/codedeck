import { loopbackTestServer } from './helpers/loopback-test-server.js';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionAttention } from '../session-attention.js';
import { createTerminalWaitingStore } from '../terminal-waiting-store.js';
import { createSessionStateService } from '../session-state-service.js';
import { createSessionAttentionRouter } from '../routes/session-attention.js';

const opened = [];
const BASE = '/api/session-attention';
function setup({ exists = id => id.startsWith('p-') } = {}) {
  const db = new Database(':memory:'); opened.push(db);
  const waitingStore = createTerminalWaitingStore(db);
  const attention = createSessionAttention({ db, now: () => 1_000_000, onLanded: id => waitingStore.clear(id) });
  const service = createSessionStateService({ attention, waitingStore, sessionExists: exists, now: () => Date.parse('2026-11-10T17:00:00.000Z') });
  return { attention, waitingStore, service };
}
const observed = (attention, id = 'p-1') => { attention.observe({ sessionId: id, status: 'running', activityHint: 10 }); attention.observe({ sessionId: id, status: 'idle', activityHint: 10 }); };
afterEach(() => opened.splice(0).forEach(db => db.close()));

describe('session state service', () => {
  it('describes finished, muted, waiting and last activity together', () => {
    const { attention, waitingStore, service } = setup();
    observed(attention); waitingStore.mark('p-1', '2026-11-10T16:00:00.000Z');
    expect(service.describe('p-1')).toEqual({ sessionId: 'p-1', finished: true, muted: false, waiting: true, lastActivityAt: 1_000_000 });
  });
  it('describes a session nothing has observed yet without inventing activity', () => {
    const { service } = setup();
    expect(service.describe('p-7')).toEqual({ sessionId: 'p-7', finished: false, muted: false, waiting: false, lastActivityAt: null });
  });
  it('applies waiting, muted and acknowledged in one change', () => {
    const { attention, service } = setup();
    observed(attention);
    expect(service.apply('p-1', { waiting: true, muted: true, acknowledged: true })).toMatchObject({ waiting: true, muted: true, finished: false });
    expect(service.apply('p-1', { waiting: false, muted: false })).toMatchObject({ waiting: false, muted: false });
  });
  it('is idempotent when the same change is applied twice', () => {
    const { attention, service, waitingStore } = setup();
    observed(attention);
    const first = service.apply('p-1', { waiting: true });
    expect(service.apply('p-1', { waiting: true })).toEqual(first);
    expect(waitingStore.list()).toHaveLength(1);
  });
  it('clears the waiting mark by itself when the parked work lands', () => {
    const { attention, service } = setup();
    attention.observe({ sessionId: 'p-1', status: 'running', activityHint: 10 });
    service.apply('p-1', { waiting: true });
    attention.observe({ sessionId: 'p-1', status: 'idle', activityHint: 10 });
    expect(service.describe('p-1')).toMatchObject({ waiting: false, finished: true });
  });
  it.each([
    [null, 'body'], [[], 'body'], ['x', 'body'], [{}, 'body'],
    [{ waiting: 'yes' }, 'waiting'], [{ muted: 1 }, 'muted'], [{ acknowledged: false }, 'acknowledged'], [{ acknowledged: null }, 'acknowledged'],
    [{ waiting: true, color: 'red' }, 'color'],
  ])('rejects patch %j naming %s', (patch, field) => {
    const { attention, service } = setup();
    observed(attention);
    try { service.apply('p-1', patch); throw new Error('accepted'); } catch (error) {
      expect(error.status).toBe(400); expect(error.errors.map(item => item.field)).toContain(field);
    }
  });
  it('reports every invalid field at once', () => {
    const { attention, service } = setup(); observed(attention);
    try { service.apply('p-1', { waiting: 'a', muted: 'b', extra: 1 }); throw new Error('accepted'); } catch (error) {
      expect(error.errors.map(item => item.field).sort()).toEqual(['extra', 'muted', 'waiting']);
    }
  });
  it('reports unknown sessions as 404 and unobserved ones as a retryable 409', () => {
    const { service } = setup();
    expect(() => service.apply('q-1', { muted: true })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => service.apply('p-7', { muted: true })).toThrow(expect.objectContaining({ status: 409 }));
    expect(service.apply('p-7', { waiting: true }).waiting).toBe(true);
  });
  it.each(['attention', 'waitingStore', 'sessionExists', 'now'])('requires %s', field => {
    const { attention, waitingStore } = setup();
    const deps = { attention, waitingStore, sessionExists: () => true, now: () => 1 };
    expect(() => createSessionStateService({ ...deps, [field]: undefined })).toThrow(new RegExp(field));
  });
});

describe('PUT /api/session-attention/:sessionId', () => {
  async function api(options) {
    const context = setup(options);
    const app = express(); app.use(createSessionAttentionRouter({ service: context.service }));
    return { ...context, app: await loopbackTestServer(app) };
  }
  const put = (app, id, body) => request(app).put(`${BASE}/${encodeURIComponent(id)}`).set('Content-Type', 'application/json').send(body);
  it('mutes and acknowledges, returning the full state', async () => {
    const { app, attention } = await api(); observed(attention);
    const res = await put(app, 'p-1', { muted: true, acknowledged: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: 'p-1', finished: false, muted: true, waiting: false, lastActivityAt: 1_000_000 });
  });
  it('accepts session ids with spaces', async () => {
    const { app, attention } = await api({ exists: () => true }); observed(attention, 'Equinox Local-15');
    expect((await put(app, 'Equinox Local-15', { muted: true })).body.sessionId).toBe('Equinox Local-15');
  });
  it('returns the same result when the same request is sent twice', async () => {
    const { app, attention } = await api(); observed(attention);
    const [first, second] = [await put(app, 'p-1', { muted: true }), await put(app, 'p-1', { muted: true })];
    expect(second.body).toEqual(first.body);
  });
  it('answers validation failures with a problem listing each field and a trace id', async () => {
    const { app, attention } = await api(); observed(attention);
    const res = await put(app, 'p-1', { muted: 'yes', bogus: 1 });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.errors.map(item => item.field).sort()).toEqual(['bogus', 'muted']);
    expect(res.body.traceId).toBe(res.headers['x-trace-id']);
    expect(res.body).toMatchObject({ status: 400, path: `${BASE}/p-1` });
  });
  it.each([['{"muted"', 400], ['null', 400], ['[]', 400], ['""', 400], [JSON.stringify({ note: 'x'.repeat(5000) }), 413]])('rejects body %s with %i', async (body, status) => {
    const { app, attention } = await api(); observed(attention);
    expect((await put(app, 'p-1', body)).status).toBe(status);
  });
  it('returns 404 for an unknown session and for unknown paths, and hides internal errors', async () => {
    const { app } = await api();
    expect((await put(app, 'q-1', { muted: true })).status).toBe(404);
    expect((await request(app).get(`${BASE}/p-1`)).status).toBe(404);
    const broken = express(); broken.use(createSessionAttentionRouter({ service: { apply() { throw new Error('ENOENT /Users/secret'); } } }));
    const res = await put(await loopbackTestServer(broken), 'p-1', { muted: true });
    expect(res.status).toBe(500); expect(JSON.stringify(res.body)).not.toContain('secret');
  });
  it.each(['%00', '%20', 'x'.repeat(257)])('rejects session id %s', async id => {
    const { app } = await api({ exists: () => true });
    const res = await request(app).put(`${BASE}/${id}`).send({ muted: true });
    expect(res.status).toBe(400); expect(res.body.errors[0].field).toBe('sessionId');
  });
});

describe('annotating desktop status rows', () => {
  const row = extra => ({ sessionId: 'p-1', alive: true, executionStatus: 'idle', startedAt: '2026-11-10T10:00:00.000Z', lastOutputAt: null, lastSubstantialOutputAt: null, ...extra });
  it('records each reading and adds finished, statusMuted and waiting', () => {
    const { service, attention } = setup();
    service.annotate(row({ executionStatus: 'running' }));
    const idle = service.annotate(row());
    expect(idle).toMatchObject({ sessionId: 'p-1', executionStatus: 'idle', finished: true, statusMuted: false, waiting: false });
    attention.setMuted('p-1', true); service.apply('p-1', { waiting: true });
    expect(service.annotate(row())).toMatchObject({ statusMuted: true, waiting: true });
  });
  it('seeds a first sighting from the latest of its own timestamps', () => {
    const { service, attention } = setup();
    service.annotate(row({ lastSubstantialOutputAt: '2026-11-10T12:00:00.000Z' }));
    expect(attention.state('p-1').lastActivityAt).toBe(Date.parse('2026-11-10T12:00:00.000Z'));
  });
  it('treats an unreachable host as unknown and a dead pane as dead', () => {
    const { service, attention } = setup();
    service.annotate(row({ executionStatus: 'running' }));
    service.annotate(row({ executionStatus: 'running', reachability: 'unreachable' }));
    expect(attention.state('p-1').finished).toBe(true);
    service.annotate(row({ alive: false }));
    expect(attention.state('p-1').finished).toBe(false);
  });
  it('does not start tracking a session whose first reading has no usable time', () => {
    const { service, attention } = setup();
    expect(service.annotate(row({ startedAt: null }))).toMatchObject({ finished: false, statusMuted: false, waiting: false });
    expect(attention.knows('p-1')).toBe(false);
  });
  it('rejects a row without a session id or with an unclassifiable status', () => {
    const { service } = setup();
    expect(() => service.annotate(row({ sessionId: '' }))).toThrow();
    expect(() => service.annotate(row({ executionStatus: 'busy' }))).toThrow(/executionStatus/);
  });
});
