import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loopbackTestServer } from './helpers/loopback-test-server.js';
import { createTerminalWorktreesRouter } from '../routes/terminal-worktrees.js';
import { TerminalWorktreeError, createTerminalWorktreeService } from '../terminal-worktree-service.js';

const base = '/api/terminal-worktrees';
async function setup() {
  const service = { open: vi.fn(async ({ project, branch }) => ({ sessionId: 'Demo-1', project, branch, worktreePath: '/tmp/worktrees/repo-new', baseCommit: 'a'.repeat(40) })) };
  const app = express();
  app.use(createTerminalWorktreesRouter({ service }));
  return { server: await loopbackTestServer(app), service };
}

function expectProblem(response, status) {
  expect(response.status).toBe(status);
  expect(response.type).toBe('application/problem+json');
  expect(response.body).toMatchObject({ type: 'about:blank', status, path: base, traceId: response.headers['x-trace-id'], timestamp: expect.any(String), error: expect.any(String), message: expect.any(String), title: expect.any(String), detail: expect.any(String) });
}

describe('terminal worktrees API', () => {
  it('returns 201 and the exact service result', async () => {
    const { server, service } = await setup();
    const response = await request(server).post(base).send({ project: 'Demo', branch: 'new' });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ sessionId: 'Demo-1', project: 'Demo', branch: 'new', worktreePath: '/tmp/worktrees/repo-new', baseCommit: 'a'.repeat(40) });
    expect(service.open).toHaveBeenCalledWith({ project: 'Demo', branch: 'new' });
  });

  it.each([
    [{}, ['project', 'branch']],
    [{ project: null, branch: 'new' }, ['project']],
    [{ project: '', branch: 'new' }, ['project']],
    [{ project: [], branch: 'new' }, ['project']],
    [{ project: 12, branch: 'new' }, ['project']],
    [{ project: {}, branch: 'new' }, ['project']],
    [{ project: 'Demo', branch: null }, ['branch']],
    [{ project: 'Demo', branch: '' }, ['branch']],
    [{ project: 'Demo', branch: [] }, ['branch']],
    [{ project: 'Demo', branch: 12 }, ['branch']],
    [{ project: 'Demo', branch: {} }, ['branch']],
    [{ project: 12, branch: '--upload-pack=x' }, ['project', 'branch']],
    [{ project: 'Demo', branch: 'a<b' }, ['branch']],
    [{ project: 'Demo', branch: 'new', extra: true }, ['extra']],
    [[], ['body']],
  ])('returns field errors for invalid body %j', async (body, fields) => {
    const { server, service } = await setup();
    const response = await request(server).post(base).send(body);
    expectProblem(response, 400);
    expect(response.body.errors.map(error => error.field)).toEqual(fields);
    expect(service.open).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const { server } = await setup();
    const malformed = await request(server).post(base).type('application/json').send('{"project":');
    expectProblem(malformed, 400);
    expect(malformed.body.errors).toHaveLength(1);
    expectProblem(await request(server).post(base).send({ project: 'Demo', branch: 'a'.repeat(5000) }), 413);
  });

  it.each([500, 503])('logs the root cause with trace id while hiding it in a %i response', async status => {
    const { server, service } = await setup();
    const cause = Object.assign(new Error('private terminal start failure'), { status });
    service.open.mockRejectedValueOnce(new TerminalWorktreeError('The worktree was created, but its terminal could not be opened.', status, undefined, { cause }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await request(server).post(base).send({ project: 'Demo', branch: 'new' });
      expectProblem(response, status);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`traceId=${response.body.traceId} cause=private terminal start failure`));
      expect(JSON.stringify(response.body)).not.toContain('private terminal start failure');
    } finally { warn.mockRestore(); }
  });

  it('serializes simultaneous requests through the real router and service', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-worktree-api-')));
    const home = path.join(root, 'repo');
    try {
      mkdirSync(home);
      const git = (...args) => execFileSync('git', ['-C', home, ...args], { encoding: 'utf8' });
      git('init');
      git('config', 'user.email', 'test@example.org');
      git('config', 'user.name', 'Test');
      writeFileSync(path.join(home, 'README.md'), 'test\n');
      git('add', '.');
      git('commit', '-m', 'initial');
      const startSession = vi.fn(async () => ({ id: 'Demo-1' }));
      const service = createTerminalWorktreeService({ findProject: () => ({ name: 'Demo', path: home, host: 'local' }), execFile, startSession, pathExists: existsSync });
      const app = express();
      app.use(createTerminalWorktreesRouter({ service }));
      const server = await loopbackTestServer(app);
      const responses = await Promise.all([request(server).post(base).send({ project: 'Demo', branch: 'new' }), request(server).post(base).send({ project: 'Demo', branch: 'new' })]);
      expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
      expect(readdirSync(path.join(root, 'worktrees'))).toEqual(['repo-new']);
      expect(startSession).toHaveBeenCalledTimes(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('forwards known service errors and hides unexpected faults', async () => {
    const { server, service } = await setup();
    service.open.mockRejectedValueOnce(new TerminalWorktreeError('Project not found', 404));
    expectProblem(await request(server).post(base).send({ project: 'Demo', branch: 'new' }), 404);
    service.open.mockRejectedValueOnce(new Error('private cause'));
    const unexpected = await request(server).post(base).send({ project: 'Demo', branch: 'new' });
    expectProblem(unexpected, 500);
    expect(unexpected.body.message).not.toContain('private cause');
  });

  it('returns 404 for unknown paths under the base', async () => {
    const { server } = await setup();
    const response = await request(server).get(`${base}/unknown`);
    expect(response.status).toBe(404);
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
  });
});
