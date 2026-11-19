import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService } from '../tasks/task-service.js';
import { planTaskFolder } from '../pipelines/run-worktree.js';
import { git, groupFixture } from './helpers/group-fixture.js';
import { setTaskState } from './helpers/task-state.js';

const ID = '7a000000-0000-4000-8000-000000000001';
const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

/** A project whose own repository is `backend`, listing `mobile-app` and `frontend` (through its main worktree). */
async function setup({ exec = execFile, link = true, working = { now: false } } = {}) {
  const ctx = groupFixture();
  if (link) {
    await ctx.service.add('Demo', { path: ctx.mobile });
    await ctx.service.add('Demo', { path: ctx.frontendMain });
  }
  const db = new Database(':memory:');
  databases.push(db);
  const taskStore = createTaskStore(db);
  const start = vi.fn(async () => ({ id: 'Demo-3' }));
  const ids = [ID, '7a000000-0000-4000-8000-000000000002'];
  const service = createTaskService({
    isRunWorking: () => working.now,
    taskStore, findProject: ctx.findProject, execFile: exec, startSession: start,
    pathExists: async target => existsSync(target), newId: () => ids.shift(),
  });
  const folder = path.join(ctx.group, 'worktrees', 'whatsapp-replies-7a000000');
  return { ...ctx, taskStore, tasks: service, start, folder, working };
}

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a rejection');
}

describe('planTaskFolder', () => {
  it('names one folder for the task and one worktree per repository under its own name', () => {
    expect(planTaskFolder({ taskId: ID, title: 'WhatsApp replies', ownHomePath: '/git/group/backend', repositories: ['mobile-app', 'backend'] })).toEqual({
      folder: '/git/group/worktrees/whatsapp-replies-7a000000',
      branch: 'task/whatsapp-replies-7a000000',
      worktrees: [
        { repository: 'mobile-app', worktreePath: '/git/group/worktrees/whatsapp-replies-7a000000/mobile-app' },
        { repository: 'backend', worktreePath: '/git/group/worktrees/whatsapp-replies-7a000000/backend' },
      ],
    });
  });

  it('names a task whose title has no letters or digits by its id', () => {
    expect(planTaskFolder({ taskId: ID, title: '—', ownHomePath: '/git/group/backend', repositories: ['backend'] }))
      .toMatchObject({ folder: '/git/group/worktrees/7a000000', branch: 'task/7a000000' });
  });

  it.each([
    [{ taskId: 'nope' }, 'taskId'],
    [{ title: 7 }, 'title'],
    [{ ownHomePath: 'relative' }, 'ownHomePath'],
    [{ repositories: [] }, 'repositories'],
    [{ repositories: ['a/b'] }, 'repositories'],
    [{ repositories: ['a', 'a'] }, 'repositories'],
  ])('refuses %j', (fields, name) => {
    expect(() => planTaskFolder({ taskId: ID, title: 'x', ownHomePath: '/git/group/backend', repositories: ['backend'], ...fields })).toThrow(name);
  });
});

// Each test builds several real repositories and worktrees.
describe('a task across the repositories of a project', { timeout: 30_000 }, () => {
  it('keeps the folder a task has today for a project with no other repository', async () => {
    const { tasks, base, group } = await setup({ link: false });
    const task = await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
    expect(task).toMatchObject({ folder: null, worktreePath: path.join(group, 'worktrees', 'backend-whatsapp-replies-7a000000') });
    expect(task.worktrees).toHaveLength(1);
    expect(base).toBeTruthy();
  });

  it('gives a task of a project with other repositories its own folder, also with one repository', async () => {
    const { tasks, folder, backend } = await setup();
    const task = await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
    expect(task).toMatchObject({ folder, worktreePath: path.join(folder, 'backend'), branch: 'task/whatsapp-replies-7a000000', baseBranch: 'main', baseCommit: git(backend, ['rev-parse', 'HEAD']) });
    expect(task.worktrees).toMatchObject([{ repository: 'backend', own: true, first: true, repositoryPath: null }]);
    expect(git(path.join(folder, 'backend'), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/whatsapp-replies-7a000000');
  });

  it('creates a worktree and a branch in every repository asked for, side by side under their own names', async () => {
    const { tasks, folder, backend, mobile, frontend, frontendMain, taskStore } = await setup();
    const task = await tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories: ['mobile-app', 'backend', 'frontend'] });
    expect(task.folder).toBe(folder);
    expect(task.worktrees.map(worktree => [worktree.repository, worktree.own, worktree.first, worktree.repositoryPath, worktree.worktreePath])).toEqual([
      ['mobile-app', false, true, mobile, path.join(folder, 'mobile-app')],
      ['backend', true, false, null, path.join(folder, 'backend')],
      ['frontend', false, false, frontendMain, path.join(folder, 'frontend')],
    ]);
    // The task answers with the worktree it started in.
    expect(task.worktreePath).toBe(path.join(folder, 'mobile-app'));
    for (const worktree of task.worktrees) {
      expect(worktree.branch).toBe('task/whatsapp-replies-7a000000');
      expect(git(worktree.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/whatsapp-replies-7a000000');
    }
    // Each starts from the commit and branch of its repository's declared checkout.
    expect(task.worktrees[1]).toMatchObject({ baseBranch: 'main', baseCommit: git(backend, ['rev-parse', 'HEAD']) });
    expect(task.worktrees[2]).toMatchObject({ baseBranch: 'main', baseCommit: git(frontendMain, ['rev-parse', 'HEAD']) });
    expect(git(frontend, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/setup');
    // A reference from one repository to the one beside it resolves inside the task.
    expect(existsSync(path.resolve(folder, 'mobile-app', 'docs', '..', '..', 'backend', 'README.md'))).toBe(true);
    expect(taskStore.get(ID)).toEqual(task);
  });

  it('plans without touching disk', async () => {
    const { tasks, folder, taskStore, mobile } = await setup();
    const planned = await tasks.plan({ project: 'Demo', title: 'WhatsApp replies', titleSource: 'owner', repositories: ['mobile-app', 'backend'] });
    expect(planned).toMatchObject({
      id: ID, folder, worktreePath: path.join(folder, 'mobile-app'), branch: 'task/whatsapp-replies-7a000000', baseBranch: 'main',
      worktrees: [
        { repository: 'mobile-app', repositoryPath: mobile, checkoutPath: mobile, worktreePath: path.join(folder, 'mobile-app'), baseBranch: 'main' },
        { repository: 'backend', repositoryPath: null, worktreePath: path.join(folder, 'backend'), baseBranch: 'main' },
      ],
    });
    expect(existsSync(folder)).toBe(false);
    expect(taskStore.list()).toEqual([]);
  });

  it.each([
    ['an unknown repository', ['backend', 'nope'], 'nope is not a repository of this project'],
    ['no repository', [], 'Choose at least one repository'],
    ['a repository twice', ['backend', 'backend'], 'backend is listed twice'],
    ['something that is not a list', 'backend', 'Use a list of repository names'],
    ['a name that is not text', [7], 'Use a list of repository names'],
  ])('refuses %s', async (_name, repositories, message) => {
    const { tasks, folder, taskStore } = await setup();
    expect(await rejection(tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories })))
      .toMatchObject({ status: 400, errors: [{ field: 'repositories', message }] });
    expect(existsSync(folder)).toBe(false);
    expect(taskStore.list()).toEqual([]);
  });

  it('refuses a repository whose checkout Git can no longer use, and says which', async () => {
    const { tasks, setProjects, backend, base, folder } = await setup();
    setProjects([{ name: 'Demo', path: backend, repositories: [{ name: 'gone', path: path.join(base, 'gone') }] }]);
    expect(await rejection(tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories: ['backend', 'gone'] })))
      .toMatchObject({ status: 409, message: 'gone: The project path must be the top level of a git working tree.' });
    expect(existsSync(folder)).toBe(false);
  });

  it('leaves nothing behind when the worktree of a later repository cannot be created', async () => {
    const { tasks, folder, backend, mobile, taskStore } = await setup();
    // The branch the task would create already exists in mobile-app.
    git(mobile, ['branch', 'task/whatsapp-replies-7a000000']);
    const error = await rejection(tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories: ['backend', 'mobile-app'] }));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/^The copy of mobile-app could not be created: .*already exists/);
    expect(error.message).toMatch(/Nothing was kept\.$/);
    expect(existsSync(folder)).toBe(false);
    expect(git(backend, ['branch', '--list', 'task/whatsapp-replies-7a000000'])).toBe('');
    expect(git(backend, ['worktree', 'list']).split('\n')).toHaveLength(1);
    expect(taskStore.list()).toEqual([]);
  });

  it('keeps the task with the worktrees that exist when the undo is refused', async () => {
    const refusingRemoval = (file, args, options, callback) => (args.includes('remove')
      ? callback(Object.assign(new Error('remove refused'), { stderr: 'fatal: cannot remove' }), '', 'fatal: cannot remove')
      : execFile(file, args, options, callback));
    const { tasks, folder, mobile, taskStore } = await setup({ exec: refusingRemoval });
    git(mobile, ['branch', 'task/whatsapp-replies-7a000000']);
    const error = await rejection(tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories: ['backend', 'mobile-app'] }));
    expect(error.status).toBe(409);
    expect(error.message).toMatch(/^The copy of mobile-app could not be created: /);
    expect(error.message).toMatch(/The task was kept with backend, whose copy could not be removed again\.$/);
    expect(taskStore.get(ID).worktrees.map(worktree => worktree.repository)).toEqual(['backend']);
    expect(readdirSync(folder)).toEqual(['backend']);
  });

  describe('terminals', () => {
    it('opens a terminal in the worktree asked for, and in the one the task started in when none is', async () => {
      const { tasks, start, folder } = await setup();
      const task = await tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories: ['mobile-app', 'backend'] });
      expect(await tasks.openTerminal(ID)).toEqual({ sessionId: 'Demo-3', taskId: ID, project: 'Demo', worktreeId: task.worktrees[0].id });
      expect(start).toHaveBeenLastCalledWith('Demo', { cwd: path.join(folder, 'mobile-app') });
      expect(await tasks.openTerminal(ID, { worktreeId: task.worktrees[1].id })).toMatchObject({ worktreeId: task.worktrees[1].id });
      expect(start).toHaveBeenLastCalledWith('Demo', { cwd: path.join(folder, 'backend') });
    });

    it('opens in the oldest open worktree once the first is finished, and refuses a finished or unknown one', async () => {
      const { tasks, start, folder, taskStore } = await setup();
      const task = await tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories: ['mobile-app', 'backend'] });
      setTaskState(taskStore, ID, { state: 'closed' });
      expect(await tasks.openTerminal(ID)).toMatchObject({ worktreeId: task.worktrees[1].id });
      expect(start).toHaveBeenLastCalledWith('Demo', { cwd: path.join(folder, 'backend') });
      expect(await rejection(tasks.openTerminal(ID, { worktreeId: task.worktrees[0].id }))).toMatchObject({ status: 409, message: 'This repository of the task is finished.' });
      expect(await rejection(tasks.openTerminal(ID, { worktreeId: '7b000000-0000-4000-8000-000000000099' })))
        .toMatchObject({ status: 400, errors: [{ field: 'worktreeId', message: 'Use the id of one of this task\'s worktrees' }] });
      expect(await rejection(tasks.openTerminal(ID, { worktreeId: 7 }))).toMatchObject({ status: 400, errors: [{ field: 'worktreeId', message: 'Use the id of one of this task\'s worktrees' }] });
    });
  });

  describe('adding a repository to an open task', () => {
    it('gives the task a copy of the repository beside its others, on the task\'s branch, from the repository\'s current commit', async () => {
      const { tasks, folder, mobile, taskStore } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      const task = await tasks.addRepository(ID, { repository: 'mobile-app' });
      expect(task.worktrees.map(worktree => [worktree.repository, worktree.first, worktree.worktreePath, worktree.branch])).toEqual([
        ['backend', true, path.join(folder, 'backend'), 'task/whatsapp-replies-7a000000'],
        ['mobile-app', false, path.join(folder, 'mobile-app'), 'task/whatsapp-replies-7a000000'],
      ]);
      expect(task.worktrees[1]).toMatchObject({ own: false, repositoryPath: mobile, baseBranch: 'main', baseCommit: git(mobile, ['rev-parse', 'HEAD']), state: 'active' });
      expect(git(path.join(folder, 'mobile-app'), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/whatsapp-replies-7a000000');
      expect(taskStore.get(ID)).toEqual(task);
    });

    it('adds the same repository once when asked twice at once', async () => {
      const { tasks, taskStore } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      const outcomes = await Promise.allSettled([tasks.addRepository(ID, { repository: 'mobile-app' }), tasks.addRepository(ID, { repository: 'mobile-app' })]);
      expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(outcomes.find(outcome => outcome.status === 'rejected').reason).toMatchObject({ status: 409, message: 'mobile-app is already part of this task.' });
      expect(taskStore.get(ID).worktrees).toHaveLength(2);
    });

    it('names a copy the way the task\'s own is named when the task has no folder of its own', async () => {
      const { tasks, group, service, mobile } = await setup({ link: false });
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      // The project lists another repository only after the task was made.
      await service.add('Demo', { path: mobile });
      const task = await tasks.addRepository(ID, { repository: 'mobile-app' });
      expect(task.folder).toBeNull();
      expect(task.worktrees[1]).toMatchObject({ worktreePath: path.join(group, 'worktrees', 'mobile-app-whatsapp-replies-7a000000'), branch: 'task/whatsapp-replies-7a000000' });
    });

    it('refuses while a run is working in the task, and allows it once the run waits', async () => {
      const { tasks, working, taskStore } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      working.now = true;
      expect(await rejection(tasks.addRepository(ID, { repository: 'mobile-app' }))).toMatchObject({ status: 409, message: 'A workflow run is working in this task. Add the repository when it pauses or finishes.' });
      expect(taskStore.get(ID).worktrees).toHaveLength(1);
      working.now = false;
      expect((await tasks.addRepository(ID, { repository: 'mobile-app' })).worktrees).toHaveLength(2);
    });

    it('refuses a repository the task has or had, one the project does not list, and a finished or unknown task', async () => {
      const { tasks, taskStore } = await setup();
      const task = await tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories: ['backend', 'mobile-app'] });
      expect(await rejection(tasks.addRepository(ID, { repository: 'backend' }))).toMatchObject({ status: 409, message: 'backend is already part of this task.' });
      taskStore.setWorktreeState(ID, task.worktrees[1].id, { state: 'closed' });
      expect(await rejection(tasks.addRepository(ID, { repository: 'mobile-app' }))).toMatchObject({ status: 409, message: 'mobile-app was already merged or closed in this task and cannot be added again.' });
      expect(await rejection(tasks.addRepository(ID, { repository: 'tools' }))).toMatchObject({ status: 400, errors: [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }] });
      for (const body of [undefined, null, [], 'frontend']) {
        expect(await rejection(tasks.addRepository(ID, body))).toMatchObject({ status: 400, errors: [{ field: 'body', message: 'Use an object with repository' }] });
      }
      for (const repository of [undefined, null, '', 7, 'a/b']) {
        expect(await rejection(tasks.addRepository(ID, { repository }))).toMatchObject({ status: 400, errors: [{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }] });
      }
      expect(await rejection(tasks.addRepository(ID, { repository: 'frontend', branch: 'x' }))).toMatchObject({ status: 400, errors: [{ field: 'branch', message: 'Unknown field' }] });
      expect(await rejection(tasks.addRepository('7a000000-0000-4000-8000-000000000009', { repository: 'frontend' }))).toMatchObject({ status: 404 });
      taskStore.setWorktreeState(ID, task.worktrees[0].id, { state: 'closed' });
      expect(await rejection(tasks.addRepository(ID, { repository: 'frontend' }))).toMatchObject({ status: 409, message: 'This task is finished.' });
    });

    it('says why when the copy cannot be created, and adds nothing', async () => {
      const { tasks, mobile, folder, taskStore } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      git(mobile, ['branch', 'task/whatsapp-replies-7a000000']);
      const error = await rejection(tasks.addRepository(ID, { repository: 'mobile-app' }));
      expect(error.status).toBe(409);
      expect(error.message).toMatch(/^The copy of mobile-app could not be created: .*already exists\.$/);
      expect(existsSync(path.join(folder, 'mobile-app'))).toBe(false);
      expect(taskStore.get(ID).worktrees).toHaveLength(1);
    });
  });
});
