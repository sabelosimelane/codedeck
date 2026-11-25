import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService } from '../tasks/task-service.js';
import { createTaskLanding } from '../tasks/task-landing.js';
import { git, groupFixture } from './helpers/group-fixture.js';

const ID = '7a000000-0000-4000-8000-000000000001';
const databases = [];
afterEach(() => { vi.restoreAllMocks(); databases.splice(0).forEach(db => db.close()); });

const write = (dir, file, text) => writeFileSync(path.join(dir, file), text);
const commitAll = (dir, message) => { git(dir, ['add', '--all']); git(dir, ['commit', '-m', message]); };
const codes = list => list.map(item => item.code);

/** A task in `backend` (the project's own repository) and `frontend` (listed through its main worktree). */
async function setup({ exec = execFile, repositories = ['backend', 'frontend'] } = {}) {
  const ctx = groupFixture();
  await ctx.service.add('Demo', { path: ctx.mobile });
  await ctx.service.add('Demo', { path: ctx.frontendMain });
  const db = new Database(':memory:');
  databases.push(db);
  const taskStore = createTaskStore(db);
  const pathExists = async target => existsSync(target);
  const ids = [ID];
  const tasks = createTaskService({ isRunWorking: () => false, taskStore, findProject: ctx.findProject, execFile, startSession: async () => ({ id: 'Demo-1' }), pathExists, newId: () => ids.shift() });
  const state = { activeRun: false, terminalsNotClosed: [] };
  const onTaskFinished = vi.fn();
  const onWorktreeFinished = vi.fn();
  const closeTerminals = vi.fn(async (_task, worktree) => ({ closed: worktree ? [`in-${worktree.repository}`] : ['rest'], notClosed: state.terminalsNotClosed }));
  const landing = createTaskLanding({
    taskStore, findProject: ctx.findProject, execFile: exec, pathExists, hasActiveRun: () => state.activeRun, onTaskFinished, onWorktreeFinished, closeTerminals,
  });
  const task = await tasks.create({ project: 'Demo', title: 'Replies', repositories });
  const [first, second] = task.worktrees;
  return { ...ctx, taskStore, landing, task, first, second, state, onTaskFinished, onWorktreeFinished, closeTerminals, folder: task.folder };
}

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a rejection');
}

// Each test builds several real repositories and worktrees.
describe('landing a task with several repositories', { timeout: 30_000 }, () => {
  it('reports how each repository stands, each against its own checkout', async () => {
    const { landing, first, second, frontendMain, backend } = await setup();
    write(first.worktreePath, 'draft.txt', 'not yet\n');
    write(second.worktreePath, 'page.txt', 'work\n');
    commitAll(second.worktreePath, 'page');
    write(frontendMain, 'scratch.txt', 'dirty checkout\n');
    const [own, other] = await landing.worktrees(ID);
    expect(own).toMatchObject({
      taskId: ID, worktreeId: first.id, repository: 'backend', own: true, first: true, state: 'active', worktreePath: first.worktreePath,
      uncommitted: ['draft.txt'], uncommittedCount: 1, commitsAhead: 0, main: { branch: 'main', dirty: false },
    });
    expect(other).toMatchObject({
      worktreeId: second.id, repository: 'frontend', own: false, first: false, uncommittedCount: 0, commitsAhead: 1, main: { branch: 'main', dirty: true },
    });
    expect(codes(own.blockers.merge)).toEqual(['uncommitted', 'nothing_to_land']);
    expect(codes(other.blockers.merge)).toEqual(['main_dirty']);
    expect(other.blockers.merge[0].message).toBe('frontend\'s checkout has uncommitted changes. Commit or stash them before merging.');
    expect(own.blockers.close[0].message).toBe('backend has uncommitted changes in this task. Commit them first.');
    // The task-level status is that of the worktree the task started in.
    expect(await landing.status(ID)).toEqual(own);
    expect(git(backend, ['status', '--porcelain'])).toBe('');
  });

  it('judges each repository on its own: one already in its base branch, one untouched', async () => {
    const { landing, first, second, frontendMain } = await setup();
    write(second.worktreePath, 'page.txt', 'work\n');
    commitAll(second.worktreePath, 'page');
    // Merged with plain Git in the checkout frontend is listed with.
    git(frontendMain, ['merge', '--ff-only', second.branch]);
    const [own, other] = await landing.worktrees(ID);
    expect(own).toMatchObject({ worktreeId: first.id, repository: 'backend', commitsAhead: 0, alreadyInBase: false });
    expect(own.blockers.merge).toEqual([{ code: 'nothing_to_land', message: 'backend has no commits of its own in this task yet.' }]);
    expect(other).toMatchObject({ worktreeId: second.id, repository: 'frontend', commitsAhead: 0, alreadyInBase: true });
    expect(other.blockers.merge).toEqual([{ code: 'already_in_base', message: "frontend's commits in this task are already in main, so there is nothing left to merge. Close frontend to finish it." }]);
    expect(other.blockers.close).toEqual([]);
  });

  it('says where a checkout stands when it is on another branch', async () => {
    const { landing, second, frontendMain } = await setup();
    git(frontendMain, ['checkout', '-q', '-b', 'elsewhere']);
    const status = await landing.status(ID, { worktreeId: second.id });
    expect(status.blockers.merge.find(item => item.code === 'main_not_on_base').message)
      .toBe('frontend\'s checkout is on elsewhere, but this task started from main there. Switch it to main to merge.');
  });

  it('blocks every repository while a run is working in the task', async () => {
    const { landing, state } = await setup();
    state.activeRun = true;
    for (const view of await landing.worktrees(ID)) {
      expect(view.runActive).toBe(true);
      expect(codes(view.blockers.close)).toEqual(['run_active']);
    }
  });

  it('commits one repository and leaves the other as it is', async () => {
    const { landing, first, second } = await setup();
    write(first.worktreePath, 'a.txt', 'a\n');
    write(second.worktreePath, 'b.txt', 'b\n');
    const after = await landing.commit(ID, { message: 'Backend part', worktreeId: second.id });
    expect(after).toMatchObject({ worktreeId: second.id, repository: 'frontend', uncommittedCount: 0, commitsAhead: 1 });
    expect(git(second.worktreePath, ['log', '-1', '--format=%s'])).toBe('Backend part');
    expect((await landing.status(ID)).uncommittedCount).toBe(1);
    expect(await rejection(landing.commit(ID, { message: 'x', worktreeId: '7b000000-0000-4000-8000-000000000099' }))).toMatchObject({ status: 404, message: 'This task has no such repository.' });
    expect(await rejection(landing.commit(ID, { message: 'x', worktreeId: 7 }))).toMatchObject({ status: 404 });
  });

  it('merges one repository into its own checkout and keeps the task open for the other', async () => {
    const { landing, first, second, frontend, frontendMain, taskStore, onTaskFinished, onWorktreeFinished, closeTerminals, folder } = await setup();
    write(first.worktreePath, 'draft.txt', 'still working\n');
    write(second.worktreePath, 'page.txt', 'work\n');
    commitAll(second.worktreePath, 'page');
    const result = await landing.merge(ID, { worktreeId: second.id });
    expect(result).toMatchObject({ mergedInto: 'main', filesRemoved: true, branchDeleted: true, repository: 'frontend', taskFinished: false, terminalsClosed: ['in-frontend'], terminalsNotClosed: [] });
    expect(result.task).toMatchObject({ state: 'active', finishedAt: null });
    expect(result.task.worktrees.map(worktree => worktree.state)).toEqual(['active', 'merged']);
    // Merged into the checkout the repository is listed with, not into its own folder.
    expect(existsSync(path.join(frontendMain, 'page.txt'))).toBe(true);
    expect(existsSync(path.join(frontend, 'page.txt'))).toBe(false);
    expect(existsSync(second.worktreePath)).toBe(false);
    expect(git(frontend, ['branch', '--list', second.branch])).toBe('');
    // The other repository and the task's folder are untouched.
    expect(existsSync(path.join(first.worktreePath, 'draft.txt'))).toBe(true);
    expect(existsSync(folder)).toBe(true);
    expect(onWorktreeFinished).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), expect.objectContaining({ id: second.id }));
    expect(closeTerminals).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), expect.objectContaining({ id: second.id }));
    expect(onTaskFinished).not.toHaveBeenCalled();
    expect(taskStore.get(ID).state).toBe('active');
    // What is finished cannot be landed again.
    expect(await rejection(landing.merge(ID, { worktreeId: second.id }))).toMatchObject({ status: 409, message: 'This repository of the task is finished.' });
  });

  it('finishes the task with its last repository and removes the task folder', async () => {
    const { landing, first, second, onTaskFinished, closeTerminals, folder, backend } = await setup();
    for (const worktree of [first, second]) { write(worktree.worktreePath, 'work.txt', 'work\n'); commitAll(worktree.worktreePath, 'work'); }
    await landing.merge(ID, { worktreeId: second.id });
    const result = await landing.merge(ID);
    expect(result).toMatchObject({ repository: 'backend', taskFinished: true, folderRemoved: true });
    expect(result.task).toMatchObject({ state: 'merged' });
    expect(result.task.finishedAt).not.toBeNull();
    expect(existsSync(folder)).toBe(false);
    expect(existsSync(path.join(backend, 'work.txt'))).toBe(true);
    expect(onTaskFinished).toHaveBeenCalledTimes(1);
    expect(onTaskFinished).toHaveBeenCalledWith(expect.objectContaining({ id: ID, state: 'merged' }));
    expect(closeTerminals).toHaveBeenLastCalledWith(expect.objectContaining({ id: ID, state: 'merged' }));
  });

  it('aborts a conflicting merge of one repository and names it', async () => {
    const { landing, second, frontendMain } = await setup();
    write(second.worktreePath, 'README.md', 'task side\n');
    commitAll(second.worktreePath, 'task side');
    write(frontendMain, 'README.md', 'checkout side\n');
    commitAll(frontendMain, 'checkout side');
    const error = await rejection(landing.merge(ID, { worktreeId: second.id }));
    expect(error).toMatchObject({ status: 409, message: 'frontend conflicts with main in 1 file. Nothing was merged.', extra: { conflicts: ['README.md'] } });
    expect(git(frontendMain, ['status', '--porcelain'])).toBe('');
    expect(existsSync(second.worktreePath)).toBe(true);
  });

  it('closes one repository of the task and keeps its branch', async () => {
    const { landing, first, second, frontend, onTaskFinished } = await setup();
    write(second.worktreePath, 'page.txt', 'work\n');
    commitAll(second.worktreePath, 'page');
    const result = await landing.closeWorktree(ID, second.id);
    expect(result).toMatchObject({ repository: 'frontend', branchKept: second.branch, unmergedCommits: 1, taskFinished: false, terminalsClosed: ['in-frontend'] });
    expect(result.task.worktrees.map(worktree => worktree.state)).toEqual(['active', 'closed']);
    expect(existsSync(second.worktreePath)).toBe(false);
    expect(git(frontend, ['branch', '--list', second.branch])).not.toBe('');
    expect(existsSync(first.worktreePath)).toBe(true);
    expect(onTaskFinished).not.toHaveBeenCalled();
    expect(await rejection(landing.closeWorktree(ID, second.id))).toMatchObject({ status: 409, message: 'This repository of the task is finished.' });
  });

  it('deletes ignored files with a repository or the whole task only on the owner\'s word', async () => {
    const { landing, first, second } = await setup();
    for (const worktree of [first, second]) {
      write(worktree.worktreePath, '.gitignore', 'owner.local\n');
      commitAll(worktree.worktreePath, 'ignore');
      write(worktree.worktreePath, 'owner.local', 'exists nowhere else\n');
    }
    expect((await landing.worktrees(ID)).map(view => [view.repository, view.ignoredAtRisk])).toEqual([['backend', ['owner.local']], ['frontend', ['owner.local']]]);
    expect(await rejection(landing.closeWorktree(ID, second.id))).toMatchObject({ status: 409 });
    expect(await rejection((async () => landing.closeWorktree(ID, second.id, { deleteIgnored: 'yes' }))())).toMatchObject({ status: 400 });
    const one = await landing.closeWorktree(ID, second.id, { deleteIgnored: true });
    expect(one.task.worktrees.map(worktree => worktree.state)).toEqual(['active', 'closed']);
    expect(existsSync(second.worktreePath)).toBe(false);
    expect(existsSync(first.worktreePath)).toBe(true);
  });

  it('closes every repository of a task with their ignored files on the owner\'s word, or none without it', async () => {
    const { landing, first, second } = await setup();
    write(second.worktreePath, '.gitignore', 'owner.local\n');
    commitAll(second.worktreePath, 'ignore');
    write(second.worktreePath, 'owner.local', 'exists nowhere else\n');
    const refused = await rejection(landing.close(ID));
    expect(refused).toMatchObject({ status: 409 });
    expect(refused.extra.reasons.map(reason => [reason.code, reason.repository])).toEqual([['ignored_files', 'frontend']]);
    expect(existsSync(first.worktreePath)).toBe(true);
    const result = await landing.close(ID, { deleteIgnored: true });
    expect(result.task.state).toBe('closed');
    expect(existsSync(first.worktreePath)).toBe(false);
    expect(existsSync(second.worktreePath)).toBe(false);
  });

  it('closes the whole task only when every repository can be closed, and says which cannot', async () => {
    const { landing, first, second, taskStore, onTaskFinished, folder } = await setup();
    write(second.worktreePath, 'draft.txt', 'not committed\n');
    const error = await rejection(landing.close(ID));
    expect(error).toMatchObject({ status: 409, message: 'Nothing was closed. frontend has uncommitted changes in this task. Commit them first.' });
    expect(error.extra.reasons).toEqual([{ code: 'uncommitted', message: 'frontend has uncommitted changes in this task. Commit them first.', repository: 'frontend' }]);
    expect(existsSync(first.worktreePath)).toBe(true);
    expect(existsSync(second.worktreePath)).toBe(true);
    expect(taskStore.get(ID).worktrees.map(worktree => worktree.state)).toEqual(['active', 'active']);

    commitAll(second.worktreePath, 'draft');
    const result = await landing.close(ID);
    expect(result).toMatchObject({ branchKept: first.branch, unmergedCommits: 1, taskFinished: true, folderRemoved: true });
    expect(result.repositories).toEqual([
      { repository: 'backend', branchKept: first.branch, unmergedCommits: 0 },
      { repository: 'frontend', branchKept: second.branch, unmergedCommits: 1 },
    ]);
    expect(result.task).toMatchObject({ state: 'closed' });
    expect(existsSync(folder)).toBe(false);
    expect(onTaskFinished).toHaveBeenCalledTimes(1);
  });

  it('reports terminal outcomes if removing the second repository fails, then finishes only what is left', async () => {
    let failRemoval = true;
    const exec = (file, args, options, callback) => {
      if (failRemoval && file === 'git' && args.includes('worktree') && args.includes('remove') &&
        args.some(arg => arg.endsWith('/frontend'))) {
        return callback(new Error('fixture removal refusal'), '', 'fixture removal refusal');
      }
      return execFile(file, args, options, callback);
    };
    const { landing, first, second, taskStore, state, closeTerminals, onTaskFinished } = await setup({ exec });
    state.terminalsNotClosed = ['surviving-backend-terminal'];
    const error = await rejection(landing.close(ID));
    expect(error.message).toContain('Already closed: backend');
    expect(error.extra.partialClose).toEqual({ terminalsClosed: ['in-backend'], terminalsNotClosed: ['surviving-backend-terminal'] });
    expect(existsSync(first.worktreePath)).toBe(false);
    expect(existsSync(second.worktreePath)).toBe(true);
    expect((await landing.worktrees(ID)).map(entry => entry.state)).toEqual(['closed', 'active']);
    expect(taskStore.get(ID).state).toBe('active');
    expect(closeTerminals).toHaveBeenCalledTimes(1);
    expect(onTaskFinished).not.toHaveBeenCalled();

    state.terminalsNotClosed = [];
    failRemoval = false;
    const closed = await landing.close(ID);
    expect(closed.task.state).toBe('closed');
    expect(closed.repositories.map(row => row.repository)).toEqual(['frontend']);
    expect(onTaskFinished).toHaveBeenCalledTimes(1);
  });

  it('closes what is left of a task after one repository was merged', async () => {
    const { landing, first, second, folder } = await setup();
    write(second.worktreePath, 'page.txt', 'work\n');
    commitAll(second.worktreePath, 'page');
    await landing.merge(ID, { worktreeId: second.id });
    const result = await landing.close(ID);
    expect(result.task).toMatchObject({ state: 'merged' });
    expect(result.repositories).toEqual([{ repository: 'backend', branchKept: first.branch, unmergedCommits: 0 }]);
    expect(existsSync(folder)).toBe(false);
  });

  it('keeps a task folder that still holds something else, and says so', async () => {
    const { landing, folder } = await setup();
    write(folder, 'notes.txt', 'the owner\'s own file\n');
    const result = await landing.close(ID);
    expect(result).toMatchObject({ taskFinished: true, folderRemoved: false });
    expect(existsSync(path.join(folder, 'notes.txt'))).toBe(true);
  });

  it('opens a pull request for one repository with that repository\'s remotes', async () => {
    const calls = [];
    const exec = (file, args, options, callback) => {
      if (file === 'git' && args.includes('push')) { calls.push(['push', args[1], ...args.slice(2)]); return callback(null, '', ''); }
      if (file === 'gh') { calls.push(['gh', options.cwd ?? null, ...args]); return callback(null, args[0] === '--version' ? 'gh 2' : 'https://github.com/team/frontend/pull/7\n', ''); }
      return execFile(file, args, options, callback);
    };
    const { landing, second, frontend, backend, first } = await setup({ exec });
    git(frontend, ['remote', 'add', 'origin', 'https://github.com/team/frontend.git']);
    git(backend, ['remote', 'add', 'gitlab', 'git@gitlab.com:team/backend.git']);
    write(second.worktreePath, 'page.txt', 'work\n');
    commitAll(second.worktreePath, 'page');
    expect((await landing.status(ID, { worktreeId: second.id })).remotes).toEqual([{ name: 'origin', host: 'github.com', tool: 'gh' }]);
    expect((await landing.status(ID)).remotes).toEqual([{ name: 'gitlab', host: 'gitlab.com', tool: 'glab' }]);
    const result = await landing.pullRequest(ID, { remote: 'origin', worktreeId: second.id });
    expect(result).toMatchObject({ prUrl: 'https://github.com/team/frontend/pull/7', remote: 'origin', repository: 'frontend' });
    expect(result.task.state).toBe('pr_open');
    expect(result.task.worktrees.map(worktree => [worktree.state, worktree.prUrl])).toEqual([['active', null], ['pr_open', 'https://github.com/team/frontend/pull/7']]);
    expect(calls).toContainEqual(['push', second.worktreePath, 'push', '--set-upstream', 'origin', second.branch]);
    expect(calls).toContainEqual(['gh', second.worktreePath, 'pr', 'create', '--fill', '--repo', 'team/frontend', '--head', second.branch, '--base', 'main']);
    // The other repository has no such remote.
    expect(await rejection(landing.pullRequest(ID, { remote: 'origin', worktreeId: first.id }))).toMatchObject({ status: 409 });
  });

  it('requires its dependencies', () => {
    expect(() => createTaskLanding({ taskStore: { get() {}, setWorktreeState() {} }, findProject() {}, execFile() {}, pathExists() {}, hasActiveRun() {}, onTaskFinished() {}, closeTerminals() {} }))
      .toThrow('onWorktreeFinished must be a function');
  });
});
