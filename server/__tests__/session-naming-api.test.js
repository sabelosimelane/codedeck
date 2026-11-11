import { loopbackTestServer } from './helpers/loopback-test-server.js';
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
async function setup() {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  const directory = mkdtempSync(path.join(tmpdir(), 'codedeck-naming-')); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = createNamingCredentialStore(path.join(directory, 'credential'));
  const store = createNamingStore(db);
  const conduit = { catalog: vi.fn(async () => providers), metrics: () => ({}) };
  const service = createNamingService({ store, generate: async () => 'Fix login redirects', capture: async () => 'fix login' });
  const app = express();
  app.use(createNamingRouter({ store, service, credentials, conduit, sessionExists: id => /^Demo-\d+$/.test(id) }));
  return { app: await loopbackTestServer(app), routerApp: app, store, credentials, conduit, service, directory, db };
}

describe('naming APIs', () => {
  it('saves local CLI selection without a Conduit connection or credential', async () => {
    const { app, conduit, credentials } = await setup();
    const selection = { provider: 'claude', model: 'sonnet', effort: 'low' };
    for (let i = 0; i < 2; i++) {
      const saved = await request(app).put('/api/session-naming/settings').send(selection);
      expect(saved.status).toBe(200); expect(saved.body).toEqual(selection);
    }
    expect((await request(app).get('/api/session-naming/settings')).body).toEqual(selection);
    expect(conduit.catalog).not.toHaveBeenCalled(); expect(credentials.read()).toBeNull();
  });
  it('round-trips custom providers and returns field errors without running a CLI on save', async () => {
    const { app } = await setup();
    const profile = { id: 'cursor', command: 'agent', args: ['--print', '--model', '{model}', '{prompt}'], effortArgs: [], input: 'argument', output: 'json' };
    const selection = { provider: 'cursor', model: 'custom', effort: null, providers: [profile] };
    const results = await Promise.all([1, 2].map(() => request(app).put('/api/session-naming/settings').send(selection)));
    for (const result of results) { expect(result.status).toBe(200); expect(result.body).toEqual(selection); }
    expect((await request(app).get('/api/session-naming/settings')).body).toEqual(selection);
    for (const patch of [{ providers: [] }, { providers: null }, { provider: 'missing' }, { providers: [{ ...profile, command: 'agent; touch bad' }] }, { providers: [{ ...profile, args: null }] }]) {
      const result = await request(app).put('/api/session-naming/settings').send({ ...selection, ...patch });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ traceId: expect.any(String), errors: expect.any(Array) });
    }
    expect((await request(app).get('/api/session-naming/settings')).body).toEqual(selection);
  });
  it('validates each CLI setting with problem details', async () => {
    const { app } = await setup();
    for (const body of [{}, { provider: null, model: null, effort: null }, { provider: 'shell', model: 'x', effort: null }, { provider: 'claude', model: '', effort: null }, { provider: 'claude', model: 'x'.repeat(257), effort: null }, { provider: 'claude', model: '$(id)', effort: null }, { provider: 'codex', model: 'x', effort: 'bad' }]) {
      const result = await request(app).put('/api/session-naming/settings').send(body);
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ traceId: expect.any(String), errors: expect.any(Array) });
    }
    expect((await request(app).put('/api/session-naming/settings').set('Content-Type', 'application/json').send('{')).status).toBe(400);
    for (const model of ['x', 'x'.repeat(256)]) expect((await request(app).put('/api/session-naming/settings').send({ provider: 'codex', model, effort: null })).status).toBe(200);
  });
  it('persists manual titles, validates boundaries, and returns a paginated list', async () => {
    const { app } = await setup();
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
    const { app, store, service } = await setup(); store.saveSettings({ provider: 'claude', model: 'sonnet', effort: null });
    store.ensure('Demo-1'); store.update('Demo-1', { state: 'failed', error: 'failed' });
    expect((await request(app).post('/api/session-naming/titles/Demo-1/retry').send({})).status).toBe(202);
    await service.waitForIdle(); expect(store.get('Demo-1').state).toBe('named');
  });
  it('stores credentials in a private file and supports removal', async () => {
    const { credentials, directory } = await setup(); credentials.write('private-key');
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
