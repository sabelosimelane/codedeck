import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createTaskStore, TASK_STATES } from '../tasks/task-store.js';

const ID = '7a000000-0000-4000-8000-000000000001';
const OTHER_ID = '7a000000-0000-4000-8000-000000000002';
const worktreeId = number => `7b000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const WT = worktreeId(1);
const WT2 = worktreeId(2);
const databases = [];

function open() {
  const db = new Database(':memory:');
  databases.push(db);
  return db;
}

function setup(options = {}) {
  const db = open();
  let tick = 0;
  let made = 0;
  const now = () => new Date(Date.UTC(2026, 10, 18, 10, 0, tick++)).toISOString();
  return { db, store: createTaskStore(db, { now, newId: () => worktreeId(++made), ...options }) };
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

const input = {
  id: ID,
  project: 'Demo',
  title: 'WhatsApp replies',
  titleSource: 'owner',
  folder: null,
  repository: 'demo',
  repositoryPath: null,
  worktreePath: '/tmp/worktrees/demo-whatsapp-replies-7a000000',
  branch: 'task/whatsapp-replies-7a000000',
  baseBranch: 'main',
  baseCommit: 'a'.repeat(40),
};
const other = { ...input, id: OTHER_ID, worktreePath: '/tmp/worktrees/other', branch: 'task/other' };
const second = {
  repository: 'mobile-app',
  repositoryPath: '/tmp/group/mobile-app',
  worktreePath: '/tmp/worktrees/whatsapp-replies-7a000000/mobile-app',
  branch: 'task/whatsapp-replies-7a000000',
  baseBranch: 'develop',
  baseCommit: 'b'.repeat(40),
};

describe('task store', () => {
  it('creates an active task with its first worktree and reads it back', () => {
    const { store } = setup();
    const task = store.create(input);
    const at = '2026-11-18T10:00:00.000Z';
    expect(task).toEqual({
      id: ID,
      project: 'Demo',
      title: 'WhatsApp replies',
      titleSource: 'owner',
      state: 'active',
      revision: 1,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      folder: null,
      worktreePath: input.worktreePath,
      branch: input.branch,
      baseBranch: 'main',
      baseCommit: input.baseCommit,
      prUrl: null,
      worktrees: [{
        id: WT,
        repository: 'demo',
        own: true,
        first: true,
        repositoryPath: null,
        worktreePath: input.worktreePath,
        branch: input.branch,
        baseBranch: 'main',
        baseCommit: input.baseCommit,
        state: 'active',
        prUrl: null,
        createdAt: at,
        updatedAt: at,
        finishedAt: null,
      }],
    });
    expect(store.get(ID)).toEqual(task);
    expect(store.get(OTHER_ID)).toBeNull();
  });

  it('accepts a task started from a detached main checkout', () => {
    const { store } = setup();
    expect(store.create({ ...input, baseBranch: null }).baseBranch).toBeNull();
  });

  it('creates a task in its own folder, starting in another repository of the project', () => {
    const { store } = setup();
    const task = store.create({ ...input, folder: '/tmp/worktrees/whatsapp-replies-7a000000', ...second });
    expect(task.folder).toBe('/tmp/worktrees/whatsapp-replies-7a000000');
    expect(task.worktrees[0]).toMatchObject({ repository: 'mobile-app', own: false, first: true, repositoryPath: '/tmp/group/mobile-app' });
    expect(task.worktreePath).toBe(second.worktreePath);
  });

  it('keeps the columns the previous release read filled with the first worktree', () => {
    const { db, store } = setup();
    store.create(input);
    expect(db.prepare('SELECT worktree_path, branch, base_branch, base_commit, pr_url FROM tasks WHERE id = ?').get(ID)).toEqual({
      worktree_path: input.worktreePath, branch: input.branch, base_branch: 'main', base_commit: input.baseCommit, pr_url: null,
    });
  });

  it('lists newest first with the id as tiebreaker', () => {
    const { store } = setup();
    store.create(input);
    store.create(other);
    expect(store.list().map(task => task.id)).toEqual([OTHER_ID, ID]);
    expect(store.list().map(task => task.worktrees.length)).toEqual([1, 1]);
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
    ['folder', undefined],
    ['folder', 'relative/folder'],
    ['folder', '/tmp/with\0nul'],
    ['repository', ''],
    ['repository', null],
    ['repository', 'a/b'],
    ['repository', '..'],
    ['repository', 'two\nlines'],
    ['repositoryPath', undefined],
    ['repositoryPath', 'relative'],
    ['repositoryPath', 12],
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
    ['titleSource', undefined],
    ['titleSource', null],
    ['titleSource', 'generated'],
    ['titleSource', 'someone'],
  ])('refuses to create with invalid %s (%j)', (field, value) => {
    const { db, store } = setup();
    expect(() => store.create({ ...input, [field]: value })).toThrow(new RegExp(`tasks: ${field}`));
    expect(store.list()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM task_worktrees').get().n).toBe(0);
  });

  it('refuses a second open task on the same worktree and stores nothing of it', () => {
    const { db, store } = setup();
    store.create(input);
    expect(() => store.create({ ...input, id: OTHER_ID })).toThrow('tasks: worktree already belongs to an open task');
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(1);
  });

  it('finds the open task of any of its worktrees', () => {
    const { store } = setup();
    store.create(input);
    store.addWorktree(ID, second);
    expect(store.findOpenByWorktreePath(input.worktreePath)?.id).toBe(ID);
    expect(store.findOpenByWorktreePath(second.worktreePath)?.id).toBe(ID);
    expect(store.findOpenByWorktreePath('/tmp/elsewhere')).toBeNull();
    store.setWorktreeState(ID, WT, { state: 'closed' });
    expect(store.findOpenByWorktreePath(input.worktreePath)).toBeNull();
    expect(store.findOpenByWorktreePath(second.worktreePath)?.id).toBe(ID);
    expect(() => store.findOpenByWorktreePath('relative')).toThrow('tasks: worktreePath');
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

  describe('the state of a worktree and of its task', () => {
    it('records a pull request and keeps the task open', () => {
      const { store } = setup();
      store.create(input);
      const task = store.setWorktreeState(ID, WT, { state: 'pr_open', prUrl: 'https://example.test/pr/1' });
      expect(task).toMatchObject({ state: 'pr_open', prUrl: 'https://example.test/pr/1', finishedAt: null, revision: 2 });
      expect(task.worktrees[0]).toMatchObject({ state: 'pr_open', prUrl: 'https://example.test/pr/1', finishedAt: null, updatedAt: '2026-11-18T10:00:01.000Z' });
      expect(store.findOpenByWorktreePath(input.worktreePath)?.id).toBe(ID);
    });

    it.each(['merged', 'closed'])('finishes a task with one worktree as %s', state => {
      const { store } = setup();
      store.create(input);
      const task = store.setWorktreeState(ID, WT, { state });
      expect(task).toMatchObject({ state, finishedAt: '2026-11-18T10:00:01.000Z', revision: 2 });
      expect(task.worktrees[0]).toMatchObject({ state, finishedAt: '2026-11-18T10:00:01.000Z' });
      expect(() => store.setWorktreeState(ID, WT, { state: 'active' })).toThrow(`task_worktrees row ${WT}: already finished`);
    });

    it('keeps a pull request address when the worktree is merged', () => {
      const { store } = setup();
      store.create(input);
      store.setWorktreeState(ID, WT, { state: 'pr_open', prUrl: 'https://example.test/pr/1' });
      expect(store.setWorktreeState(ID, WT, { state: 'merged' }).worktrees[0].prUrl).toBe('https://example.test/pr/1');
    });

    it('keeps the task open until its last worktree is finished', () => {
      const { store } = setup();
      store.create(input);
      store.addWorktree(ID, second);
      const half = store.setWorktreeState(ID, WT, { state: 'merged' });
      expect(half).toMatchObject({ state: 'active', finishedAt: null });
      expect(half.worktrees.map(worktree => worktree.state)).toEqual(['merged', 'active']);
      const done = store.setWorktreeState(ID, WT2, { state: 'closed' });
      expect(done).toMatchObject({ state: 'merged', finishedAt: '2026-11-18T10:00:03.000Z' });
    });

    it('finishes as closed when no worktree was merged', () => {
      const { store } = setup();
      store.create(input);
      store.addWorktree(ID, second);
      store.setWorktreeState(ID, WT, { state: 'closed' });
      expect(store.setWorktreeState(ID, WT2, { state: 'closed' }).state).toBe('closed');
    });

    it('shows a pull request only while an open worktree has one', () => {
      const { store } = setup();
      store.create(input);
      store.addWorktree(ID, second);
      expect(store.setWorktreeState(ID, WT2, { state: 'pr_open', prUrl: 'https://example.test/pr/2' }).state).toBe('pr_open');
      expect(store.setWorktreeState(ID, WT2, { state: 'merged' }).state).toBe('active');
    });

    it('refuses invalid state changes', () => {
      const { store } = setup();
      store.create(input);
      expect(() => store.setWorktreeState(ID, WT, { state: 'done' })).toThrow('tasks: state');
      expect(() => store.setWorktreeState(ID, WT, { state: 'pr_open' })).toThrow('tasks: prUrl');
      expect(() => store.setWorktreeState(ID, WT, { state: 'pr_open', prUrl: 'javascript:alert(1)' })).toThrow('tasks: prUrl');
      expect(() => store.setWorktreeState(ID, WT, { state: 'closed', prUrl: 12 })).toThrow('tasks: prUrl');
      expect(() => store.setWorktreeState(OTHER_ID, WT, { state: 'closed' })).toThrow(`tasks row ${OTHER_ID}: not found`);
      expect(() => store.setWorktreeState(ID, WT2, { state: 'closed' })).toThrow(`task_worktrees row ${WT2}: not found in task ${ID}`);
      expect(() => store.setWorktreeState(ID, 'nope', { state: 'closed' })).toThrow('tasks: worktreeId');
      expect(store.get(ID)).toMatchObject({ state: 'active', revision: 1 });
    });
  });

  describe('adding a worktree', () => {
    it('adds a worktree in another repository after the first', () => {
      const { store } = setup();
      store.create(input);
      const task = store.addWorktree(ID, second);
      expect(task).toMatchObject({ revision: 2, updatedAt: '2026-11-18T10:00:01.000Z', worktreePath: input.worktreePath, branch: input.branch });
      expect(task.worktrees).toHaveLength(2);
      expect(task.worktrees[1]).toEqual({
        id: WT2, repository: 'mobile-app', own: false, first: false, repositoryPath: '/tmp/group/mobile-app',
        worktreePath: second.worktreePath, branch: second.branch, baseBranch: 'develop', baseCommit: second.baseCommit,
        state: 'active', prUrl: null, createdAt: '2026-11-18T10:00:01.000Z', updatedAt: '2026-11-18T10:00:01.000Z', finishedAt: null,
      });
    });

    it('keeps the worktrees in the order they were added, also when several are added in the same instant', () => {
      const db = open();
      // Ids that sort against the order of addition, and a clock that does not move.
      const ids = [worktreeId(9), worktreeId(5), worktreeId(1), worktreeId(7)];
      const store = createTaskStore(db, { now: () => '2026-11-18T10:00:00.000Z', newId: () => ids.shift() });
      store.create(input);
      for (const repository of ['mobile-app', 'frontend', 'docs']) {
        store.addWorktree(ID, { ...second, repository, repositoryPath: `/tmp/group/${repository}`, worktreePath: `/tmp/worktrees/whatsapp-replies-7a000000/${repository}` });
      }
      expect(store.get(ID).worktrees.map(worktree => worktree.repository)).toEqual(['demo', 'mobile-app', 'frontend', 'docs']);
      expect(store.list()[0].worktrees.map(worktree => worktree.repository)).toEqual(['demo', 'mobile-app', 'frontend', 'docs']);
    });

    it.each([
      ['repository', ''],
      ['repository', 'a/b'],
      ['repositoryPath', undefined],
      ['repositoryPath', 'relative'],
      ['worktreePath', 'relative'],
      ['branch', 'has space'],
      ['baseBranch', ''],
      ['baseCommit', 'abc'],
    ])('refuses to add with invalid %s (%j)', (field, value) => {
      const { store } = setup();
      store.create(input);
      expect(() => store.addWorktree(ID, { ...second, [field]: value })).toThrow(new RegExp(`tasks: ${field}`));
      expect(store.get(ID).worktrees).toHaveLength(1);
    });

    it('refuses a repository the task already has, a worktree in use, a finished task and an unknown task', () => {
      const { store } = setup();
      store.create(input);
      store.create(other);
      expect(() => store.addWorktree(ID, { ...second, repository: 'demo' })).toThrow('tasks: repository is already part of this task');
      expect(() => store.addWorktree(ID, { ...second, worktreePath: other.worktreePath })).toThrow('tasks: worktree already belongs to an open task');
      expect(() => store.addWorktree('7a000000-0000-4000-8000-000000000009', second)).toThrow('not found');
      store.setWorktreeState(ID, WT, { state: 'closed' });
      expect(() => store.addWorktree(ID, second)).toThrow(`tasks row ${ID}: already finished`);
    });
  });

  it('exposes the allowed states', () => {
    expect(TASK_STATES).toEqual(['active', 'pr_open', 'merged', 'closed']);
  });

  it.each([
    ['project', ''],
    ['title', ''],
    ['state', 'bogus'],
    ['revision', 0],
    ['title_source', 'someone'],
    ['created_at', 'yesterday'],
    ['updated_at', 'yesterday'],
    ['finished_at', 'yesterday'],
    ['task_folder', 'relative'],
  ])('fails loudly when stored task column %s is invalid', (column, value) => {
    const { db, store } = setup();
    store.create(input);
    db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(value, ID);
    expect(() => store.get(ID)).toThrow(new RegExp(`tasks row ${ID} field ${column}`));
  });

  it.each([
    ['is_first', 2],
    ['repository', ''],
    ['repository', 'a/b'],
    ['repository_path', 'relative'],
    ['worktree_path', 'relative'],
    ['branch', ''],
    ['base_branch', ''],
    ['base_commit', 'zz'],
    ['state', 'bogus'],
    ['pr_url', 'ftp://x'],
    ['created_at', 'yesterday'],
    ['updated_at', 'yesterday'],
    ['finished_at', 'yesterday'],
  ])('fails loudly when stored worktree column %s is invalid (%j)', (column, value) => {
    const { db, store } = setup();
    store.create(input);
    db.prepare(`UPDATE task_worktrees SET ${column} = ? WHERE id = ?`).run(value, WT);
    expect(() => store.get(ID)).toThrow(new RegExp(`task_worktrees row ${WT} field ${column}`));
  });

  it('requires a finish time exactly when a worktree is finished', () => {
    const { db, store } = setup();
    store.create(input);
    db.prepare('UPDATE task_worktrees SET state = ? WHERE id = ?').run('merged', WT);
    expect(() => store.get(ID)).toThrow(`task_worktrees row ${WT} field finished_at`);
  });

  it('requires a finish time exactly when the task is finished', () => {
    const { db, store } = setup();
    store.create(input);
    db.prepare('UPDATE tasks SET finished_at = ? WHERE id = ?').run('2026-11-18T11:00:00.000Z', ID);
    expect(() => store.get(ID)).toThrow(`tasks row ${ID} field finished_at`);
  });

  it('fails loudly when the stored task state is not what its worktrees give', () => {
    const { db, store } = setup();
    store.create(input);
    db.prepare("UPDATE tasks SET state = 'pr_open' WHERE id = ?").run(ID);
    expect(() => store.get(ID)).toThrow(`tasks row ${ID} field state`);
  });

  it('fails loudly when a task has no first worktree', () => {
    const { db, store } = setup();
    store.create(input);
    db.prepare('UPDATE task_worktrees SET is_first = 0 WHERE id = ?').run(WT);
    expect(() => store.get(ID)).toThrow(`tasks row ${ID}: must have exactly one first worktree`);
  });

  describe('where a title came from', () => {
    const fromInput = { ...input, title: '/tmp/drop/screenshot.png', titleSource: 'input' };

    it('remembers whether the owner gave the title or it was made from the run input', () => {
      const { store } = setup();
      expect(store.create(input).titleSource).toBe('owner');
      expect(store.create({ ...fromInput, id: OTHER_ID, worktreePath: '/tmp/worktrees/other', branch: 'task/other' }).titleSource).toBe('input');
    });

    it('replaces a title made from the run input with a generated one', () => {
      const { store } = setup();
      store.create(fromInput);
      const named = store.applyGeneratedTitle(ID, '  First name only on the call ');
      expect(named).toMatchObject({ title: 'First name only on the call', titleSource: 'generated', revision: 2, updatedAt: '2026-11-18T10:00:01.000Z' });
      expect(store.get(ID)).toEqual(named);
    });

    it.each([
      ['the owner gave', store => store.create(input)],
      ['the owner changed', store => { store.create(fromInput); store.rename(ID, { title: 'Mine', revision: 1 }); }],
      ['was already generated', store => { store.create(fromInput); store.applyGeneratedTitle(ID, 'First'); }],
    ])('never replaces a title %s', (_name, arrange) => {
      const { store } = setup();
      arrange(store);
      const before = store.get(ID);
      expect(store.applyGeneratedTitle(ID, 'Something else')).toBeNull();
      expect(store.get(ID)).toEqual(before);
    });

    it('does not name a finished task', () => {
      const { store } = setup();
      store.create(fromInput);
      store.setWorktreeState(ID, WT, { state: 'closed' });
      expect(store.applyGeneratedTitle(ID, 'Too late')).toBeNull();
      expect(store.get(ID).title).toBe('/tmp/drop/screenshot.png');
    });

    it('marks a renamed title as the owner\'s', () => {
      const { store } = setup();
      store.create(fromInput);
      expect(store.rename(ID, { title: 'Mine', revision: 1 }).titleSource).toBe('owner');
    });

    it.each([[''], ['   '], ['x'.repeat(81)], ['two\nlines'], [null], [undefined]])('refuses a generated title of %j', value => {
      const { store } = setup();
      store.create(fromInput);
      expect(() => store.applyGeneratedTitle(ID, value)).toThrow('tasks: title');
      expect(store.get(ID).titleSource).toBe('input');
    });

    it('requires the task to exist', () => {
      const { store } = setup();
      expect(() => store.applyGeneratedTitle(OTHER_ID, 'Named')).toThrow(`tasks row ${OTHER_ID}: not found`);
      expect(() => store.applyGeneratedTitle('nope', 'Named')).toThrow('tasks: id');
    });
  });

  describe('tasks stored by the previous release', () => {
    const OLD_TABLE = `CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, worktree_path TEXT NOT NULL, branch TEXT NOT NULL,
      base_branch TEXT, base_commit TEXT NOT NULL, state TEXT NOT NULL, pr_url TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      finished_at TEXT, title_source TEXT NOT NULL DEFAULT 'owner');
      CREATE UNIQUE INDEX tasks_open_worktree ON tasks (worktree_path) WHERE state IN ('active', 'pr_open');`;
    const stored = [
      { id: '7a000000-0000-4000-8000-000000000011', project: 'Demo', state: 'active', prUrl: null, finishedAt: null },
      { id: '7a000000-0000-4000-8000-000000000012', project: 'Demo', state: 'pr_open', prUrl: 'https://example.test/pr/7', finishedAt: null },
      { id: '7a000000-0000-4000-8000-000000000013', project: 'Gone', state: 'merged', prUrl: 'https://example.test/pr/8', finishedAt: '2026-11-18T09:30:00.000Z' },
      { id: '7a000000-0000-4000-8000-000000000014', project: 'Demo', state: 'closed', prUrl: null, finishedAt: '2026-11-18T09:40:00.000Z' },
    ];
    const findProject = name => (name === 'Demo' ? { name: 'Demo', path: '/tmp/group/backend' } : null);

    function oldDatabase() {
      const db = open();
      db.exec(OLD_TABLE);
      const insert = db.prepare("INSERT INTO tasks VALUES (?, ?, 'Old task', ?, ?, 'main', ?, ?, ?, 3, ?, ?, ?, 'owner')");
      stored.forEach((task, index) => insert.run(task.id, task.project, `/tmp/worktrees/old-${index}`, `task/old-${index}`, 'c'.repeat(40),
        task.state, task.prUrl, '2026-11-18T09:00:00.000Z', '2026-11-18T09:10:00.000Z', task.finishedAt));
      return db;
    }

    it('gives every stored task one worktree, whatever its state', () => {
      const db = oldDatabase();
      let made = 0;
      const store = createTaskStore(db, { findProject, newId: () => worktreeId(++made) });
      stored.forEach((before, index) => {
        const task = store.get(before.id);
        expect(task).toMatchObject({
          state: before.state, revision: 3, folder: null, finishedAt: before.finishedAt,
          worktreePath: `/tmp/worktrees/old-${index}`, branch: `task/old-${index}`, baseBranch: 'main', baseCommit: 'c'.repeat(40), prUrl: before.prUrl,
        });
        expect(task.worktrees).toEqual([{
          id: worktreeId(index + 1), repository: before.project === 'Demo' ? 'backend' : 'Gone', own: true, first: true, repositoryPath: null,
          worktreePath: `/tmp/worktrees/old-${index}`, branch: `task/old-${index}`, baseBranch: 'main', baseCommit: 'c'.repeat(40),
          state: before.state, prUrl: before.prUrl, createdAt: '2026-11-18T09:00:00.000Z', updatedAt: '2026-11-18T09:10:00.000Z', finishedAt: before.finishedAt,
        }]);
      });
    });

    it('changes nothing when started again', () => {
      const db = oldDatabase();
      createTaskStore(db, { findProject });
      const before = db.prepare('SELECT * FROM task_worktrees ORDER BY id').all();
      const store = createTaskStore(db, { findProject });
      expect(db.prepare('SELECT * FROM task_worktrees ORDER BY id').all()).toEqual(before);
      expect(store.list()).toHaveLength(4);
    });

    it('stops when it has tasks to carry over and cannot look up their projects', () => {
      const db = oldDatabase();
      expect(() => createTaskStore(db)).toThrow('tasks: findProject is required to carry over stored tasks');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_worktrees'").get()).toBeUndefined();
    });

    it('stops when a stored project has no usable path', () => {
      const db = oldDatabase();
      expect(() => createTaskStore(db, { findProject: () => ({ name: 'Demo', path: 'relative' }) })).toThrow('tasks: stored project Demo has no absolute path');
    });

    it('lets the worktree table alone answer which worktree is open', () => {
      const db = oldDatabase();
      const store = createTaskStore(db, { findProject });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tasks_open_worktree'").get()).toBeUndefined();
      expect(store.findOpenByWorktreePath('/tmp/worktrees/old-0')?.id).toBe(stored[0].id);
      expect(store.findOpenByWorktreePath('/tmp/worktrees/old-2')).toBeNull();
    });

    it('treats the titles of tasks stored before title sources as the owner\'s', () => {
      const db = open();
      db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, worktree_path TEXT NOT NULL, branch TEXT NOT NULL,
        base_branch TEXT, base_commit TEXT NOT NULL, state TEXT NOT NULL, pr_url TEXT, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT)`);
      db.prepare("INSERT INTO tasks VALUES (?, 'Demo', '/tmp/old.md', '/tmp/worktrees/old', 'task/old', 'main', ?, 'active', NULL, 1, ?, ?, NULL)")
        .run(ID, 'a'.repeat(40), '2026-11-18T09:00:00.000Z', '2026-11-18T09:00:00.000Z');
      const store = createTaskStore(db, { findProject });
      expect(store.get(ID)).toMatchObject({ title: '/tmp/old.md', titleSource: 'owner' });
      expect(store.applyGeneratedTitle(ID, 'Named')).toBeNull();
      expect(() => createTaskStore(db, { findProject })).not.toThrow();
    });
  });

  it('requires a database handle', () => {
    expect(() => createTaskStore(null)).toThrow('tasks: a database handle is required');
  });
});
