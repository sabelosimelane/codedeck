import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { loopbackTestServer } from './helpers/loopback-test-server.js';
import { createTasksRouter } from '../routes/tasks.js';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService, TaskError } from '../tasks/task-service.js';
import { setTaskState, OWN_REPOSITORY } from './helpers/task-state.js';

const base = '/api/tasks';
const id = n => `7a${String(n).padStart(6, '0')}-0000-4000-8000-000000000000`;
const databases = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(db => db.close()); });

/** Real store and service; only Git and the terminal are replaced. */
async function setup({ openTerminal, landing, changes = [] } = {}) {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const db = new Database(':memory:');
  databases.push(db);
  let tick = 0;
  const taskStore = createTaskStore(db, { now: () => new Date(Date.UTC(2026, 10, 18, 10, 0, tick++)).toISOString() });
  let created = 0;
  const real = createTaskService({ isRunWorking: () => false, taskStore, findProject: () => null, execFile: () => {}, startSession: async () => ({ id: 'Demo-1' }), pathExists: async () => true });
  const service = {
    create: vi.fn(async ({ project, title, repositories }) => {
      if (repositories !== undefined && (!Array.isArray(repositories) || repositories.includes('nope'))) throw new TaskError('One or more fields failed validation.', 400, [{ field: 'repositories', message: 'nope is not a repository of this project' }]);
      if (typeof project !== 'string' || !project) throw new TaskError('One or more fields failed validation.', 400, [{ field: 'project', message: 'A project name is required' }]);
      if (typeof title !== 'string' || !title.trim() || title.length > 80) throw new TaskError('One or more fields failed validation.', 400, [{ field: 'title', message: 'Use 1–80 characters on one line' }]);
      if (project === 'Nope') throw new TaskError('Project not found', 404);
      created += 1;
      return taskStore.create({ ...OWN_REPOSITORY, id: id(created), project, title, worktreePath: `/tmp/worktrees/t-${created}`, branch: `task/t-${created}`, baseBranch: 'main', baseCommit: 'a'.repeat(40), titleSource: 'owner' });
    }),
    get: real.get,
    rename: real.rename,
    openTerminal: openTerminal ?? real.openTerminal,
    // Stands in for Git: records the worktree the real service would have created, and refuses what it would refuse.
    addRepository: vi.fn(async (taskId, body) => {
      const task = real.get(taskId);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new TaskError('One or more fields failed validation.', 400, [{ field: 'body', message: 'Use an object with repository' }]);
      const unknown = Object.keys(body).filter(field => field !== 'repository');
      if (unknown.length) throw new TaskError('One or more fields failed validation.', 400, unknown.map(field => ({ field, message: 'Unknown field' })));
      if (typeof body.repository !== 'string' || !['mobile-app', 'frontend'].includes(body.repository)) throw new TaskError('One or more fields failed validation.', 400, [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]);
      if (task.worktrees.some(worktree => worktree.repository === body.repository)) throw new TaskError(`${body.repository} is already part of this task.`, 409);
      return { ...taskStore.addWorktree(taskId, { repository: body.repository, repositoryPath: `/tmp/group/${body.repository}`, worktreePath: `/tmp/worktrees/${taskId}-${body.repository}`, branch: 'task/t-1', baseBranch: 'main', baseCommit: 'b'.repeat(40) }), secretColumn: 'never shown' };
    }),
  };
  const app = express();
  const refused = (message, extra) => Object.assign(new TaskError(message, 409), { extra });
  const land = {
    status: vi.fn(async taskId => { real.get(taskId); return { taskId, state: 'active', uncommittedCount: 0, blockers: { commit: [], merge: [], pullRequest: [], close: [] } }; }),
    commit: vi.fn(async (taskId, { message }) => {
      real.get(taskId);
      if (typeof message !== 'string' || !message.trim() || message.length > 200) throw new TaskError('One or more fields failed validation.', 400, [{ field: 'message', message: 'Use 1–200 characters on one line' }]);
      return { taskId, uncommittedCount: 0, commitsAhead: 1 };
    }),
    merge: vi.fn(async taskId => {
      const task = real.get(taskId);
      if (task.title === 'Conflict') throw refused('This task conflicts with main in 1 file. Nothing was merged.', { conflicts: ['shared.txt'] });
      if (task.title === 'Dirty') throw refused('This task has uncommitted changes. Commit them first.', { reasons: [{ code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }] });
      return { task: { ...setTaskState(taskStore, taskId, { state: 'merged' }), secretColumn: 'never shown' }, mergedInto: 'main', filesRemoved: true, filesDetail: null, branchDeleted: true, terminalsClosed: ['Demo-2'], terminalsNotClosed: [] };
    }),
    pullRequest: vi.fn(async (taskId, { remote }) => {
      real.get(taskId);
      if (typeof remote !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(remote)) throw new TaskError('One or more fields failed validation.', 400, [{ field: 'remote', message: 'Use the name of one of the project remotes' }]);
      if (remote === 'down') throw new TaskError('The branch could not be pushed to down: timeout', 503);
      return { task: setTaskState(taskStore, taskId, { state: 'pr_open', prUrl: 'https://example.test/pr/1' }), prUrl: 'https://example.test/pr/1', remote };
    }),
    close: vi.fn(async taskId => { real.get(taskId); return { task: setTaskState(taskStore, taskId, { state: 'closed' }), branchKept: 'task/t-1', unmergedCommits: 2, terminalsClosed: [], terminalsNotClosed: ['Demo-3'] }; }),
    worktrees: vi.fn(async taskId => real.get(taskId).worktrees.map(worktree => ({
      taskId, worktreeId: worktree.id, repository: worktree.repository, own: worktree.own, first: worktree.first, worktreePath: worktree.worktreePath,
      state: worktree.state, branch: worktree.branch, baseBranch: worktree.baseBranch, prUrl: worktree.prUrl, filesPresent: true, runActive: false,
      uncommitted: ['a.txt'], uncommittedCount: 1, commitsAhead: 2, commitsBehind: 0, alreadyInBase: false, ignoredAtRisk: ['logs/'], ignoredAtRiskCount: 1, main: { branch: 'main', dirty: false, secret: 'never shown' },
      remotes: [{ name: 'origin', host: 'github.com', tool: 'gh', url: 'never shown' }],
      blockers: { commit: [], merge: [{ code: 'uncommitted', message: 'Commit first.', internal: 'never shown' }], pullRequest: [], close: [] },
      secretColumn: 'never shown',
    }))),
    closeWorktree: vi.fn(async (taskId, worktreeId) => {
      const task = real.get(taskId);
      return { task: { ...taskStore.setWorktreeState(taskId, worktreeId, { state: 'closed' }), secretColumn: 'never shown' }, repository: task.worktrees.find(worktree => worktree.id === worktreeId).repository,
        branchKept: 'task/t-1', unmergedCommits: 1, taskFinished: false, terminalsClosed: ['Demo-4'], terminalsNotClosed: [] };
    }),
    ...landing,
  };
  // Stands in for the changes read from tasks, runs and notes: the rows a test gives, or what its function returns.
  const changeList = { list: vi.fn(() => (typeof changes === 'function' ? changes() : changes)) };
  app.use(createTasksRouter({ service, taskStore, landing: land, changes: changeList }));
  return { server: await loopbackTestServer(app), service, taskStore, landing: land, changes: changeList };
}

function expectProblem(response, status, path = base) {
  expect(response.status).toBe(status);
  expect(response.type).toBe('application/problem+json');
  expect(response.body).toMatchObject({ type: 'about:blank', status, path, traceId: response.headers['x-trace-id'], timestamp: expect.any(String), error: expect.any(String), message: expect.any(String), title: expect.any(String), detail: expect.any(String) });
  expect(JSON.stringify(response.body)).not.toMatch(/at .*\.js:\d+|SELECT |tasks row/);
}

describe('tasks API', () => {
  it('creates a task and returns exactly its public fields', async () => {
    const { server } = await setup();
    const response = await request(server).post(base).send({ project: 'Demo', title: 'WhatsApp replies' });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: id(1), project: 'Demo', title: 'WhatsApp replies', state: 'active',
      worktreePath: '/tmp/worktrees/t-1', branch: 'task/t-1', baseBranch: 'main', baseCommit: 'a'.repeat(40),
      prUrl: null, revision: 1, createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:00:00.000Z', finishedAt: null,
      folder: null,
      worktrees: [{
        id: expect.stringMatching(/^[0-9a-f-]{36}$/), repository: 'demo', own: true, first: true,
        worktreePath: '/tmp/worktrees/t-1', branch: 'task/t-1', baseBranch: 'main', baseCommit: 'a'.repeat(40), state: 'active', prUrl: null,
      }],
    });
    expect((await request(server).get(`${base}/${id(1)}`)).body).toEqual(response.body);
    // What the released phone and desktop read from a task is still there, with the same meaning.
    for (const field of ['id', 'project', 'title', 'state', 'worktreePath', 'branch', 'baseBranch', 'baseCommit', 'prUrl', 'revision', 'createdAt', 'updatedAt', 'finishedAt']) {
      expect(response.body).toHaveProperty(field);
    }
  });

  it('creates a separate task for each identical request', async () => {
    const { server } = await setup();
    const [first, second] = await Promise.all([
      request(server).post(base).send({ project: 'Demo', title: 'Twice' }),
      request(server).post(base).send({ project: 'Demo', title: 'Twice' }),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.id).not.toBe(second.body.id);
    expect((await request(server).get(base)).body.page.totalElements).toBe(2);
  });

  it.each([
    [{}, ['project']],
    [{ project: null, title: 'x' }, ['project']],
    [{ project: '', title: 'x' }, ['project']],
    [{ project: 12, title: 'x' }, ['project']],
    [{ project: 'Demo' }, ['title']],
    [{ project: 'Demo', title: '' }, ['title']],
    [{ project: 'Demo', title: null }, ['title']],
    [{ project: 'Demo', title: [] }, ['title']],
    [{ project: 'Demo', title: 'x'.repeat(81) }, ['title']],
    [{ project: 'Demo', title: 'x', extra: true }, ['extra']],
    [[], ['body']],
  ])('refuses invalid create body %j', async (body, fields) => {
    const { server, taskStore } = await setup();
    const response = await request(server).post(base).send(body);
    expectProblem(response, 400);
    expect(response.body.errors.map(error => error.field)).toEqual(fields);
    expect(taskStore.list()).toEqual([]);
  });

  it('accepts a title at the length limit and stores hostile text as text', async () => {
    const { server } = await setup();
    expect((await request(server).post(base).send({ project: 'Demo', title: 'x'.repeat(80) })).status).toBe(201);
    const hostile = "<script>alert(1)</script>'; DROP TABLE tasks;--";
    const response = await request(server).post(base).send({ project: 'Demo', title: hostile });
    expect(response.status).toBe(201);
    expect(response.type).toBe('application/json');
    expect((await request(server).get(base)).body.data.map(task => task.title)).toContain(hostile);
  });

  it('refuses malformed JSON and oversized bodies', async () => {
    const { server } = await setup();
    expectProblem(await request(server).post(base).set('Content-Type', 'application/json').send('{"project":'), 400);
    const large = await request(server).post(base).send({ project: 'Demo', title: 'x'.repeat(5000) });
    expectProblem(large, 413);
  });

  it('returns 404 for an unknown project, task and path', async () => {
    const { server } = await setup();
    expectProblem(await request(server).post(base).send({ project: 'Nope', title: 'x' }), 404);
    expectProblem(await request(server).get(`${base}/${id(9)}`), 404, `${base}/${id(9)}`);
    expectProblem(await request(server).get(`${base}/not-a-uuid`), 404, `${base}/not-a-uuid`);
    expectProblem(await request(server).delete(`${base}/${id(9)}`), 404, `${base}/${id(9)}`);
  });

  it('lists tasks in a paginated envelope, newest first', async () => {
    const { server } = await setup();
    for (const title of ['one', 'two', 'three']) await request(server).post(base).send({ project: 'Demo', title });
    const first = await request(server).get(`${base}?size=2`);
    expect(first.status).toBe(200);
    expect(first.body.data.map(task => task.title)).toEqual(['three', 'two']);
    expect(first.body.page).toEqual({ currentPage: 0, size: 2, totalElements: 3, totalPages: 2, hasNextPage: true });
    const second = await request(server).get(`${base}?size=2&page=1`);
    expect(second.body.data.map(task => task.title)).toEqual(['one']);
    expect(second.body.page).toEqual({ currentPage: 1, size: 2, totalElements: 3, totalPages: 2, hasNextPage: false });
    expect((await request(server).get(base)).body.page.size).toBe(20);
  });

  it('sorts deterministically across a page boundary when values tie', async () => {
    const { server } = await setup();
    for (let n = 0; n < 3; n += 1) await request(server).post(base).send({ project: 'Demo', title: 'same' });
    const pages = await Promise.all([0, 1, 2].map(page => request(server).get(`${base}?sort=title,asc&size=1&page=${page}`)));
    expect(pages.map(page => page.body.data[0].id)).toEqual([id(1), id(2), id(3)]);
  });

  it('filters by project, state and open', async () => {
    const { server, taskStore } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'a' });
    await request(server).post(base).send({ project: 'Other', title: 'b' });
    await request(server).post(base).send({ project: 'Demo', title: 'c' });
    setTaskState(taskStore, id(3), { state: 'merged' });
    setTaskState(taskStore, id(1), { state: 'pr_open', prUrl: 'https://example.test/pr/1' });
    const titles = async query => (await request(server).get(`${base}?${query}`)).body.data.map(task => task.title);
    expect(await titles('project=Demo')).toEqual(['c', 'a']);
    expect(await titles('state=merged')).toEqual(['c']);
    expect(await titles('open=true')).toEqual(['b', 'a']);
    expect(await titles('open=false&project=Demo')).toEqual(['c']);
    expect(await titles('project=Nobody')).toEqual([]);
  });

  it.each([
    ['page=-1', 'page'], ['page=x', 'page'], ['size=0', 'size'], ['size=101', 'size'], ['size=', 'size'],
    ['sort=branch,asc', 'sort'], ['sort=title', 'sort'], ['sort=title,asc,x', 'sort'],
    ['state=done', 'state'], ['open=yes', 'open'], ['project=', 'project'], ['worktreePath=/tmp', 'worktreePath'],
  ])('refuses list query %s', async (query, field) => {
    const { server } = await setup();
    const response = await request(server).get(`${base}?${query}`);
    expectProblem(response, 400);
    expect(response.body.errors.map(error => error.field)).toEqual([field]);
  });

  it('accepts the size limits', async () => {
    const { server } = await setup();
    expect((await request(server).get(`${base}?size=1`)).status).toBe(200);
    expect((await request(server).get(`${base}?size=100`)).status).toBe(200);
  });

  it('renames a task and refuses a stale or invalid rename', async () => {
    const { server } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'Before' });
    const url = `${base}/${id(1)}`;
    const renamed = await request(server).put(url).send({ title: 'After', revision: 1 });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ title: 'After', revision: 2 });
    expectProblem(await request(server).put(url).send({ title: 'Late', revision: 1 }), 409, url);
    for (const [body, fields] of [
      [{ title: '', revision: 2 }, ['title']],
      [{ title: null, revision: 2 }, ['title']],
      [{ title: 'x', revision: '2' }, ['revision']],
      [{ title: 'x' }, ['revision']],
      [{ title: 'x', revision: 0 }, ['revision']],
      [{ revision: 'x' }, ['title', 'revision']],
      [{ title: 'x', revision: 2, state: 'merged' }, ['state']],
    ]) {
      const response = await request(server).put(url).send(body);
      expectProblem(response, 400, url);
      expect(response.body.errors.map(error => error.field)).toEqual(fields);
    }
    expectProblem(await request(server).put(`${base}/${id(9)}`).send({ title: 'x', revision: 1 }), 404, `${base}/${id(9)}`);
  });

  it('opens a terminal in the task', async () => {
    const openTerminal = vi.fn(async taskId => ({ sessionId: 'Demo-4', taskId, project: 'Demo' }));
    const { server } = await setup({ openTerminal });
    await request(server).post(base).send({ project: 'Demo', title: 'Terminal' });
    const response = await request(server).post(`${base}/${id(1)}/terminals`);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ sessionId: 'Demo-4', taskId: id(1), project: 'Demo' });
    expect(openTerminal).toHaveBeenCalledWith(id(1), {});
  });

  it('reports terminal refusals and refuses a body', async () => {
    const { server, taskStore } = await setup();
    const url = `${base}/${id(1)}/terminals`;
    expectProblem(await request(server).post(url), 404, url);
    await request(server).post(base).send({ project: 'Demo', title: 'Terminal' });
    const withBody = await request(server).post(url).send({ cwd: '/etc' });
    expectProblem(withBody, 400, url);
    expect(withBody.body.errors.map(error => error.field)).toEqual(['cwd']);
    setTaskState(taskStore, id(1), { state: 'closed' });
    expectProblem(await request(server).post(url), 409, url);
  });

  it('hides the cause of an unexpected failure', async () => {
    const { server } = await setup({ openTerminal: async () => { throw new Error('SELECT secret FROM internals'); } });
    await request(server).post(base).send({ project: 'Demo', title: 'Boom' });
    const response = await request(server).post(`${base}/${id(1)}/terminals`);
    expectProblem(response, 500, `${base}/${id(1)}/terminals`);
    expect(response.body.message).toBe('Task request failed');
  });

  it('reports how a task stands for landing', async () => {
    const { server } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'Land me' });
    const url = `${base}/${id(1)}/landing`;
    const response = await request(server).get(url);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ taskId: id(1), state: 'active', blockers: { merge: [] } });
    const bad = await request(server).get(`${url}?verbose=1`);
    expectProblem(bad, 400, url);
    expect(bad.body.errors.map(error => error.field)).toEqual(['verbose']);
    expectProblem(await request(server).get(`${base}/${id(9)}/landing`), 404, `${base}/${id(9)}/landing`);
  });

  it('commits with a message and refuses a bad one', async () => {
    const { server, landing } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'Commit me' });
    const url = `${base}/${id(1)}/commit`;
    const done = await request(server).post(url).send({ message: 'Add replies' });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ taskId: id(1), uncommittedCount: 0, commitsAhead: 1 });
    expect(landing.commit).toHaveBeenCalledWith(id(1), { message: 'Add replies' });
    expect((await request(server).post(url).send({ message: 'x'.repeat(200) })).status).toBe(200);
    for (const [body, fields] of [[{}, ['message']], [{ message: '' }, ['message']], [{ message: null }, ['message']], [{ message: 'x'.repeat(201) }, ['message']], [{ message: 'x', amend: true }, ['amend']], [[], ['body']]]) {
      const response = await request(server).post(url).send(body);
      expectProblem(response, 400, url);
      expect(response.body.errors.map(error => error.field)).toEqual(fields);
    }
    expectProblem(await request(server).post(`${base}/${id(9)}/commit`).send({ message: 'x' }), 404, `${base}/${id(9)}/commit`);
  });

  it('merges a task and returns only its public fields', async () => {
    const { server } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'Merge me' });
    const url = `${base}/${id(1)}/merge`;
    const response = await request(server).post(url);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ mergedInto: 'main', filesRemoved: true, branchDeleted: true, terminalsClosed: ['Demo-2'], terminalsNotClosed: [], task: { id: id(1), state: 'merged' } });
    expect(response.body.task).not.toHaveProperty('secretColumn');
    const withBody = await request(server).post(url).send({ force: true });
    expectProblem(withBody, 400, url);
    expect(withBody.body.errors.map(error => error.field)).toEqual(['force']);
  });

  it('says why a merge was refused: the reasons, or the conflicting files', async () => {
    const { server } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'Dirty' });
    await request(server).post(base).send({ project: 'Demo', title: 'Conflict' });
    const dirty = await request(server).post(`${base}/${id(1)}/merge`);
    expectProblem(dirty, 409, `${base}/${id(1)}/merge`);
    expect(dirty.body.reasons).toEqual([{ code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }]);
    const conflict = await request(server).post(`${base}/${id(2)}/merge`);
    expectProblem(conflict, 409, `${base}/${id(2)}/merge`);
    expect(conflict.body).toMatchObject({ message: 'This task conflicts with main in 1 file. Nothing was merged.', conflicts: ['shared.txt'] });
  });

  it('opens a pull request on a named remote and reports an unreachable one as 503', async () => {
    const { server } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'PR me' });
    const url = `${base}/${id(1)}/pull-request`;
    for (const [body, fields] of [[{}, ['remote']], [{ remote: '' }, ['remote']], [{ remote: '--force' }, ['remote']], [{ remote: 12 }, ['remote']], [{ remote: 'origin', draft: true }, ['draft']]]) {
      const response = await request(server).post(url).send(body);
      expectProblem(response, 400, url);
      expect(response.body.errors.map(error => error.field)).toEqual(fields);
    }
    expectProblem(await request(server).post(url).send({ remote: 'down' }), 503, url);
    const opened = await request(server).post(url).send({ remote: 'origin' });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ prUrl: 'https://example.test/pr/1', remote: 'origin', task: { state: 'pr_open', prUrl: 'https://example.test/pr/1' } });
  });

  it('closes a task and says which branch was kept', async () => {
    const { server } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'Close me' });
    const response = await request(server).post(`${base}/${id(1)}/close`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ branchKept: 'task/t-1', unmergedCommits: 2, terminalsClosed: [], terminalsNotClosed: ['Demo-3'], task: { state: 'closed' } });
    expect((await request(server).get(`${base}?open=true`)).body.data).toEqual([]);
    expectProblem(await request(server).post(`${base}/${id(9)}/close`), 404, `${base}/${id(9)}/close`);
  });

  it('requires its dependencies', () => {
    expect(() => createTasksRouter({})).toThrow('service.create');
    const { service, taskStore, landing } = { service: Object.fromEntries(['create', 'get', 'rename', 'openTerminal', 'addRepository'].map(name => [name, () => {}])), taskStore: { list: () => [] }, landing: Object.fromEntries(['status', 'commit', 'merge', 'pullRequest', 'close', 'worktrees', 'closeWorktree'].map(name => [name, () => {}])) };
    expect(() => createTasksRouter({ service, taskStore, landing })).toThrow('changes.list');
  });
});

describe('tasks API — the repositories of a task', () => {
  const second = { repository: 'mobile-app', repositoryPath: '/tmp/group/mobile-app', worktreePath: '/tmp/worktrees/t-1-mobile', branch: 'task/t-1', baseBranch: 'main', baseCommit: 'b'.repeat(40) };
  async function withTask(options) {
    const ctx = await setup(options);
    await request(ctx.server).post(base).send({ project: 'Demo', title: 'Across' });
    const task = ctx.taskStore.addWorktree(id(1), second);
    return { ...ctx, task, firstId: task.worktrees[0].id, secondId: task.worktrees[1].id };
  }

  it('creates a task in the repositories asked for', async () => {
    const { server, service } = await setup();
    const response = await request(server).post(base).send({ project: 'Demo', title: 'Across', repositories: ['mobile-app', 'backend'] });
    expect(response.status).toBe(201);
    expect(service.create).toHaveBeenCalledWith({ project: 'Demo', title: 'Across', repositories: ['mobile-app', 'backend'] });
    // Without the field the request is what it always was.
    await request(server).post(base).send({ project: 'Demo', title: 'Alone' });
    expect(service.create).toHaveBeenLastCalledWith({ project: 'Demo', title: 'Alone', repositories: undefined });
  });

  it.each([
    [{ repositories: ['nope'] }], [{ repositories: 'backend' }], [{ repositories: null }], [{ repositories: {} }],
  ])('refuses %j with the field to fix', async (fields) => {
    const { server } = await setup();
    const response = await request(server).post(base).send({ project: 'Demo', title: 'Across', ...fields });
    expectProblem(response, 400);
    expect(response.body.errors.map(error => error.field)).toEqual(['repositories']);
  });

  it('returns every repository of a task with it', async () => {
    const { server, firstId, secondId } = await withTask();
    const response = await request(server).get(`${base}/${id(1)}`);
    expect(response.body.worktrees).toEqual([
      { id: firstId, repository: 'demo', own: true, first: true, worktreePath: '/tmp/worktrees/t-1', branch: 'task/t-1', baseBranch: 'main', baseCommit: 'a'.repeat(40), state: 'active', prUrl: null },
      { id: secondId, repository: 'mobile-app', own: false, first: false, worktreePath: '/tmp/worktrees/t-1-mobile', branch: 'task/t-1', baseBranch: 'main', baseCommit: 'b'.repeat(40), state: 'active', prUrl: null },
    ]);
    // Where a repository's checkout is on disk is not part of a task's public fields.
    expect(JSON.stringify(response.body)).not.toContain('/tmp/group/mobile-app');
    expect(response.body.worktreePath).toBe('/tmp/worktrees/t-1');
  });

  it('opens a terminal in the repository asked for', async () => {
    const openTerminal = vi.fn(async (taskId, { worktreeId }) => ({ sessionId: 'Demo-7', taskId, project: 'Demo', worktreeId: worktreeId ?? 'first' }));
    const { server, secondId } = await withTask({ openTerminal });
    const url = `${base}/${id(1)}/terminals`;
    const named = await request(server).post(url).send({ worktreeId: secondId });
    expect(named.status).toBe(201);
    expect(named.body).toEqual({ sessionId: 'Demo-7', taskId: id(1), project: 'Demo', worktreeId: secondId });
    expect(openTerminal).toHaveBeenLastCalledWith(id(1), { worktreeId: secondId });
    expect((await request(server).post(url)).body.worktreeId).toBe('first');
    expect((await request(server).post(url).send({})).body.worktreeId).toBe('first');
    const unknown = await request(server).post(url).send({ worktreeId: secondId, cwd: '/etc' });
    expectProblem(unknown, 400, url);
    expect(unknown.body.errors.map(error => error.field)).toEqual(['cwd']);
  });

  it('refuses a terminal in a repository the task does not have', async () => {
    const { server } = await withTask();
    const url = `${base}/${id(1)}/terminals`;
    for (const worktreeId of ['7b000000-0000-4000-8000-000000000099', 'nope', 7, null, '']) {
      const response = await request(server).post(url).send({ worktreeId });
      expectProblem(response, 400, url);
      expect(response.body.errors).toEqual([{ field: 'worktreeId', message: 'Use the id of one of this task\'s worktrees' }]);
    }
  });

  it('lists how each repository of a task stands, in a paginated envelope with only public fields', async () => {
    const { server, firstId, secondId } = await withTask();
    const url = `${base}/${id(1)}/worktrees`;
    const response = await request(server).get(url);
    expect(response.status).toBe(200);
    expect(response.body.page).toEqual({ currentPage: 0, size: 20, totalElements: 2, totalPages: 1, hasNextPage: false });
    expect(response.body.data.map(entry => [entry.repository, entry.worktreeId])).toEqual([['demo', firstId], ['mobile-app', secondId]]);
    expect(response.body.data[1]).toEqual({
      taskId: id(1), worktreeId: secondId, repository: 'mobile-app', own: false, first: false, worktreePath: '/tmp/worktrees/t-1-mobile',
      state: 'active', branch: 'task/t-1', baseBranch: 'main', prUrl: null, filesPresent: true, runActive: false,
      uncommitted: ['a.txt'], uncommittedCount: 1, commitsAhead: 2, commitsBehind: 0, alreadyInBase: false, ignoredAtRisk: ['logs/'], ignoredAtRiskCount: 1, main: { branch: 'main', dirty: false },
      remotes: [{ name: 'origin', host: 'github.com', tool: 'gh' }],
      blockers: { commit: [], merge: [{ code: 'uncommitted', message: 'Commit first.' }], pullRequest: [], close: [] },
    });
    expect(JSON.stringify(response.body)).not.toContain('never shown');
    const paged = await request(server).get(`${url}?size=1&page=1&sort=repository,asc`);
    expect(paged.body.data.map(entry => entry.repository)).toEqual(['mobile-app']);
    expect(paged.body.page).toEqual({ currentPage: 1, size: 1, totalElements: 2, totalPages: 2, hasNextPage: false });
    expect((await request(server).get(`${url}?sort=repository,desc`)).body.data.map(entry => entry.repository)).toEqual(['mobile-app', 'demo']);
  });

  it.each([
    ['size=0', 'size'], ['size=101', 'size'], ['page=-1', 'page'], ['sort=branch,asc', 'sort'], ['sort=repository', 'sort'], ['state=active', 'state'],
  ])('refuses the worktrees query %s', async (query, field) => {
    const { server } = await withTask();
    const url = `${base}/${id(1)}/worktrees`;
    const response = await request(server).get(`${url}?${query}`);
    expectProblem(response, 400, url);
    expect(response.body.errors.map(error => error.field)).toEqual([field]);
  });

  it('reports an unknown task when its repositories are asked for', async () => {
    const { server } = await setup();
    const url = `${base}/${id(9)}/worktrees`;
    expectProblem(await request(server).get(url), 404, url);
    expectProblem(await request(server).get(`${base}/nope/worktrees`), 404, `${base}/nope/worktrees`);
  });

  it('commits, merges, opens a pull request for and closes one repository of a task', async () => {
    const { server, landing, secondId } = await withTask();
    const root = `${base}/${id(1)}/worktrees/${secondId}`;

    // The landing of one repository answers with how that repository stands afterwards.
    landing.commit.mockImplementationOnce(async (taskId, { worktreeId }) => (await landing.worktrees(taskId)).find(view => view.worktreeId === worktreeId));
    const committed = await request(server).post(`${root}/commit`).send({ message: 'Mobile part' });
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({ worktreeId: secondId, repository: 'mobile-app' });
    expect(JSON.stringify(committed.body)).not.toContain('never shown');
    expect(landing.commit).toHaveBeenLastCalledWith(id(1), { message: 'Mobile part', worktreeId: secondId });

    const opened = await request(server).post(`${root}/pull-request`).send({ remote: 'origin' });
    expect(opened.status).toBe(200);
    expect(landing.pullRequest).toHaveBeenLastCalledWith(id(1), { remote: 'origin', worktreeId: secondId });
    expect(opened.body.task.id).toBe(id(1));

    const merged = await request(server).post(`${root}/merge`);
    expect(merged.status).toBe(200);
    expect(landing.merge).toHaveBeenLastCalledWith(id(1), { worktreeId: secondId });
    expect(merged.body.task).not.toHaveProperty('secretColumn');
  });

  it('passes the owner\'s word about ignored files to Close, and refuses anything but true or false', async () => {
    const { server, landing, secondId } = await withTask();
    const whole = `${base}/${id(1)}/close`;
    const one = `${base}/${id(1)}/worktrees/${secondId}/close`;
    for (const [url, value] of [[whole, 'yes'], [whole, null], [whole, 1], [one, 'yes'], [one, []]]) {
      const bad = await request(server).post(url).send({ deleteIgnored: value });
      expectProblem(bad, 400, url);
      expect(bad.body.errors).toEqual([{ field: 'deleteIgnored', message: 'Use true or false' }]);
    }
    const unknown = await request(server).post(whole).send({ deleteIgnored: true, force: true });
    expectProblem(unknown, 400, whole);
    expect(unknown.body.errors.map(error => error.field)).toEqual(['force']);
    expect(landing.close).not.toHaveBeenCalled();
    expect(landing.closeWorktree).not.toHaveBeenCalled();

    expect((await request(server).post(one).send({ deleteIgnored: true })).status).toBe(200);
    expect(landing.closeWorktree).toHaveBeenLastCalledWith(id(1), secondId, { deleteIgnored: true });
    expect((await request(server).post(whole).send({ deleteIgnored: false })).status).toBe(200);
    expect(landing.close).toHaveBeenLastCalledWith(id(1), { deleteIgnored: false });
  });

  it('closes one repository and returns only the task\'s public fields', async () => {
    const { server, landing, secondId } = await withTask();
    const url = `${base}/${id(1)}/worktrees/${secondId}/close`;
    const response = await request(server).post(url);
    expect(response.status).toBe(200);
    expect(landing.closeWorktree).toHaveBeenCalledWith(id(1), secondId);
    expect(response.body).toMatchObject({ repository: 'mobile-app', branchKept: 'task/t-1', unmergedCommits: 1, taskFinished: false, terminalsClosed: ['Demo-4'], terminalsNotClosed: [] });
    expect(response.body.task.worktrees.map(worktree => worktree.state)).toEqual(['active', 'closed']);
    expect(response.body.task).not.toHaveProperty('secretColumn');
  });

  it('refuses bodies the worktree actions do not take, and paths it does not serve', async () => {
    const { server, landing, secondId } = await withTask();
    const root = `${base}/${id(1)}/worktrees/${secondId}`;
    for (const [action, body, field] of [['merge', { force: true }, 'force'], ['close', { force: true }, 'force'], ['commit', { message: 'x', amend: true }, 'amend'], ['pull-request', { remote: 'origin', draft: true }, 'draft']]) {
      const response = await request(server).post(`${root}/${action}`).send(body);
      expectProblem(response, 400, `${root}/${action}`);
      expect(response.body.errors.map(error => error.field)).toEqual([field]);
    }
    expect(landing.merge).not.toHaveBeenCalled();
    expect(landing.closeWorktree).not.toHaveBeenCalled();
    expectProblem(await request(server).post(`${root}/force-push`), 404, `${root}/force-push`);
    expectProblem(await request(server).post(`${root}/commit`).send({}), 400, `${root}/commit`);
  });

  it('passes on why a repository could not be landed', async () => {
    const refusal = Object.assign(new TaskError('mobile-app has uncommitted changes in this task. Commit them first.', 409), { extra: { reasons: [{ code: 'uncommitted', message: 'mobile-app has uncommitted changes in this task. Commit them first.' }] } });
    const { server, secondId } = await withTask({ landing: { closeWorktree: vi.fn(async () => { throw refusal; }), merge: vi.fn(async () => { throw new TaskError('This task has no such repository.', 404); }) } });
    const closed = await request(server).post(`${base}/${id(1)}/worktrees/${secondId}/close`);
    expectProblem(closed, 409, `${base}/${id(1)}/worktrees/${secondId}/close`);
    expect(closed.body.reasons).toEqual(refusal.extra.reasons);
    expectProblem(await request(server).post(`${base}/${id(1)}/worktrees/nope/merge`), 404, `${base}/${id(1)}/worktrees/nope/merge`);
  });

  it('adds a repository to a task and returns the task with it, once', async () => {
    const { server, service } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'Across' });
    const url = `${base}/${id(1)}/worktrees`;
    const added = await request(server).post(url).send({ repository: 'mobile-app' });
    expect(added.status).toBe(201);
    expect(added.body.worktrees.map(worktree => [worktree.repository, worktree.first])).toEqual([['demo', true], ['mobile-app', false]]);
    expect(added.body).not.toHaveProperty('secretColumn');
    expect(JSON.stringify(added.body)).not.toContain('/tmp/group/mobile-app');
    expect(service.addRepository).toHaveBeenCalledWith(id(1), { repository: 'mobile-app' });
    // The same request again adds nothing.
    expectProblem(await request(server).post(url).send({ repository: 'mobile-app' }), 409, url);
    expect((await request(server).get(`${base}/${id(1)}`)).body.worktrees).toHaveLength(2);
  });

  it('adds one worktree when the same repository is asked for twice at once', async () => {
    const { server } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'Across' });
    const url = `${base}/${id(1)}/worktrees`;
    const responses = await Promise.all([request(server).post(url).send({ repository: 'frontend' }), request(server).post(url).send({ repository: 'frontend' })]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect((await request(server).get(`${base}/${id(1)}`)).body.worktrees).toHaveLength(2);
  });

  it.each([
    ['a missing name', {}, ['repository']],
    ['null', { repository: null }, ['repository']],
    ['an empty name', { repository: '' }, ['repository']],
    ['a number', { repository: 7 }, ['repository']],
    ['a repository the project does not list', { repository: 'tools' }, ['repository']],
    ['a path', { repository: '../../etc/passwd' }, ['repository']],
    ['markup', { repository: '<script>alert(1)</script>' }, ['repository']],
    ['a name of 5000 characters', { repository: 'r'.repeat(5000) }, null],
    ['an unknown field', { repository: 'frontend', branch: 'main' }, ['branch']],
    ['a list', [], ['body']],
  ])('refuses to add %s', async (_name, body, fields) => {
    const { server } = await setup();
    await request(server).post(base).send({ project: 'Demo', title: 'Across' });
    const url = `${base}/${id(1)}/worktrees`;
    const response = await request(server).post(url).send(body);
    if (fields === null) {
      // Larger than the router's 4 KB body limit.
      expectProblem(response, 413, url);
    } else {
      expectProblem(response, 400, url);
      expect(response.body.errors.map(error => error.field)).toEqual(fields);
    }
    expect(JSON.stringify(response.body)).not.toMatch(/<script>|passwd/);
    expect((await request(server).get(`${base}/${id(1)}`)).body.worktrees).toHaveLength(1);
  });

  it('reports an unknown task and malformed JSON when a repository is added', async () => {
    const { server } = await setup();
    const url = `${base}/${id(9)}/worktrees`;
    expectProblem(await request(server).post(url).send({ repository: 'frontend' }), 404, url);
    expectProblem(await request(server).post(url).set('Content-Type', 'application/json').send('{"repository":'), 400, url);
  });

  it('requires the landing of single repositories', () => {
    const landing = { status() {}, commit() {}, merge() {}, pullRequest() {}, close() {} };
    expect(() => createTasksRouter({ service: { create() {}, get() {}, rename() {}, openTerminal() {}, addRepository() {} }, taskStore: { list() {} }, landing })).toThrow('tasks router requires landing.worktrees');
    expect(() => createTasksRouter({ service: { create() {}, get() {}, rename() {}, openTerminal() {} }, taskStore: { list() {} }, landing })).toThrow('tasks router requires service.addRepository');
  });
});

describe('tasks API — changes', () => {
  const change = (n, extra = {}) => ({
    id: id(n), project: 'Demo', title: `Change ${n}`, mergedAt: new Date(Date.UTC(2026, 10, 19, 10, 0, n)).toISOString(), workflow: 'Bug fix',
    summary: `Summary ${n}`, detail: `# Summary ${n}\nBody`,
    repositories: [{ repository: 'demo', branch: `task/t-${n}`, baseBranch: 'main', commit: 'c'.repeat(40), mergedAt: new Date(Date.UTC(2026, 10, 19, 10, 0, n)).toISOString(), secret: 'never shown' }],
    secretColumn: 'never shown', ...extra,
  });
  const url = `${base}/changes`;

  it('lists changes in a paginated envelope, newest merge first, with exactly their public fields', async () => {
    const { server } = await setup({ changes: [change(1), change(3), change(2)] });
    const first = await request(server).get(`${url}?size=2`);
    expect(first.status).toBe(200);
    expect(first.headers['x-trace-id']).toEqual(expect.any(String));
    expect(first.body.data.map(item => item.title)).toEqual(['Change 3', 'Change 2']);
    expect(first.body.page).toEqual({ currentPage: 0, size: 2, totalElements: 3, totalPages: 2, hasNextPage: true });
    expect(first.body.data[0]).toEqual({
      id: id(3), project: 'Demo', title: 'Change 3', mergedAt: '2026-11-19T10:00:03.000Z', workflow: 'Bug fix', summary: 'Summary 3', detail: '# Summary 3\nBody',
      repositories: [{ repository: 'demo', branch: 'task/t-3', baseBranch: 'main', commit: 'c'.repeat(40), mergedAt: '2026-11-19T10:00:03.000Z' }],
    });
    const second = await request(server).get(`${url}?size=2&page=1`);
    expect(second.body.data.map(item => item.title)).toEqual(['Change 1']);
    expect(second.body.page).toEqual({ currentPage: 1, size: 2, totalElements: 3, totalPages: 2, hasNextPage: false });
    expect((await request(server).get(url)).body.page.size).toBe(20);
    expect((await request(server).get(`${url}?sort=mergedAt,asc`)).body.data.map(item => item.title)).toEqual(['Change 1', 'Change 2', 'Change 3']);
  });

  it('returns an empty page when nothing was merged, and past the last page', async () => {
    const { server } = await setup();
    const empty = await request(server).get(url);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ data: [], page: { currentPage: 0, size: 20, totalElements: 0, totalPages: 0, hasNextPage: false } });
    const { server: one } = await setup({ changes: [change(1)] });
    expect((await request(one).get(`${url}?page=5`)).body).toMatchObject({ data: [], page: { currentPage: 5, totalElements: 1, hasNextPage: false } });
  });

  it('sorts deterministically across a page boundary when merge times tie', async () => {
    const at = '2026-11-19T10:00:00.000Z';
    const { server } = await setup({ changes: [change(2, { mergedAt: at }), change(3, { mergedAt: at }), change(1, { mergedAt: at })] });
    const pages = await Promise.all([0, 1, 2].map(page => request(server).get(`${url}?size=1&page=${page}`)));
    expect(pages.map(page => page.body.data[0].id)).toEqual([id(1), id(2), id(3)]);
  });

  it('filters by project, and treats a hostile project name as a name', async () => {
    const { server } = await setup({ changes: [change(1), change(2, { project: 'Other' }), change(3)] });
    const titles = async query => (await request(server).get(`${url}?${query}`)).body.data.map(item => item.title);
    expect(await titles('project=Demo')).toEqual(['Change 3', 'Change 1']);
    expect(await titles('project=Other')).toEqual(['Change 2']);
    expect(await titles('project=Nobody')).toEqual([]);
    expect(await titles(`project=${encodeURIComponent("Demo' OR '1'='1")}`)).toEqual([]);
  });

  it('returns a change without a summary, a workflow or a commit, and hostile text as text', async () => {
    const hostile = '<script>alert(1)</script>';
    const { server } = await setup({ changes: [
      change(1, { workflow: null, summary: null, detail: null, repositories: [{ repository: 'demo', branch: 'task/t-1', baseBranch: null, commit: null, mergedAt: '2026-11-19T10:00:01.000Z' }] }),
      change(2, { summary: hostile, detail: hostile }),
    ] });
    const response = await request(server).get(url);
    expect(response.type).toBe('application/json');
    expect(response.body.data[0]).toMatchObject({ summary: hostile, detail: hostile });
    expect(response.body.data[1]).toMatchObject({ workflow: null, summary: null, detail: null, repositories: [{ baseBranch: null, commit: null }] });
  });

  it.each([
    ['page=-1', 'page'], ['page=x', 'page'], ['page=100001', 'page'], ['size=0', 'size'], ['size=101', 'size'], ['size=', 'size'], ['size=1.5', 'size'],
    ['sort=title,asc', 'sort'], ['sort=mergedAt', 'sort'], ['sort=mergedAt,desc,x', 'sort'], ['sort=', 'sort'],
    ['project=', 'project'], ['state=merged', 'state'], ['repository=demo', 'repository'],
  ])('refuses changes query %s', async (query, field) => {
    const { server, changes } = await setup({ changes: [change(1)] });
    const response = await request(server).get(`${url}?${query}`);
    expectProblem(response, 400, url);
    expect(response.body.errors.map(error => error.field)).toEqual([field]);
    expect(changes.list).not.toHaveBeenCalled();
  });

  it('accepts the page and size limits', async () => {
    const { server } = await setup({ changes: [change(1)] });
    expect((await request(server).get(`${url}?size=1`)).status).toBe(200);
    expect((await request(server).get(`${url}?size=100`)).status).toBe(200);
    expect((await request(server).get(`${url}?page=0`)).status).toBe(200);
    expect((await request(server).get(`${url}?page=100000`)).status).toBe(200);
  });

  it('gives the same answer to the same request sent twice at once', async () => {
    const { server } = await setup({ changes: [change(1), change(2)] });
    const [a, b] = await Promise.all([request(server).get(url), request(server).get(url)]);
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
  });

  it('is not read as a task id, and serves only GET', async () => {
    const { server, service } = await setup({ changes: [change(1)] });
    await request(server).get(url);
    expect(service.create).not.toHaveBeenCalled();
    expectProblem(await request(server).post(url).send({}), 404, url);
    expectProblem(await request(server).get(`${url}/${id(1)}`), 404, `${url}/${id(1)}`);
  });

  it('hides the cause when the changes cannot be read', async () => {
    const { server } = await setup({ changes: () => { throw new Error('task changes: run nope field id'); } });
    const response = await request(server).get(url);
    expectProblem(response, 500, url);
    expect(response.body.message).toBe('Task request failed');
    expect(JSON.stringify(response.body)).not.toContain('nope');
  });
});
