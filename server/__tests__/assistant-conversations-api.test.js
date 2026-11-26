import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createConversationStore } from '../assistant/conversation-store.js';
import { createAssistantRouter } from '../routes/assistant.js';

const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup() {
  const db = new Database(':memory:'); databases.push(db);
  const store = createConversationStore(db);
  const app = express();
  const findProject = name => name === 'Demo' ? { name, path: '/tmp/demo', defaultHost: 'local' } : name === 'Remote' ? { name, path: '/tmp/remote', defaultHost: 'elsewhere' } : null;
  app.use(createAssistantRouter({ compose: async () => ({}), store, findProject }));
  return { app, store, db };
}
function problem(response, status) { expect(response.status).toBe(status); expect(response.headers['content-type']).toMatch(/problem\+json/); expect(response.body.traceId).toBe(response.headers['x-trace-id']); expect(response.body.message).toEqual(expect.any(String)); }

describe('assistant conversation API', () => {
  it('keeps the same current id across concurrent and repeat first calls', async () => {
    const { app } = setup();
    const [a, b] = await Promise.all([request(app).get('/api/assistant/conversations/current?project=Demo'), request(app).get('/api/assistant/conversations/current?project=Demo')]);
    const again = await request(app).get('/api/assistant/conversations/current?project=Demo');
    expect([a.status, b.status, again.status]).toEqual([200, 200, 200]);
    expect(a.body.id).toBe(b.body.id); expect(again.body.id).toBe(a.body.id);
  });
  it('pages empty, boundary, past-end and equal timestamps stably', async () => {
    const { app, store, db } = setup(); const id = store.current('Demo').id;
    const url = `/api/assistant/conversations/${id}/messages`;
    expect((await request(app).get(url)).body).toMatchObject({ data: [], page: { totalElements: 0, totalPages: 0 } });
    for (let n = 0; n < 101; n++) store.append(id, { role: 'owner', content: `line ${n}` });
    db.prepare('UPDATE assistant_messages SET created_at=?').run('2026-11-25T20:00:00.000Z');
    const first = await request(app).get(`${url}?size=100`);
    expect(first.status).toBe(200); expect(first.body.data).toHaveLength(100);
    const second = await request(app).get(`${url}?size=100&page=1`);
    expect(second.body.data).toHaveLength(1); expect(second.body.data[0].id).toBe(101);
    expect((await request(app).get(`${url}?size=100&page=2`)).body.data).toEqual([]);
    problem(await request(app).get(`${url}?size=101`), 400);
  });
  it('rejects fuzzed ids and messages for an unknown local project', async () => {
    const { app, store } = setup();
    for (const id of ['00000000----------------------------', 'aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      const response = await request(app).get(`/api/assistant/conversations/${id}/messages`);
      problem(response, 400); expect(response.body.errors).toContainEqual(expect.objectContaining({ field: 'id' }));
    }
    const id = store.current('Gone').id;
    problem(await request(app).get(`/api/assistant/conversations/${id}/messages`), 404);
    const remoteId = store.current('Remote').id;
    problem(await request(app).get(`/api/assistant/conversations/${remoteId}/messages`), 409);
  });
  it('creates a current conversation and returns a paginated transcript', async () => {
    const { app, store } = setup();
    const current = await request(app).get('/api/assistant/conversations/current?project=Demo');
    expect(current.status).toBe(200); expect(current.body).toMatchObject({ project: 'Demo', state: 'current' });
    expect(current.headers['x-trace-id']).toBeTruthy();
    store.append(current.body.id, { role: 'owner', content: 'one' });
    store.append(current.body.id, { role: 'agent', content: 'two' });
    const page = await request(app).get(`/api/assistant/conversations/${current.body.id}/messages?size=1&sort=createdAt,desc`);
    expect(page.status).toBe(200); expect(page.body).toMatchObject({ data: [{ content: 'two' }], page: { currentPage: 0, size: 1, totalElements: 2, totalPages: 2, hasNextPage: true } });
  });
  it('rejects missing, unknown, empty, long and unsafe fields with traceable problems', async () => {
    const { app } = setup();
    for (const url of ['/api/assistant/conversations/current', '/api/assistant/conversations/current?project=', '/api/assistant/conversations/current?project=x&bad=1', `/api/assistant/conversations/current?project=${'x'.repeat(201)}`]) {
      const response = await request(app).get(url); problem(response, 400); expect(response.body.errors.length).toBeGreaterThan(0);
    }
    for (const body of [{}, { project: null }, { project: [] }, { project: 'Demo', extra: 1 }, { project: '<script>' }]) {
      const response = await request(app).post('/api/assistant/conversations').send(body); problem(response, 400); expect(response.body.errors.length).toBeGreaterThan(0);
    }
    problem(await request(app).post('/api/assistant/conversations').set('Content-Type', 'application/json').send('{'), 400);
    problem(await request(app).get('/api/assistant/conversations/current?project=Missing'), 404);
    problem(await request(app).get('/api/assistant/conversations/current?project=Remote'), 409);
    problem(await request(app).get('/api/assistant/conversations/00000000-0000-4000-8000-000000000000/messages'), 404);
    for (const query of ['size=0', 'size=101', 'sort=content,asc', 'page=null', 'bad=1']) problem(await request(app).get(`/api/assistant/conversations/00000000-0000-4000-8000-000000000000/messages?${query}`), 400);
    problem(await request(app).post('/api/assistant/conversations').send({ project: 'Demo', padding: 'x'.repeat(5000) }), 413);
  });
  it('serializes simultaneous new-conversation requests', async () => {
    const { app, db } = setup();
    const [a, b] = await Promise.all([request(app).post('/api/assistant/conversations').send({ project: 'Demo' }), request(app).post('/api/assistant/conversations').send({ project: 'Demo' })]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(db.prepare("SELECT count(*) n FROM assistant_conversations WHERE state='current'").get().n).toBe(1);
  });
});
