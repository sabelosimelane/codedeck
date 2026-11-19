import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRunPlaces } from '../pipelines/run-places.js';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService } from '../tasks/task-service.js';
import { groupFixture } from './helpers/group-fixture.js';
import { setTaskState } from './helpers/task-state.js';

const ID = '7a000000-0000-4000-8000-000000000001';
const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

async function setup({ link = true } = {}) {
  const ctx = groupFixture();
  if (link) {
    await ctx.service.add('Demo', { path: ctx.mobile });
    await ctx.service.add('Demo', { path: ctx.frontendMain });
  }
  const db = new Database(':memory:');
  databases.push(db);
  const taskStore = createTaskStore(db);
  const ids = [ID];
  const tasks = createTaskService({ isRunWorking: () => false, taskStore, findProject: ctx.findProject, execFile, startSession: async () => ({ id: 'Demo-1' }), pathExists: async target => existsSync(target), newId: () => ids.shift() });
  const places = createRunPlaces({ taskStore, findProject: ctx.findProject, execFile });
  return { ...ctx, taskStore, tasks, places };
}

describe('where a run may work and read', { timeout: 30_000 }, () => {
  it('names every open worktree of the run\'s task to work in, and the project\'s other repositories to read', async () => {
    const { tasks, places, frontendMain } = await setup();
    const task = await tasks.create({ project: 'Demo', title: 'Replies', repositories: ['mobile-app', 'backend'] });
    const [mobile, backend] = task.worktrees;
    expect(await places({ project: 'Demo', taskId: ID, worktreePath: backend.worktreePath })).toEqual({
      current: 'backend',
      worktrees: [{ repository: 'mobile-app', path: mobile.worktreePath }, { repository: 'backend', path: backend.worktreePath }],
      readOnly: [{ repository: 'frontend', path: frontendMain }],
    });
  });

  it('reads a repository of the task at its own checkout again once its worktree there is finished', async () => {
    const { tasks, places, taskStore, mobile, frontendMain } = await setup();
    const task = await tasks.create({ project: 'Demo', title: 'Replies', repositories: ['mobile-app', 'backend'] });
    setTaskState(taskStore, ID, { state: 'closed' });
    expect(await places({ project: 'Demo', taskId: ID, worktreePath: task.worktrees[1].worktreePath })).toEqual({
      current: 'backend',
      worktrees: [{ repository: 'backend', path: task.worktrees[1].worktreePath }],
      readOnly: [{ repository: 'mobile-app', path: mobile }, { repository: 'frontend', path: frontendMain }],
    });
  });

  it('gives a run in Main the checkout it runs in, and the project\'s other repositories to read', async () => {
    const { places, backend, mobile, frontendMain } = await setup();
    expect(await places({ project: 'Demo', taskId: null, worktreePath: backend })).toEqual({
      current: 'backend', worktrees: [{ repository: 'backend', path: backend }],
      readOnly: [{ repository: 'mobile-app', path: mobile }, { repository: 'frontend', path: frontendMain }],
    });
    expect(await places({ project: 'Demo', taskId: null, worktreePath: mobile })).toEqual({
      current: 'mobile-app', worktrees: [{ repository: 'mobile-app', path: mobile }],
      readOnly: [{ repository: 'backend', path: backend }, { repository: 'frontend', path: frontendMain }],
    });
  });

  it('gives a run in a project with one repository its worktree and nothing else', async () => {
    const { places, group } = await setup({ link: false });
    const worktreePath = path.join(group, 'worktrees', 'backend-run-12345678');
    expect(await places({ project: 'Demo', taskId: null, worktreePath })).toEqual({ current: 'backend', worktrees: [{ repository: 'backend', path: worktreePath }], readOnly: [] });
  });

  it('refuses a run whose project is gone, whose worktree is not one of its task\'s, and malformed runs', async () => {
    const { tasks, places } = await setup();
    await tasks.create({ project: 'Demo', title: 'Replies' });
    await expect(places({ project: 'Nope', taskId: null, worktreePath: '/tmp/x' })).rejects.toThrow('Project Nope of this run no longer exists');
    await expect(places({ project: 'Demo', taskId: ID, worktreePath: '/tmp/elsewhere' })).rejects.toThrow('is not a worktree of its task');
    await expect(places({ project: '', taskId: null, worktreePath: '/tmp/x' })).rejects.toThrow('run.project');
    await expect(places({ project: 'Demo', taskId: null, worktreePath: 'relative' })).rejects.toThrow('run.worktreePath');
    await expect(places({ project: 'Demo', taskId: 7, worktreePath: '/tmp/x' })).rejects.toThrow('run.taskId');
    expect(() => createRunPlaces({})).toThrow('taskStore is required');
  });
});

it('resolves recorded branches, repository checkouts and base revisions for verification and Commit', async () => {
  const { tasks, places, backend, mobile } = await setup();
  const task = await tasks.create({ project: 'Demo', title: 'Proof', repositories: ['backend', 'mobile-app'] });
  const run = { project: 'Demo', taskId: ID, worktreePath: task.worktrees[0].worktreePath, worktreeBranch: task.branch, baseCommit: task.baseCommit, homePath: backend };
  const work = await places(run, { includeGit: true });
  expect(work.worktrees).toEqual(task.worktrees.map(w => ({ repository: w.repository, path: w.worktreePath, branch: w.branch, baseCommit: w.baseCommit, repositoryPath: w.repository === 'backend' ? backend : mobile })));
  const standalone = await places({ ...run, taskId: null }, { includeGit: true });
  expect(standalone.worktrees).toEqual([work.worktrees[0]]);
  await expect(places({ ...run, taskId: '7a000000-0000-4000-8000-000000000002' }, { includeGit: true })).rejects.toThrow(/task.*no longer exists/);
});
