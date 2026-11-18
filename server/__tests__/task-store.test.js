import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createTaskStore, TASK_STATES } from '../tasks/task-store.js';

const ID = '7a000000-0000-4000-8000-000000000001';
const OTHER_ID = '7a000000-0000-4000-8000-000000000002';
const databases = [];

function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 18, 10, 0, tick++)).toISOString();
  return { db, store: createTaskStore(db, { now }) };
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

const input = {
  id: ID,
  project: 'Demo',
  title: 'WhatsApp replies',
  worktreePath: '/tmp/worktrees/demo-whatsapp-replies-7a000000',
  branch: 'task/whatsapp-replies-7a000000',
  baseBranch: 'main',
  baseCommit: 'a'.repeat(40),
};

describe('task store', () => {
  it('creates an active task and reads it back', () => {
    const { store } = setup();
    const task = store.create(input);
    expect(task).toEqual({
      ...input,
      state: 'active',
      prUrl: null,
      revision: 1,
      createdAt: '2026-11-18T10:00:00.000Z',
      updatedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: null,
    });
    expect(store.get(ID)).toEqual(task);
    expect(store.get(OTHER_ID)).toBeNull();
  });

  it('accepts a task started from a detached main checkout', () => {
    const { store } = setup();
    expect(store.create({ ...input, baseBranch: null }).baseBranch).toBeNull();
  });

  it('lists newest first with the id as tiebreaker', () => {
    const { store } = setup();
    store.create(input);
    store.create({ ...input, id: OTHER_ID, worktreePath: '/tmp/worktrees/other', branch: 'task/other' });
    expect(store.list().map(task => task.id)).toEqual([OTHER_ID, ID]);
  });

  it.each([
    ['id', 'not-a-uuid'],
    ['id', null],
    ['project', ''],
    ['project', null],
    ['title', ''],
    ['title', '   '],
    ['title', 'x'.repeat(81)],
    ['title', 'two\nlines'],
    ['title', null],
    ['worktreePath', 'relative/path'],
    ['worktreePath', '/tmp/with\0nul'],
    ['worktreePath', null],
    ['branch', ''],
    ['branch', 'has space'],
    ['branch', '-leading-dash'],
    ['branch', null],
    ['baseBranch', ''],
    ['baseBranch', 12],
    ['baseCommit', 'abc'],
    ['baseCommit', null],
  ])('refuses to create with invalid %s (%j)', (field, value) => {
    const { store } = setup();
    expect(() => store.create({ ...input, [field]: value })).toThrow(new RegExp(`tasks: ${field}`));
    expect(store.list()).toEqual([]);
  });

  it('refuses a second open task on the same worktree', () => {
    const { store } = setup();
    store.create(input);
    expect(() => store.create({ ...input, id: OTHER_ID })).toThrow('tasks: worktree already belongs to an open task');
  });

  it('finds the open task of a worktree', () => {
    const { store } = setup();
    store.create(input);
    expect(store.findOpenByWorktreePath(input.worktreePath)?.id).toBe(ID);
    expect(store.findOpenByWorktreePath('/tmp/elsewhere')).toBeNull();
    store.setState(ID, { state: 'closed' });
    expect(store.findOpenByWorktreePath(input.worktreePath)).toBeNull();
  });

  it('renames with an optimistic revision', () => {
    const { store } = setup();
    store.create(input);
    const renamed = store.rename(ID, { title: '  Replies v2 ', revision: 1 });
    expect(renamed).toMatchObject({ title: 'Replies v2', revision: 2, updatedAt: '2026-11-18T10:00:01.000Z' });
    expect(() => store.rename(ID, { title: 'Again', revision: 1 })).toThrow(`tasks row ${ID}: revision conflict`);
    expect(() => store.rename(OTHER_ID, { title: 'Again', revision: 1 })).toThrow(`tasks row ${OTHER_ID}: not found`);
    expect(() => store.rename(ID, { title: '', revision: 2 })).toThrow('tasks: title');
    expect(() => store.rename(ID, { title: 'Ok', revision: 0 })).toThrow('tasks: revision');
  });

  it('records a pull request and keeps the task open', () => {
    const { store } = setup();
    store.create(input);
    const task = store.setState(ID, { state: 'pr_open', prUrl: 'https://example.test/pr/1' });
    expect(task).toMatchObject({ state: 'pr_open', prUrl: 'https://example.test/pr/1', finishedAt: null, revision: 2 });
    expect(store.findOpenByWorktreePath(input.worktreePath)?.id).toBe(ID);
  });

  it.each(['merged', 'closed'])('finishes a task as %s', state => {
    const { store } = setup();
    store.create(input);
    const task = store.setState(ID, { state });
    expect(task).toMatchObject({ state, finishedAt: '2026-11-18T10:00:01.000Z', revision: 2 });
    expect(() => store.setState(ID, { state: 'active' })).toThrow(`tasks row ${ID}: already finished`);
  });

  it('refuses invalid state changes', () => {
    const { store } = setup();
    store.create(input);
    expect(() => store.setState(ID, { state: 'done' })).toThrow('tasks: state');
    expect(() => store.setState(ID, { state: 'pr_open' })).toThrow('tasks: prUrl');
    expect(() => store.setState(ID, { state: 'pr_open', prUrl: 'javascript:alert(1)' })).toThrow('tasks: prUrl');
    expect(() => store.setState(ID, { state: 'closed', prUrl: 12 })).toThrow('tasks: prUrl');
    expect(() => store.setState(OTHER_ID, { state: 'closed' })).toThrow(`tasks row ${OTHER_ID}: not found`);
  });

  it('exposes the allowed states', () => {
    expect(TASK_STATES).toEqual(['active', 'pr_open', 'merged', 'closed']);
  });

  it.each([
    ['project', ''],
    ['title', ''],
    ['worktree_path', 'relative'],
    ['branch', ''],
    ['base_branch', ''],
    ['base_commit', 'zz'],
    ['state', 'bogus'],
    ['pr_url', 'ftp://x'],
    ['revision', 0],
    ['created_at', 'yesterday'],
    ['updated_at', 'yesterday'],
    ['finished_at', 'yesterday'],
  ])('fails loudly when stored column %s is invalid', (column, value) => {
    const { db, store } = setup();
    store.create(input);
    db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(value, ID);
    expect(() => store.get(ID)).toThrow(new RegExp(`tasks row ${ID} field ${column}`));
  });

  it('requires a finish time exactly when the task is finished', () => {
    const { db, store } = setup();
    store.create(input);
    db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('merged', ID);
    expect(() => store.get(ID)).toThrow(`tasks row ${ID} field finished_at`);
  });

  it('requires a database handle', () => {
    expect(() => createTaskStore(null)).toThrow('tasks: a database handle is required');
  });
});
