import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskService } from '../tasks/task-service.js';
import { createTaskLanding, describeRemote } from '../tasks/task-landing.js';

const ID = '7a000000-0000-4000-8000-000000000001';
const cleanups = [];
afterEach(() => { vi.restoreAllMocks(); cleanups.splice(0).forEach(fn => fn()); });

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, file, text) => writeFileSync(path.join(dir, file), text);
const commitAll = (dir, message) => { git(dir, ['add', '--all']); git(dir, ['commit', '-m', message]); };

/** A real repository with one task; `exec` lets a test stand in for the hosting CLI. */
async function setup({ exec = execFile, activeRun = false } = {}) {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codedeck-landing-')));
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'task@test.local']);
  git(repo, ['config', 'user.name', 'Task Test']);
  write(repo, 'README.md', '# landing\n');
  write(repo, 'shared.txt', 'original\n');
  commitAll(repo, 'init');
  const db = new Database(':memory:');
  cleanups.push(() => { db.close(); rmSync(base, { recursive: true, force: true }); });
  const taskStore = createTaskStore(db);
  const findProject = name => (name === 'Demo' ? { name: 'Demo', path: repo } : null);
  const pathExists = async target => existsSync(target);
  const ids = [ID, '7b000000-0000-4000-8000-000000000002'];
  const service = createTaskService({ taskStore, findProject, execFile, startSession: async () => ({ id: 'Demo-1' }), pathExists, newId: () => ids.shift() });
  const state = { activeRun, terminals: { closed: [], notClosed: [] } };
  const onTaskFinished = vi.fn();
  const closeTerminals = vi.fn(async () => state.terminals);
  const landing = createTaskLanding({ taskStore, findProject, execFile: exec, pathExists, hasActiveRun: () => state.activeRun, onTaskFinished, closeTerminals });
  const task = await service.create({ project: 'Demo', title: 'Replies' });
  return { base, repo, taskStore, service, landing, task, wt: task.worktreePath, state, onTaskFinished, closeTerminals };
}

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a rejection');
}
const codes = list => list.map(item => item.code);

describe('task landing — status', () => {
  it('reports a fresh task: nothing to commit, merge or push', async () => {
    const { landing } = await setup();
    const status = await landing.status(ID);
    expect(status).toMatchObject({
      taskId: ID, state: 'active', baseBranch: 'main', prUrl: null, filesPresent: true, runActive: false,
      uncommitted: [], uncommittedCount: 0, commitsAhead: 0, commitsBehind: 0, main: { branch: 'main', dirty: false }, remotes: [],
    });
    expect(codes(status.blockers.commit)).toEqual(['nothing_to_commit']);
    expect(codes(status.blockers.merge)).toEqual(['nothing_to_land']);
    expect(codes(status.blockers.pullRequest)).toEqual(['nothing_to_land', 'no_remote']);
    expect(status.blockers.close).toEqual([]);
  });

  it('counts uncommitted files and commits ahead and behind, and names what blocks a merge', async () => {
    const { landing, repo, wt, state } = await setup();
    write(wt, 'feature.txt', 'work\n');
    commitAll(wt, 'feature');
    write(wt, 'draft.txt', 'not yet\n');
    write(repo, 'other.txt', 'main moved\n');
    commitAll(repo, 'main moved');
    write(repo, 'scratch.txt', 'dirty main\n');
    state.activeRun = true;
    const status = await landing.status(ID);
    expect(status).toMatchObject({ uncommitted: ['draft.txt'], uncommittedCount: 1, commitsAhead: 1, commitsBehind: 1, runActive: true, main: { branch: 'main', dirty: true } });
    expect(codes(status.blockers.merge)).toEqual(['run_active', 'uncommitted', 'main_dirty']);
    expect(codes(status.blockers.commit)).toEqual(['run_active']);
    expect(codes(status.blockers.close)).toEqual(['run_active', 'uncommitted']);
  });

  it('says when Main is on another branch, and lists remotes with the tool that serves them', async () => {
    const { landing, repo } = await setup();
    git(repo, ['checkout', '-b', 'elsewhere']);
    git(repo, ['remote', 'add', 'origin', 'git@gitlab.com:team/demo.git']);
    git(repo, ['remote', 'add', 'github', 'https://github.com/team/demo.git']);
    git(repo, ['remote', 'add', 'mirror', 'https://git.example.test/team/demo.git']);
    const status = await landing.status(ID);
    expect(status.blockers.merge.find(item => item.code === 'main_not_on_base').message).toBe('Main is on elsewhere, but this task was started from main. Switch Main to main to merge.');
    expect(status.remotes).toEqual([
      { name: 'github', host: 'github.com', tool: 'gh' },
      { name: 'mirror', host: 'git.example.test', tool: null },
      { name: 'origin', host: 'gitlab.com', tool: 'glab' },
    ]);
  });

  it('reports vanished files and a finished or unknown task', async () => {
    const { landing, wt, taskStore } = await setup();
    rmSync(wt, { recursive: true, force: true });
    const gone = await landing.status(ID);
    expect(gone).toMatchObject({ filesPresent: false, commitsAhead: null, uncommittedCount: 0 });
    expect(codes(gone.blockers.merge)).toContain('files_missing');
    expect(gone.blockers.close).toEqual([]);
    taskStore.setState(ID, { state: 'closed' });
    expect(codes((await landing.status(ID)).blockers.merge)).toEqual(['finished']);
    expect(await rejection(landing.status('7c000000-0000-4000-8000-000000000009'))).toMatchObject({ status: 404 });
    expect(await rejection(landing.status('nope'))).toMatchObject({ status: 404 });
  });
});

describe('task landing — commit', () => {
  it('commits every change in the task and nothing in Main', async () => {
    const { landing, repo, wt } = await setup();
    write(wt, 'a.txt', 'a\n');
    write(wt, 'shared.txt', 'changed in task\n');
    const status = await landing.commit(ID, { message: '  Add replies ' });
    expect(status).toMatchObject({ uncommittedCount: 0, commitsAhead: 1 });
    expect(git(wt, ['log', '-1', '--format=%s'])).toBe('Add replies');
    expect(git(repo, ['log', '-1', '--format=%s'])).toBe('init');
  });

  it.each([[''], ['   '], ['x'.repeat(201)], ['two\nlines'], [null], [12]])('refuses the message %j', async message => {
    const { landing } = await setup();
    const error = await rejection((async () => landing.commit(ID, { message }))());
    expect(error).toMatchObject({ status: 400 });
    expect(error.errors.map(item => item.field)).toEqual(['message']);
  });

  it('refuses when there is nothing to commit or a run is active', async () => {
    const { landing, wt, state } = await setup();
    expect(await rejection(landing.commit(ID, { message: 'x' }))).toMatchObject({ status: 409, message: 'There is nothing to commit.' });
    write(wt, 'a.txt', 'a\n');
    state.activeRun = true;
    const refused = await rejection(landing.commit(ID, { message: 'x' }));
    expect(refused).toMatchObject({ status: 409 });
    expect(codes(refused.extra.reasons)).toEqual(['run_active']);
  });
});

describe('task landing — merge', () => {
  it('merges the task into its base branch, removes its files and deletes the merged branch', async () => {
    const { landing, repo, wt, task, taskStore, onTaskFinished, closeTerminals, state } = await setup();
    write(wt, 'feature.txt', 'work\n');
    commitAll(wt, 'feature');
    state.terminals = { closed: ['Demo-2', 'Demo-3'], notClosed: ['Demo-4'] };
    const result = await landing.merge(ID);
    expect(onTaskFinished).toHaveBeenCalledWith(expect.objectContaining({ id: ID, state: 'merged' }));
    // The task's terminals are closed with it: their folder is gone.
    expect(closeTerminals).toHaveBeenCalledWith(expect.objectContaining({ id: ID, state: 'merged' }));
    expect(result).toMatchObject({ mergedInto: 'main', filesRemoved: true, filesDetail: null, branchDeleted: true, task: { state: 'merged' }, terminalsClosed: ['Demo-2', 'Demo-3'], terminalsNotClosed: ['Demo-4'] });
    expect(existsSync(path.join(repo, 'feature.txt'))).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, ['branch', '--list', task.branch])).toBe('');
    expect(taskStore.get(ID).finishedAt).not.toBeNull();
    expect(await rejection(landing.merge(ID))).toMatchObject({ status: 409, message: 'This task is finished.' });
  });

  it('aborts a conflicting merge, names the files and leaves both sides untouched', async () => {
    const { landing, repo, wt, taskStore, onTaskFinished, closeTerminals } = await setup();
    write(wt, 'shared.txt', 'task side\n');
    commitAll(wt, 'task change');
    write(repo, 'shared.txt', 'main side\n');
    commitAll(repo, 'main change');
    const before = git(repo, ['rev-parse', 'HEAD']);
    const refused = await rejection(landing.merge(ID));
    expect(refused).toMatchObject({ status: 409, message: 'This task conflicts with main in 1 file. Nothing was merged.' });
    expect(refused.extra.conflicts).toEqual(['shared.txt']);
    expect(closeTerminals).not.toHaveBeenCalled();
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(repo, ['status', '--porcelain'])).toBe('');
    expect(existsSync(wt)).toBe(true);
    expect(taskStore.get(ID).state).toBe('active');
    expect(onTaskFinished).not.toHaveBeenCalled();
  });

  it('refuses with every reason and changes nothing', async () => {
    const { landing, repo, wt } = await setup();
    write(wt, 'draft.txt', 'x\n');
    write(repo, 'scratch.txt', 'x\n');
    const before = git(repo, ['rev-parse', 'HEAD']);
    const refused = await rejection(landing.merge(ID));
    expect(codes(refused.extra.reasons)).toEqual(['uncommitted', 'nothing_to_land', 'main_dirty']);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(before);
  });

  it('refuses a task started from a detached Main', async () => {
    const { service, landing, repo } = await setup();
    git(repo, ['checkout', '--detach']);
    const detached = await service.create({ project: 'Demo', title: 'Detached' });
    write(detached.worktreePath, 'x.txt', 'x\n');
    commitAll(detached.worktreePath, 'x');
    expect(codes((await rejection(landing.merge(detached.id))).extra.reasons)).toEqual(['no_base_branch']);
  });
});

describe('task landing — pull request', () => {
  /** A bare repository stands in for the host; the hosting CLI is replaced. */
  async function withRemote(tool = async () => ({ stdout: 'https://gitlab.com/team/demo/-/merge_requests/7\n' })) {
    const calls = [];
    const exec = (file, args, options, done) => {
      if (file === 'git') return execFile(file, args, options, done);
      calls.push({ file, args, cwd: options.cwd, timeout: options.timeout });
      Promise.resolve().then(() => tool(file, args)).then(out => done(null, out.stdout ?? '', out.stderr ?? ''), error => done(error, '', error.stderr ?? ''));
      return undefined;
    };
    const ctx = await setup({ exec });
    const bare = path.join(ctx.base, 'gitlab.com', 'team', 'demo.git');
    mkdirSync(bare, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], { stdio: 'pipe' });
    git(ctx.repo, ['remote', 'add', 'origin', bare]);
    git(ctx.repo, ['config', `url.${bare}.insteadOf`, 'git@gitlab.com:team/demo.git']);
    git(ctx.repo, ['remote', 'set-url', 'origin', 'git@gitlab.com:team/demo.git']);
    write(ctx.wt, 'feature.txt', 'work\n');
    commitAll(ctx.wt, 'feature');
    return { ...ctx, bare, calls };
  }

  it('pushes the branch, opens a merge request with the host tool and keeps the task open', async () => {
    const { landing, bare, calls, task, taskStore, wt } = await withRemote();
    const result = await landing.pullRequest(ID, { remote: 'origin' });
    expect(result).toMatchObject({ prUrl: 'https://gitlab.com/team/demo/-/merge_requests/7', remote: 'origin', task: { state: 'pr_open' } });
    expect(execFileSync('git', ['-C', bare, 'branch', '--list', task.branch], { encoding: 'utf8' })).toContain(task.branch);
    expect(calls.map(call => call.args)).toEqual([
      ['--version'],
      ['mr', 'create', '--fill', '--yes', '--repo', 'team/demo', '--source-branch', task.branch, '--target-branch', 'main'],
    ]);
    expect(calls[1]).toMatchObject({ file: 'glab', cwd: wt, timeout: 90000 });
    expect(taskStore.get(ID)).toMatchObject({ state: 'pr_open', prUrl: result.prUrl, finishedAt: null });
    expect(existsSync(wt)).toBe(true);
  });

  it('uses gh for a GitHub remote', async () => {
    const { landing, repo, bare, calls, task } = await withRemote(async () => ({ stdout: 'https://github.com/team/demo/pull/3\n' }));
    git(repo, ['config', `url.${bare}.insteadOf`, 'https://github.com/team/demo.git']);
    git(repo, ['remote', 'add', 'github', 'https://github.com/team/demo.git']);
    await landing.pullRequest(ID, { remote: 'github' });
    expect(calls[1]).toMatchObject({ file: 'gh', args: ['pr', 'create', '--fill', '--repo', 'team/demo', '--head', task.branch, '--base', 'main'] });
  });

  it('says so when the tool is missing, fails, or reports no address, and never marks a pull request open', async () => {
    const missing = await withRemote(async (_file, args) => { if (args[0] === '--version') throw Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' }); return { stdout: '' }; });
    expect(await rejection(missing.landing.pullRequest(ID, { remote: 'origin' }))).toMatchObject({ status: 409, message: 'Install the GitLab CLI (glab) and sign in to open a pull request from here.' });

    const failing = await withRemote(async (_file, args) => { if (args[0] === '--version') return { stdout: '1' }; throw Object.assign(new Error('exit 1'), { stderr: 'not signed in\nmore' }); });
    expect(await rejection(failing.landing.pullRequest(ID, { remote: 'origin' }))).toMatchObject({ status: 503, message: 'The branch was pushed to origin, but the pull request could not be opened: not signed in' });

    const silent = await withRemote(async () => ({ stdout: 'done\n' }));
    expect(await rejection(silent.landing.pullRequest(ID, { remote: 'origin' }))).toMatchObject({ status: 503 });
    for (const ctx of [missing, failing, silent]) expect(ctx.taskStore.get(ID).state).toBe('active');
  });

  it('reports a push that failed and opens nothing', async () => {
    const { landing, repo, calls } = await withRemote();
    git(repo, ['config', '--unset', `url.${path.join(path.dirname(repo), 'gitlab.com', 'team', 'demo.git')}.insteadOf`]);
    git(repo, ['remote', 'set-url', 'origin', path.join(repo, 'no-such-remote.gitlab.com')]);
    const refused = await rejection(landing.pullRequest(ID, { remote: 'origin' }));
    expect(refused.status === 503 || refused.status === 409).toBe(true);
    expect(calls.filter(call => call.args[0] !== '--version')).toEqual([]);
  });

  it('refuses a bad or unknown remote, an unsupported host, uncommitted work and nothing to land', async () => {
    const { landing, repo, wt } = await withRemote();
    for (const remote of ['', '--force', 'a b', null, 12, 'x'.repeat(65)]) {
      const bad = await rejection((async () => landing.pullRequest(ID, { remote }))());
      expect(bad.status).toBe(400);
      expect(bad.errors.map(item => item.field)).toEqual(['remote']);
    }
    expect(await rejection(landing.pullRequest(ID, { remote: 'nowhere' }))).toMatchObject({ status: 400 });
    git(repo, ['remote', 'add', 'mirror', 'https://git.example.test/team/demo.git']);
    expect(await rejection(landing.pullRequest(ID, { remote: 'mirror' }))).toMatchObject({ status: 409, message: 'CodeDeck can open pull requests on GitHub and GitLab only; mirror is on git.example.test.' });
    write(wt, 'draft.txt', 'x\n');
    expect(codes((await rejection(landing.pullRequest(ID, { remote: 'origin' }))).extra.reasons)).toEqual(['uncommitted']);
  });
});

describe('task landing — close', () => {
  it('removes a clean task, keeps its unmerged branch and says so', async () => {
    const { landing, repo, wt, task, onTaskFinished, closeTerminals, state } = await setup();
    write(wt, 'feature.txt', 'work\n');
    commitAll(wt, 'feature');
    state.terminals = { closed: ['Demo-2'], notClosed: [] };
    const result = await landing.close(ID);
    expect(onTaskFinished).toHaveBeenCalledWith(expect.objectContaining({ id: ID, state: 'closed' }));
    expect(closeTerminals).toHaveBeenCalledWith(expect.objectContaining({ id: ID, state: 'closed' }));
    expect(result).toMatchObject({ task: { state: 'closed' }, branchKept: task.branch, unmergedCommits: 1, terminalsClosed: ['Demo-2'], terminalsNotClosed: [] });
    expect(existsSync(wt)).toBe(false);
    expect(git(repo, ['branch', '--list', task.branch])).toContain(task.branch);
  });

  it('refuses to close over uncommitted work or an active run, and closes a task whose files are gone', async () => {
    const { landing, wt, state, taskStore } = await setup();
    write(wt, 'draft.txt', 'x\n');
    expect(codes((await rejection(landing.close(ID))).extra.reasons)).toEqual(['uncommitted']);
    expect(existsSync(path.join(wt, 'draft.txt'))).toBe(true);
    state.activeRun = true;
    expect(codes((await rejection(landing.close(ID))).extra.reasons)).toEqual(['run_active', 'uncommitted']);
    state.activeRun = false;
    rmSync(wt, { recursive: true, force: true });
    expect((await landing.close(ID)).task.state).toBe('closed');
    expect(taskStore.get(ID).state).toBe('closed');
  });
});

describe('describeRemote', () => {
  it.each([
    ['git@github.com:team/demo.git', 'github.com', 'team/demo', 'gh'],
    ['https://github.com/team/demo', 'github.com', 'team/demo', 'gh'],
    ['https://user@gitlab.com/group/sub/demo.git', 'gitlab.com', 'group/sub/demo', 'glab'],
    ['ssh://git@gitlab.example.test:2222/team/demo.git', 'gitlab.example.test', 'team/demo', 'glab'],
    ['https://git.example.test/team/demo.git', 'git.example.test', 'team/demo', null],
    ['/local/path/demo.git', null, null, null],
    ['', null, null, null],
  ])('%s', (url, host, repository, tool) => {
    expect(describeRemote(url)).toEqual({ host, repository, tool });
  });
});

it('requires its dependencies', () => {
  expect(() => createTaskLanding({})).toThrow('taskStore is required');
});

// Audit b2bd312, items B01 and B02: landing must not lose work that Git's ordinary status does not show.
describe('task landing — work that ordinary status does not show', () => {
  const tracing = trace => (file, args, options, callback) => execFile(file, args, options, (error, stdout, stderr) => {
    trace.push({ command: args.slice(2).join(' '), ok: !error });
    callback(error, stdout, stderr);
  });
  const ran = (trace, prefix) => trace.some(call => call.ok && call.command.startsWith(prefix));
  const refs = repo => git(repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']).split('\n');
  const fingerprint = (dir, file) => (existsSync(path.join(dir, file)) ? git(dir, ['hash-object', file]) : null);
  const registered = (repo, wt) => git(repo, ['worktree', 'list', '--porcelain']).split('\n').includes(`worktree ${wt}`);
  const outcome = promise => promise.then(
    result => ({ refused: false, status: null, reasons: [], state: result.task.state }),
    error => ({ refused: true, status: error.status, reasons: error.extra?.reasons ?? [], state: null }),
  );

  it('Close preserves a unique ignored owner file', async () => {
    const trace = [];
    const { wt, repo, landing, taskStore } = await setup({ exec: tracing(trace) });
    write(wt, '.gitignore', 'owner.local\n');
    commitAll(wt, 'ignore the owner file');
    write(wt, 'owner.local', 'unique fixture, exists nowhere else\n');
    // The conditions of the stated cause: ordinary status is empty, the ignored listing is not, Main has no copy.
    expect(git(wt, ['status', '--porcelain'])).toBe('');
    expect(git(wt, ['status', '--porcelain', '--ignored'])).toBe('!! owner.local');
    expect(existsSync(path.join(repo, 'owner.local'))).toBe(false);
    const before = fingerprint(wt, 'owner.local');

    const closed = await outcome(landing.close(ID));

    expect({
      refused: closed.refused, status: closed.status, taskState: taskStore.get(ID).state,
      worktreeRemoved: ran(trace, 'worktree remove'), checkoutExists: existsSync(wt), ownerFile: fingerprint(wt, 'owner.local'),
    }).toEqual({ refused: true, status: 409, taskState: 'active', worktreeRemoved: false, checkoutExists: true, ownerFile: before });
    expect(closed.reasons).toHaveLength(1);
    expect(closed.reasons[0].message).toContain('owner.local');
    expect((await landing.status(ID)).blockers.close.map(item => item.code)).toEqual([closed.reasons[0].code]);
  });

  it('Merge refuses a task whose checkout switched branches', async () => {
    const trace = [];
    const { wt, repo, landing, taskStore, task } = await setup({ exec: tracing(trace) });
    git(wt, ['switch', '-c', 'other']);
    write(wt, 'desired.txt', 'requested work\n');
    commitAll(wt, 'requested work');
    const commit = git(wt, ['rev-parse', 'HEAD']);
    const before = { refs: refs(repo), fixture: fingerprint(wt, 'desired.txt') };
    // The conditions of the stated cause: the saved branch is still at Main, the work is on another branch.
    expect(git(repo, ['rev-parse', task.branch])).toBe(git(repo, ['rev-parse', 'main']));
    expect(git(repo, ['branch', '--contains', commit, '--format=%(refname:short)'])).toBe('other');

    const merged = await outcome(landing.merge(ID));

    expect({
      refused: merged.refused, status: merged.status, taskState: taskStore.get(ID).state,
      mergeRan: ran(trace, 'merge '), worktreeRemoved: ran(trace, 'worktree remove'),
      refs: refs(repo), registered: registered(repo, wt), fixture: fingerprint(wt, 'desired.txt'),
    }).toEqual({
      refused: true, status: 409, taskState: 'active', mergeRan: false, worktreeRemoved: false,
      refs: before.refs, registered: true, fixture: before.fixture,
    });
    expect(merged.reasons).toHaveLength(1);
    expect(merged.reasons[0].message).toContain('other');
    expect(merged.reasons[0].message).toContain(task.branch);
  });

  it('Merge lands the work but keeps a folder holding a unique ignored owner file, and says so', async () => {
    const trace = [];
    const { wt, repo, landing, taskStore, task } = await setup({ exec: tracing(trace) });
    write(wt, '.gitignore', 'owner.local\n');
    write(wt, 'feature.txt', 'work\n');
    commitAll(wt, 'feature');
    write(wt, 'owner.local', 'unique fixture, exists nowhere else\n');
    const before = fingerprint(wt, 'owner.local');

    const result = await landing.merge(ID);

    expect({
      taskState: taskStore.get(ID).state, mainHasFeature: existsSync(path.join(repo, 'feature.txt')),
      worktreeRemoved: ran(trace, 'worktree remove'), registered: registered(repo, wt), ownerFile: fingerprint(wt, 'owner.local'),
      filesRemoved: result.filesRemoved, branchDeleted: result.branchDeleted, branchKept: refs(repo).some(ref => ref.startsWith(`${task.branch} `)),
    }).toEqual({
      taskState: 'merged', mainHasFeature: true, worktreeRemoved: false, registered: true, ownerFile: before,
      filesRemoved: false, branchDeleted: false, branchKept: true,
    });
    expect(result.filesDetail).toContain('owner.local');
  });

  it('Close refuses an ignored file whose name is in Main but whose bytes differ', async () => {
    const { wt, repo, landing, taskStore } = await setup();
    write(wt, '.gitignore', 'owner.local\n');
    commitAll(wt, 'ignore the owner file');
    write(wt, 'owner.local', 'task copy\n');
    write(repo, 'owner.local', 'home copy\n');
    const before = fingerprint(wt, 'owner.local');

    const closed = await outcome(landing.close(ID));

    expect({ refused: closed.refused, status: closed.status, taskState: taskStore.get(ID).state, ownerFile: fingerprint(wt, 'owner.local') })
      .toEqual({ refused: true, status: 409, taskState: 'active', ownerFile: before });
    expect(closed.reasons.map(item => item.code)).toEqual(['ignored_files']);
  });

  it('Close lets disposable ignored folders and byte-identical copies of Main go with the folder', async () => {
    const { wt, repo, landing } = await setup();
    write(wt, '.gitignore', 'node_modules/\ndist/\nbuild/\ntarget/\n.codedeck/\nsame.local\n');
    commitAll(wt, 'ignore');
    // `target` is where Maven and Cargo put what they build.
    for (const dir of ['node_modules', 'dist', 'build', 'target', '.codedeck']) { mkdirSync(path.join(wt, dir)); write(path.join(wt, dir), 'x.txt', 'x\n'); }
    write(wt, 'same.local', 'identical\n');
    write(repo, 'same.local', 'identical\n');

    expect((await landing.status(ID)).blockers.close).toEqual([]);
    expect((await landing.close(ID)).task.state).toBe('closed');
    expect(existsSync(wt)).toBe(false);
  });

  describe('an ignored folder', () => {
    // The Setup step copies local settings such as a secrets folder from Main into the task.
    const secrets = (root, files) => {
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(root, 'secrets', file)), { recursive: true });
        write(path.join(root, 'secrets'), file, text);
      }
    };
    async function ignoring() {
      const ctx = await setup();
      write(ctx.wt, '.gitignore', 'secrets/\n');
      commitAll(ctx.wt, 'ignore the secrets folder');
      return ctx;
    }
    const COPIES = { 'api.key': 'key-one\n', 'certs/server.pem': 'pem\n', 'certs/deep/ca.pem': 'ca\n' };

    it('goes with the task when every file in it is copied byte for byte in Main', async () => {
      const { wt, repo, landing } = await ignoring();
      secrets(wt, COPIES);
      secrets(repo, { ...COPIES, 'only-in-main.key': 'extra\n' });
      mkdirSync(path.join(wt, 'secrets', 'empty'));
      // The conditions of the reported fault: Git lists the folder as one entry, and Main holds the same files.
      expect(git(wt, ['status', '--porcelain', '--ignored'])).toBe('!! secrets/');

      expect((await landing.status(ID)).blockers.close).toEqual([]);
      expect((await landing.close(ID)).task.state).toBe('closed');
      expect(existsSync(wt)).toBe(false);
      expect(existsSync(path.join(repo, 'secrets', 'api.key'))).toBe(true);
    });

    it.each([
      ['a file Main does not have', { ...COPIES, 'new.key': 'made in the task\n' }, COPIES],
      ['a nested file Main does not have', { ...COPIES, 'certs/deep/new.pem': 'made in the task\n' }, COPIES],
      ['a file of the same length whose bytes differ', { ...COPIES, 'api.key': 'key-two\n' }, COPIES],
      ['a file of another length', { ...COPIES, 'api.key': 'a longer key\n' }, COPIES],
      ['files when Main has no such folder', COPIES, {}],
      ['a file whose name is a folder in Main', { 'api.key': 'key-one\n' }, { 'api.key/inner': 'x\n' }],
      ['a folder whose name is a file in Main', { 'certs/server.pem': 'pem\n' }, { certs: 'a file\n' }],
    ])('is kept when it holds %s', async (_name, inTask, inMain) => {
      const { wt, repo, landing, taskStore } = await ignoring();
      secrets(wt, inTask);
      secrets(repo, inMain);

      const closed = await outcome(landing.close(ID));

      expect({ refused: closed.refused, status: closed.status, taskState: taskStore.get(ID).state, checkoutExists: existsSync(wt) })
        .toEqual({ refused: true, status: 409, taskState: 'active', checkoutExists: true });
      expect(closed.reasons.map(item => item.code)).toEqual(['ignored_files']);
      expect(closed.reasons[0].message).toBe('This task has files Git ignores that exist nowhere else: secrets/. Move or delete them first.');
    });

    it('is kept when it holds a link, which cannot be shown to be a copy', async () => {
      const { wt, repo, landing } = await ignoring();
      secrets(wt, { 'api.key': 'key-one\n' });
      secrets(repo, { 'api.key': 'key-one\n', 'link.key': 'key-one\n' });
      symlinkSync('api.key', path.join(wt, 'secrets', 'link.key'));

      expect(codes((await landing.status(ID)).blockers.close)).toEqual(['ignored_files']);
    });

    it('does not look inside disposable folders it contains', async () => {
      const { wt, repo, landing } = await ignoring();
      secrets(wt, { 'api.key': 'key-one\n', 'node_modules/pkg/index.js': 'installed in the task\n', 'tool/.codedeck/note.md': 'note\n' });
      secrets(repo, { 'api.key': 'key-one\n' });

      expect((await landing.status(ID)).blockers.close).toEqual([]);
    });
  });

  it('Status reports an ignored file whose name is a folder in Main instead of failing', async () => {
    const { wt, repo, landing } = await setup();
    write(wt, '.gitignore', 'conf\n');
    commitAll(wt, 'ignore conf');
    write(wt, 'conf', 'a file in the task\n');
    mkdirSync(path.join(repo, 'conf'));
    write(path.join(repo, 'conf'), 'inner.txt', 'a folder in Main\n');

    expect(codes((await landing.status(ID)).blockers.close)).toEqual(['ignored_files']);
  });

  it.each([
    ['another branch', wt => git(wt, ['switch', '-c', 'other'])],
    ['a detached HEAD', wt => git(wt, ['switch', '--detach'])],
  ])('Close refuses a task whose checkout is on %s', async (_label, move) => {
    const trace = [];
    const { wt, landing, taskStore } = await setup({ exec: tracing(trace) });
    move(wt);
    write(wt, 'desired.txt', 'requested work\n');
    commitAll(wt, 'requested work');

    const closed = await outcome(landing.close(ID));

    expect({ refused: closed.refused, status: closed.status, taskState: taskStore.get(ID).state, worktreeRemoved: ran(trace, 'worktree remove'), checkoutExists: existsSync(wt) })
      .toEqual({ refused: true, status: 409, taskState: 'active', worktreeRemoved: false, checkoutExists: true });
    expect(closed.reasons.map(item => item.code)).toEqual(['branch_switched']);
  });
});
