import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, promises as fsPromises, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService } from '../tasks/task-service.js';
import { planTaskFolder } from '../pipelines/run-worktree.js';
import { createHostRuntimeResolver } from '../host-runtime-resolver.js';
import { createMobileSessionStarter } from '../mobile-session-start.js';
import { getProjectLocation, normalizeHostName, normalizeProject } from '../project-config.js';
import { createTerminalSessionHostStore } from '../terminal-session-host-store.js';
import { createWorktreeSessionStarter } from '../terminal-session-worktree-start.js';
import { createTerminalSessionWorktreeStore } from '../terminal-session-worktree-store.js';
import { git, groupFixture } from './helpers/group-fixture.js';
import { setTaskState } from './helpers/task-state.js';

const ID = '7a000000-0000-4000-8000-000000000001';
const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

/** A project whose own repository is `backend`, listing `mobile-app` and `frontend` (through its main worktree). */
async function setup({ exec = execFile, link = true, working = { now: false }, runs = [], reserved = new Set() } = {}) {
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
    listRuns: () => runs, reservedWorktreePaths: () => reserved,
    taskStore, findProject: ctx.findProject, execFile: exec, startSession: start,
    pathExists: async target => existsSync(target), newId: () => ids.shift(),
  });
  const folder = path.join(ctx.group, 'worktrees', 'whatsapp-replies-7a000000');
  return { ...ctx, taskStore, tasks: service, start, folder, working, runs, reserved };
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
      expect(await tasks.openTerminal(ID)).toEqual({ sessionId: 'Demo-3', taskId: ID, project: 'Demo', host: 'local', worktreeId: task.worktrees[0].id });
      expect(start).toHaveBeenLastCalledWith('Demo', { cwd: path.join(folder, 'mobile-app'), host: 'local', skipSync: true });
      expect(await tasks.openTerminal(ID, { worktreeId: task.worktrees[1].id })).toMatchObject({ worktreeId: task.worktrees[1].id });
      expect(start).toHaveBeenLastCalledWith('Demo', { cwd: path.join(folder, 'backend'), host: 'local', skipSync: true });
    });

    it('opens in the oldest open worktree once the first is finished, and refuses a finished or unknown one', async () => {
      const { tasks, start, folder, taskStore } = await setup();
      const task = await tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories: ['mobile-app', 'backend'] });
      setTaskState(taskStore, ID, { state: 'closed' });
      expect(await tasks.openTerminal(ID)).toMatchObject({ worktreeId: task.worktrees[1].id });
      expect(start).toHaveBeenLastCalledWith('Demo', { cwd: path.join(folder, 'backend'), host: 'local', skipSync: true });
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
        expect(await rejection(tasks.addRepository(ID, body))).toMatchObject({ status: 400, errors: [{ field: 'body', message: 'Use an object with repository, path or worktreePath' }] });
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

  describe('adding a repository the project does not list to an open task', () => {
    const TOP_LEVEL = 'This folder is not the top level of a Git working tree';

    it('gives the task a copy of a repository from any folder, beside its others, and leaves the project\'s list alone', async () => {
      const { tasks, folder, tools, taskStore, stored } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      const listedBefore = JSON.stringify(stored());
      const task = await tasks.addRepository(ID, { path: tools });
      expect(task.worktrees.map(worktree => [worktree.repository, worktree.first, worktree.worktreePath, worktree.branch])).toEqual([
        ['backend', true, path.join(folder, 'backend'), 'task/whatsapp-replies-7a000000'],
        ['tools', false, path.join(folder, 'tools'), 'task/whatsapp-replies-7a000000'],
      ]);
      expect(task.worktrees[1]).toMatchObject({ own: false, repositoryPath: tools, baseBranch: 'main', baseCommit: git(tools, ['rev-parse', 'HEAD']), state: 'active' });
      expect(git(path.join(folder, 'tools'), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('task/whatsapp-replies-7a000000');
      expect(taskStore.get(ID)).toEqual(task);
      expect(JSON.stringify(stored())).toBe(listedBefore);
    });

    it('keeps the copy beside its own repository when the task has no folder of its own', async () => {
      const { tasks, base, tools } = await setup({ link: false });
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      const task = await tasks.addRepository(ID, { path: tools });
      expect(task.folder).toBeNull();
      expect(task.worktrees[1]).toMatchObject({ repository: 'tools', repositoryPath: tools, worktreePath: path.join(base, 'elsewhere', 'worktrees', 'tools-whatsapp-replies-7a000000') });
    });

    it('refuses a folder that is not a repository, one the project lists, a name already used, and more than one way of naming it', async () => {
      const { tasks, tools, notes, mobile, frontend, otherBackend, base, working, taskStore } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      for (const value of [undefined, null, '', 7, 'relative/tools', `${tools}\0`, `/${'a'.repeat(1024)}`]) {
        expect(await rejection(tasks.addRepository(ID, { path: value }))).toMatchObject({ status: 400, errors: [{ field: 'path', message: 'Use the absolute path of a folder' }] });
      }
      expect(await rejection(tasks.addRepository(ID, { path: path.join(base, 'nowhere') }))).toMatchObject({ status: 400, errors: [{ field: 'path', message: 'This folder does not exist' }] });
      mkdirSync(path.join(tools, 'src'));
      for (const folder of [notes, path.join(tools, 'src'), path.join(tools, 'README.md')]) {
        expect(await rejection(tasks.addRepository(ID, { path: folder }))).toMatchObject({ status: 400, errors: [{ field: 'path', message: TOP_LEVEL }] });
      }
      // A repository of the project is added by its name, whichever of its folders is given.
      expect(await rejection(tasks.addRepository(ID, { path: mobile }))).toMatchObject({ status: 409, message: 'This folder belongs to mobile-app, a repository of this project. Add it from the list.' });
      expect(await rejection(tasks.addRepository(ID, { path: frontend }))).toMatchObject({ status: 409, message: 'This folder belongs to frontend, a repository of this project. Add it from the list.' });
      expect(await rejection(tasks.addRepository(ID, { path: otherBackend }))).toMatchObject({ status: 409, message: 'Another repository of this project is already called backend.' });
      const both = { message: 'Give one of repository, path and worktreePath' };
      expect(await rejection(tasks.addRepository(ID, { repository: 'mobile-app', path: tools }))).toMatchObject({ status: 400, errors: [{ field: 'repository', ...both }, { field: 'path', ...both }] });
      expect(await rejection(tasks.addRepository(ID, { path: tools, worktreePath: tools }))).toMatchObject({ status: 400, errors: [{ field: 'path', ...both }, { field: 'worktreePath', ...both }] });
      working.now = true;
      expect(await rejection(tasks.addRepository(ID, { path: tools }))).toMatchObject({ status: 409, message: 'A workflow run is working in this task. Add the repository when it pauses or finishes.' });
      working.now = false;
      expect(taskStore.get(ID).worktrees).toHaveLength(1);
      await tasks.addRepository(ID, { path: tools });
      expect(await rejection(tasks.addRepository(ID, { path: tools }))).toMatchObject({ status: 409, message: 'tools is already part of this task.' });
    });
  });

  describe('adding an existing worktree to an open task', () => {
    /** A worktree made by hand beside its repository, with a commit of its own and a file Git does not track. */
    function handMade(repo, name, branch = `feat/${name}`) {
      const made = path.join(path.dirname(repo), 'worktrees', name);
      git(repo, ['worktree', 'add', '-q', '-b', branch, made]);
      writeFileSync(path.join(made, 'work.txt'), 'work\n');
      git(made, ['add', 'work.txt']);
      git(made, ['commit', '-q', '-m', 'work']);
      writeFileSync(path.join(made, 'scratch.txt'), 'not tracked\n');
      return made;
    }

    it('takes a worktree of a repository the project does not list as it is, landing in that repository\'s own checkout', async () => {
      const { tasks, tools, taskStore, folder } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      const made = handMade(tools, 'tools-meter');
      const head = git(made, ['rev-parse', 'HEAD']);
      const task = await tasks.addRepository(ID, { worktreePath: made });
      expect(task.worktrees[1]).toMatchObject({
        repository: 'tools', own: false, first: false, repositoryPath: tools, worktreePath: made,
        branch: 'feat/tools-meter', baseBranch: 'main', baseCommit: git(tools, ['rev-parse', 'HEAD']), state: 'active',
      });
      expect(taskStore.get(ID)).toEqual(task);
      // Nothing in it was touched, and no copy was made in the task's folder.
      expect(git(made, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(made, ['status', '--porcelain'])).toBe('?? scratch.txt');
      expect(existsSync(path.join(folder, 'tools'))).toBe(false);
    });

    it('knows a worktree of one of the project\'s repositories by that repository', async () => {
      const { tasks, mobile, backend } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies', repositories: ['frontend'] });
      const ofMobile = handMade(mobile, 'mobile-meter');
      const ofBackend = handMade(backend, 'backend-meter');
      await tasks.addRepository(ID, { worktreePath: ofMobile });
      const task = await tasks.addRepository(ID, { worktreePath: ofBackend });
      expect(task.worktrees.slice(1).map(worktree => [worktree.repository, worktree.own, worktree.repositoryPath, worktree.worktreePath, worktree.baseBranch])).toEqual([
        ['mobile-app', false, mobile, ofMobile, 'main'],
        ['backend', true, null, ofBackend, 'main'],
      ]);
    });

    it('refuses a folder that is not a worktree made for the work', async () => {
      const { tasks, tools, notes, base, frontendMain, mobile, taskStore } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      for (const value of [undefined, null, '', 7, 'relative/tools', `${tools}\0`]) {
        expect(await rejection(tasks.addRepository(ID, { worktreePath: value }))).toMatchObject({ status: 400, errors: [{ field: 'worktreePath', message: 'Use the absolute path of a worktree' }] });
      }
      expect(await rejection(tasks.addRepository(ID, { worktreePath: path.join(base, 'nowhere') }))).toMatchObject({ status: 400, errors: [{ field: 'worktreePath', message: 'This folder does not exist' }] });
      expect(await rejection(tasks.addRepository(ID, { worktreePath: notes }))).toMatchObject({ status: 400, errors: [{ field: 'worktreePath', message: 'This folder is not the top level of a Git working tree' }] });
      const own = 'This folder is the checkout its repository is kept in, not a worktree made for this work. Add it as a repository to give the task a copy of it.';
      for (const checkout of [tools, mobile, frontendMain]) {
        expect(await rejection(tasks.addRepository(ID, { worktreePath: checkout }))).toMatchObject({ status: 409, message: own });
      }
      const detached = handMade(tools, 'tools-detached');
      git(detached, ['checkout', '-q', '--detach']);
      expect(await rejection(tasks.addRepository(ID, { worktreePath: detached }))).toMatchObject({ status: 409, message: 'No branch is checked out in this worktree.' });
      const orphan = handMade(tools, 'tools-orphan');
      git(orphan, ['checkout', '-q', '--orphan', 'unrelated']);
      git(orphan, ['commit', '-q', '-m', 'unrelated']);
      expect(await rejection(tasks.addRepository(ID, { worktreePath: orphan }))).toMatchObject({ status: 409, message: 'The worktree branch has no common base with the checkout.' });
      expect(taskStore.get(ID).worktrees).toHaveLength(1);
    });

    it('refuses a worktree whose repository has no base branch checked out', async () => {
      const { tasks, tools } = await setup();
      await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      const made = handMade(tools, 'tools-meter');
      git(tools, ['checkout', '-q', '--detach']);
      expect(await rejection(tasks.addRepository(ID, { worktreePath: made }))).toMatchObject({ status: 409, message: 'No base branch is checked out in the repository.' });
    });

    it('refuses a worktree a task or a run already has, a repository the task already has, and a working run', async () => {
      const { tasks, tools, otherBackend, runs, reserved, working, taskStore } = await setup();
      const first = await tasks.create({ project: 'Demo', title: 'WhatsApp replies' });
      expect(await rejection(tasks.addRepository(ID, { worktreePath: first.worktreePath }))).toMatchObject({ status: 409, message: 'This worktree already belongs to a task.' });
      const made = handMade(tools, 'tools-meter');
      runs.push({ worktreePath: made, status: 'running', worktreeState: 'external' });
      expect(await rejection(tasks.addRepository(ID, { worktreePath: made }))).toMatchObject({ status: 409, message: 'An open workflow run is already using it.' });
      runs.length = 0;
      reserved.add(made);
      expect(await rejection(tasks.addRepository(ID, { worktreePath: made }))).toMatchObject({ status: 409, message: 'An open workflow run is already using it.' });
      reserved.clear();
      expect(await rejection(tasks.addRepository(ID, { worktreePath: handMade(otherBackend, 'backend-meter') }))).toMatchObject({ status: 409, message: 'Another repository of this project is already called backend.' });
      working.now = true;
      expect(await rejection(tasks.addRepository(ID, { worktreePath: made }))).toMatchObject({ status: 409, message: 'A workflow run is working in this task. Add the repository when it pauses or finishes.' });
      working.now = false;
      expect(taskStore.get(ID).worktrees).toHaveLength(1);
      await tasks.addRepository(ID, { worktreePath: made });
      expect(await rejection(tasks.addRepository(ID, { worktreePath: handMade(tools, 'tools-again') }))).toMatchObject({ status: 409, message: 'tools is already part of this task.' });
    });
  });

  describe('cross-host task terminals', () => {
    const INCARNATION = '8d7f3a7e-8a54-4d5b-9d5e-7f4b6a0c2e11';
    const REMOTE_HOST = 'media-server';
    const REMOTE_ROOT = '/home/sabside/git/demo';

    function setupCrossHost({ defaultHost = REMOTE_HOST } = {}) {
      const ctx = groupFixture();
      let projects = [
        normalizeProject({
          name: 'Demo',
          defaultHost,
          autoSync: false,
          locations: [
            {
              host: 'local',
              path: ctx.backend,
              repositories: [
                { name: 'mobile-app', path: ctx.mobile },
                { name: 'frontend', path: ctx.frontendMain },
              ],
            },
            {
              host: REMOTE_HOST,
              path: `${REMOTE_ROOT}/backend`,
              repositories: [
                { name: 'mobile-app', path: `${REMOTE_ROOT}/mobile-app` },
                { name: 'frontend', path: `${REMOTE_ROOT}/frontend` },
              ],
            },
          ],
        }),
      ];

      const db = new Database(':memory:');
      databases.push(db);
      const taskStore = createTaskStore(db);
      const sessionHostStore = createTerminalSessionHostStore(db);
      const worktreeStore = createTerminalSessionWorktreeStore(db);

      const localRuntime = {
        createDetachedSession: vi.fn(),
        getSessionIncarnationAsync: vi.fn(async () => INCARNATION),
      };
      const remoteRuntime = {
        createDetachedSessionAsync: vi.fn(async () => {}),
        getSessionIncarnationAsync: vi.fn(async () => INCARNATION),
      };

      const hostRuntimeResolver = createHostRuntimeResolver({
        loadProjects: () => projects,
        loadHosts: () => [{ name: REMOTE_HOST, sshTarget: REMOTE_HOST }],
        sessionHostStore,
        createRuntime: () => remoteRuntime,
      });

      let nextSessionNumber = 1;
      const reserveSessionId = vi.fn(async (projectName, opts) => {
        const project = projects.find(candidate => candidate.name === projectName);
        const targetHost = normalizeHostName(opts?.host || project.defaultHost);
        const location = getProjectLocation(project, targetHost);
        const sessionId = `${projectName}-${nextSessionNumber++}`;
        worktreeStore.clear(sessionId);
        sessionHostStore.set({ sessionId, project: projectName, host: location.host });
        return { sessionId, host: location.host, path: location.path };
      });

      const mobileStarter = createMobileSessionStarter({
        loadProjects: () => projects,
        saveProjects: next => { projects = next; },
        reserveSessionId,
        releaseReservation: vi.fn(),
        resolveHostRuntime: hostRuntimeResolver.resolveHostRuntime,
        localRuntime,
        store: { adoptIncarnation: (_id, value) => value },
        now: () => 5000,
      });

      const startSessionWithWorktree = createWorktreeSessionStarter({
        start: (project, options) => mobileStarter.start(project, options),
        loadProjects: () => projects,
        store: worktreeStore,
        now: () => '2026-11-28T06:57:19.000Z',
      });

      const resolveHostTools = host => (host === REMOTE_HOST
        ? {
          host: REMOTE_HOST,
          runner: null,
          execFile: () => { throw new Error('unexpected remote execFile'); },
          pathExists: async target => target.startsWith(`${REMOTE_ROOT}/`),
          realpath: async target => target,
          mkdir: async () => {},
          rmdir: async () => {},
        }
        : {
          host: 'local',
          runner: null,
          execFile,
          pathExists: async target => existsSync(target),
          realpath: target => fsPromises.realpath(target),
          mkdir: (dir, opts) => fsPromises.mkdir(dir, opts),
          rmdir: target => fsPromises.rmdir(target),
        });

      const ids = [ID, '7a000000-0000-4000-8000-000000000002'];
      const tasks = createTaskService({
        isRunWorking: () => false,
        taskStore,
        findProject: name => projects.find(candidate => candidate.name === name) ?? null,
        execFile,
        resolveHostTools,
        startSession: startSessionWithWorktree,
        pathExists: async target => existsSync(target),
        newId: () => ids.shift(),
      });

      return { ...ctx, taskStore, sessionHostStore, worktreeStore, localRuntime, remoteRuntime, reserveSessionId, tasks };
    }

    it('reserves and starts local task terminals on local with the selected worktree even when the project default host is remote', async () => {
      const { tasks, sessionHostStore, worktreeStore, localRuntime, remoteRuntime, reserveSessionId } = setupCrossHost({ defaultHost: REMOTE_HOST });
      const task = await tasks.create({
        project: 'Demo',
        title: 'Wake up with many calls',
        host: 'local',
        repositories: ['backend', 'mobile-app'],
      });
      expect(task.host).toBe('local');

      const [backendWorktree, mobileWorktree] = task.worktrees;
      const first = await tasks.openTerminal(task.id);
      const selected = await tasks.openTerminal(task.id, { worktreeId: mobileWorktree.id });

      expect(first).toEqual({
        sessionId: 'Demo-1',
        taskId: task.id,
        project: 'Demo',
        host: 'local',
        worktreeId: backendWorktree.id,
      });
      expect(selected).toEqual({
        sessionId: 'Demo-2',
        taskId: task.id,
        project: 'Demo',
        host: 'local',
        worktreeId: mobileWorktree.id,
      });

      expect({
        reservedHosts: [
          sessionHostStore.get(first.sessionId)?.host,
          sessionHostStore.get(selected.sessionId)?.host,
        ],
        recordedWorktrees: [
          worktreeStore.get(first.sessionId)?.worktreePath,
          worktreeStore.get(selected.sessionId)?.worktreePath,
        ],
        localRuntimeCalls: localRuntime.createDetachedSession.mock.calls.map(([arg]) => arg),
        remoteRuntimeCalls: remoteRuntime.createDetachedSessionAsync.mock.calls.map(([arg]) => arg),
      }).toEqual({
        reservedHosts: ['local', 'local'],
        recordedWorktrees: [backendWorktree.worktreePath, mobileWorktree.worktreePath],
        localRuntimeCalls: [
          { sessionId: 'Demo-1', cwd: backendWorktree.worktreePath, cols: 120, rows: 32 },
          { sessionId: 'Demo-2', cwd: mobileWorktree.worktreePath, cols: 120, rows: 32 },
        ],
        remoteRuntimeCalls: [],
      });
      expect(reserveSessionId).toHaveBeenNthCalledWith(1, 'Demo', expect.objectContaining({ host: 'local' }));
      expect(reserveSessionId).toHaveBeenNthCalledWith(2, 'Demo', expect.objectContaining({ host: 'local' }));
    });

    it('starts an explicitly remote task terminal on its remote host with the remote worktree when the project default host is local', async () => {
      const { tasks, taskStore, sessionHostStore, worktreeStore, localRuntime, remoteRuntime, reserveSessionId } = setupCrossHost({ defaultHost: 'local' });
      const remoteFolder = `${REMOTE_ROOT}/worktrees/remote-task-7a000000`;
      const remoteBackend = `${remoteFolder}/backend`;
      const remoteMobile = `${remoteFolder}/mobile-app`;
      const commit = '0123456789abcdef0123456789abcdef01234567';
      const task = taskStore.create({
        id: ID,
        project: 'Demo',
        host: REMOTE_HOST,
        title: 'Remote task',
        titleSource: 'owner',
        folder: remoteFolder,
        repository: 'backend',
        repositoryPath: null,
        worktreePath: remoteBackend,
        branch: 'task/remote-task-7a000000',
        baseBranch: 'main',
        baseCommit: commit,
        others: [
          {
            repository: 'mobile-app',
            repositoryPath: `${REMOTE_ROOT}/mobile-app`,
            worktreePath: remoteMobile,
            branch: 'task/remote-task-7a000000',
            baseBranch: 'main',
            baseCommit: commit,
          },
        ],
      });

      const first = await tasks.openTerminal(task.id);
      const selected = await tasks.openTerminal(task.id, { worktreeId: task.worktrees[1].id });

      expect(first.host).toBe(REMOTE_HOST);
      expect(selected.host).toBe(REMOTE_HOST);
      expect(reserveSessionId).toHaveBeenNthCalledWith(1, 'Demo', expect.objectContaining({ host: REMOTE_HOST }));
      expect(reserveSessionId).toHaveBeenNthCalledWith(2, 'Demo', expect.objectContaining({ host: REMOTE_HOST }));
      expect(sessionHostStore.get(first.sessionId)?.host).toBe(REMOTE_HOST);
      expect(sessionHostStore.get(selected.sessionId)?.host).toBe(REMOTE_HOST);
      expect(worktreeStore.get(first.sessionId)?.worktreePath).toBe(remoteBackend);
      expect(worktreeStore.get(selected.sessionId)?.worktreePath).toBe(remoteMobile);

      expect(remoteRuntime.createDetachedSessionAsync).toHaveBeenNthCalledWith(1, {
        sessionId: 'Demo-1',
        cwd: remoteBackend,
        cols: 120,
        rows: 32,
      });
      expect(remoteRuntime.createDetachedSessionAsync).toHaveBeenNthCalledWith(2, {
        sessionId: 'Demo-2',
        cwd: remoteMobile,
        cols: 120,
        rows: 32,
      });
      expect(localRuntime.createDetachedSession).not.toHaveBeenCalled();
    });
  });
});
