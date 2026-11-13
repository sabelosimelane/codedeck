import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { loopbackTestServer } from '../helpers/loopback-test-server.js';
import { createAgentSessionsRouter } from '../../routes/agent-sessions.js';
const id = '11111111-1111-4111-8111-111111111111';
const base = '/api/agent-sessions';
function setup(start = async () => ({ id: 'Demo-1' }), submit = async () => {}) {
  const projects = [{ name: 'Demo', path: '/one', host: 'local' }, { name: 'Remote', path: '/remote', host: 'box' }];
  const history = { search: (cwds, options) => ({ data: cwds.includes('/one') ? [{ cli: 'claude', conversationId: id, title: 'Hello', firstPrompt: 'Prompt', cwd: '/one', updatedAt: 100 }] : [], page: { currentPage: options.page ?? 0, size: options.size ?? 20, totalElements: cwds.includes('/one') ? 1 : 0, totalPages: cwds.includes('/one') ? 1 : 0, hasNextPage: false }, sources: [{ cli: 'claude', available: true }] }) };
  const app = express(); app.use(createAgentSessionsRouter({ loadProjects: () => projects, history, startSession: start, submitCommand: submit }));
  return loopbackTestServer(app);
}
describe('agent sessions API', () => {
  it('returns a paginated local list with sources', async () => {
    const res = await request(await setup()).get(base);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [{ project: 'Demo', conversationId: id }], page: { currentPage: 0, size: 20, totalElements: 1, totalPages: 1, hasNextPage: false }, sources: [{ cli: 'claude', available: true }] });
  });
  it.each([{ page: -1 }, { size: 0 }, { size: 101 }, { sort: 'title' }, { cli: 'bogus' }, { q: 'x'.repeat(201) }, { unknown: 'x' }])('rejects invalid GET query %j', async query => {
    const res = await request(await setup()).get(base).query(query);
    expect(res.status).toBe(400); expect(res.body.errors).toEqual(expect.arrayContaining([{ field: expect.any(String), message: expect.any(String) }])); expect(res.body.traceId).toBe(res.headers['x-trace-id']);
  });
  it('returns 404 for unknown project and 409 for remote project', async () => {
    expect((await request(await setup()).get(base).query({ project: 'missing' })).status).toBe(404);
    expect((await request(await setup()).get(base).query({ project: 'Remote' })).status).toBe(409);
  });
  it('resumes a known conversation once and rejects an in-flight duplicate', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const app = await setup(async () => { await gate; return { id: 'Demo-1' }; });
    const body = { cli: 'claude', conversationId: id, project: 'Demo' };
    const first = request(app).post(`${base}/resume`).send(body);
    const firstPending = first.then(x => x);
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await request(app).post(`${base}/resume`).send(body);
    expect(second.status).toBe(409); release();
    const result = await firstPending; expect(result.status).toBe(201); expect(result.body).toEqual({ sessionId: 'Demo-1', ...body });
  });
  it('submits the fixed resume command to the newly started session', async () => {
    const submitted = [];
    const app = await setup(async () => ({ id: 'Demo-7' }), async (sessionId, command) => { submitted.push([sessionId, command]); });
    const result = await request(app).post(`${base}/resume`).send({ cli: 'claude', conversationId: id, project: 'Demo' });
    expect(result.status).toBe(201);
    expect(submitted).toEqual([['Demo-7', `claude --resume ${id}`]]);
  });
  it.each([{}, { cli: 'claude', conversationId: 'bad', project: 'Demo' }, { cli: null, conversationId: id, project: 'Demo' }, { cli: 'claude', conversationId: id, project: '' }])('rejects invalid resume body %j', async body => {
    const res = await request(await setup()).post(`${base}/resume`).send(body);
    expect(res.status).toBe(400); expect(res.body.errors.length).toBeGreaterThan(0);
  });
  it('accepts paging and search boundaries, and rejects values outside them', async () => {
    const app = await setup();
    const valid = await request(app).get(base).query({ q: 'x'.repeat(200), page: 0, size: 100, sort: '-updatedAt' });
    expect(valid.status).toBe(200);
    expect(valid.body.page).toMatchObject({ currentPage: 0, size: 100 });
    expect((await request(app).get(base).query({ page: 100001 })).status).toBe(400);
    expect((await request(app).get(base).query({ size: -1 })).status).toBe(400);
    expect((await request(app).get(base).query({ cli: ['claude', 'codex'] })).status).toBe(400);
  });
  it('rejects remote resume and invalid empty, null, array, and injected values', async () => {
    const app = await setup();
    expect((await request(app).post(`${base}/resume`).send({ cli: 'claude', conversationId: id, project: 'Remote' })).status).toBe(409);
    for (const body of [null, [], { cli: 'claude', conversationId: id, project: null }, { cli: 'claude; echo bad', conversationId: id, project: 'Demo' }, { cli: 'claude', conversationId: `${id}; echo bad`, project: 'Demo' }]) {
      const res = await request(app).post(`${base}/resume`).send(body);
      expect(res.status).toBe(400); expect(res.body.errors.length).toBeGreaterThan(0);
    }
    const tooLarge = await request(app).post(`${base}/resume`).set('Content-Type', 'application/json').send(JSON.stringify({ cli: 'claude', conversationId: id, project: 'Demo', padding: 'x'.repeat(5000) }));
    expect(tooLarge.status).toBe(413); expect(tooLarge.body.traceId).toBe(tooLarge.headers['x-trace-id']);
  });
  it('rejects malformed JSON and unknown conversation', async () => {
    const app = await setup();
    expect((await request(app).post(`${base}/resume`).type('application/json').send('{')).status).toBe(400);
    expect((await request(app).post(`${base}/resume`).send({ cli: 'claude', conversationId: '22222222-2222-4222-8222-222222222222', project: 'Demo' })).status).toBe(404);
  });
});
describe('agent sessions API fault logging', () => {
  it('logs the cause of a server fault beside its trace id without exposing it to the caller', async () => {
    const { vi } = await import('vitest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const app = express();
      app.use(createAgentSessionsRouter({ loadProjects: () => [{ name: 'Demo', path: '/one', host: 'local' }], history: { search: () => { throw new Error('/store/x.jsonl:2: invalid JSON'); } }, startSession: async () => ({ id: 'Demo-1' }), submitCommand: async () => {} }));
      const res = await request(await loopbackTestServer(app)).get(base);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('invalid JSON');
      expect(warn.mock.calls.flat().join(' ')).toContain(`traceId=${res.body.traceId}`);
      expect(warn.mock.calls.flat().join(' ')).toContain('/store/x.jsonl:2: invalid JSON');
    } finally { warn.mockRestore(); }
  });
});
