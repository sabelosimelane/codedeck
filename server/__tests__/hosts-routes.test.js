import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHostsRouter } from '../routes/hosts.js';

function makeApp({ hosts = [], projects = [], createRunner, now, saveHostsAndProjects, getReachability } = {}) {
  const state = { hosts: [...hosts], projects: [...projects] };
  const app = express();
  app.use(express.json());
  app.use(createHostsRouter({
    loadHosts: () => state.hosts,
    saveHosts: (h) => { state.hosts = h; },
    loadProjects: () => state.projects,
    saveProjects: (p) => { state.projects = p; },
    saveHostsAndProjects,
    createRunner,
    now,
    getReachability,
  }));
  return { app, state };
}

/** Fake runner whose `run` resolves/rejects per command for /test scenarios. */
function fakeRunner({ sshOk = true, tmuxOk = true } = {}) {
  const calls = [];
  return {
    calls,
    run: vi.fn((cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'tmux') {
        return tmuxOk ? Promise.resolve({ stdout: 'tmux 3.4\n', stderr: '' }) : Promise.reject(new Error('tmux: command not found'));
      }
      return sshOk ? Promise.resolve({ stdout: '', stderr: '' }) : Promise.reject(new Error('ssh: connect timeout'));
    }),
  };
}

// ---------------------------------------------------------------------------
// GET /api/hosts
// ---------------------------------------------------------------------------

describe('GET /api/hosts', () => {
  it('lists the built-in local host first, then stored hosts', async () => {
    const { app } = makeApp({ hosts: [{ name: 'devbox', sshTarget: 'devbox' }] });
    const res = await request(app).get('/api/hosts');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ name: 'local', sshTarget: null, builtIn: true, reachability: 'reachable' });
    expect(res.body[1]).toEqual({ name: 'devbox', sshTarget: 'devbox', builtIn: false, reachability: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// POST /api/hosts
// ---------------------------------------------------------------------------

describe('POST /api/hosts', () => {
  it('creates a host (201) that then appears in GET after local', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/api/hosts').send({ name: 'devbox', sshTarget: 'devbox' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ name: 'devbox', sshTarget: 'devbox' });

    const list = await request(app).get('/api/hosts');
    expect(list.body.map(h => h.name)).toEqual(['local', 'devbox']);
  });

  it.each(['local', 'LOCAL', 'Local'])('rejects the reserved name %j with 400', async (name) => {
    const { app } = makeApp();
    const res = await request(app).post('/api/hosts').send({ name, sshTarget: 'devbox' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it.each(['has space', 'evil;rm', '-leadingdash', 'pipe|x'])(
    'rejects an invalid sshTarget %j with 400',
    async (sshTarget) => {
      const { app } = makeApp();
      const res = await request(app).post('/api/hosts').send({ name: 'devbox', sshTarget });
      expect(res.status).toBe(400);
    }
  );

  it('rejects a missing name or sshTarget with 400', async () => {
    const { app } = makeApp();
    expect((await request(app).post('/api/hosts').send({ sshTarget: 'devbox' })).status).toBe(400);
    expect((await request(app).post('/api/hosts').send({ name: 'devbox' })).status).toBe(400);
  });

  it('rejects a duplicate name (case-insensitive) with 409', async () => {
    const { app } = makeApp({ hosts: [{ name: 'devbox', sshTarget: 'devbox' }] });
    const res = await request(app).post('/api/hosts').send({ name: 'DevBox', sshTarget: 'other' });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// PUT /api/hosts/:name
// ---------------------------------------------------------------------------

describe('PUT /api/hosts/:name', () => {
  it('returns 404 for an unknown host', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/api/hosts/ghost').send({ sshTarget: 'x' });
    expect(res.status).toBe(404);
  });

  it('rejects modifying the reserved local host with 400', async () => {
    const { app } = makeApp();
    const res = await request(app).put('/api/hosts/local').send({ sshTarget: 'x' });
    expect(res.status).toBe(400);
  });

  it('changes the sshTarget (200)', async () => {
    const { app, state } = makeApp({ hosts: [{ name: 'devbox', sshTarget: 'devbox' }] });
    const res = await request(app).put('/api/hosts/devbox').send({ sshTarget: 'devbox.new' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'devbox', sshTarget: 'devbox.new' });
    expect(state.hosts[0].sshTarget).toBe('devbox.new');
  });

  it('rejects renaming to a colliding name with 409', async () => {
    const { app } = makeApp({ hosts: [{ name: 'devbox', sshTarget: 'devbox' }, { name: 'prod', sshTarget: 'prod' }] });
    const res = await request(app).put('/api/hosts/devbox').send({ name: 'PROD' });
    expect(res.status).toBe(409);
  });

  it('renaming rewrites the host field on all referencing projects atomically', async () => {
    const { app, state } = makeApp({
      hosts: [{ name: 'devbox', sshTarget: 'devbox' }],
      projects: [
        { name: 'a', path: '/a', host: 'devbox' },
        { name: 'b', path: '/b', host: 'devbox' },
        { name: 'c', path: '/c' },
      ],
    });
    const res = await request(app).put('/api/hosts/devbox').send({ name: 'devbox-renamed' });
    expect(res.status).toBe(200);
    // Both configs are consistent after the single operation.
    expect(state.hosts).toEqual([{ name: 'devbox-renamed', sshTarget: 'devbox' }]);
    expect(state.projects.map(p => p.host)).toEqual(['devbox-renamed', 'devbox-renamed', undefined]);
  });

  it('persists hosts+projects in a single transactional write when a rename rewrites projects', async () => {
    const saveHostsAndProjects = vi.fn();
    const { app } = makeApp({
      hosts: [{ name: 'devbox', sshTarget: 'devbox' }],
      projects: [{ name: 'a', path: '/a', host: 'devbox' }],
      saveHostsAndProjects,
    });
    await request(app).put('/api/hosts/devbox').send({ name: 'devbox-renamed' });
    // The rename commits both configs atomically via the combined persist dep,
    // never two independent writes that could partially fail.
    expect(saveHostsAndProjects).toHaveBeenCalledTimes(1);
    const [hostsArg, projectsArg] = saveHostsAndProjects.mock.calls[0];
    expect(hostsArg).toEqual([{ name: 'devbox-renamed', sshTarget: 'devbox' }]);
    expect(projectsArg.map(p => p.host)).toEqual(['devbox-renamed']);
  });

  it('does NOT use the combined persist path when only the sshTarget changes (no rename)', async () => {
    const saveHostsAndProjects = vi.fn();
    const { app, state } = makeApp({
      hosts: [{ name: 'devbox', sshTarget: 'devbox' }],
      projects: [{ name: 'a', path: '/a', host: 'devbox' }],
      saveHostsAndProjects,
    });
    await request(app).put('/api/hosts/devbox').send({ sshTarget: 'devbox.new' });
    expect(saveHostsAndProjects).not.toHaveBeenCalled();
    expect(state.hosts).toEqual([{ name: 'devbox', sshTarget: 'devbox.new' }]);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/hosts/:name
// ---------------------------------------------------------------------------

describe('DELETE /api/hosts/:name', () => {
  it('returns 404 for an unknown host', async () => {
    const { app } = makeApp();
    expect((await request(app).delete('/api/hosts/ghost')).status).toBe(404);
  });

  it('rejects deleting the reserved local host with 400', async () => {
    const { app } = makeApp();
    expect((await request(app).delete('/api/hosts/local')).status).toBe(400);
  });

  it('deletes an unreferenced host (200)', async () => {
    const { app, state } = makeApp({ hosts: [{ name: 'devbox', sshTarget: 'devbox' }] });
    const res = await request(app).delete('/api/hosts/devbox');
    expect(res.status).toBe(200);
    expect(state.hosts).toEqual([]);
  });

  it('returns 409 and leaves the host intact while a project references it', async () => {
    const { app, state } = makeApp({
      hosts: [{ name: 'devbox', sshTarget: 'devbox' }],
      projects: [{ name: 'a', path: '/a', host: 'devbox' }],
    });
    const res = await request(app).delete('/api/hosts/devbox');
    expect(res.status).toBe(409);
    expect(state.hosts).toEqual([{ name: 'devbox', sshTarget: 'devbox' }]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/hosts/:name/test
// ---------------------------------------------------------------------------

describe('POST /api/hosts/:name/test', () => {
  it('returns 404 for an unknown host', async () => {
    const { app } = makeApp({ createRunner: () => fakeRunner() });
    expect((await request(app).post('/api/hosts/ghost/test')).status).toBe(404);
  });

  it('rejects testing the reserved local host with 400', async () => {
    const { app } = makeApp({ createRunner: () => fakeRunner() });
    expect((await request(app).post('/api/hosts/local/test')).status).toBe(400);
  });

  it('reports ssh + tmux both healthy (always 200)', async () => {
    let t = 100;
    const runner = fakeRunner({ sshOk: true, tmuxOk: true });
    const { app } = makeApp({
      hosts: [{ name: 'devbox', sshTarget: 'devbox' }],
      createRunner: () => runner,
      now: () => (t += 42),
    });
    const res = await request(app).post('/api/hosts/devbox/test');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sshOk: true, sshDetail: null, tmuxOk: true, tmuxDetail: null });
    expect(typeof res.body.latencyMs).toBe('number');
  });

  it('reports ssh ok but tmux missing, naming the host (always 200)', async () => {
    const runner = fakeRunner({ sshOk: true, tmuxOk: false });
    const { app } = makeApp({ hosts: [{ name: 'devbox', sshTarget: 'devbox' }], createRunner: () => runner });
    const res = await request(app).post('/api/hosts/devbox/test');
    expect(res.status).toBe(200);
    expect(res.body.sshOk).toBe(true);
    expect(res.body.tmuxOk).toBe(false);
    expect(res.body.tmuxDetail).toContain('devbox');
    expect(res.body.tmuxDetail).toMatch(/tmux/i);
  });

  it('fails fast with 503 and does not probe when live reachability is already unreachable', async () => {
    const runner = fakeRunner({ sshOk: true });
    const { app } = makeApp({
      hosts: [{ name: 'devbox', sshTarget: 'devbox' }],
      createRunner: () => runner,
      getReachability: () => ({ reachability: 'unreachable', lastError: 'connect timeout' }),
    });
    const res = await request(app).post('/api/hosts/devbox/test');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'host unreachable', host: 'devbox' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('reports ssh failure without probing tmux (always 200)', async () => {
    const runner = fakeRunner({ sshOk: false });
    const { app } = makeApp({ hosts: [{ name: 'devbox', sshTarget: 'devbox' }], createRunner: () => runner });
    const res = await request(app).post('/api/hosts/devbox/test');
    expect(res.status).toBe(200);
    expect(res.body.sshOk).toBe(false);
    expect(res.body.sshDetail).toBeTruthy();
    expect(res.body.tmuxOk).toBe(false);
    // tmux is never probed once ssh is unreachable.
    expect(runner.calls.some(c => c[0] === 'tmux')).toBe(false);
  });
});
