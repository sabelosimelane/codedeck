import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService, TaskError } from '../tasks/task-service.js';
import { setTaskState } from './helpers/task-state.js';
import { createTaskLanding } from '../tasks/task-landing.js';

const ID = '7a000000-0000-4000-8000-000000000001';
const cleanups = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function setup({ host, startSession, gitExec = execFile } = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codedeck-task-')));
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'task@test.local']);
  git(repo, ['config', 'user.name', 'Task Test']);
  writeFileSync(path.join(repo, 'README.md'), '# task test\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'init']);
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(base, { recursive: true, force: true }); });
  const taskStore = createTaskStore(db);
  const start = startSession ?? vi.fn(async () => ({ id: 'Demo-3' }));
  const ids = [ID, '7b000000-0000-4000-8000-000000000002'];
  const findProject = name => (name === 'Demo' ? { name: 'Demo', path: repo, repositories: [], ...(host ? { host } : {}) } : null);
  const service = createTaskService({
    isRunWorking: () => false,
    taskStore, findProject,
    execFile: gitExec,
    startSession: start,
    pathExists: async target => existsSync(target),
    newId: () => ids.shift(),
  });
  return { base, repo, db, findProject, taskStore, service, start };
}

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a rejection');
}

describe('task service', () => {
  it('creates no worktree or branch when the task insert fails', async () => {
    const { repo, service, taskStore } = setup();
    const plan = await service.plan({ project: 'Demo', title: 'Insert failure', titleSource: 'owner' });
    vi.spyOn(taskStore, 'create').mockImplementationOnce(() => { throw new Error('Insert failed'); });
    const before = git(repo, ['worktree', 'list', '--porcelain']);
    await expect(service.createPlanned(plan)).rejects.toThrow('Insert failed');
    expect(git(repo, ['branch', '--list', plan.branch])).toBe('');
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toBe(before);
    expect(existsSync(plan.worktreePath)).toBe(false);
    expect(taskStore.list()).toEqual([]);
  });

  it('removes the initial row when Git fails without leaving a folder', async () => {
    const { repo, service, taskStore } = setup();
    const plan = await service.plan({ project: 'Demo', title: 'Branch collision', titleSource: 'owner' });
    git(repo, ['branch', plan.branch]);
    const create = vi.spyOn(taskStore, 'create');
    await expect(service.createPlanned(plan)).rejects.toThrow(/already exists/);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: plan.id }));
    expect(taskStore.list()).toEqual([]);
    expect(existsSync(plan.worktreePath)).toBe(false);
  });

  it('keeps the task row and its files when Git fails after leaving a folder', async () => {
    const gitExec = (cmd, args, options, callback) => {
      if (args[2] !== 'worktree' || args[3] !== 'add') return execFile(cmd, args, options, callback);
      mkdirSync(args[4]);
      writeFileSync(path.join(args[4], 'owner.txt'), 'keep');
      callback(new Error('Worktree add interrupted'));
    };
    const { service, taskStore } = setup({ gitExec });
    const plan = await service.plan({ project: 'Demo', title: 'Partial worktree', titleSource: 'owner' });
    await expect(service.createPlanned(plan)).rejects.toThrow('Worktree add interrupted');
    expect(taskStore.get(plan.id)).toMatchObject({ state: 'active', worktreePath: plan.worktreePath });
    expect(readFileSync(path.join(plan.worktreePath, 'owner.txt'), 'utf8')).toBe('keep');
  });

  it('can close a task after interruption between the row and Git while preserving owner files', async () => {
    const { db, repo, findProject, service, taskStore } = setup();
    const plan = await service.plan({ project: 'Demo', title: 'Interrupted', titleSource: 'owner' });
    const [first] = plan.worktrees;
    const row = taskStore.create({
      id: plan.id, project: plan.project, title: plan.title, titleSource: plan.titleSource, folder: plan.folder,
      repository: first.repository, repositoryPath: first.repositoryPath, worktreePath: first.worktreePath,
      branch: first.branch, baseBranch: first.baseBranch, baseCommit: git(repo, ['rev-parse', 'HEAD']),
    });
    const reopened = createTaskStore(db);
    const pathExists = vi.fn(async target => existsSync(target));
    const restarted = createTaskService({ taskStore: reopened, findProject, execFile, pathExists, startSession: vi.fn(), isRunWorking: () => false });
    const landing = createTaskLanding({ taskStore: reopened, findProject, execFile, pathExists,
      hasActiveRun: () => false, onTaskFinished: () => {}, onWorktreeFinished: () => {}, closeTerminals: async () => ({ closed: [], notClosed: [] }) });
    expect(reopened.list()).toEqual([row]);
    expect(restarted.get(row.id)).toEqual(row);
    const status = await landing.status(row.id);
    expect(status.filesPresent).toBe(false);
    expect(status.blockers.commit).toContainEqual({ code: 'files_missing', message: "This task's files are no longer on disk." });
    expect(status.blockers.close).toEqual([]);
    // An owner can recreate the path after the close operation observes that the worktree is missing.
    pathExists.mockImplementationOnce(async target => {
      expect(existsSync(target)).toBe(false);
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'owner.txt'), 'keep');
      return false;
    });
    await expect(landing.close(row.id)).resolves.toMatchObject({ task: { state: 'closed' } });
    expect(readFileSync(path.join(plan.worktreePath, 'owner.txt'), 'utf8')).toBe('keep');
  });

  it('uses the recorded base commit even when HEAD moves during the task insert', async () => {
    const { repo, service, taskStore } = setup();
    const baseCommit = git(repo, ['rev-parse', 'HEAD']);
    const plan = await service.plan({ project: 'Demo', title: 'Pinned base', titleSource: 'owner' });
    const create = taskStore.create;
    vi.spyOn(taskStore, 'create').mockImplementationOnce(input => {
      git(repo, ['commit', '--allow-empty', '-m', 'Move HEAD']);
      expect(existsSync(plan.worktreePath)).toBe(false);
      return create(input);
    });
    const task = await service.createPlanned(plan);
    expect(git(repo, ['rev-parse', 'HEAD'])).not.toBe(baseCommit);
    expect(task.baseCommit).toBe(baseCommit);
    expect(git(task.worktreePath, ['rev-parse', 'HEAD'])).toBe(baseCommit);
  });

  it('creates a task with its own worktree and branch from the current commit', async () => {
    const { base, repo, service, taskStore } = setup();
    const task = await service.create({ project: 'Demo', title: '  WhatsApp replies ' });
    expect(task).toMatchObject({
      id: ID,
      project: 'Demo',
      title: 'WhatsApp replies',
      worktreePath: path.join(base, 'worktrees', 'repo-whatsapp-replies-7a000000'),
      branch: 'task/whatsapp-replies-7a000000',
      baseBranch: 'main',
      baseCommit: git(repo, ['rev-parse', 'HEAD']),
      state: 'active',
    });
    expect(git(task.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(task.branch);
    expect(taskStore.get(ID)).toEqual(task);
  });

  it('names a task whose title has no letters or digits by its id', async () => {
    const { base, service } = setup();
    const task = await service.create({ project: 'Demo', title: '—' });
    expect(task.worktreePath).toBe(path.join(base, 'worktrees', 'repo-7a000000'));
    expect(task.branch).toBe('task/7a000000');
  });

  it('records no base branch when the main checkout is detached', async () => {
    const { repo, service } = setup();
    git(repo, ['checkout', '--detach']);
    expect((await service.create({ project: 'Demo', title: 'Detached' })).baseBranch).toBeNull();
  });

  it('runs tasks side by side', async () => {
    const { service } = setup();
    const [first, second] = await Promise.all([
      service.create({ project: 'Demo', title: 'Same title' }),
      service.create({ project: 'Demo', title: 'Same title' }),
    ]);
    expect(first.worktreePath).not.toBe(second.worktreePath);
    expect(existsSync(first.worktreePath) && existsSync(second.worktreePath)).toBe(true);
  });

  it.each([
    [{ project: '', title: 'x' }, 'project'],
    [{ project: null, title: 'x' }, 'project'],
    [{ project: 'Demo', title: '' }, 'title'],
    [{ project: 'Demo', title: 'x'.repeat(81) }, 'title'],
    [{ project: 'Demo', title: 'a\nb' }, 'title'],
    [{ project: 'Demo', title: 12 }, 'title'],
  ])('refuses invalid input %j', async (input, field) => {
    const { service, taskStore } = setup();
    const error = await rejection(service.create(input));
    expect(error).toBeInstanceOf(TaskError);
    expect(error.status).toBe(400);
    expect(error.errors.map(item => item.field)).toEqual([field]);
    expect(taskStore.list()).toEqual([]);
  });

  it('refuses an unknown project, a remote project and a non-repository', async () => {
    const { service } = setup();
    expect(await rejection(service.create({ project: 'Nope', title: 'x' }))).toMatchObject({ status: 404, message: 'Project not found' });
    const remote = setup({ host: 'devbox' });
    expect(await rejection(remote.service.create({ project: 'Demo', title: 'x' }))).toMatchObject({ status: 409, message: 'Tasks are only available for local projects.' });
    const plain = setup();
    rmSync(path.join(plain.repo, '.git'), { recursive: true, force: true });
    expect(await rejection(plain.service.create({ project: 'Demo', title: 'x' }))).toMatchObject({ status: 409 });
  });

  it('opens a terminal in the task worktree', async () => {
    const { service, start } = setup();
    const task = await service.create({ project: 'Demo', title: 'Terminal' });
    expect(await service.openTerminal(ID)).toEqual({ sessionId: 'Demo-3', taskId: ID, project: 'Demo', host: 'local', worktreeId: task.worktrees[0].id });
    expect(start).toHaveBeenCalledWith('Demo', { cwd: task.worktreePath });
  });

  it('refuses a terminal for a missing, finished or vanished task', async () => {
    const { service, taskStore, start } = setup();
    expect(await rejection(service.openTerminal(ID))).toMatchObject({ status: 404, message: 'Task not found' });
    const task = await service.create({ project: 'Demo', title: 'Gone' });
    rmSync(task.worktreePath, { recursive: true, force: true });
    expect(await rejection(service.openTerminal(ID))).toMatchObject({ status: 409, message: "This task's files are no longer on disk." });
    setTaskState(taskStore, ID, { state: 'closed' });
    expect(await rejection(service.openTerminal(ID))).toMatchObject({ status: 409, message: 'This task is finished.' });
    expect(start).not.toHaveBeenCalled();
  });

  it('reports a terminal that could not start', async () => {
    const { service } = setup({ startSession: vi.fn(async () => { throw Object.assign(new Error('tmux missing'), { status: 503 }); }) });
    await service.create({ project: 'Demo', title: 'No tmux' });
    expect(await rejection(service.openTerminal(ID))).toMatchObject({ status: 503, message: 'The terminal could not be opened.' });
  });

  it('renames and reports stale revisions', async () => {
    const { service } = setup();
    await service.create({ project: 'Demo', title: 'Before' });
    expect(service.rename(ID, { title: 'After', revision: 1 })).toMatchObject({ title: 'After', revision: 2 });
    expect(() => service.rename(ID, { title: 'Late', revision: 1 })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => service.rename(ID, { title: '', revision: 2 })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => service.rename(ID, { title: 'x', revision: 'two' })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => service.rename('7a000000-0000-4000-8000-00000000000f', { title: 'x', revision: 1 })).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('plans a task without touching disk, then creates exactly what was planned', async () => {
    const { base, service, taskStore } = setup();
    const planned = await service.plan({ project: 'Demo', title: ' Planned ', titleSource: 'input' });
    expect(planned).toMatchObject({ id: ID, project: 'Demo', title: 'Planned', titleSource: 'input', worktreePath: path.join(base, 'worktrees', 'repo-planned-7a000000'), branch: 'task/planned-7a000000', baseBranch: 'main' });
    expect(existsSync(planned.worktreePath)).toBe(false);
    expect(taskStore.list()).toEqual([]);
    const task = await service.createPlanned(planned);
    expect(task).toMatchObject({ id: ID, worktreePath: planned.worktreePath, branch: planned.branch, titleSource: 'input', folder: null });
    // The task's one worktree is in the project's own repository, known by its folder name.
    expect(task.worktrees).toMatchObject([{ repository: 'repo', own: true, first: true, repositoryPath: null, worktreePath: planned.worktreePath, branch: planned.branch }]);
    await expect(service.createPlanned({ ...planned, titleSource: 'generated' })).rejects.toThrow('Task plan titleSource is invalid');
    expect(await rejection(service.createPlanned(planned))).toMatchObject({ status: 409 });
    await expect(service.createPlanned({ ...planned, worktrees: [{ ...planned.worktrees[0], branch: '' }] })).rejects.toThrow('Task plan worktree branch is invalid');
    await expect(service.createPlanned({ ...planned, worktrees: [] })).rejects.toThrow('Task plan worktrees is invalid');
    await expect(service.createPlanned(null)).rejects.toThrow('A task plan is required');
  });

  it('records the title of a task made by hand as the owner\'s', async () => {
    const { service } = setup();
    expect((await service.create({ project: 'Demo', title: 'By hand' })).titleSource).toBe('owner');
  });

  it.each([[undefined], ['generated'], ['someone']])('refuses to plan with the title source %j', async titleSource => {
    const { service, taskStore } = setup();
    await expect(service.plan({ project: 'Demo', title: 'Planned', titleSource })).rejects.toThrow('Task title source must be owner or input');
    expect(taskStore.list()).toEqual([]);
  });

  it('requires its dependencies', () => {
    expect(() => createTaskService({ isRunWorking: () => false,})).toThrow('taskStore');
  });
});
