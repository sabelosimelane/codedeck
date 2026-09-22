import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createTerminalWaitingStore } from '../terminal-waiting-store.js';
import { createTerminalWaitingRouter } from '../routes/terminal-waiting.js';

const base = '/api/terminal-waiting';
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });

function setup() {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  const store = createTerminalWaitingStore(db);
  const app = express();
  app.use(createTerminalWaitingRouter({ store, sessionExists: id => /^Demo-\d+$/.test(id) }));
  return { app, store };
}

describe('terminal waiting API', () => {
  it('marks a session waiting and reads it back through the collection', async () => {
    const { app } = setup();
    const marked = await request(app).put(`${base}/Demo-1`).send({ waiting: true });
    expect(marked.status).toBe(200);
    expect(marked.body).toMatchObject({ sessionId: 'Demo-1', waiting: true });
    expect(typeof marked.body.waitingAt).toBe('string');

    const listed = await request(app).get(base);
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual([marked.body]);
    expect(listed.body.page).toEqual({ currentPage: 0, size: 20, totalElements: 1, totalPages: 1, hasNextPage: false });
  });

  it('clears a waiting session', async () => {
    const { app, store } = setup();
    await request(app).put(`${base}/Demo-1`).send({ waiting: true });
    const cleared = await request(app).put(`${base}/Demo-1`).send({ waiting: false });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toEqual({ sessionId: 'Demo-1', waiting: false, waitingAt: null });
    expect(store.get('Demo-1')).toBeNull();
    expect((await request(app).get(base)).body.data).toEqual([]);
  });

  it('is idempotent — re-marking keeps the original timestamp, re-clearing stays 200', async () => {
    const { app } = setup();
    const first = await request(app).put(`${base}/Demo-1`).send({ waiting: true });
    const second = await request(app).put(`${base}/Demo-1`).send({ waiting: true });
    expect(second.body.waitingAt).toBe(first.body.waitingAt);
    expect((await request(app).put(`${base}/Demo-2`).send({ waiting: false })).status).toBe(200);
  });

  it('paginates, filters by sessionId and sorts by waitingAt with a stable tiebreaker', async () => {
    const { app, store } = setup();
    store.mark('Demo-1', '2026-09-22T12:00:00.000Z');
    store.mark('Demo-2', '2026-09-22T10:00:00.000Z');
    store.mark('Demo-3', '2026-09-22T11:00:00.000Z');

    const firstPage = await request(app).get(base).query({ size: 2, sort: 'waitingAt,asc' });
    expect(firstPage.body.data.map(r => r.sessionId)).toEqual(['Demo-2', 'Demo-3']);
    expect(firstPage.body.page).toMatchObject({ currentPage: 0, size: 2, totalElements: 3, totalPages: 2, hasNextPage: true });

    const secondPage = await request(app).get(base).query({ page: 1, size: 2, sort: 'waitingAt,asc' });
    expect(secondPage.body.data.map(r => r.sessionId)).toEqual(['Demo-1']);
    expect(secondPage.body.page).toMatchObject({ currentPage: 1, hasNextPage: false });

    const descending = await request(app).get(base).query({ sort: 'sessionId,desc' });
    expect(descending.body.data.map(r => r.sessionId)).toEqual(['Demo-3', 'Demo-2', 'Demo-1']);

    const filtered = await request(app).get(base).query({ sessionId: 'Demo-2' });
    expect(filtered.body.data.map(r => r.sessionId)).toEqual(['Demo-2']);
    expect(filtered.body.page).toMatchObject({ totalElements: 1 });
  });

  it('returns 404 with problem details for an unknown session', async () => {
    const { app } = setup();
    const response = await request(app).put(`${base}/Ghost-9`).send({ waiting: true });
    expect(response.status).toBe(404);
    expect(response.type).toBe('application/problem+json');
    expect(response.body).toMatchObject({ status: 404, error: 'Terminal Waiting Error', path: `${base}/Ghost-9` });
    expect(response.body.traceId).toEqual(expect.any(String));
    expect(response.headers['x-trace-id']).toBe(response.body.traceId);
  });

  it.each([
    ['a missing waiting field', {}],
    ['a non-boolean waiting field', { waiting: 'yes' }],
    ['a null waiting field', { waiting: null }],
  ])('returns 400 with field errors for %s', async (_label, body) => {
    const { app } = setup();
    const response = await request(app).put(`${base}/Demo-1`).send(body);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ status: 400, error: 'Validation Error' });
    expect(response.body.errors).toEqual([{ field: 'waiting', message: expect.any(String) }]);
  });

  it.each([
    ['an out-of-range size', { size: 500 }, 'size'],
    ['a negative page', { page: -1 }, 'page'],
    ['an unknown sort field', { sort: 'nope,asc' }, 'sort'],
    ['an unknown sort direction', { sort: 'sessionId,sideways' }, 'sort'],
    ['a blank sessionId filter', { sessionId: '  ' }, 'sessionId'],
  ])('rejects %s on the collection', async (_label, query, field) => {
    const { app } = setup();
    const response = await request(app).get(base).query(query);
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([{ field, message: expect.any(String) }]);
  });

  it('returns 400 problem details for malformed JSON', async () => {
    const { app } = setup();
    const response = await request(app).put(`${base}/Demo-1`).type('application/json').send('{"waiting":');
    expect(response.status).toBe(400);
    expect(response.type).toBe('application/problem+json');
  });

  it('returns 404 problem details for an unknown waiting route', async () => {
    const { app } = setup();
    const response = await request(app).get(`${base}/Demo-1/nope`);
    expect(response.status).toBe(404);
    expect(response.type).toBe('application/problem+json');
  });
});
