import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { createAssistantRouter } from '../routes/assistant.js';
import { composeSituation } from '../assistant/situation.js';
import Database from 'better-sqlite3';
import { createAssistantSettingsStore } from '../assistant/assistant-settings-store.js';

const roots = [];
const settingsDbs = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
afterEach(() => settingsDbs.splice(0).forEach(db => db.close()));

const situation = { project: 'Demo', generatedAt: '2026-11-25T20:00:00.000Z', repositories: [], tasks: [], todos: [], specifications: [], skipped: [], flags: [], truncated: { dirty: false, todos: false, specifications: false }, markdown: '# Demo\nNothing needs your attention.' };
function setup(compose = vi.fn(async name => ({ ...situation, project: name }))) {
  const app = express();
  app.use(createAssistantRouter({ compose }));
  return { app, compose };
}
const url = name => `/api/projects/${encodeURIComponent(name)}/situation`;
function expectProblem(response, status) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(response.body).toMatchObject({ type: 'about:blank', status, path: response.request.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0], traceId: response.headers['x-trace-id'] });
  expect(response.body).toHaveProperty('timestamp');
  expect(response.body).toHaveProperty('error');
  expect(response.body).toHaveProperty('message');
}

describe('assistant settings singleton', () => {
  function app() {
    const db = new Database(':memory:'); settingsDbs.push(db);
    const settingsStore = createAssistantSettingsStore(db);
    const app = express(); app.use(createAssistantRouter({ compose: async () => situation, settingsStore }));
    return app;
  }
  it('gets defaults and saves a valid choice idempotently', async () => {
    const server = app();
    expect((await request(server).get('/api/assistant/settings')).body).toEqual({ model: 'default', effort: null });
    for (let i = 0; i < 2; i++) expect((await request(server).put('/api/assistant/settings').send({ model: 'opus', effort: 'high' })).body).toEqual({ model: 'opus', effort: 'high' });
    expect((await request(server).get('/api/assistant/settings')).body).toEqual({ model: 'opus', effort: 'high' });
  });
  it('returns field errors and a trace for invalid or malformed input', async () => {
    const server = app();
    for (const body of [{ model: 'wrong', effort: 'nope' }, { model: null, effort: null }, {}, []]) {
      const response = await request(server).put('/api/assistant/settings').send(body);
      expectProblem(response, 400);
      expect(response.body.errors.length).toBeGreaterThan(0);
    }
    const malformed = await request(server).put('/api/assistant/settings').set('Content-Type', 'application/json').send('{');
    expectProblem(malformed, 400);
  });
});

describe('GET project situation', () => {
  it('returns the bounded document with a trace header', async () => {
    const { app } = setup();
    const response = await request(app).get(url('Demo'));
    expect(response.status).toBe(200);
    expect(response.headers['x-trace-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body).toEqual(situation);
  });
  it('returns 404 for unknown and 409 for remote projects', async () => {
    const { app } = setup(async name => { throw Object.assign(new Error(name === 'Remote' ? 'Assistant is only available for local projects.' : 'Project not found'), { status: name === 'Remote' ? 409 : 404 }); });
    expectProblem(await request(app).get(url('Missing')), 404);
    expectProblem(await request(app).get(url('Remote')), 409);
  });
  it('rejects every query parameter with field errors, including empty and null-like values', async () => {
    const { app, compose } = setup();
    for (const query of ['?page=0', '?size=', '?foo=null', '?foo=%5B%5D']) {
      const response = await request(app).get(`${url('Demo')}${query}`);
      expectProblem(response, 400);
      expect(response.body.errors).toEqual([expect.objectContaining({ field: expect.any(String) })]);
    }
    expect(compose).not.toHaveBeenCalled();
  });
  it('rejects unsafe project names and never executes them', async () => {
    const { app, compose } = setup();
    expectProblem(await request(app).get(url('<script>alert(1)</script>')), 400);
    expectProblem(await request(app).get(url('../secret')), 400);
    expect(compose).not.toHaveBeenCalled();
  });
  it('returns equal flags to parallel readers', async () => {
    const { app } = setup();
    const [one, two] = await Promise.all([request(app).get(url('Demo')), request(app).get(url('Demo'))]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(one.body.flags).toEqual(two.body.flags);
  });
  it('serves equal flags to parallel readers using the real composer and Git', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-api-real-')); roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    await fs.writeFile(path.join(root, 'README.md'), 'demo');
    const compose = name => composeSituation({ projectName: name, findProject: project => project === 'Demo' ? { name: 'Demo', path: root, host: 'local' } : null, repositoryService: { list: async () => [{ name: 'backend', own: true, path: root, branch: 'main', usable: true, reason: null }] }, taskStore: { list: () => [] }, landing: { worktrees: async () => [] }, runStore: { list: () => [] }, runView: async () => { throw new Error('unexpected run'); }, execFile });
    const { app } = setup(compose);
    const [one, two] = await Promise.all([request(app).get(url('Demo')), request(app).get(url('Demo'))]);
    expect(one.status).toBe(200); expect(two.status).toBe(200);
    expect(one.body).toMatchObject({ project: 'Demo', repositories: [{ name: 'backend', dirtyCount: 1 }], tasks: [], todos: [], flags: [{ code: 'other_repository_dirty' }] });
    expect(one.body.flags).toEqual(two.body.flags);
  });
  it('returns a traceable 500 for composer faults', async () => {
    const { app } = setup(async () => { throw new Error('corrupt task t-1'); });
    const response = await request(app).get(url('Demo'));
    expectProblem(response, 500);
  });
  it('reports a badly encoded name as a name validation error', async () => {
    const { app } = setup();
    const response = await request(app).get('/api/projects/%E0/situation');
    expectProblem(response, 400);
    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'name' })]);
  });
  it('accepts 100 characters and rejects 101', async () => {
    const { app } = setup(async () => { throw Object.assign(new Error('Project not found'), { status: 404 }); });
    expectProblem(await request(app).get(url('a'.repeat(100))), 404);
    const response = await request(app).get(url('a'.repeat(101)));
    expectProblem(response, 400);
    expect(response.body.errors).toEqual([expect.objectContaining({ field: 'name' })]);
  });
});
