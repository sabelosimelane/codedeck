import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { loopbackTestServer } from '../helpers/loopback-test-server.js';
import { createAgentSessionsRouter } from '../../routes/agent-sessions.js';

const id = '11111111-1111-4111-8111-111111111111';
const id2 = '22222222-2222-4222-8222-222222222222';
const base = '/api/agent-sessions';

function setup({
  projects = [
    { name: 'Demo', path: '/one', host: 'local' },
    { name: 'Remote', path: '/remote', host: 'box' },
  ],
  localRecords = [{ cli: 'claude', conversationId: id, title: 'Hello', firstPrompt: 'Prompt', cwd: '/one', updatedAt: 100 }],
  remoteByHost = {
    box: {
      sources: [{ cli: 'claude', available: true }],
      records: [{ cli: 'claude', conversationId: id2, title: 'Remote chat', firstPrompt: 'Hi', cwd: '/remote', updatedAt: 200, host: 'box' }],
    },
  },
  start = async (projectName) => ({ id: `${projectName}-1` }),
  submit = async () => {},
  materialize = async () => ({ synced: true }),
} = {}) {
  const history = {
    search: (cwds) => ({
      data: localRecords.filter(r => cwds.includes(r.cwd)),
      page: { currentPage: 0, size: 20, totalElements: localRecords.length, totalPages: 1, hasNextPage: false },
      sources: [{ cli: 'claude', available: true }],
    }),
  };
  const remoteHistory = {
    listHost: async (hostName, cwds) => {
      const entry = remoteByHost[hostName];
      if (entry instanceof Error) throw entry;
      if (!entry) return { host: hostName, available: true, error: null, sources: [], records: [] };
      return {
        host: hostName,
        available: true,
        error: null,
        sources: entry.sources ?? [],
        records: (entry.records ?? []).filter(r => cwds.includes(r.cwd)),
      };
    },
    invalidate: vi.fn(),
  };
  const app = express();
  app.use(createAgentSessionsRouter({
    loadProjects: () => projects,
    history,
    remoteHistory,
    materializeSession: materialize,
    startSession: start,
    submitCommand: submit,
  }));
  return { serverPromise: loopbackTestServer(app), remoteHistory };
}

describe('agent sessions API (cross-host)', () => {
  it('consolidates local and remote projects sorted newest first with host metadata', async () => {
    const { serverPromise } = setup();
    const res = await request(await serverPromise).get(base);
    expect(res.status).toBe(200);
    expect(res.body.data.map(r => [r.project, r.host, r.conversationId])).toEqual([
      ['Remote', 'box', id2],
      ['Demo', 'local', id],
    ]);
    expect(res.body.hosts).toEqual([
      { host: 'local', available: true, error: null },
      { host: 'box', available: true, error: null },
    ]);
  });

  it('filters by host query param while still returning all hosts metadata', async () => {
    const { serverPromise } = setup();
    const res = await request(await serverPromise).get(base).query({ host: 'box' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ project: 'Remote', host: 'box', conversationId: id2 });
  });

  it('deduplicates same (cli, conversationId) across multi-host project locations keeping newest updatedAt', async () => {
    const projects = [{
      name: 'Unified',
      defaultHost: 'local',
      locations: [
        { host: 'local', path: '/local/unified' },
        { host: 'box', path: '/remote/unified' },
      ],
    }];
    const { serverPromise } = setup({
      projects,
      localRecords: [{ cli: 'claude', conversationId: id, title: 'Older local', firstPrompt: null, cwd: '/local/unified', updatedAt: 100 }],
      remoteByHost: {
        box: {
          sources: [{ cli: 'claude', available: true }],
          records: [{ cli: 'claude', conversationId: id, title: 'Newer remote', firstPrompt: null, cwd: '/remote/unified', updatedAt: 500, host: 'box' }],
        },
      },
    });
    const res = await request(await serverPromise).get(base).query({ project: 'Unified' });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ title: 'Newer remote', host: 'box', updatedAt: 500 });
    expect(res.body.data[0].availableHosts).toEqual(['local', 'box']);
  });

  it('degrades gracefully when a remote host is unreachable in all-projects search, and returns 503 for a remote-only project', async () => {
    const { serverPromise } = setup({ remoteByHost: { box: new Error('host unreachable') } });
    const server = await serverPromise;

    const allRes = await request(server).get(base);
    expect(allRes.status).toBe(200);
    expect(allRes.body.data).toHaveLength(1);
    expect(allRes.body.data[0].project).toBe('Demo');
    expect(allRes.body.hosts).toContainEqual({ host: 'box', available: false, error: 'host unreachable' });

    const remoteOnly = await request(server).get(base).query({ project: 'Remote' });
    expect(remoteOnly.status).toBe(503);
  });

  it('materializes session on demand when resuming onto a different host and invalidates target cache', async () => {
    const projects = [{
      name: 'Unified',
      defaultHost: 'local',
      locations: [
        { host: 'local', path: '/local/unified' },
        { host: 'box', path: '/remote/unified' },
      ],
    }];
    const materialize = vi.fn(async () => ({ synced: true }));
    const start = vi.fn(async () => ({ id: 'Unified-3' }));
    const submit = vi.fn(async () => {});
    const { serverPromise, remoteHistory } = setup({
      projects,
      localRecords: [],
      remoteByHost: {
        box: {
          sources: [{ cli: 'claude', available: true }],
          records: [{ cli: 'claude', conversationId: id2, title: 'From box', firstPrompt: null, cwd: '/remote/unified', updatedAt: 500, host: 'box' }],
        },
      },
      materialize,
      start,
      submit,
    });

    const res = await request(await serverPromise)
      .post(`${base}/resume`)
      .send({ cli: 'claude', conversationId: id2, project: 'Unified', host: 'local' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sessionId: 'Unified-3',
      project: 'Unified',
      host: 'local',
      cli: 'claude',
      conversationId: id2,
      synced: true,
    });
    expect(materialize).toHaveBeenCalledWith({
      cli: 'claude',
      conversationId: id2,
      sourceHost: 'box',
      sourceCwd: '/remote/unified',
      targetHost: 'local',
      targetCwd: '/local/unified',
    });
    expect(start).toHaveBeenCalledWith('Unified', { host: 'local' });
    expect(submit).toHaveBeenCalledWith('Unified-3', `claude --resume ${id2}`, { host: 'local' });
    expect(remoteHistory.invalidate).toHaveBeenCalledWith('local');
  });

  it('skips materialization when session is already newest on target host and passes host to start/submit', async () => {
    const materialize = vi.fn(async () => ({ synced: true }));
    const start = vi.fn(async () => ({ id: 'Remote-7' }));
    const submit = vi.fn(async () => {});
    const { serverPromise } = setup({ materialize, start, submit });

    const res = await request(await serverPromise)
      .post(`${base}/resume`)
      .send({ cli: 'claude', conversationId: id2, project: 'Remote' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sessionId: 'Remote-7', project: 'Remote', host: 'box', synced: false });
    expect(materialize).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith('Remote', { host: 'box' });
    expect(submit).toHaveBeenCalledWith('Remote-7', `claude --resume ${id2}`, { host: 'box' });
  });

  it('resumes a known conversation once and rejects an in-flight duplicate', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const { serverPromise } = setup({ start: async () => { await gate; return { id: 'Demo-1' }; } });
    const server = await serverPromise;
    const body = { cli: 'claude', conversationId: id, project: 'Demo' };
    const first = request(server).post(`${base}/resume`).send(body);
    const firstPending = first.then(x => x);
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await request(server).post(`${base}/resume`).send(body);
    expect(second.status).toBe(409);
    release();
    const result = await firstPending;
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ sessionId: 'Demo-1', host: 'local', synced: false, ...body });
  });

  it.each([{ page: -1 }, { size: 0 }, { size: 101 }, { sort: 'title' }, { cli: 'bogus' }, { q: 'x'.repeat(201) }, { unknown: 'x' }])('rejects invalid GET query %j', async query => {
    const { serverPromise } = setup();
    const res = await request(await serverPromise).get(base).query(query);
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expect.arrayContaining([{ field: expect.any(String), message: expect.any(String) }]));
    expect(res.body.traceId).toBe(res.headers['x-trace-id']);
  });

  it('returns 404 for unknown project or unknown conversation and 400/413 for malformed bodies', async () => {
    const { serverPromise } = setup();
    const server = await serverPromise;
    expect((await request(server).get(base).query({ project: 'missing' })).status).toBe(404);
    expect((await request(server).post(`${base}/resume`).type('application/json').send('{')).status).toBe(400);
    expect((await request(server).post(`${base}/resume`).send({ cli: 'claude', conversationId: id2, project: 'Demo' })).status).toBe(404);
    const tooLarge = await request(server).post(`${base}/resume`).set('Content-Type', 'application/json').send(JSON.stringify({ cli: 'claude', conversationId: id, project: 'Demo', padding: 'x'.repeat(5000) }));
    expect(tooLarge.status).toBe(413);
  });
});

describe('agent sessions API fault logging', () => {
  it('logs the cause of a server fault beside its trace id without exposing it to the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const app = express();
      app.use(createAgentSessionsRouter({
        loadProjects: () => [{ name: 'Demo', path: '/one', host: 'local' }],
        history: { search: () => { throw new Error('/store/x.jsonl:2: invalid JSON'); } },
        startSession: async () => ({ id: 'Demo-1' }),
        submitCommand: async () => {},
      }));
      const res = await request(await loopbackTestServer(app)).get(base);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('invalid JSON');
      expect(warn.mock.calls.flat().join(' ')).toContain(`traceId=${res.body.traceId}`);
      expect(warn.mock.calls.flat().join(' ')).toContain('/store/x.jsonl:2: invalid JSON');
    } finally { warn.mockRestore(); }
  });
});
