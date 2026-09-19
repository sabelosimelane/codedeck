import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNamingStore } from '../session-naming-store.js';
import { createNamingService } from '../session-naming-service.js';
import { createNamingRouter } from '../routes/session-naming.js';
import { createConduitNamingClient } from '../conduit-naming-client.js';
import { createNamingCredentialStore } from '../session-naming-credentials.js';

const settings = { baseUrl: 'http://localhost:3100', provider: 'test', model: 'small', effort: null };
const providers = [{ id: 'test', enabled: true, available: true, defaultModel: 'small', models: ['small', 'large'], effort: ['low'], capabilities: {}, toolPolicies: [] }];
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });
function setup() {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  const directory = mkdtempSync(path.join(tmpdir(), 'codedeck-naming-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = createNamingCredentialStore(path.join(directory, 'credential'));
  const store = createNamingStore(db);
  const conduit = { catalog: vi.fn(async () => providers), metrics: () => ({}) };
  const service = createNamingService({ store, generate: async () => 'Fix login redirects', capture: async () => 'fix login' });
  const app = express();
  app.use(createNamingRouter({ store, service, credentials, conduit, sessionExists: id => /^Demo-\d+$/.test(id) }));
  return { app, store, credentials, conduit, service, directory, db };
}

describe('naming APIs', () => {
  it('tests an unsaved connection, saves settings and keeps credentials out of responses and generic config', async () => {
    const { app, credentials, db } = setup();
    const test = await request(app).post('/api/session-naming/connection-test').send({ baseUrl: settings.baseUrl, credential: 'secret-value' });
    expect(test.status).toBe(200); expect(credentials.read()).toBeNull();
    const saved = await request(app).put('/api/session-naming/settings').send({ ...settings, credential: 'secret-value' });
    expect(saved.status).toBe(200); expect(saved.body).toMatchObject({ ...settings, hasCredential: true });
    expect(JSON.stringify(saved.body)).not.toContain('secret-value');
    expect(credentials.read()).toBe('secret-value');
    expect(db.prepare('SELECT value FROM session_naming_settings').get().value).not.toContain('secret-value');
    expect((await request(app).get('/api/session-naming/settings')).body).toEqual(saved.body);
  });
  it('returns field errors for bad settings, invalid selection and malformed JSON', async () => {
    const { app } = setup();
    const invalid = await request(app).put('/api/session-naming/settings').send({ baseUrl: 'file:///tmp' });
    expect(invalid.status).toBe(400); expect(invalid.body.errors.length).toBeGreaterThanOrEqual(4);
    expect(invalid.body).toMatchObject({ status: 400, traceId: expect.any(String), path: '/api/session-naming/settings', type: expect.any(String) });
    const badModel = await request(app).put('/api/session-naming/settings').send({ ...settings, model: 'absent', credential: 'key' });
    expect(badModel.status).toBe(400);
    const malformed = await request(app).put('/api/session-naming/settings').set('Content-Type', 'application/json').send('{');
    expect(malformed.status).toBe(400); expect(malformed.body.errors).toBeInstanceOf(Array);
  });
  it('paginates and filters a stable catalog and clears model selections only explicitly', async () => {
    const { app, conduit } = setup();
    await request(app).put('/api/session-naming/settings').send({ ...settings, credential: 'key' });
    conduit.catalog.mockResolvedValue([...providers, { ...providers[0], id: 'alpha' }]);
    const first = await request(app).get('/api/session-naming/catalog?size=1&sort=id,asc');
    const second = await request(app).get('/api/session-naming/catalog?size=1&page=1&sort=id,asc');
    expect(first.body.data.map(p => p.id)).toEqual(['alpha']);
    expect(first.body.page).toEqual({ currentPage: 0, size: 1, totalElements: 2, totalPages: 2, hasNextPage: true });
    expect(second.body.data.map(p => p.id)).toEqual(['test']);
    expect((await request(app).get('/api/session-naming/catalog?id=test')).body.data).toHaveLength(1);
    expect((await request(app).get('/api/session-naming/catalog?size=101')).status).toBe(400);
    expect((await request(app).get('/api/session-naming/catalog?sort=secret,asc')).status).toBe(400);
  });
  it('persists manual titles, validates boundaries, and returns a paginated list', async () => {
    const { app } = setup();
    for (const title of ['', null, 'x'.repeat(61), 'a\nb']) {
      expect((await request(app).put('/api/session-naming/titles/Demo-1').send({ title })).status).toBe(400);
    }
    for (const title of ['x', 'x'.repeat(60), '<script>alert(1)</script>']) {
      expect((await request(app).put('/api/session-naming/titles/Demo-1').send({ title })).status).toBe(200);
    }
    const repeated = await request(app).put('/api/session-naming/titles/Demo-1').send({ title: 'Fix login' });
    expect(repeated.body).toMatchObject({ state: 'manual', title: 'Fix login' });
    const list = await request(app).get('/api/session-naming/titles?sessionId=Demo-1');
    expect(list.body.data).toHaveLength(1); expect(list.body.page.totalElements).toBe(1);
    expect((await request(app).put('/api/session-naming/titles/missing').send({ title: 'test' })).status).toBe(404);
  });
  it('returns 202 for retry without waiting for a result', async () => {
    const { app, store, service } = setup(); store.saveSettings(settings);
    store.ensure('Demo-1'); store.update('Demo-1', { state: 'failed', error: 'failed' });
    expect((await request(app).post('/api/session-naming/titles/Demo-1/retry').send({})).status).toBe(202);
    await service.waitForIdle(); expect(store.get('Demo-1').state).toBe('named');
  });
  it('stores credentials in a private file and supports removal', async () => {
    const { credentials, directory } = setup(); credentials.write('private-key');
    expect(statSync(path.join(directory, 'credential')).mode & 0o777).toBe(0o600);
    credentials.write(null); expect(credentials.read()).toBeNull();
  });
});

describe('Conduit naming transport', () => {
  it('uses exact provider/model/effort and accepts a validated response', async () => {
    const fetch = vi.fn(async url => new Response(JSON.stringify(url.endsWith('/providers') ? { defaultProvider: 'test', providers } : { status: 'success', provider: 'test', model: 'small', response: '{"title":"Fix login redirects"}' })));
    const client = createConduitNamingClient({ fetch, readCredential: () => 'private-key' }); cleanup.push(() => client.close());
    expect(await client.generate({ ...settings, effort: 'low' }, 'terminal text')).toBe('Fix login redirects');
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body).toMatchObject({ provider: 'test', model: 'small', effort: 'low', sync: true });
    expect(body).not.toHaveProperty('projectPath'); expect(body).not.toHaveProperty('sessionId');
    expect(body.message).toContain('terminal text');
    expect(fetch.mock.calls[1][1].headers['X-Conduit-Key']).toBe('private-key');
  });
  it('reports a safe actionable reason when the configured provider is degraded', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'PROVIDER_DEGRADED_NO_FALLBACK', error: 'secret upstream content' }), { status: 503 }));
    const client = createConduitNamingClient({ fetch, readCredential: () => 'key' }); cleanup.push(() => client.close());
    await expect(client.catalog(settings.baseUrl)).rejects.toThrow('configured provider is degraded');
  });
  it('opens its breaker on timeout and closes after recovery', async () => {
    let slow = true;
    const fetch = vi.fn(async (_url, options) => {
      if (slow) return await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return new Response(JSON.stringify({ defaultProvider: 'test', providers }));
    });
    const client = createConduitNamingClient({ fetch, readCredential: () => 'key', catalogTimeoutMs: 15, resetTimeout: 30, volumeThreshold: 1 }); cleanup.push(() => client.close());
    await expect(client.catalog(settings.baseUrl)).rejects.toMatchObject({ status: 503 });
    const calls = fetch.mock.calls.length;
    await expect(client.catalog(settings.baseUrl)).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(calls);
    slow = false;
    await vi.waitFor(async () => expect(await client.catalog(settings.baseUrl)).toHaveLength(1), { interval: 40 });
    expect(client.metrics().catalog.state).toBe('closed');
  });
  it.each([{ provider: 'other', model: 'small' }, { provider: 'test', model: 'other' }, {}])('rejects unverified or substituted provider/model %j', async selection => {
    const fetch = vi.fn(async url => new Response(JSON.stringify(url.endsWith('/providers') ? { defaultProvider: 'test', providers } : { status: 'success', ...selection, response: '{"title":"Fix login redirects"}' })));
    const client = createConduitNamingClient({ fetch, readCredential: () => 'key' }); cleanup.push(() => client.close());
    await expect(client.generate(settings, 'task')).rejects.toMatchObject({ status: 503 });
  });
  it.each([{}, { status: 'error', response: '{"title":"Misleading success"}' }, { status: 'success', response: 'bad JSON' }])('rejects malformed or failed responses', async payload => {
    const fetch = vi.fn(async url => new Response(JSON.stringify(url.endsWith('/providers') ? { defaultProvider: 'test', providers } : payload)));
    const client = createConduitNamingClient({ fetch, readCredential: () => 'key' }); cleanup.push(() => client.close());
    await expect(client.generate(settings, 'task')).rejects.toBeDefined();
  });
});
