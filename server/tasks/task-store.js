/**
 * Tasks: a titled piece of work under a project, with its own Git worktree and branch.
 * The row is the source of truth for which worktree belongs to which task; live Git
 * facts (uncommitted files, commits ahead) are read when asked for, never stored here.
 */

import path from 'node:path';
import { isUuid } from '../../shared/pipeline-definitions.mjs';

export const TASK_STATES = ['active', 'pr_open', 'merged', 'closed'];
const OPEN_STATES = ['active', 'pr_open'];
const FINISHED_STATES = ['merged', 'closed'];

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const COMMIT_ID = /^[0-9a-f]{40}$/;
export const TASK_TITLE_MAX = 80;
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

function isWorktreePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
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

function hydrate(row) {
  const id = row.id;
  if (!isUuid(id)) rowError(id ?? 'unknown', 'id', 'must be a UUID v4');
  if (!isProject(row.project)) rowError(id, 'project', 'must be a nonempty string');
  if (!isTaskTitle(row.title) || row.title.trim() !== row.title) rowError(id, 'title', `must be 1–${TASK_TITLE_MAX} trimmed single-line characters`);
  if (!isWorktreePath(row.worktree_path)) rowError(id, 'worktree_path', 'must be an absolute path');
  if (!isBranch(row.branch)) rowError(id, 'branch', 'must be a branch name');
  if (row.base_branch !== null && !isBranch(row.base_branch)) rowError(id, 'base_branch', 'must be a branch name or null');
  if (typeof row.base_commit !== 'string' || !COMMIT_ID.test(row.base_commit)) rowError(id, 'base_commit', 'must be a commit id');
  if (!TASK_STATES.includes(row.state)) rowError(id, 'state', `must be one of ${TASK_STATES.join(', ')}`);
  if (row.pr_url !== null && !isPrUrl(row.pr_url)) rowError(id, 'pr_url', 'must be an http(s) URL or null');
  if (!Number.isInteger(row.revision) || row.revision < 1) rowError(id, 'revision', 'must be an integer ≥ 1');
  if (!TITLE_SOURCES.includes(row.title_source)) rowError(id, 'title_source', `must be one of ${TITLE_SOURCES.join(', ')}`);
  if (!isIso(row.created_at)) rowError(id, 'created_at', 'must be an ISO-8601 timestamp');
  if (!isIso(row.updated_at)) rowError(id, 'updated_at', 'must be an ISO-8601 timestamp');
  if (row.finished_at !== null && !isIso(row.finished_at)) rowError(id, 'finished_at', 'must be an ISO-8601 timestamp or null');
  if (FINISHED_STATES.includes(row.state) !== (row.finished_at !== null)) rowError(id, 'finished_at', 'must be set exactly when the task is finished');
  return {
    id,
    project: row.project,
    title: row.title,
    titleSource: row.title_source,
    worktreePath: row.worktree_path,
    branch: row.branch,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    state: row.state,
    prUrl: row.pr_url,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function isUniqueConflict(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(err.message));
}

export function createTaskStore(db, { now = () => new Date().toISOString() } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') throw new Error('tasks: a database handle is required');
  db.exec(`
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
      title_source TEXT NOT NULL DEFAULT 'owner'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS tasks_open_worktree
      ON tasks (worktree_path) WHERE state IN ('active', 'pr_open');
  `);
  // Titles stored before their source was recorded are kept as the owner's: none is replaced.
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(column => column.name === 'title_source')) {
    db.exec("ALTER TABLE tasks ADD COLUMN title_source TEXT NOT NULL DEFAULT 'owner'");
  }

  const read = db.prepare('SELECT * FROM tasks WHERE id = ?');
  const readAll = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC');
  const readOpenByPath = db.prepare(`SELECT * FROM tasks WHERE worktree_path = ? AND state IN (${OPEN_STATES.map(() => '?').join(', ')})`);
  const insert = db.prepare(`
    INSERT INTO tasks (id, project, title, worktree_path, branch, base_branch, base_commit, state, pr_url, revision, created_at, updated_at, finished_at, title_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, NULL, ?)
  `);
  const renameStmt = db.prepare("UPDATE tasks SET title = ?, title_source = 'owner', revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?");
  const generatedStmt = db.prepare(`UPDATE tasks SET title = ?, title_source = 'generated', revision = revision + 1, updated_at = ?
    WHERE id = ? AND title_source = 'input' AND state IN (${OPEN_STATES.map(() => '?').join(', ')})`);
  const stateStmt = db.prepare('UPDATE tasks SET state = ?, pr_url = ?, finished_at = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?');

  const get = id => {
    if (!isUuid(id)) inputError('id', 'must be a UUID');
    const row = read.get(id);
    return row ? hydrate(row) : null;
  };

  const requireTask = id => {
    const task = get(id);
    if (!task) throw new Error(`tasks row ${id}: not found`);
    return task;
  };

  return {
    get,
    list() {
      return readAll.all().map(hydrate);
    },
    findOpenByWorktreePath(worktreePath) {
      if (!isWorktreePath(worktreePath)) inputError('worktreePath', 'must be an absolute path');
      const row = readOpenByPath.get(worktreePath, ...OPEN_STATES);
      return row ? hydrate(row) : null;
    },
    create(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) inputError('body', 'must be an object');
      const { id, project, title, worktreePath, branch, baseBranch, baseCommit, titleSource } = input;
      // A new title is the owner's or made from a run's input; 'generated' only ever replaces the latter.
      if (titleSource !== 'owner' && titleSource !== 'input') inputError('titleSource', 'must be owner or input');
      if (!isUuid(id)) inputError('id', 'must be a UUID');
      if (!isProject(project)) inputError('project', 'must be a nonempty string');
      if (!isTaskTitle(title)) inputError('title', `must be 1–${TASK_TITLE_MAX} single-line characters`);
      if (!isWorktreePath(worktreePath)) inputError('worktreePath', 'must be an absolute path');
      if (!isBranch(branch)) inputError('branch', 'must be a branch name');
      if (baseBranch !== null && !isBranch(baseBranch)) inputError('baseBranch', 'must be a branch name or null');
      if (typeof baseCommit !== 'string' || !COMMIT_ID.test(baseCommit)) inputError('baseCommit', 'must be a commit id');
      const stamp = now();
      try {
        insert.run(id, project, title.trim(), worktreePath, branch, baseBranch, baseCommit, stamp, stamp, titleSource);
      } catch (err) {
        if (isUniqueConflict(err) && /worktree_path/.test(err.message)) throw new Error('tasks: worktree already belongs to an open task');
        throw err;
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
    setState(id, { state, prUrl } = {}) {
      if (!TASK_STATES.includes(state)) inputError('state', `must be one of ${TASK_STATES.join(', ')}`);
      if (prUrl !== undefined && prUrl !== null && !isPrUrl(prUrl)) inputError('prUrl', 'must be an http(s) URL');
      if (state === 'pr_open' && !isPrUrl(prUrl)) inputError('prUrl', 'is required when a pull request is open');
      const current = requireTask(id);
      if (FINISHED_STATES.includes(current.state)) throw new Error(`tasks row ${id}: already finished`);
      const stamp = now();
      const finishedAt = FINISHED_STATES.includes(state) ? stamp : null;
      if (stateStmt.run(state, prUrl ?? current.prUrl, finishedAt, stamp, id, current.revision).changes !== 1) {
        throw new Error(`tasks row ${id}: revision conflict`);
      }
      return get(id);
    },
  };
}
