import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createTaskStore } from '../tasks/task-store.js';
import { createNoteStore } from '../pipelines/note-store.js';
import { createTaskChanges } from '../tasks/task-changes.js';

const taskId = n => `7a${String(n).padStart(6, '0')}-0000-4000-8000-000000000000`;
const runId = n => `a2${String(n).padStart(6, '0')}-0000-4000-8000-000000000000`;
const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 19, 10, 0, tick++)).toISOString();
  const taskStore = createTaskStore(db, { now });
  const noteStore = createNoteStore(db, { now });
  const runs = [];
  const changes = createTaskChanges({ taskStore, noteStore, listRuns: () => runs });
  const task = (n, extra = {}) => taskStore.create({
    id: taskId(n), project: 'Demo', title: `Task ${n}`, titleSource: 'owner', folder: null, repository: 'demo', repositoryPath: null,
    worktreePath: `/tmp/worktrees/t-${n}`, branch: `task/t-${n}`, baseBranch: 'main', baseCommit: 'a'.repeat(40), ...extra,
  });
  const merge = (n, index = 0, mergedCommit = 'c'.repeat(40)) => taskStore.setWorktreeState(taskId(n), taskStore.get(taskId(n)).worktrees[index].id, { state: 'merged', mergedCommit });
  const node = name => ({ kind: 'node', name });
  const run = (n, task, { createdAt = '2026-11-19T09:00:00.000Z', steps = [{ kind: 'setup', name: 'Setup' }, node('Fix'), node('Commit')], notesDir = '.codedeck/runs/abcdef12' } = {}) => {
    runs.push({ id: runId(n), taskId: task === null ? null : taskId(task), createdAt, definition: { workflowName: 'Bug fix', notesDir, steps } });
  };
  const note = (n, stepIndex, summary, content = `# ${summary}\nBody`) => noteStore.add({ runId: runId(n), stepIndex, stepName: 'Step', attempt: 1, pass: noteStore.count(runId(n), stepIndex) + 1, status: 'written', summary, content });
  return { taskStore, noteStore, changes, task, merge, run, note, runs };
}

describe('task changes', () => {
  it('lists a merged task with the summary its run\'s last step wrote', () => {
    const { changes, task, merge, run, note } = setup();
    task(1);
    run(1, 1);
    note(1, 1, 'Fix: guarded the null');
    note(1, 2, 'Tags left at home now get a check-in', '# Tags left at home now get a check-in\n\nWhat changed and why.');
    merge(1);
    expect(changes.list()).toEqual([{
      id: taskId(1), project: 'Demo', title: 'Task 1', mergedAt: '2026-11-19T10:00:03.000Z', workflow: 'Bug fix',
      summary: 'Tags left at home now get a check-in', detail: '# Tags left at home now get a check-in\n\nWhat changed and why.',
      repositories: [{ repository: 'demo', branch: 'task/t-1', baseBranch: 'main', commit: 'c'.repeat(40), mergedAt: '2026-11-19T10:00:03.000Z' }],
    }]);
  });

  it('leaves out tasks that are open or were closed without a merge', () => {
    const { changes, task, taskStore } = setup();
    task(1);
    task(2);
    taskStore.setWorktreeState(taskId(2), taskStore.get(taskId(2)).worktrees[0].id, { state: 'closed' });
    expect(changes.list()).toEqual([]);
  });

  it('has no summary for a task merged without a run, or whose last step wrote no note; newest merge first', () => {
    const { changes, task, merge, run, note } = setup();
    task(1);
    merge(1);
    task(2);
    run(2, 2);
    note(2, 1, 'Fix only');
    merge(2);
    expect(changes.list().map(change => [change.title, change.workflow, change.summary, change.detail])).toEqual([
      ['Task 2', 'Bug fix', null, null],
      ['Task 1', null, null, null],
    ]);
  });

  it('reads the latest written note of the last step, and the task\'s most recent run', () => {
    const { changes, task, merge, run, note, noteStore } = setup();
    task(1);
    run(1, 1, { createdAt: '2026-11-19T08:00:00.000Z' });
    note(1, 2, 'Older run');
    run(2, 1, { createdAt: '2026-11-19T09:00:00.000Z' });
    note(2, 2, 'First pass');
    note(2, 2, 'Second pass', '# Second pass\nMore');
    noteStore.add({ runId: runId(2), stepIndex: 2, stepName: 'Step', attempt: 1, pass: 3, status: 'unchanged', summary: null, content: null });
    run(3, null, { createdAt: '2026-11-19T09:30:00.000Z' });
    merge(1);
    expect(changes.list()[0]).toMatchObject({ summary: 'Second pass', detail: '# Second pass\nMore' });
  });

  it('has no summary for a run that kept no notes', () => {
    const { changes, task, merge, run } = setup();
    task(1);
    run(1, 1, { notesDir: null });
    merge(1);
    expect(changes.list()[0]).toMatchObject({ workflow: 'Bug fix', summary: null, detail: null });
  });

  it('gives one change for a task merged in several repositories, dated by the last merge', () => {
    const { changes, task, merge, taskStore } = setup();
    task(1);
    taskStore.addWorktree(taskId(1), { repository: 'mobile-app', repositoryPath: '/tmp/group/mobile-app', worktreePath: '/tmp/worktrees/t-1-mobile', branch: 'task/t-1', baseBranch: 'develop', baseCommit: 'b'.repeat(40) });
    taskStore.addWorktree(taskId(1), { repository: 'frontend', repositoryPath: '/tmp/group/frontend', worktreePath: '/tmp/worktrees/t-1-frontend', branch: 'task/t-1', baseBranch: 'main', baseCommit: 'b'.repeat(40) });
    merge(1, 0, 'c'.repeat(40));
    merge(1, 1, 'd'.repeat(40));
    // The third repository is still open: the task is, too, and what has landed is already a change.
    const [change] = changes.list();
    expect(change.mergedAt).toBe('2026-11-19T10:00:04.000Z');
    expect(change.repositories).toEqual([
      { repository: 'demo', branch: 'task/t-1', baseBranch: 'main', commit: 'c'.repeat(40), mergedAt: '2026-11-19T10:00:03.000Z' },
      { repository: 'mobile-app', branch: 'task/t-1', baseBranch: 'develop', commit: 'd'.repeat(40), mergedAt: '2026-11-19T10:00:04.000Z' },
    ]);
  });

  it('gives no commit for a worktree merged before commits were kept', () => {
    const { changes, task, taskStore } = setup();
    task(1);
    taskStore.setWorktreeState(taskId(1), taskStore.get(taskId(1)).worktrees[0].id, { state: 'merged' });
    expect(changes.list()[0].repositories[0].commit).toBeNull();
  });

  it('requires its dependencies and fails loudly on a run it cannot read', () => {
    const { taskStore, noteStore, task, merge } = setup();
    expect(() => createTaskChanges({ noteStore, listRuns: () => [] })).toThrow('taskStore');
    expect(() => createTaskChanges({ taskStore, listRuns: () => [] })).toThrow('noteStore');
    expect(() => createTaskChanges({ taskStore, noteStore })).toThrow('listRuns');
    task(1);
    merge(1);
    expect(() => createTaskChanges({ taskStore, noteStore, listRuns: () => null }).list()).toThrow('task changes: runs must be a list');
    const bad = fields => createTaskChanges({ taskStore, noteStore, listRuns: () => [{ id: runId(1), taskId: taskId(1), createdAt: '2026-11-19T09:00:00.000Z', definition: { workflowName: 'Bug fix', notesDir: null, steps: [] }, ...fields }] });
    expect(() => bad({ id: 'nope' }).list()).toThrow('task changes: run nope field id');
    expect(() => bad({ taskId: 12 }).list()).toThrow(`task changes: run ${runId(1)} field taskId`);
    expect(() => bad({ createdAt: 'yesterday' }).list()).toThrow(`task changes: run ${runId(1)} field createdAt`);
    expect(() => bad({ definition: null }).list()).toThrow(`task changes: run ${runId(1)} field definition`);
    expect(() => bad({ definition: { workflowName: '', notesDir: null, steps: [] } }).list()).toThrow(`task changes: run ${runId(1)} field definition.workflowName`);
    expect(() => bad({ definition: { workflowName: 'Bug fix', notesDir: null } }).list()).toThrow(`task changes: run ${runId(1)} field definition.steps`);
    expect(() => bad({ definition: { workflowName: 'Bug fix', steps: [] } }).list()).toThrow(`task changes: run ${runId(1)} field definition.notesDir`);
  });
});
