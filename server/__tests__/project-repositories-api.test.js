import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { loopbackTestServer } from './helpers/loopback-test-server.js';
import { groupFixture, repository } from './helpers/group-fixture.js';
import { createProjectRepositoriesRouter } from '../routes/project-repositories.js';
import { RepositoryError } from '../project-repositories.js';

afterEach(() => vi.restoreAllMocks());

const list = name => `/api/projects/${encodeURIComponent(name)}/repositories`;
const candidates = name => `/api/projects/${encodeURIComponent(name)}/repository-candidates`;
const HEAD = expect.stringMatching(/^[0-9a-f]{40}$/);
const TRACE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The real service over real throwaway repositories; only the HTTP layer is under test. */
async function setup({ service } = {}) {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const ctx = groupFixture();
  const app = express();
  app.use(createProjectRepositoriesRouter({ service: service ?? ctx.service }));
  const server = await loopbackTestServer(app);
  return { ...ctx, server, warn, error };
}

function expectProblem(response, status, message) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(response.body).toMatchObject({ type: 'about:blank', status, detail: message, message, path: response.request.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0] });
  expect(response.body.traceId).toMatch(TRACE);
  expect(response.headers['x-trace-id']).toBe(response.body.traceId);
  expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  expect(typeof response.body.error).toBe('string');
}

function expectFieldErrors(response, errors) {
  expectProblem(response, 400, 'One or more fields failed validation.');
  expect(response.body.error).toBe('Validation Error');
  expect(response.body.errors).toEqual(errors);
}

describe('project repositories API', () => {
  describe('GET /api/projects/:name/repositories', () => {
    it('lists the project\'s own repository and the others in a paginated envelope', async () => {
      const { server, backend, mobile, service } = await setup();
      await service.add('Demo', { path: mobile });
      const response = await request(server).get(list('Demo'));
      expect(response.status).toBe(200);
      expect(response.headers['x-trace-id']).toMatch(TRACE);
      expect(response.body).toEqual({
        data: [
          { name: 'backend', path: backend, own: true, branch: 'main', head: HEAD, dirty: false, usable: true, reason: null },
          { name: 'mobile-app', path: mobile, own: false, branch: 'main', head: HEAD, dirty: false, usable: true, reason: null },
        ],
        page: { currentPage: 0, size: 20, totalElements: 2, totalPages: 1, hasNextPage: false },
      });
    });

    it('pages and sorts by name in a stable order', async () => {
      const { server, mobile, frontendMain, service } = await setup();
      await service.add('Demo', { path: mobile });
      await service.add('Demo', { path: frontendMain });
      const first = await request(server).get(`${list('Demo')}?size=2&page=0`);
      const second = await request(server).get(`${list('Demo')}?size=2&page=1`);
      expect(first.body.data.map(entry => entry.name)).toEqual(['backend', 'frontend']);
      expect(first.body.page).toEqual({ currentPage: 0, size: 2, totalElements: 3, totalPages: 2, hasNextPage: true });
      expect(second.body.data.map(entry => entry.name)).toEqual(['mobile-app']);
      expect(second.body.page.hasNextPage).toBe(false);
      expect((await request(server).get(`${list('Demo')}?sort=name,desc`)).body.data.map(entry => entry.name)).toEqual(['mobile-app', 'frontend', 'backend']);
      expect((await request(server).get(`${list('Demo')}?size=100&page=5`)).body.data).toEqual([]);
    });

    it.each([
      ['size=0', 'size', 'Use an integer from 1 to 100'],
      ['size=101', 'size', 'Use an integer from 1 to 100'],
      ['size=ten', 'size', 'Use an integer from 1 to 100'],
      ['size=', 'size', 'Use an integer from 1 to 100'],
      ['page=-1', 'page', 'Use an integer from 0 to 100000'],
      ['page=1.5', 'page', 'Use an integer from 0 to 100000'],
      ['sort=path,asc', 'sort', 'Sort by name with asc or desc'],
      ['sort=name', 'sort', 'Sort by name with asc or desc'],
      ['sort=name,asc,extra', 'sort', 'Sort by name with asc or desc'],
      ['own=true', 'own', 'Unknown query field'],
      ['name=%27%3B%20DROP%20TABLE%20configs%3B--', 'name', 'Unknown query field'],
    ])('refuses the query %s', async (query, field, message) => {
      const { server } = await setup();
      expectFieldErrors(await request(server).get(`${list('Demo')}?${query}`), [{ field, message }]);
      expectFieldErrors(await request(server).get(`${candidates('Demo')}?${query}`), [{ field, message }]);
    });

    it('accepts the largest and smallest page size', async () => {
      const { server } = await setup();
      expect((await request(server).get(`${list('Demo')}?size=1`)).body.page.size).toBe(1);
      expect((await request(server).get(`${list('Demo')}?size=100`)).body.page.size).toBe(100);
    });

    it('reports an unknown project and a remote one', async () => {
      const { server } = await setup();
      expectProblem(await request(server).get(list('Nope')), 404, 'Project not found');
      expectProblem(await request(server).get(list('Remote')), 409, 'Repositories are only available for local projects.');
      expectProblem(await request(server).get(list('<script>alert(1)</script>')), 404, 'Project not found');
    });

    it('answers 500 without internals when the stored list cannot be trusted', async () => {
      const { server, setProjects, backend, error } = await setup();
      setProjects([{ name: 'Demo', path: backend, repositories: [{ name: 'a/b', path: '/tmp/a' }] }]);
      const response = await request(server).get(list('Demo'));
      expectProblem(response, 500, 'The repositories request failed.');
      expect(JSON.stringify(response.body)).not.toContain('Stored project');
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`traceId=${response.body.traceId}`), expect.any(Error));
    });
  });

  describe('GET /api/projects/:name/repository-candidates', () => {
    it('lists the repositories beside the project in a paginated envelope', async () => {
      const { server, mobile, frontend } = await setup();
      const response = await request(server).get(candidates('Demo'));
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: [{ name: 'frontend', path: frontend }, { name: 'mobile-app', path: mobile }],
        page: { currentPage: 0, size: 20, totalElements: 2, totalPages: 1, hasNextPage: false },
      });
      const paged = await request(server).get(`${candidates('Demo')}?size=1&page=1&sort=name,asc`);
      expect(paged.body.data).toEqual([{ name: 'mobile-app', path: mobile }]);
      expect(paged.body.page).toEqual({ currentPage: 1, size: 1, totalElements: 2, totalPages: 2, hasNextPage: false });
    });

    it('is empty once every neighbour is listed', async () => {
      const { server, mobile, frontend, service } = await setup();
      await service.add('Demo', { path: mobile });
      await service.add('Demo', { path: frontend });
      expect((await request(server).get(candidates('Demo'))).body).toEqual({ data: [], page: { currentPage: 0, size: 20, totalElements: 0, totalPages: 0, hasNextPage: false } });
    });

    it('reports an unknown project, a remote one and one that is not a repository', async () => {
      const { server } = await setup();
      expectProblem(await request(server).get(candidates('Nope')), 404, 'Project not found');
      expectProblem(await request(server).get(candidates('Remote')), 409, 'Repositories are only available for local projects.');
      expectProblem(await request(server).get(candidates('Plain')), 409, 'This project\'s folder is not the top level of a Git working tree.');
    });
  });

  describe('POST /api/projects/:name/repositories', () => {
    it('adds a repository and returns it', async () => {
      const { server, mobile, stored } = await setup();
      const response = await request(server).post(list('Demo')).send({ path: mobile });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ name: 'mobile-app', path: mobile, own: false, branch: 'main', head: HEAD, dirty: false, usable: true, reason: null });
      expect(stored().find(project => project.name === 'Demo').repositories).toEqual([{ name: 'mobile-app', path: mobile }]);
    });

    it.each([
      ['a missing path', {}, [{ field: 'path', message: 'Use the absolute path of a folder' }]],
      ['a null path', { path: null }, [{ field: 'path', message: 'Use the absolute path of a folder' }]],
      ['an empty path', { path: '' }, [{ field: 'path', message: 'Use the absolute path of a folder' }]],
      ['a number', { path: 7 }, [{ field: 'path', message: 'Use the absolute path of a folder' }]],
      ['a list', { path: ['/tmp'] }, [{ field: 'path', message: 'Use the absolute path of a folder' }]],
      ['a relative path', { path: 'mobile-app' }, [{ field: 'path', message: 'Use the absolute path of a folder' }]],
      ['a path one character too long', { path: `/${'a'.repeat(1024)}` }, [{ field: 'path', message: 'Use the absolute path of a folder' }]],
      ['a path of the greatest length that does not exist', { path: `/${'a'.repeat(1023)}` }, [{ field: 'path', message: 'This folder does not exist' }]],
      ['SQL in the path', { path: '/tmp/\'; DROP TABLE configs;--' }, [{ field: 'path', message: 'This folder does not exist' }]],
      ['markup in the path', { path: '/tmp/<script>alert(1)</script>' }, [{ field: 'path', message: 'This folder does not exist' }]],
      ['unknown fields', { path: '/tmp', name: 'x', own: true }, [{ field: 'name', message: 'Unknown field' }, { field: 'own', message: 'Unknown field' }]],
      ['an empty list as the body', [], [{ field: 'body', message: 'Use an object with path' }]],
    ])('refuses %s with the fields to fix', async (_name, body, errors) => {
      const { server, stored } = await setup();
      const response = await request(server).post(list('Demo')).send(body);
      expectFieldErrors(response, errors);
      // What was sent is never echoed back.
      expect(JSON.stringify(response.body)).not.toMatch(/DROP TABLE|<script>/);
      expect(stored().find(project => project.name === 'Demo').repositories).toBeUndefined();
    });

    it('refuses a folder that is not a repository, malformed JSON and a body that is too large', async () => {
      const { server, notes } = await setup();
      expectFieldErrors(await request(server).post(list('Demo')).send({ path: notes }), [{ field: 'path', message: 'This folder is not the top level of a Git working tree' }]);
      expectFieldErrors(await request(server).post(list('Demo')).set('Content-Type', 'application/json').send('{"path":'), [{ field: 'body', message: 'Malformed JSON body' }]);
      expectFieldErrors(await request(server).post(list('Demo')).set('Content-Type', 'application/json').send('null'), [{ field: 'body', message: 'Malformed JSON body' }]);
      expectProblem(await request(server).post(list('Demo')).send({ path: `/${'a'.repeat(8000)}` }), 413, 'Request body too large');
    });

    it('reports conflicts and unknown or remote projects', async () => {
      const { server, backend, mobile, otherBackend } = await setup();
      expectProblem(await request(server).post(list('Nope')).send({ path: mobile }), 404, 'Project not found');
      expectProblem(await request(server).post(list('Remote')).send({ path: mobile }), 409, 'Repositories are only available for local projects.');
      expectProblem(await request(server).post(list('Demo')).send({ path: backend }), 409, 'This repository is already part of the project.');
      expectProblem(await request(server).post(list('Demo')).send({ path: otherBackend }), 409, 'Another repository of this project is already called backend.');
    });

    it('stores a repository once when the same request is sent twice at once', async () => {
      const { server, mobile, stored } = await setup();
      const responses = await Promise.all([request(server).post(list('Demo')).send({ path: mobile }), request(server).post(list('Demo')).send({ path: mobile })]);
      expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
      expectProblem(responses.find(response => response.status === 409), 409, 'This repository is already part of the project.');
      expect(stored().find(project => project.name === 'Demo').repositories).toHaveLength(1);
    });

    it('accepts the eighth other repository and refuses the ninth', async () => {
      const { server, base } = await setup();
      for (let index = 1; index <= 8; index += 1) {
        expect((await request(server).post(list('Demo')).send({ path: repository(path.join(base, 'many', `repo-${index}`)) })).status).toBe(201);
      }
      expectProblem(await request(server).post(list('Demo')).send({ path: repository(path.join(base, 'many', 'one-more')) }), 409, 'A project can list at most 8 other repositories.');
    }, 30_000);

    it('logs a refused request once with its route and field names, never the values', async () => {
      const { server, warn } = await setup();
      const response = await request(server).post(list('Demo')).send({ path: 'secret-relative-path' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`traceId=${response.body.traceId}`);
      expect(warn.mock.calls[0][0]).toContain('fields=path');
      expect(warn.mock.calls[0][0]).not.toContain('secret-relative-path');
    });
  });

  describe('DELETE /api/projects/:name/repositories/:repository', () => {
    it('removes a repository from the project, once', async () => {
      const { server, mobile, service, stored } = await setup();
      await service.add('Demo', { path: mobile });
      const response = await request(server).delete(`${list('Demo')}/mobile-app`);
      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(stored().find(project => project.name === 'Demo').repositories).toEqual([]);
      expectProblem(await request(server).delete(`${list('Demo')}/mobile-app`), 404, 'Repository not found');
    });

    it('removes one repository when asked twice at once', async () => {
      const { server, mobile, service } = await setup();
      await service.add('Demo', { path: mobile });
      const responses = await Promise.all([request(server).delete(`${list('Demo')}/mobile-app`), request(server).delete(`${list('Demo')}/mobile-app`)]);
      expect(responses.map(response => response.status).sort()).toEqual([204, 404]);
    });

    it('reports what it cannot remove', async () => {
      const { server } = await setup();
      expectProblem(await request(server).delete(`${list('Nope')}/mobile-app`), 404, 'Project not found');
      expectProblem(await request(server).delete(`${list('Remote')}/mobile-app`), 409, 'Repositories are only available for local projects.');
      expectProblem(await request(server).delete(`${list('Demo')}/backend`), 404, 'Repository not found');
      expectProblem(await request(server).delete(`${list('Demo')}/${encodeURIComponent('\'; DROP TABLE configs;--')}`), 404, 'Repository not found');
      expectProblem(await request(server).delete(`${list('Demo')}/${'x'.repeat(300)}`), 404, 'Repository not found');
    });
  });

  describe('POST /api/projects/:name/terminals', () => {
    const terminals = name => `/api/projects/${encodeURIComponent(name)}/terminals`;

    it('opens a terminal in the own checkout of one of the project\'s repositories', async () => {
      const { server, mobile, backend, service, starts } = await setup();
      await service.add('Demo', { path: mobile });
      const response = await request(server).post(terminals('Demo')).send({ repository: 'mobile-app' });
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ sessionId: 'Demo-1', project: 'Demo', repository: 'mobile-app', path: mobile });
      expect((await request(server).post(terminals('Demo')).send({ repository: 'backend' })).body).toEqual({ sessionId: 'Demo-2', project: 'Demo', repository: 'backend', path: backend });
      expect(starts).toEqual([['Demo', { cwd: mobile }], ['Demo', { cwd: backend }]]);
    });

    it('opens a terminal for each request, also when the same one is sent twice at once', async () => {
      const { server, starts } = await setup();
      const responses = await Promise.all([request(server).post(terminals('Demo')).send({ repository: 'backend' }), request(server).post(terminals('Demo')).send({ repository: 'backend' })]);
      expect(responses.map(response => response.status)).toEqual([201, 201]);
      expect(new Set(responses.map(response => response.body.sessionId)).size).toBe(2);
      expect(starts).toHaveLength(2);
    });

    it.each([
      ['a missing name', {}, [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]],
      ['null', { repository: null }, [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]],
      ['an empty name', { repository: '' }, [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]],
      ['a number', { repository: 3 }, [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]],
      ['a name of 101 characters', { repository: 'r'.repeat(101) }, [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]],
      ['a repository that is not listed', { repository: 'tools' }, [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]],
      ['a folder instead of a name', { repository: '../../etc' }, [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]],
      ['markup', { repository: '<script>alert(1)</script>' }, [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]],
      ['an unknown field', { repository: 'backend', cwd: '/etc' }, [{ field: 'cwd', message: 'Unknown field' }]],
      ['a list as the body', [], [{ field: 'body', message: 'Use an object with repository' }]],
    ])('refuses %s and starts nothing', async (_name, body, errors) => {
      const { server, starts } = await setup();
      const response = await request(server).post(terminals('Demo')).send(body);
      expectFieldErrors(response, errors);
      expect(JSON.stringify(response.body)).not.toMatch(/<script>|etc/);
      expect(starts).toEqual([]);
    });

    it('refuses malformed JSON and a body that is too large', async () => {
      const { server } = await setup();
      expectFieldErrors(await request(server).post(terminals('Demo')).set('Content-Type', 'application/json').send('{"repository":'), [{ field: 'body', message: 'Malformed JSON body' }]);
      expectProblem(await request(server).post(terminals('Demo')).send({ repository: 'r'.repeat(8000) }), 413, 'Request body too large');
    });

    it('reports an unknown project, a remote one, and a terminal runtime that is not available', async () => {
      const { server } = await setup();
      expectProblem(await request(server).post(terminals('Nope')).send({ repository: 'backend' }), 404, 'Project not found');
      expectProblem(await request(server).post(terminals('Remote')).send({ repository: 'app' }), 409, 'Repositories are only available for local projects.');
      const failing = { list: vi.fn(), candidates: vi.fn(), add: vi.fn(), remove: vi.fn(), openTerminal: vi.fn(async () => { throw new RepositoryError('The terminal could not be opened.', 503); }) };
      const down = await setup({ service: failing });
      expectProblem(await request(down.server).post(terminals('Demo')).send({ repository: 'backend' }), 503, 'The terminal could not be opened.');
    });
  });

  it('answers 404 for a path it does not serve and leaves other routes alone', async () => {
    const { server } = await setup();
    expectProblem(await request(server).put(`${list('Demo')}/mobile-app`).send({}), 404, 'Repositories endpoint not found');
    const elsewhere = await request(server).get('/api/projects');
    expect(elsewhere.status).toBe(404);
    expect(elsewhere.headers['content-type']).not.toMatch(/problem\+json/);
  });

  it('requires a service', () => {
    expect(() => createProjectRepositoriesRouter({})).toThrow('project repositories router requires service.list');
  });
});
