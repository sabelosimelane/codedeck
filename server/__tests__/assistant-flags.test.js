import { describe, expect, it } from 'vitest';
import { situationFlags } from '../assistant/situation-flags.js';

const path = 'docs/todos/first.md';
const task = { id: 't', title: 'Build integration', state: 'active', worktrees: [{ worktreeId: 'w', repository: 'backend', uncommittedCount: 2, commitsAhead: 0, blockers: { merge: [{ code: 'main_dirty', message: 'Main is dirty.' }] }, strayFiles: [' ', '\\n'] }], runs: [{ id: 'r', workflow: 'Feature Build', status: 'complete', steps: [{ status: 'limit_accepted' }], progressFile: path, progress: { file: path, status: 'in_progress', tasksDone: 4, tasksTotal: 6 } }] };
const first = { path, repository: 'backend', location: 'task:t/w', title: 'First', phases: [{ number: 1, title: 'Setup', done: 2, total: 2 }, { number: 2, title: 'Feed', done: 4, total: 6 }], dependsOn: [] };
const second = { path: 'docs/todos/second.md', repository: 'backend', location: 'task:t/w', title: 'Second', phases: [{ number: 1, title: 'Plan', done: 0, total: 2 }], dependsOn: [path] };
const facts = { tasks: [task], repositories: [{ name: 'backend', dirtyCount: 1, strayFiles: [] }, { name: 'frontend', dirtyCount: 2, strayFiles: [] }], todos: [first, second] };

describe('situationFlags', () => {
  it('raises all seven codes in specification order with useful identities', () => {
    const flags = situationFlags(facts);
    expect([...new Set(flags.map(flag => flag.code))]).toEqual(['run_complete_todo_unfinished', 'work_uncommitted_no_commits', 'merge_blocked', 'todo_not_started', 'todo_depends_on_unfinished', 'other_repository_dirty', 'stray_files']);
    expect(flags.find(flag => flag.code === 'merge_blocked').blockers).toEqual([{ code: 'main_dirty', message: 'Main is dirty.' }]);
    expect(flags.find(flag => flag.code === 'todo_depends_on_unfinished').message).toContain('Phase 2');
    expect(flags.find(flag => flag.code === 'run_complete_todo_unfinished').where).toMatchObject({ taskId: 't', runId: 'r', path });
    for (const flag of flags) expect(flag.message).toMatch(/\.$/);
  });
  it('raises no codes for clean, completed work', () => {
    expect(situationFlags({ tasks: [], repositories: [{ name: 'backend', dirtyCount: 0, strayFiles: [] }], todos: [] })).toEqual([]);
  });
  it('judges distinct todo copies independently', () => {
    const mainCopy = { ...first, location: 'main:backend', phases: [{ number: 1, title: 'Setup', done: 0, total: 2 }] };
    const flags = situationFlags({ tasks: [], repositories: [], todos: [mainCopy, first] });
    expect(flags.filter(flag => flag.code === 'todo_not_started')).toHaveLength(1);
  });
  it('judges a run only from its own progress', () => {
    const run = { ...task.runs[0], steps: [], progress: { ...task.runs[0].progress, tasksDone: 6, tasksTotal: 6 } };
    expect(situationFlags({ tasks: [{ ...task, runs: [run], worktrees: [] }], repositories: [], todos: [{ ...first, phases: [{ number: 1, title: 'Open', done: 0, total: 6 }], dependsOn: [] }] }).filter(flag => flag.code === 'run_complete_todo_unfinished')).toHaveLength(0);
  });
  it('rejects invalid dependency and stray collections with identities', () => {
    expect(() => situationFlags({ tasks: [], repositories: [], todos: [{ ...first, dependsOn: null }] })).toThrow(path);
    expect(() => situationFlags({ tasks: [{ ...task, runs: [], worktrees: [{ ...task.worktrees[0], strayFiles: null }] }], repositories: [], todos: [] })).toThrow('w');
  });
});

describe('situationFlags wording', () => {
  it('names a Main todo by its repository, never as a task', () => {
    const mainTodo = { ...second, location: 'main:backend', dependsOn: [] };
    const flag = situationFlags({ tasks: [], repositories: [], todos: [mainTodo] }).find(entry => entry.code === 'todo_not_started');
    expect(flag.message).toBe('Todo docs/todos/second.md in Main (backend) has not started.');
    expect(flag.where).toEqual({ repository: 'backend', path: 'docs/todos/second.md' });
  });
  it('names a dependent Main todo by its repository, never as a task', () => {
    const mainFirst = { ...first, location: 'main:backend' };
    const mainSecond = { ...second, location: 'main:backend' };
    const flag = situationFlags({ tasks: [], repositories: [], todos: [mainFirst, mainSecond] }).find(entry => entry.code === 'todo_depends_on_unfinished');
    expect(flag.message).toBe(`Todo docs/todos/second.md in Main (backend) waits for Phase 2 of ${path}.`);
  });
  it('shows a stray file name as it is on disk, without escaping it again', () => {
    const messages = situationFlags(facts).filter(flag => flag.code === 'stray_files').map(flag => flag.message);
    expect(messages).toEqual(['Task “Build integration” has an untracked stray file " " in backend.', 'Task “Build integration” has an untracked stray file "\\n" in backend.']);
  });
});

describe('situationFlags for repository stray files', () => {
  it('names the repository for a stray file in Main', () => {
    const flags = situationFlags({ tasks: [], repositories: [{ name: 'codedeck', dirtyCount: 1, strayFiles: [' '] }], todos: [] }).filter(flag => flag.code === 'stray_files');
    expect(flags).toEqual([{ code: 'stray_files', message: 'Repository codedeck has an untracked stray file " ".', where: { repository: 'codedeck', path: ' ' } }]);
  });
});

describe('strayPaths', () => {
  it('names blank files and files made only of whitespace and backslash escapes, not ordinary short names', async () => {
    const { strayPaths } = await import('../assistant/situation.js');
    expect(strayPaths([' ', '\t', '\\n', 'dir/\\n\\t', '\\', ' \\r ', 'n t', '0 0', 'r n', 'notes.md', 'tn'])).toEqual([' ', '\t', '\\n', 'dir/\\n\\t', '\\', ' \\r ']);
  });
});
