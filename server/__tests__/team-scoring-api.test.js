import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { parseCollectionQuery as parse } from '../routes/collection-query.js';
import { mountTeamScoring } from '../routes/team-scoring.js';
class PipelineError extends Error {
  constructor(message, status, errors) {
    super(message);
    Object.assign(this, { status, errors });
  }
}
const fieldError = (field, message) => new PipelineError(message, 400, [{ field, message }]);
const base = '/api/pipelines/improvements/teams';
function setup() {
  const teamId = randomUUID(),
    ids = [randomUUID(), randomUUID()].sort();
  const cards = ids.map((id) => ({ id, teamId, name: 'Same' })).reverse();
  const service = {
    cards: () => cards,
    runs: () => [],
    history: () => [],
    detail() {
      throw Object.assign(new Error('Run not found'), { status: 404 });
    },
    correct: vi.fn(() => ({ revision: 2 })),
    trials: {
      list: () => [],
      decide: vi.fn(() => {
        throw Object.assign(new Error('Changed'), { status: 409 });
      }),
    },
  };
  const app = express();
  app.use(express.json());
  mountTeamScoring({
    router: app,
    service,
    route: (fn) => (req, res, next) =>
      Promise.resolve()
        .then(() => fn(req, res))
        .catch(next),
    parseCollectionQuery: (query, opts) => parse(query, opts, fieldError),
    fieldError,
    PipelineError,
  });
  app.use((err, req, res, next) =>
    res.status(err.status || 500).json({ message: err.message, errors: err.errors }),
  );
  return { app, service, teamId, ids };
}
describe('team scoring API', () => {
  it('orders and filters paginated collections with a stable tiebreaker', async () => {
    const { app, teamId, ids } = setup();
    for (const [i, id] of ids.entries()) {
      const { body, status } = await request(app)
        .get(base + '/scorecards')
        .query({ page: i, size: 1, teamId, sort: 'name,asc' });
      expect(status).toBe(200);
      expect(body.data.map((r) => r.id)).toEqual([id]);
      expect(body.page.totalElements).toBe(2);
    }
    expect((await request(app).get(base + '/runs')).body.data).toEqual([]);
    expect((await request(app).get(base + '/trials')).body.data).toEqual([]);
  });
  it('preserves field validation errors returned by a decision', async () => {
    const {
      app,
      service,
      ids: [id],
    } = setup();
    const errors = [{ field: 'revision', message: 'Invalid trial revision' }];
    service.trials.decide.mockImplementation(() => {
      throw Object.assign(new Error('Invalid decision'), { status: 400, errors });
    });
    const response = await request(app)
      .post(base + '/trials/' + id + '/decision')
      .send({ action: 'adopt', revision: 1 });
    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual(errors);
  });
  it('refuses unknown input and propagates revision conflicts and missing subjects', async () => {
    const {
      app,
      ids: [id],
    } = setup();
    for (const query of [
      { size: 101 },
      { teamId: 'garbage' },
      { sort: 'sql,desc' },
      { password: 'unexpected' },
    ]) {
      const response = await request(app)
        .get(base + '/runs')
        .query(query);
      expect(response.status).toBe(400);
      expect(response.body.errors.length).toBeGreaterThan(0);
    }
    expect((await request(app).get(base + '/runs/' + id)).status).toBe(404);
    expect(
      (
        await request(app)
          .post(base + '/trials/' + id + '/decision')
          .send({ action: 'adopt', revision: 1 })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .post(base + '/trials/' + id + '/decision')
          .send({ action: 'adopt', revision: 1, extra: 'bad' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(base + '/runs/' + id + '/corrections')
          .send({})
      ).status,
    ).toBe(400);
  });
});
