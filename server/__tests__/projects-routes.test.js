import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createProjectsRouter } from '../routes/projects.js';

const HOSTS = [{ name: 'devbox', sshTarget: 'devbox' }];

function makeApp({ projects = [], hosts = HOSTS, localPathExists, createRunner, getReachability } = {}) {
  const state = { projects: [...projects] };
  const app = express();
  app.use(express.json());
  app.use(createProjectsRouter({
    loadProjects: () => state.projects,
    saveProjects: (p) => { state.projects = p; },
    loadHosts: () => hosts,
    localPathExists: localPathExists ?? (() => true),
    createRunner: createRunner ?? (() => remoteRunner()),
    getReachability,
  }));
  return { app, state };
}

/** Fake remote runner: `test -d` result configurable per scenario. */
function remoteRunner({ pathExists = true, transportError = false } = {}) {
  return {
    run: vi.fn(() => {
      if (transportError) return Promise.reject(Object.assign(new Error('connect timeout'), { code: 255 }));
      if (!pathExists) return Promise.reject(Object.assign(new Error('missing'), { code: 1 }));
      return Promise.resolve({ stdout: '', stderr: '' });
    }),
  };
}

// ---------------------------------------------------------------------------
// GET /api/projects
// ---------------------------------------------------------------------------

describe('GET /api/projects', () => {
  it('includes host on every project, defaulting to local', async () => {
    const { app } = makeApp({
      projects: [
        { name: 'a', path: '/a' },
        { name: 'b', path: '/b', host: 'devbox' },
      ],
    });
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body.map(p => p.host)).toEqual(['local', 'devbox']);
  });

  it('includes live reachability on every project for sidebar truthfulness', async () => {
    const { app } = makeApp({
      projects: [
        { name: 'local-app', path: '/local' },
        { name: 'remote-app', path: '/remote', host: 'devbox' },
      ],
      getReachability: (hostName) => hostName === 'devbox'
        ? { reachability: 'unreachable', lastError: 'connect timeout', unreachableSince: 1720287000000 }
        : { reachability: 'reachable' },
    });

    const res = await request(app).get('/api/projects');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ name: 'local-app', host: 'local', reachability: 'reachable' }),
      expect.objectContaining({
        name: 'remote-app',
        host: 'devbox',
        reachability: 'unreachable',
        lastError: 'connect timeout',
        unreachableSince: 1720287000000,
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/projects
// ---------------------------------------------------------------------------

describe('POST /api/projects', () => {
  it('creates a local project exactly as before (no host field sent)', async () => {
    const localPathExists = vi.fn(() => true);
    const { app, state } = makeApp({ localPathExists });
    const res = await request(app).post('/api/projects').send({ name: 'p', path: '/tmp/p' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'p', path: '/tmp/p', host: 'local' });
    expect(localPathExists).toHaveBeenCalledWith('/tmp/p');
    // Local projects are stored without a host field (absence = local, Spec §4).
    expect(state.projects[0]).not.toHaveProperty('host');
  });

  it('treats an explicit host "local" as the local host', async () => {
    const { app, state } = makeApp();
    const res = await request(app).post('/api/projects').send({ name: 'p', path: '/tmp/p', host: 'local' });
    expect(res.status).toBe(201);
    expect(state.projects[0]).not.toHaveProperty('host');
  });

  it('rejects a missing local path with 400 (unchanged behavior)', async () => {
    const { app } = makeApp({ localPathExists: () => false });
    const res = await request(app).post('/api/projects').send({ name: 'p', path: '/nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('path does not exist');
  });

  it('rejects an unknown host with 400', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/projects').send({ name: 'p', path: '/tmp/p', host: 'ghost' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown host/i);
  });

  it('creates a remote project after validating the path through the host runner', async () => {
    const runner = remoteRunner({ pathExists: true });
    const { app, state } = makeApp({ createRunner: () => runner });
    const res = await request(app).post('/api/projects').send({ name: 'p', path: '/srv/app', host: 'devbox' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'p', path: '/srv/app', host: 'devbox' });
    expect(state.projects[0]).toMatchObject({ name: 'p', path: '/srv/app', host: 'devbox' });
    // Path existence ran on the host: POSIX test -d via the runner.
    expect(runner.run).toHaveBeenCalledWith('test', ['-d', '/srv/app'], expect.anything());
  });

  it('rejects a remote path that does not exist with 400', async () => {
    const { app, state } = makeApp({ createRunner: () => remoteRunner({ pathExists: false }) });
    const res = await request(app).post('/api/projects').send({ name: 'p', path: '/nope', host: 'devbox' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('path does not exist');
    expect(state.projects).toHaveLength(0);
  });

  it('returns 503 host unreachable without invoking the runner when reachability is already unreachable', async () => {
    const runner = remoteRunner();
    const { app, state } = makeApp({
      createRunner: () => runner,
      getReachability: () => ({ reachability: 'unreachable', lastError: 'connect timeout' }),
    });
    const res = await request(app).post('/api/projects').send({ name: 'remote', path: '/srv/app', host: 'devbox' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'host unreachable', host: 'devbox' });
    expect(runner.run).not.toHaveBeenCalled();
    expect(state.projects).toEqual([]);
  });

  it('returns 503 host unreachable when validation cannot reach the host — never creates unvalidated', async () => {
    const { app, state } = makeApp({ createRunner: () => remoteRunner({ transportError: true }) });
    const res = await request(app).post('/api/projects').send({ name: 'p', path: '/srv/app', host: 'devbox' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'host unreachable', host: 'devbox' });
    expect(state.projects).toHaveLength(0);
  });

  it('scopes path uniqueness per host: same path on the same host → 409', async () => {
    const { app } = makeApp({ projects: [{ name: 'a', path: '/srv/app', host: 'devbox' }] });
    const res = await request(app).post('/api/projects').send({ name: 'b', path: '/srv/app', host: 'devbox' });
    expect(res.status).toBe(409);
  });

  it('allows the same path on different hosts', async () => {
    const { app } = makeApp({ projects: [{ name: 'a', path: '/srv/app', host: 'devbox' }] });
    const res = await request(app).post('/api/projects').send({ name: 'b', path: '/srv/app' });
    expect(res.status).toBe(201);
  });

  it('still blocks duplicate local paths (absent host and explicit local are the same host)', async () => {
    const { app } = makeApp({ projects: [{ name: 'a', path: '/tmp/p' }] });
    const res = await request(app).post('/api/projects').send({ name: 'b', path: '/tmp/p', host: 'local' });
    expect(res.status).toBe(409);
  });

  it('requires name and path (unchanged behavior)', async () => {
    const { app } = makeApp();
    expect((await request(app).post('/api/projects').send({ name: 'p' })).status).toBe(400);
    expect((await request(app).post('/api/projects').send({ path: '/tmp/p' })).status).toBe(400);
  });

  it('rejects a duplicate project name even across hosts — session ids derive from names', async () => {
    const { app } = makeApp({ projects: [{ name: 'web', path: '/local/web' }] });
    const res = await request(app).post('/api/projects').send({ name: 'web', path: '/srv/web', host: 'devbox' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/name/i);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/projects/:name — existing behavior preserved, host-aware path check
// ---------------------------------------------------------------------------

describe('PUT /api/projects/:name', () => {
  it('returns 404 for an unknown project (unchanged)', async () => {
    const { app } = makeApp();
    expect((await request(app).put('/api/projects/ghost').send({ name: 'x' })).status).toBe(404);
  });

  it('renames a local project with local path validation (unchanged)', async () => {
    const localPathExists = vi.fn(() => true);
    const { app, state } = makeApp({
      projects: [{ name: 'a', path: '/tmp/a' }],
      localPathExists,
    });
    const res = await request(app).put('/api/projects/a').send({ name: 'a2' });
    expect(res.status).toBe(200);
    expect(state.projects[0].name).toBe('a2');
    expect(localPathExists).toHaveBeenCalledWith('/tmp/a');
  });

  it('rejects a local rename to a missing path with 400 (unchanged)', async () => {
    const { app } = makeApp({
      projects: [{ name: 'a', path: '/tmp/a' }],
      localPathExists: () => false,
    });
    expect((await request(app).put('/api/projects/a').send({ path: '/nope' })).status).toBe(400);
  });

  it('validates a remote project path change through the host runner', async () => {
    const runner = remoteRunner({ pathExists: true });
    const { app, state } = makeApp({
      projects: [{ name: 'a', path: '/srv/app', host: 'devbox' }],
      createRunner: () => runner,
    });
    const res = await request(app).put('/api/projects/a').send({ path: '/srv/app2' });
    expect(res.status).toBe(200);
    expect(state.projects[0].path).toBe('/srv/app2');
    expect(runner.run).toHaveBeenCalledWith('test', ['-d', '/srv/app2'], expect.anything());
  });

  it('returns 503 without runner invocation when a remote path change targets an already-unreachable host', async () => {
    const runner = remoteRunner();
    const { app, state } = makeApp({
      projects: [{ name: 'remote', path: '/old', host: 'devbox' }],
      createRunner: () => runner,
      getReachability: () => ({ reachability: 'unreachable', lastError: 'connect timeout' }),
    });
    const res = await request(app).put('/api/projects/remote').send({ path: '/new' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'host unreachable', host: 'devbox' });
    expect(runner.run).not.toHaveBeenCalled();
    expect(state.projects[0].path).toBe('/old');
  });

  it('returns 503 when a remote path change cannot be validated (host unreachable)', async () => {
    const { app, state } = makeApp({
      projects: [{ name: 'a', path: '/srv/app', host: 'devbox' }],
      createRunner: () => remoteRunner({ transportError: true }),
    });
    const res = await request(app).put('/api/projects/a').send({ path: '/srv/app2' });
    expect(res.status).toBe(503);
    expect(state.projects[0].path).toBe('/srv/app');
  });

  it('rejects renaming a project to a name another project already uses', async () => {
    const { app } = makeApp({
      projects: [{ name: 'a', path: '/tmp/a' }, { name: 'b', path: '/tmp/b' }],
    });
    const res = await request(app).put('/api/projects/a').send({ name: 'b' });
    expect(res.status).toBe(409);
  });

  it('applies shelf/waiting fields without touching name/path (unchanged)', async () => {
    const { app, state } = makeApp({ projects: [{ name: 'a', path: '/tmp/a' }] });
    const res = await request(app).put('/api/projects/a').send({ shelved: true, shelvedAt: 't1' });
    expect(res.status).toBe(200);
    expect(state.projects[0]).toMatchObject({ shelved: true, shelvedAt: 't1' });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/:name — unchanged
// ---------------------------------------------------------------------------

describe('DELETE /api/projects/:name', () => {
  it('removes the project (unchanged behavior)', async () => {
    const { app, state } = makeApp({ projects: [{ name: 'a', path: '/tmp/a' }] });
    const res = await request(app).delete('/api/projects/a');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(state.projects).toHaveLength(0);
  });
});
