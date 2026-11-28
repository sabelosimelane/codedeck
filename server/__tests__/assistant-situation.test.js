import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import Database from 'better-sqlite3';
import { createTaskStore } from '../tasks/task-store.js';
import { createTaskLanding } from '../tasks/task-landing.js';
import { createRunStore } from '../pipelines/run-store.js';
import { composeSituation } from '../assistant/situation.js';

const roots = [];
const dbs = [];
afterEach(async () => { dbs.splice(0).forEach(db => db.close()); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
async function repository(base, name) {
  const root = path.join(base, name);
  await fs.mkdir(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'assistant@test.local');
  git(root, 'config', 'user.name', 'Assistant Test');
  await fs.writeFile(path.join(root, 'README.md'), name);
  git(root, 'add', '--all'); git(root, 'commit', '-m', 'init');
  return root;
}

describe('composeSituation', () => {
  it('reads real repositories, task worktree, landing and run store like the Acme case', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-situation-')); roots.push(base);
    const backend = await repository(base, 'backend');
    const frontend = await repository(base, 'frontend');
    const worktreePath = path.join(base, 'task');
    git(backend, 'worktree', 'add', '-b', 'feature/task', worktreePath);
    const first = 'docs/todos/first.md';
    const second = 'docs/todos/second.md';
    await fs.mkdir(path.join(worktreePath, 'docs/todos'), { recursive: true });
    await fs.writeFile(path.join(worktreePath, first), '# First\n**Status**: In Progress\n## Phase 1: Setup\n' + '- [x] done\n'.repeat(10) + '## Phase 2: Feed\n' + '- [x] done\n'.repeat(4) + '- [ ] next\n'.repeat(2) + '## Phase 3\n- [ ] next\n## Phase 4\n- [ ] next\n## Phase 5\n- [ ] next');
    await fs.writeFile(path.join(worktreePath, second), `# Second\n> Wait for ${first}.\n## Phase 1: Start\n- [ ] next`);
    await fs.writeFile(path.join(worktreePath, ' '), 'stray');
    await fs.writeFile(path.join(worktreePath, '\\n'), 'stray');
    await fs.writeFile(path.join(backend, 'main-draft.txt'), 'dirty');
    await fs.writeFile(path.join(frontend, 'front-draft.txt'), 'dirty');
    const db = new Database(':memory:'); dbs.push(db);
    const ids = ['7a000000-0000-4000-8000-000000000001', '7a000000-0000-4000-8000-000000000002'];
    const taskStore = createTaskStore(db, { newId: () => ids.shift() });
    const task = taskStore.create({ id: '7a000000-0000-4000-8000-000000000003', project: 'Demo', title: 'Build integration', titleSource: 'owner', folder: null, repository: 'backend', repositoryPath: backend, worktreePath, branch: 'feature/task', baseBranch: 'main', baseCommit: git(backend, 'rev-parse', 'HEAD') });
    const findProject = name => name === 'Demo' ? { name: 'Demo', path: backend, host: 'local', repositories: [{ name: 'frontend', path: frontend }] } : null;
    const landing = createTaskLanding({ taskStore, findProject, execFile, pathExists: async target => (await fs.stat(target).then(() => true, () => false)), hasActiveRun: () => false, onTaskFinished: () => {}, onWorktreeFinished: () => {}, closeTerminals: async () => ({ closed: [], notClosed: [] }) });
    const runStore = createRunStore(db);
    const runId = '8a000000-0000-4000-8000-000000000001';
    const agentId = '9a000000-0000-4000-8000-000000000001';
    const workflowId = 'aa000000-0000-4000-8000-000000000001';
    runStore.create({ id: runId, requestId: 'assistant-run', workflowId, project: 'Demo', input: first, status: 'complete', stopReason: null, currentStepIndex: 0, error: null, definition: { workflowId, workflowName: 'Feature Build', workflowRevision: 1, agentsDecide: false, progressFile: first, notesDir: null, steps: [{ kind: 'node', role: '', askOwner: false, readOnly: false, approval: false, name: 'Test', prompt: 'Test', repeat: { mode: 'once' }, agent: { id: agentId, name: 'Test agent', launchCommand: 'codex', resetCommand: '/clear' } }] }, steps: [{ status: 'limit_accepted', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 }], homePath: backend, worktreePath, worktreeBranch: 'feature/task', baseCommit: git(backend, 'rev-parse', 'HEAD'), worktreeState: 'removal_blocked', worktreeDetail: null, inputRequest: null, taskId: task.id, finishedAt: new Date().toISOString() });
    const situation = await composeSituation({ projectName: 'Demo', findProject, repositoryService: { list: async () => [{ name: 'backend', own: true, path: backend, branch: 'main', usable: true, reason: null }, { name: 'frontend', own: false, path: frontend, branch: 'main', usable: true, reason: null }] }, taskStore, landing, runStore, runView: async run => ({ id: run.id, workflowName: run.definition.workflowName, status: run.status, steps: run.steps.map((step, index) => ({ index, name: 'Test', status: step.status })), progress: { file: first, status: 'in_progress', phaseCount: 5, phase: { number: 2, position: 2, title: 'Feed', tasksDone: 4, tasksTotal: 6 }, tasksDone: 14, tasksTotal: 18 } }), execFile });
    expect(situation.todos.find(todo => todo.path === first).phases[1]).toMatchObject({ done: 4, total: 6 });
    expect([...new Set(situation.flags.map(flag => flag.code))]).toEqual(['run_complete_todo_unfinished', 'work_uncommitted_no_commits', 'merge_blocked', 'todo_not_started', 'todo_depends_on_unfinished', 'other_repository_dirty', 'stray_files']);
    expect(situation.flags.find(flag => flag.code === 'merge_blocked').blockers).toContainEqual(expect.objectContaining({ code: 'main_dirty' }));
    expect(situation.flags.filter(flag => flag.code === 'stray_files')).toHaveLength(2);
  });

  it('reports a clean project without tasks or attention flags', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-clean-')); roots.push(base);
    const root = await repository(base, 'clean');
    const result = await composeSituation({ projectName: 'Clean', findProject: () => ({ name: 'Clean', path: root, host: 'local' }), repositoryService: { list: async () => [{ name: 'clean', own: true, path: root, branch: 'main', usable: true, reason: null }] }, taskStore: { list: () => [] }, landing: { worktrees: async () => [] }, runStore: { list: () => [] }, runView: async () => { throw new Error('unexpected run'); }, execFile });
    expect(result.flags).toEqual([]);
    expect(result.markdown).toContain('Nothing needs your attention');
  });

  it('names a corrupt repository field', async () => {
    await expect(composeSituation({ projectName: 'Bad', findProject: () => ({ name: 'Bad', path: '/tmp', host: 'local' }), repositoryService: { list: async () => [{ name: null, path: '/tmp' }] }, taskStore: { list: () => [] }, landing: { worktrees: async () => [] }, runStore: { list: () => [] }, runView: async () => {}, execFile })).rejects.toThrow(/repository.*name/);
  });
  it('keeps changed task todos, folds identical copies into Main, and reads one nonlocking status per folder', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-copies-')); roots.push(base);
    const backend = await repository(base, 'backend');
    const frontend = await repository(base, 'frontend');
    const rel = 'docs/todos/shared.md';
    const mainText = '# Shared\n## Phase 1\n' + '- [ ] open\n'.repeat(6);
    for (const root of [backend, frontend]) { await fs.mkdir(path.join(root, 'docs/todos'), { recursive: true }); await fs.writeFile(path.join(root, rel), mainText); git(root, 'add', '--all'); git(root, 'commit', '-m', 'todo'); }
    const a = path.join(base, 'task-a'); const b = path.join(base, 'task-b');
    git(backend, 'worktree', 'add', '-b', 'task/a', a); git(backend, 'worktree', 'add', '-b', 'task/b', b);
    await fs.writeFile(path.join(a, rel), '# Shared\n## Phase 1\n' + '- [x] done\n'.repeat(6));
    for (const name of ['0', 't', 'n', 'tt', ' ', '\\n']) await fs.writeFile(path.join(a, name), 'stray');
    const worktree = (root, id) => ({ worktreeId: id, repository: 'backend', worktreePath: root, branch: `task/${id}`, baseBranch: 'main', filesPresent: true, uncommittedCount: id === 'a' ? 7 : 0, commitsAhead: 0, commitsBehind: 0, blockers: { commit: [], merge: [], pullRequest: [], close: [] } });
    const run = { id: 'run-a', taskId: 'task-a', project: 'Demo', worktreeState: 'removal_blocked', status: 'complete' };
    const released = { ...run, id: 'run-b', taskId: 'task-b', worktreeState: 'released' };
    const progress = { file: rel, status: 'complete', phaseCount: 1, phase: { number: 1, position: 1, title: 'Phase 1', tasksDone: 6, tasksTotal: 6 }, tasksDone: 6, tasksTotal: 6 };
    const calls = [];
    const observedExec = (command, args, options, callback) => { calls.push({ command, args, options }); return execFile(command, args, options, callback); };
    const result = await composeSituation({ projectName: 'Demo', findProject: () => ({ name: 'Demo', path: backend, host: 'local' }), repositoryService: { list: async () => [{ name: 'backend', own: true, path: backend, branch: 'main', usable: true, reason: null }, { name: 'frontend', own: false, path: frontend, branch: 'main', usable: true, reason: null }] }, taskStore: { list: () => [{ id: 'task-a', project: 'Demo', state: 'active', title: 'A' }, { id: 'task-b', project: 'Demo', state: 'active', title: 'B' }] }, landing: { worktrees: async id => [id === 'task-a' ? worktree(a, 'a') : worktree(b, 'b')] }, runStore: { list: () => [run, released] }, runView: async item => ({ workflowName: 'Build', status: 'complete', steps: [{ index: 0, name: 'Test', status: 'done' }], progress: item.id === 'run-a' ? progress : null }), execFile: observedExec });
    expect(result.todos.filter(todo => todo.path === rel)).toHaveLength(3);
    expect(result.todos.find(todo => todo.location === 'main:backend').alsoIn).toEqual(['task:task-b/b']);
    expect(result.todos.find(todo => todo.location === 'task:task-a/a').phases[0].done).toBe(6);
    expect(result.flags.filter(flag => flag.code === 'todo_not_started')).toHaveLength(2);
    expect(result.flags.filter(flag => flag.code === 'run_complete_todo_unfinished')).toHaveLength(0);
    expect(result.tasks[1].runs).toEqual([]);
    expect(result.tasks[0].worktrees[0].strayFiles).toEqual([' ', '\\n']);
    const statuses = calls.filter(call => call.args.includes('status'));
    expect(statuses).toHaveLength(4);
    for (const call of statuses) { expect(call.args).toContain('--no-optional-locks'); expect(call.options.timeout).toBeGreaterThan(0); expect(call.options.maxBuffer).toBe(10 * 1024 * 1024); }
  });
  it('names corrupt task, worktree, run, and progress fields at their edges', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-guards-')); roots.push(base);
    const root = await repository(base, 'backend');
    const task = { id: 'task-1', project: 'Demo', title: 'Build', state: 'active' };
    const worktree = { worktreeId: 'worktree-1', repository: 'backend', worktreePath: root, branch: 'feature/task', baseBranch: 'main', filesPresent: false, uncommittedCount: 0, commitsAhead: 0, commitsBehind: 0, blockers: { commit: [], merge: [], pullRequest: [], close: [] } };
    const run = { id: 'run-1', taskId: task.id, project: 'Demo', worktreeState: 'removal_blocked', status: 'complete' };
    const progress = { file: 'docs/todos/work.md', status: 'in_progress', phaseCount: 1, phase: { number: 1, position: 1, title: 'Work', tasksDone: 0, tasksTotal: 1 }, tasksDone: 0, tasksTotal: 1 };
    const view = { workflowName: 'Build', status: 'complete', steps: [], progress };
    const options = { projectName: 'Demo', findProject: () => ({ name: 'Demo', path: root, host: 'local' }), repositoryService: { list: async () => [{ name: 'backend', own: true, path: root, branch: 'main', usable: true, reason: null }] }, taskStore: { list: () => [task] }, landing: { worktrees: async () => [worktree] }, runStore: { list: () => [run] }, runView: async () => view, execFile };
    await expect(composeSituation({ ...options, taskStore: { list: () => [{ ...task, title: null }] } })).rejects.toThrow(/task-1.*title/);
    await expect(composeSituation({ ...options, taskStore: { list: () => [{ ...task, state: null }] } })).rejects.toThrow(/task-1.*state/);
    await expect(composeSituation({ ...options, landing: { worktrees: async () => [{ ...worktree, filesPresent: null }] } })).rejects.toThrow(/worktree-1.*filesPresent/);
    for (const [field, bad] of [['taskId', 42], ['worktreeState', null], ['worktreeState', 'mystery'], ['project', 'Elsewhere']]) {
      await expect(composeSituation({ ...options, runStore: { list: () => [{ ...run, [field]: bad }] } })).rejects.toThrow(new RegExp(`run-1.*${field}`));
    }
    for (const field of ['file', 'status', 'phaseCount', 'tasksDone', 'tasksTotal']) {
      await expect(composeSituation({ ...options, runView: async () => ({ ...view, progress: { ...progress, [field]: undefined } }) })).rejects.toThrow(new RegExp(`run-1.*progress\\.${field}`));
    }
    for (const field of ['number', 'position', 'title', 'tasksDone', 'tasksTotal']) {
      await expect(composeSituation({ ...options, runView: async () => ({ ...view, progress: { ...progress, phase: { ...progress.phase, [field]: undefined } } }) })).rejects.toThrow(new RegExp(`run-1.*progress\\.phase\\.${field}`));
    }
    const foreign = { id: 'run-other', taskId: 'task-elsewhere', project: 'Elsewhere', worktreeState: 'present', status: 'running' };
    const withForeign = await composeSituation({ ...options, runStore: { list: () => [foreign, run] } });
    expect(withForeign.tasks[0].runs.map(entry => entry.id)).toEqual(['run-1']);
    const noProgress = await composeSituation({ ...options, runStore: { list: () => [{ ...run, definition: { progressFile: 'docs/todos/old.md' } }] }, runView: async () => ({ ...view, progress: null }) });
    expect(noProgress.tasks[0].runs[0].progressFile).toBeNull();
    expect(noProgress.tasks[0].runs[0].progress).toBeNull();
  });
});

describe('composeSituation bounds', () => {
  it('keeps at most 50 dirty paths per repository and marks the list truncated', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-dirty-')); roots.push(base);
    const root = await repository(base, 'busy');
    for (let i = 0; i < 51; i++) await fs.writeFile(path.join(root, `draft-${String(i).padStart(2, '0')}.txt`), 'dirty');
    const result = await composeSituation({ projectName: 'Busy', findProject: () => ({ name: 'Busy', path: root, host: 'local' }), repositoryService: { list: async () => [{ name: 'busy', own: true, path: root, branch: 'main', usable: true, reason: null }] }, taskStore: { list: () => [] }, landing: { worktrees: async () => [] }, runStore: { list: () => [] }, runView: async () => { throw new Error('unexpected run'); }, execFile });
    expect(result.repositories[0].dirtyCount).toBe(51);
    expect(result.repositories[0].dirty).toHaveLength(50);
    expect(result.truncated.dirty).toBe(true);
  });

  it('does not mark exactly 50 dirty paths as truncated', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-dirty-50-')); roots.push(base);
    const root = await repository(base, 'full');
    for (let i = 0; i < 50; i++) await fs.writeFile(path.join(root, `draft-${String(i).padStart(2, '0')}.txt`), 'dirty');
    const result = await composeSituation({ projectName: 'Full', findProject: () => ({ name: 'Full', path: root, host: 'local' }), repositoryService: { list: async () => [{ name: 'full', own: true, path: root, branch: 'main', usable: true, reason: null }] }, taskStore: { list: () => [] }, landing: { worktrees: async () => [] }, runStore: { list: () => [] }, runView: async () => { throw new Error('unexpected run'); }, execFile });
    expect(result.repositories[0].dirty).toHaveLength(50);
    expect(result.truncated.dirty).toBe(false);
  });
});

describe('composeSituation with real-world names and progress', () => {
  it('accepts a whitespace-named untracked file in Main and reports it as stray', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-main-stray-')); roots.push(base);
    const root = await repository(base, 'main-stray');
    await fs.writeFile(path.join(root, ' '), '');
    await fs.writeFile(path.join(root, '\\n'), '');
    const result = await composeSituation({ projectName: 'Stray', findProject: () => ({ name: 'Stray', path: root, host: 'local' }), repositoryService: { list: async () => [{ name: 'main-stray', own: true, path: root, branch: 'main', usable: true, reason: null }] }, taskStore: { list: () => [] }, landing: { worktrees: async () => [] }, runStore: { list: () => [] }, runView: async () => { throw new Error('unexpected run'); }, execFile });
    expect(result.repositories[0].dirty).toEqual(expect.arrayContaining([' ', '\\n']));
    expect(result.repositories[0].strayFiles).toEqual(expect.arrayContaining([' ', '\\n']));
    expect(result.flags.filter(flag => flag.code === 'stray_files').map(flag => flag.where)).toEqual(expect.arrayContaining([{ repository: 'main-stray', path: ' ' }, { repository: 'main-stray', path: '\\n' }]));
  });

  it('accepts a run whose progress file is missing, with null counts', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-missing-progress-')); roots.push(base);
    const root = await repository(base, 'backend');
    const task = { id: 'task-1', project: 'Demo', title: 'Build', state: 'active' };
    const worktree = { worktreeId: 'worktree-1', repository: 'backend', worktreePath: root, branch: 'feature/task', baseBranch: 'main', filesPresent: false, uncommittedCount: 0, commitsAhead: 0, commitsBehind: 0, blockers: { commit: [], merge: [], pullRequest: [], close: [] } };
    const run = { id: 'run-1', taskId: task.id, project: 'Demo', worktreeState: 'external', status: 'complete' };
    const view = { workflowName: 'Build', status: 'complete', steps: [], progress: { file: 'docs/todos/gone.md', status: 'missing', phaseCount: null, phase: null, tasksDone: null, tasksTotal: null } };
    const result = await composeSituation({ projectName: 'Demo', findProject: () => ({ name: 'Demo', path: root, host: 'local' }), repositoryService: { list: async () => [{ name: 'backend', own: true, path: root, branch: 'main', usable: true, reason: null }] }, taskStore: { list: () => [task] }, landing: { worktrees: async () => [worktree] }, runStore: { list: () => [run] }, runView: async () => view, execFile });
    expect(result.tasks[0].runs[0].progress).toEqual(view.progress);
    expect(result.flags.filter(flag => flag.code === 'run_complete_todo_unfinished')).toEqual([]);
    for (const field of ['phaseCount', 'tasksDone', 'tasksTotal']) {
      await expect(composeSituation({ projectName: 'Demo', findProject: () => ({ name: 'Demo', path: root, host: 'local' }), repositoryService: { list: async () => [{ name: 'backend', own: true, path: root, branch: 'main', usable: true, reason: null }] }, taskStore: { list: () => [task] }, landing: { worktrees: async () => [worktree] }, runStore: { list: () => [run] }, runView: async () => ({ ...view, progress: { ...view.progress, [field]: -1 } }), execFile })).rejects.toThrow(new RegExp(`run-1.*progress\\.${field}`));
    }
  });
});

describe('composeSituation with a folder that is not a Git repository', () => {
  it('reports the repository as unusable with its reason and runs no Git command there', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-not-git-')); roots.push(base);
    const calls = [];
    const spy = (file, args, options, callback) => { calls.push(args); return execFile(file, args, options, callback); };
    const reason = { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' };
    const result = await composeSituation({ projectName: 'Plain', findProject: () => ({ name: 'Plain', path: base, host: 'local' }), repositoryService: { list: async () => [{ name: 'plain', own: true, path: base, branch: null, usable: false, reason }] }, taskStore: { list: () => [] }, landing: { worktrees: async () => [] }, runStore: { list: () => [] }, runView: async () => { throw new Error('unexpected run'); }, execFile: spy });
    expect(result.repositories).toEqual([{ name: 'plain', own: true, path: base, usable: false, reason }]);
    expect(calls).toEqual([]);
    expect(result.flags).toEqual([]);
    expect(result.markdown).toContain('plain: This folder is not the top level of a Git working tree.');
  });

  it('names a repository entry without a usable flag', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-usable-guard-')); roots.push(base);
    await expect(composeSituation({ projectName: 'Plain', findProject: () => ({ name: 'Plain', path: base, host: 'local' }), repositoryService: { list: async () => [{ name: 'plain', own: true, path: base, branch: null }] }, taskStore: { list: () => [] }, landing: { worktrees: async () => [] }, runStore: { list: () => [] }, runView: async () => { throw new Error('unexpected run'); }, execFile })).rejects.toThrow(/repository plain.*usable/);
  });
});
