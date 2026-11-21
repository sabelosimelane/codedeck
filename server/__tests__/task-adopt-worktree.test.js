import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile as gitExecFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService } from '../tasks/task-service.js';

const roots = [];
const databases = [];
afterEach(() => {
  databases.splice(0).forEach(db => db.close());
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

function fixture({ execFile = gitExecFile, reservedWorktreePaths = () => new Set() } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck-adopt-')));
  roots.push(root);
  const own = path.join(root, 'backend');
  const other = path.join(root, 'mobile-app');
  for (const checkout of [own, other]) {
    fs.mkdirSync(checkout);
    git(checkout, 'init', '-b', 'main');
    git(checkout, 'config', 'user.email', 'test@example.test');
    git(checkout, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(checkout, 'README.md'), 'base');
    git(checkout, 'add', 'README.md');
    git(checkout, 'commit', '-m', 'base');
  }
  const ownTree = path.join(root, 'worktrees', 'backend-feature-one');
  const otherTree = path.join(root, 'worktrees', 'mobile-feature-two');
  fs.mkdirSync(path.dirname(ownTree));
  git(own, 'worktree', 'add', '-b', 'feature/first_spec', ownTree);
  git(other, 'worktree', 'add', '-b', 'feature/second_spec', otherTree);
  fs.writeFileSync(path.join(ownTree, 'draft.md'), 'untracked spec');
  const db = new Database(':memory:');
  databases.push(db);
  const store = createTaskStore(db);
  const runs = [];
  const service = createTaskService({ taskStore: store, findProject: name => name === 'Demo' ? { name, path: own, repositories: [{ name: 'mobile-app', path: other }] } : null,
    execFile, startSession: async () => ({ id: 's1' }), pathExists: async target => fs.existsSync(target), isRunWorking: () => false,
    listRuns: () => runs, reservedWorktreePaths });
  return { root, own, other, ownTree, otherTree, store, service, runs };
}

describe('adopting a Git worktree', () => {
  it('lists only unused linked worktrees with repository identity and untracked count', async () => {
    const { service, ownTree, otherTree } = fixture();
    expect(await service.listWorktreeCandidates('Demo')).toEqual([
      expect.objectContaining({ path: ownTree, repository: 'backend', own: true, branch: 'feature/first_spec', uncommittedCount: 1, selectable: true, reason: null }),
      expect.objectContaining({ path: otherTree, repository: 'mobile-app', own: false, branch: 'feature/second_spec', uncommittedCount: 0, selectable: true, reason: null }),
    ]);
  });

  it('counts each untracked file inside a directory', async () => {
    const { service, ownTree } = fixture();
    fs.mkdirSync(path.join(ownTree, 'specs'));
    fs.writeFileSync(path.join(ownTree, 'specs', 'one.md'), 'one');
    fs.writeFileSync(path.join(ownTree, 'specs', 'two.md'), 'two');
    expect((await service.listWorktreeCandidates('Demo')).find(entry => entry.path === ownTree).uncommittedCount).toBe(3);
  });

  it('records the merge base and derived title without changing untracked files', async () => {
    const { service, store, own, ownTree } = fixture();
    const before = fs.readFileSync(path.join(ownTree, 'draft.md'), 'utf8');
    const task = await service.adoptWorktree({ project: 'Demo', worktreePath: ownTree });
    expect(task).toMatchObject({ project: 'Demo', title: 'first spec', titleSource: 'input', worktreePath: ownTree,
      branch: 'feature/first_spec', baseBranch: 'main', baseCommit: git(own, 'rev-parse', 'HEAD'), folder: null });
    expect(store.findOpenByWorktreePath(ownTree)?.id).toBe(task.id);
    expect(fs.readFileSync(path.join(ownTree, 'draft.md'), 'utf8')).toBe(before);
    expect(await service.listWorktreeCandidates('Demo')).toEqual([expect.objectContaining({ repository: 'mobile-app' })]);
    await expect(service.adoptWorktree({ project: 'Demo', worktreePath: ownTree })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a path Git did not list and an in-use candidate', async () => {
    const { service, ownTree, runs } = fixture();
    await expect(service.adoptWorktree({ project: 'Demo', worktreePath: '/tmp/unknown' })).rejects.toMatchObject({ status: 404 });
    runs.push({ worktreePath: ownTree, taskId: null, status: 'running', worktreeState: 'external' });
    expect((await service.listWorktreeCandidates('Demo'))[0].reason.code).toBe('in_use');
    await expect(service.adoptWorktree({ project: 'Demo', worktreePath: ownTree })).rejects.toMatchObject({ status: 409 });
  });

  it('shows missing, detached and base-unknown reasons', async () => {
    const { service, own, ownTree, other, otherTree, root } = fixture();
    const detached = path.join(root, 'worktrees', 'backend-detached');
    git(own, 'worktree', 'add', '--detach', detached);
    fs.rmSync(ownTree, { recursive: true, force: true });
    git(other, 'checkout', '--detach');
    const candidates = await service.listWorktreeCandidates('Demo');
    expect(candidates.find(entry => entry.path === ownTree)).toMatchObject({ selectable: false, reason: { code: 'missing' }, uncommittedCount: null });
    expect(candidates.find(entry => entry.path === detached)).toMatchObject({ selectable: false, reason: { code: 'detached' } });
    expect(candidates.find(entry => entry.path === otherTree)).toMatchObject({ selectable: false, reason: { code: 'base_unknown' } });
  });

  it('marks a Git status failure unreadable', async () => {
    let unreadablePath;
    const execFile = (file, args, options, callback) => {
      if (args.includes('status') && args[1] === unreadablePath) return callback(Object.assign(new Error('cannot read'), { stderr: 'cannot read' }));
      return gitExecFile(file, args, options, callback);
    };
    const { service, ownTree } = fixture({ execFile });
    unreadablePath = ownTree;
    expect((await service.listWorktreeCandidates('Demo')).find(entry => entry.path === ownTree)).toMatchObject({
      selectable: false, reason: { code: 'unreadable' }, uncommittedCount: null,
    });
  });

  it('reports the worktree path and Git error when status cannot be read', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let unreadablePath;
      const execFile = (file, args, options, callback) => {
        if (args.includes('status') && args[1] === unreadablePath) return callback(Object.assign(new Error('status denied'), { stderr: 'status denied' }));
        return gitExecFile(file, args, options, callback);
      };
      const { service, ownTree } = fixture({ execFile });
      unreadablePath = ownTree;
      await service.listWorktreeCandidates('Demo');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(ownTree), expect.stringContaining('status denied'));
    } finally {
      warning.mockRestore();
    }
  });

  it('uses the pipeline run hold rule for an unfinished run in a present worktree', async () => {
    const { service, ownTree, runs } = fixture();
    runs.push({ worktreePath: ownTree, taskId: null, status: 'running', worktreeState: 'present' });
    expect((await service.listWorktreeCandidates('Demo')).find(entry => entry.path === ownTree)).toMatchObject({
      selectable: false, reason: { code: 'in_use' },
    });
  });

  it('marks a pending start reservation in use', async () => {
    const reserved = new Set();
    const { service, ownTree } = fixture({ reservedWorktreePaths: () => reserved });
    reserved.add(ownTree);
    expect((await service.listWorktreeCandidates('Demo'))[0].reason.code).toBe('in_use');
  });

  it('rejects a branch with no merge base and keeps the untracked file', async () => {
    const { service, ownTree } = fixture();
    git(ownTree, 'checkout', '--orphan', 'orphan');
    git(ownTree, 'rm', '-rf', '.');
    fs.writeFileSync(path.join(ownTree, 'orphan.md'), 'new root');
    git(ownTree, 'add', 'orphan.md');
    git(ownTree, 'commit', '-m', 'orphan root');
    fs.writeFileSync(path.join(ownTree, 'draft.md'), 'untracked spec');
    await expect(service.adoptWorktree({ project: 'Demo', worktreePath: ownTree })).rejects.toMatchObject({ status: 409 });
    expect(fs.readFileSync(path.join(ownTree, 'draft.md'), 'utf8')).toBe('untracked spec');
  });
});
