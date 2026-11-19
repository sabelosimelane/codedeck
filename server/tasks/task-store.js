/**
 * Tasks: a titled piece of work under a project, with one Git worktree and branch in each
 * repository it includes. The task row holds the title and the task's state; a row per
 * worktree says which worktree belongs to which task and how that repository stands. Live
 * Git facts (uncommitted files, commits ahead) are read when asked for, never stored here.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUuid } from '../../shared/pipeline-definitions.mjs';

export const TASK_STATES = ['active', 'pr_open', 'merged', 'closed'];
const OPEN_STATES = ['active', 'pr_open'];
const FINISHED_STATES = ['merged', 'closed'];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const COMMIT_ID = /^[0-9a-f]{40}$/;
export const TASK_TITLE_MAX = 80;
const REPOSITORY_NAME_MAX = 100;
// Where a title came from: the owner gave or changed it ('owner'), it was made from the input
// of the run the task was created for ('input'), or it was generated from the run's work
// ('generated'). Only a title made from the input is ever replaced, and only once.
export const TITLE_SOURCES = ['owner', 'input', 'generated'];

function isIso(value) {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

export function isTaskTitle(value) {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= TASK_TITLE_MAX && !CONTROL.test(value);
}

function isProject(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
}

/** A repository is known by its folder name. */
export function isRepositoryName(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= REPOSITORY_NAME_MAX
    && !CONTROL.test(value) && !value.includes('/') && value !== '.' && value !== '..';
}

function isBranch(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && !value.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(value);
}

function isPrUrl(value) {
  if (typeof value !== 'string' || value.length > 2000 || CONTROL.test(value)) return false;
  try { return ['https:', 'http:'].includes(new URL(value).protocol); } catch { return false; }
}

function inputError(field, message) {
  throw new Error(`tasks: ${field}: ${message}`);
}

function rowError(id, field, message) {
  throw new Error(`tasks row ${id} field ${field}: ${message}`);
}

function worktreeRowError(id, field, message) {
  throw new Error(`task_worktrees row ${id} field ${field}: ${message}`);
}

/** The state a task shows, given the states of its worktrees. */
function deriveTaskState(states) {
  if (states.some(state => OPEN_STATES.includes(state))) return states.includes('pr_open') ? 'pr_open' : 'active';
  return states.includes('merged') ? 'merged' : 'closed';
}

function hydrateWorktree(row) {
  const id = row.id;
  if (!isUuid(id)) worktreeRowError(id ?? 'unknown', 'id', 'must be a UUID v4');
  if (!isUuid(row.task_id)) worktreeRowError(id, 'task_id', 'must be a UUID v4');
  if (row.is_first !== 0 && row.is_first !== 1) worktreeRowError(id, 'is_first', 'must be 0 or 1');
  if (!isRepositoryName(row.repository)) worktreeRowError(id, 'repository', 'must be a folder name');
  if (row.repository_path !== null && !isAbsolutePath(row.repository_path)) worktreeRowError(id, 'repository_path', 'must be an absolute path, or null for the project\'s own repository');
  if (!isAbsolutePath(row.worktree_path)) worktreeRowError(id, 'worktree_path', 'must be an absolute path');
  if (!isBranch(row.branch)) worktreeRowError(id, 'branch', 'must be a branch name');
  if (row.base_branch !== null && !isBranch(row.base_branch)) worktreeRowError(id, 'base_branch', 'must be a branch name or null');
  if (typeof row.base_commit !== 'string' || !COMMIT_ID.test(row.base_commit)) worktreeRowError(id, 'base_commit', 'must be a commit id');
  if (!TASK_STATES.includes(row.state)) worktreeRowError(id, 'state', `must be one of ${TASK_STATES.join(', ')}`);
  if (row.pr_url !== null && !isPrUrl(row.pr_url)) worktreeRowError(id, 'pr_url', 'must be an http(s) URL or null');
  if (!isIso(row.created_at)) worktreeRowError(id, 'created_at', 'must be an ISO-8601 timestamp');
  if (!isIso(row.updated_at)) worktreeRowError(id, 'updated_at', 'must be an ISO-8601 timestamp');
  if (row.finished_at !== null && !isIso(row.finished_at)) worktreeRowError(id, 'finished_at', 'must be an ISO-8601 timestamp or null');
  if (FINISHED_STATES.includes(row.state) !== (row.finished_at !== null)) worktreeRowError(id, 'finished_at', 'must be set exactly when the worktree is finished');
  if (row.merged_commit !== null && (typeof row.merged_commit !== 'string' || !COMMIT_ID.test(row.merged_commit) || row.state !== 'merged')) worktreeRowError(id, 'merged_commit', 'must be a commit id on a merged worktree, or null');
  return {
    id,
    repository: row.repository,
    // The project's own repository is not stored with a checkout: it is the project's path when asked.
    own: row.repository_path === null,
    first: row.is_first === 1,
    repositoryPath: row.repository_path,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    state: row.state,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    // The commit the checkout stood at once this worktree was merged into it; null when not merged, or merged before this was kept.
    mergedCommit: row.merged_commit,
  };
}

function hydrate(row, worktreeRows) {
  const id = row.id;
  if (!isUuid(id)) rowError(id ?? 'unknown', 'id', 'must be a UUID v4');
  if (!isProject(row.project)) rowError(id, 'project', 'must be a nonempty string');
  if (!isTaskTitle(row.title) || row.title.trim() !== row.title) rowError(id, 'title', `must be 1–${TASK_TITLE_MAX} trimmed single-line characters`);
  if (!TASK_STATES.includes(row.state)) rowError(id, 'state', `must be one of ${TASK_STATES.join(', ')}`);
  if (!Number.isInteger(row.revision) || row.revision < 1) rowError(id, 'revision', 'must be an integer ≥ 1');
  if (!TITLE_SOURCES.includes(row.title_source)) rowError(id, 'title_source', `must be one of ${TITLE_SOURCES.join(', ')}`);
  if (!isIso(row.created_at)) rowError(id, 'created_at', 'must be an ISO-8601 timestamp');
  if (!isIso(row.updated_at)) rowError(id, 'updated_at', 'must be an ISO-8601 timestamp');
  if (row.finished_at !== null && !isIso(row.finished_at)) rowError(id, 'finished_at', 'must be an ISO-8601 timestamp or null');
  if (FINISHED_STATES.includes(row.state) !== (row.finished_at !== null)) rowError(id, 'finished_at', 'must be set exactly when the task is finished');
  if (row.task_folder !== null && !isAbsolutePath(row.task_folder)) rowError(id, 'task_folder', 'must be an absolute path or null');

  const worktrees = worktreeRows.map(hydrateWorktree);
  if (worktrees.filter(worktree => worktree.first).length !== 1) throw new Error(`tasks row ${id}: must have exactly one first worktree`);
  if (row.state !== deriveTaskState(worktrees.map(worktree => worktree.state))) rowError(id, 'state', 'must be the state its worktrees give');
  const first = worktrees.find(worktree => worktree.first);
  return {
    id,
    project: row.project,
    title: row.title,
    titleSource: row.title_source,
    state: row.state,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    folder: row.task_folder,
    // The worktree the task started in answers for the task where one worktree is asked for.
    worktreePath: first.worktreePath,
    branch: first.branch,
    baseBranch: first.baseBranch,
    baseCommit: first.baseCommit,
    prUrl: first.prUrl,
    worktrees,
  };
}

function isUniqueConflict(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err.message));
}

/** Checks what describes one worktree of a task; the same for the first and for one added later. */
function requireWorktreeInput({ repository, repositoryPath, worktreePath, branch, baseBranch, baseCommit }) {
  if (!isRepositoryName(repository)) inputError('repository', 'must be a folder name');
  if (repositoryPath !== null && !isAbsolutePath(repositoryPath)) inputError('repositoryPath', 'must be an absolute path, or null for the project\'s own repository');
  if (!isAbsolutePath(worktreePath)) inputError('worktreePath', 'must be an absolute path');
  if (!isBranch(branch)) inputError('branch', 'must be a branch name');
  if (baseBranch !== null && !isBranch(baseBranch)) inputError('baseBranch', 'must be a branch name or null');
  if (typeof baseCommit !== 'string' || !COMMIT_ID.test(baseCommit)) inputError('baseCommit', 'must be a commit id');
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    title TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_branch TEXT,
    base_commit TEXT NOT NULL,
    state TEXT NOT NULL,
    pr_url TEXT,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    title_source TEXT NOT NULL DEFAULT 'owner',
    task_folder TEXT
  );
`;
// `worktree_path`, `branch`, `base_branch`, `base_commit` and `pr_url` of `tasks` are what the
// previous release read. They are filled when a task is created and not read here any more.

const WORKTREE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_worktrees (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    is_first INTEGER NOT NULL,
    repository TEXT NOT NULL,
    repository_path TEXT,
    worktree_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_branch TEXT,
    base_commit TEXT NOT NULL,
    state TEXT NOT NULL,
    pr_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    merged_commit TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS task_worktrees_open_path
    ON task_worktrees (worktree_path) WHERE state IN ('active', 'pr_open');
  CREATE UNIQUE INDEX IF NOT EXISTS task_worktrees_first ON task_worktrees (task_id) WHERE is_first = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS task_worktrees_repository ON task_worktrees (task_id, repository);
  CREATE INDEX IF NOT EXISTS task_worktrees_task ON task_worktrees (task_id);
`;

/**
 * Creates the tables and gives every task stored by the previous release its one worktree row.
 * All of it happens in one transaction, so a start that cannot finish leaves the database as it was.
 */
function prepareSchema(db, { findProject, newId }) {
  db.transaction(() => {
    db.exec(SCHEMA);
    const columns = db.prepare('PRAGMA table_info(tasks)').all().map(column => column.name);
    // Titles stored before their source was recorded are kept as the owner's: none is replaced.
    if (!columns.includes('title_source')) db.exec("ALTER TABLE tasks ADD COLUMN title_source TEXT NOT NULL DEFAULT 'owner'");
    if (!columns.includes('task_folder')) db.exec('ALTER TABLE tasks ADD COLUMN task_folder TEXT');
    db.exec(WORKTREE_SCHEMA);
    // Worktrees merged before their commit was kept have none.
    if (!db.prepare('PRAGMA table_info(task_worktrees)').all().some(column => column.name === 'merged_commit')) db.exec('ALTER TABLE task_worktrees ADD COLUMN merged_commit TEXT');
    // Which worktree is open is now answered by task_worktrees alone.
    db.exec('DROP INDEX IF EXISTS tasks_open_worktree');

    const pending = db.prepare('SELECT * FROM tasks WHERE NOT EXISTS (SELECT 1 FROM task_worktrees WHERE task_worktrees.task_id = tasks.id) ORDER BY created_at, id').all();
    if (pending.length === 0) return;
    if (typeof findProject !== 'function') throw new Error('tasks: findProject is required to carry over stored tasks');
    const insert = db.prepare(`
      INSERT INTO task_worktrees (id, task_id, is_first, repository, repository_path, worktree_path, branch, base_branch, base_commit, state, pr_url, created_at, updated_at, finished_at)
      VALUES (?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of pending) {
      const project = findProject(row.project);
      let repository;
      if (project === null || project === undefined) {
        // The project is no longer stored; the task keeps its project's name as the repository's.
        repository = row.project;
      } else {
        if (typeof project.path !== 'string' || !path.isAbsolute(project.path)) throw new Error(`tasks: stored project ${row.project} has no absolute path`);
        repository = path.basename(project.path);
      }
      if (!isRepositoryName(repository)) throw new Error(`tasks: stored task ${row.id} has no usable repository name`);
      const id = newId();
      if (!isUuid(id)) throw new Error('tasks: a worktree id must be a UUID');
      insert.run(id, row.id, repository, row.worktree_path, row.branch, row.base_branch, row.base_commit, row.state, row.pr_url, row.created_at, row.updated_at, row.finished_at);
    }
  })();
}

export function createTaskStore(db, { now = () => new Date().toISOString(), newId = randomUUID, findProject } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function' || typeof db.transaction !== 'function') throw new Error('tasks: a database handle is required');
  if (typeof now !== 'function') throw new Error('tasks: now must be a function');
  if (typeof newId !== 'function') throw new Error('tasks: newId must be a function');
  prepareSchema(db, { findProject, newId });

  const read = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const readAll = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC');
  // The first worktree first, then in the order they were added: the order the rows were written in,
  // which holds also for worktrees recorded in the same instant.
  const readWorktrees = db.prepare('SELECT * FROM task_worktrees WHERE task_id = ? ORDER BY is_first DESC, rowid');
  const readAllWorktrees = db.prepare('SELECT * FROM task_worktrees ORDER BY is_first DESC, rowid');
  const readOpenByPath = db.prepare(`SELECT task_id FROM task_worktrees WHERE worktree_path = ? AND state IN (${OPEN_STATES.map(() => '?').join(', ')})`);
  const insert = db.prepare(`
    INSERT INTO tasks (id, project, title, worktree_path, branch, base_branch, base_commit, state, pr_url, revision, created_at, updated_at, finished_at, title_source, task_folder)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, NULL, ?, ?)
  `);
  const insertWorktree = db.prepare(`
    INSERT INTO task_worktrees (id, task_id, is_first, repository, repository_path, worktree_path, branch, base_branch, base_commit, state, pr_url, created_at, updated_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, NULL)
  `);
  const renameStmt = db.prepare("UPDATE tasks SET title = ?, title_source = 'owner', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?");
  const generatedStmt = db.prepare(`UPDATE tasks SET title = ?, title_source = 'generated', revision = revision + 1, updated_at = ?
    WHERE id = ? AND title_source = 'input' AND state IN (${OPEN_STATES.map(() => '?').join(', ')})`);
  const taskStateStmt = db.prepare('UPDATE tasks SET state = ?, finished_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?');
  const touchStmt = db.prepare('UPDATE tasks SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?');
  const worktreeStateStmt = db.prepare('UPDATE task_worktrees SET state = ?, pr_url = ?, finished_at = ?, updated_at = ?, merged_commit = ? WHERE id = ? AND task_id = ?');
  const removeInitial = db.prepare("DELETE FROM tasks WHERE id = ? AND state = 'active' AND revision = 1");
  const removeWorktreesOf = db.prepare('DELETE FROM task_worktrees WHERE task_id = ?');
  const removeAddedWorktree = db.prepare("DELETE FROM task_worktrees WHERE id = ? AND task_id = ? AND is_first = 0 AND state = 'active'");

  const get = id => {
    if (!isUuid(id)) inputError('id', 'must be a UUID');
    const row = read.get(id);
    return row ? hydrate(row, readWorktrees.all(id)) : null;
  };

  const requireTask = id => {
    const task = get(id);
    if (!task) throw new Error(`tasks row ${id}: not found`);
    return task;
  };

  const newWorktreeId = () => {
    const id = newId();
    if (!isUuid(id)) throw new Error('tasks: a worktree id must be a UUID');
    return id;
  };

  const conflict = err => {
    if (!isUniqueConflict(err)) return err;
    if (/task_worktrees\.worktree_path/.test(err.message)) return new Error('tasks: worktree already belongs to an open task');
    if (/task_worktrees\.task_id, task_worktrees\.repository/.test(err.message)) return new Error('tasks: repository is already part of this task');
    return err;
  };

  const createNow = db.transaction((input, others, stamp) => {
    insert.run(input.id, input.project, input.title.trim(), input.worktreePath, input.branch, input.baseBranch, input.baseCommit, stamp, stamp, input.titleSource, input.folder);
    insertWorktree.run(newWorktreeId(), input.id, 1, input.repository, input.repositoryPath, input.worktreePath, input.branch, input.baseBranch, input.baseCommit, stamp, stamp);
    for (const other of others) {
      insertWorktree.run(newWorktreeId(), input.id, 0, other.repository, other.repositoryPath, other.worktreePath, other.branch, other.baseBranch, other.baseCommit, stamp, stamp);
    }
  });

  // A task goes with its worktree rows, and only while nothing has happened to it.
  const removeNow = db.transaction((id) => {
    if (removeInitial.run(id).changes !== 1) throw new Error(`tasks row ${id}: must be active at revision 1 to remove`);
    removeWorktreesOf.run(id);
  });

  const removeWorktreeNow = db.transaction((task, worktreeId, stamp) => {
    if (removeAddedWorktree.run(worktreeId, task.id).changes !== 1) throw new Error(`task_worktrees row ${worktreeId}: must be an added, active worktree of task ${task.id} to remove`);
    if (touchStmt.run(stamp, task.id, task.revision).changes !== 1) throw new Error(`tasks row ${task.id}: revision conflict`);
  });

  const addWorktreeNow = db.transaction((task, input, stamp) => {
    insertWorktree.run(newWorktreeId(), task.id, 0, input.repository, input.repositoryPath, input.worktreePath, input.branch, input.baseBranch, input.baseCommit, stamp, stamp);
    if (touchStmt.run(stamp, task.id, task.revision).changes !== 1) throw new Error(`tasks row ${task.id}: revision conflict`);
  });

  const setWorktreeStateNow = db.transaction((task, worktree, state, prUrl, mergedCommit, stamp) => {
    const finishedAt = FINISHED_STATES.includes(state) ? stamp : null;
    if (worktreeStateStmt.run(state, prUrl, finishedAt, stamp, mergedCommit, worktree.id, task.id).changes !== 1) throw new Error(`task_worktrees row ${worktree.id}: not found in task ${task.id}`);
    const taskState = deriveTaskState(task.worktrees.map(other => (other.id === worktree.id ? state : other.state)));
    if (taskStateStmt.run(taskState, FINISHED_STATES.includes(taskState) ? stamp : null, stamp, task.id, task.revision).changes !== 1) {
      throw new Error(`tasks row ${task.id}: revision conflict`);
    }
  });

  return {
    get,
    /** Takes back a task that was recorded and then could not get its worktrees: only while it is active and untouched. */
    remove(id) {
      if (!isUuid(id)) inputError('id', 'must be a UUID');
      removeNow(id);
    },
    /** Takes back a worktree that was recorded for an open task and then could not be created. Never the one the task started in. */
    removeWorktree(id, worktreeId) {
      if (!isUuid(worktreeId)) inputError('worktreeId', 'must be a UUID');
      const task = requireTask(id);
      removeWorktreeNow(task, worktreeId, now());
      return get(id);
    },
    list() {
      const byTask = new Map();
      for (const row of readAllWorktrees.all()) {
        if (!byTask.has(row.task_id)) byTask.set(row.task_id, []);
        byTask.get(row.task_id).push(row);
      }
      return readAll.all().map(row => hydrate(row, byTask.get(row.id) ?? []));
    },
    /** The open task that has an open worktree at this path, whichever of its repositories it is. */
    findOpenByWorktreePath(worktreePath) {
      if (!isAbsolutePath(worktreePath)) inputError('worktreePath', 'must be an absolute path');
      const row = readOpenByPath.get(worktreePath, ...OPEN_STATES);
      return row ? requireTask(row.task_id) : null;
    },
    /**
     * A new task with the worktree it starts in, and optionally its `others`. `repositoryPath` is
     * the checkout a worktree came from, or null when it is the project's own repository. `folder`
     * is the folder that holds the task's worktrees, or null when each is named on its own.
     */
    create(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) inputError('body', 'must be an object');
      const { id, project, title, titleSource, folder } = input;
      // A new title is the owner's or made from a run's input; 'generated' only ever replaces the latter.
      if (titleSource !== 'owner' && titleSource !== 'input') inputError('titleSource', 'must be owner or input');
      if (!isUuid(id)) inputError('id', 'must be a UUID');
      if (!isProject(project)) inputError('project', 'must be a nonempty string');
      if (!isTaskTitle(title)) inputError('title', `must be 1–${TASK_TITLE_MAX} single-line characters`);
      if (folder !== null && !isAbsolutePath(folder)) inputError('folder', 'must be an absolute path or null');
      requireWorktreeInput(input);
      // `others`: the task's further worktrees, recorded with it so that the task is still untouched when Git is asked for them.
      const others = input.others ?? [];
      if (!Array.isArray(others)) inputError('others', 'must be a list of worktrees');
      for (const other of others) {
        if (!other || typeof other !== 'object' || Array.isArray(other)) inputError('others', 'must be a list of worktrees');
        requireWorktreeInput(other);
      }
      try {
        createNow(input, others, now());
      } catch (err) {
        throw conflict(err);
      }
      return get(id);
    },
    /** One more repository for an open task. */
    addWorktree(id, input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) inputError('body', 'must be an object');
      requireWorktreeInput(input);
      const task = requireTask(id);
      if (FINISHED_STATES.includes(task.state)) throw new Error(`tasks row ${id}: already finished`);
      try {
        addWorktreeNow(task, input, now());
      } catch (err) {
        throw conflict(err);
      }
      return get(id);
    },
    rename(id, { title, revision } = {}) {
      if (!isTaskTitle(title)) inputError('title', `must be 1–${TASK_TITLE_MAX} single-line characters`);
      if (!Number.isInteger(revision) || revision < 1) inputError('revision', 'must be an integer ≥ 1');
      const current = requireTask(id);
      if (current.revision !== revision || renameStmt.run(title.trim(), now(), id, revision).changes !== 1) {
        throw new Error(`tasks row ${id}: revision conflict`);
      }
      return get(id);
    },
    /**
     * Gives an open task whose title was made from a run's input a generated one. Returns the
     * task, or null when its title is no longer one to replace: the owner's always stands.
     */
    applyGeneratedTitle(id, title) {
      if (!isTaskTitle(title)) inputError('title', `must be 1–${TASK_TITLE_MAX} single-line characters`);
      requireTask(id);
      return generatedStmt.run(title.trim(), now(), id, ...OPEN_STATES).changes === 1 ? get(id) : null;
    },
    /**
     * How one repository of a task stands. The task's own state follows from its worktrees: open
     * while any of them is, then merged if any was merged, otherwise closed.
     */
    setWorktreeState(id, worktreeId, { state, prUrl, mergedCommit } = {}) {
      if (!TASK_STATES.includes(state)) inputError('state', `must be one of ${TASK_STATES.join(', ')}`);
      if (prUrl !== undefined && prUrl !== null && !isPrUrl(prUrl)) inputError('prUrl', 'must be an http(s) URL');
      if (state === 'pr_open' && !isPrUrl(prUrl)) inputError('prUrl', 'is required when a pull request is open');
      if (mergedCommit !== undefined && (state !== 'merged' || typeof mergedCommit !== 'string' || !COMMIT_ID.test(mergedCommit))) inputError('mergedCommit', 'must be a commit id, given only with a merge');
      if (!isUuid(worktreeId)) inputError('worktreeId', 'must be a UUID');
      const task = requireTask(id);
      const worktree = task.worktrees.find(candidate => candidate.id === worktreeId);
      if (!worktree) throw new Error(`task_worktrees row ${worktreeId}: not found in task ${id}`);
      if (FINISHED_STATES.includes(worktree.state)) throw new Error(`task_worktrees row ${worktreeId}: already finished`);
      setWorktreeStateNow(task, worktree, state, prUrl ?? worktree.prUrl, mergedCommit ?? null, now());
      return get(id);
    },
  };
}
