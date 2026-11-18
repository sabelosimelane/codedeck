/**
 * A task is a piece of work with its own worktree and branch. This service creates the
 * worktree, opens terminals inside it, and keeps the owner from having to name a branch
 * or a folder. Git is always called with argv arrays, never through a shell.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { create as createWorktree, planNames, preflight, resolveHomeRepoPath } from '../pipelines/run-worktree.js';
import { isTaskTitle, TASK_TITLE_MAX } from './task-store.js';

export class TaskError extends Error {
  constructor(message, status, errors, options) {
    super(message, options);
    this.status = status;
    this.errors = errors;
  }
}

const invalid = (field, message) => new TaskError('One or more fields failed validation.', 400, [{ field, message }]);
const TITLE_RULE = `Use 1–${TASK_TITLE_MAX} characters on one line`;

export function createTaskService({ taskStore, findProject, execFile, startSession, pathExists, realpath, newId = randomUUID } = {}) {
  if (typeof taskStore?.create !== 'function') throw new TypeError('taskStore is required');
  for (const [name, value] of Object.entries({ findProject, execFile, startSession, pathExists, newId })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  async function resolveProject(projectName) {
    const project = await findProject(projectName);
    if (project === null || project === undefined) throw new TaskError('Project not found', 404);
    if (typeof project.name !== 'string' || project.name.length === 0) throw new Error('Stored project name is invalid');
    if (typeof project.path !== 'string' || !path.isAbsolute(project.path)) throw new Error('Stored project path is invalid');
    if (project.host !== undefined && project.host !== null && typeof project.host !== 'string') throw new Error('Stored project host is invalid');
    if (project.host && project.host !== 'local') throw new TaskError('Tasks are only available for local projects.', 409);
    return project;
  }

  async function createNow({ project: projectName, title } = {}) {
    if (typeof projectName !== 'string' || projectName.length === 0) throw invalid('project', 'A project name is required');
    if (!isTaskTitle(title)) throw invalid('title', TITLE_RULE);
    const project = await resolveProject(projectName);

    const eligibility = await preflight({ projectPath: project.path, projectHost: project.host, setupAgentId: undefined, execFile, realpath });
    if (!Array.isArray(eligibility?.reasons)) throw new Error('Git preflight reasons are invalid');
    for (const reason of eligibility.reasons) {
      if (typeof reason?.code !== 'string' || typeof reason?.message !== 'string') throw new Error('Git preflight reason is invalid');
      if (reason.code !== 'setup_agent_missing') throw new TaskError(reason.message, 409);
    }
    if (eligibility.branch !== null && typeof eligibility.branch !== 'string') throw new Error('Git preflight branch is invalid');

    const id = newId();
    if (!isUuid(id)) throw new Error('Task id is invalid');
    const home = await resolveHomeRepoPath({ projectPath: project.path, execFile });
    if (typeof home !== 'string' || !path.isAbsolute(home) || home === path.parse(home).root) throw new Error('Git home repository path is invalid');
    const names = planNames({ runId: id, workflowName: title, homeRepoPath: home, branchPrefix: 'task' });

    const exists = await pathExists(names.worktreePath);
    if (typeof exists !== 'boolean') throw new Error('pathExists must return a boolean');
    if (exists) throw new TaskError('A folder for this task already exists. Try again.', 409);

    const created = await createWorktree({ homePath: home, worktreePath: names.worktreePath, branch: names.branch, projectPath: project.path, execFile });
    return taskStore.create({
      id,
      project: project.name,
      title,
      worktreePath: names.worktreePath,
      branch: names.branch,
      baseBranch: eligibility.branch,
      baseCommit: created?.baseCommit,
    });
  }

  function requireTask(id) {
    if (!isUuid(id)) throw new TaskError('Task not found', 404);
    const task = taskStore.get(id);
    if (!task) throw new TaskError('Task not found', 404);
    return task;
  }

  // Git refuses concurrent `worktree add` in one repository, so creations run one at a time.
  let queue = Promise.resolve();
  return {
    create(input) {
      const run = queue.then(() => createNow(input));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
    get: requireTask,
    rename(id, { title, revision } = {}) {
      const errors = [];
      if (!isTaskTitle(title)) errors.push({ field: 'title', message: TITLE_RULE });
      if (!Number.isInteger(revision) || revision < 1) errors.push({ field: 'revision', message: 'Use a whole number of 1 or more' });
      if (errors.length) throw new TaskError('One or more fields failed validation.', 400, errors);
      const task = requireTask(id);
      if (task.revision !== revision) throw new TaskError('This task was changed elsewhere. Reload and try again.', 409);
      return taskStore.rename(id, { title, revision });
    },
    async openTerminal(id) {
      const task = requireTask(id);
      if (!['active', 'pr_open'].includes(task.state)) throw new TaskError('This task is finished.', 409);
      const exists = await pathExists(task.worktreePath);
      if (typeof exists !== 'boolean') throw new Error('pathExists must return a boolean');
      if (!exists) throw new TaskError("This task's files are no longer on disk.", 409);
      let started;
      try {
        started = await startSession(task.project, { cwd: task.worktreePath });
        if (typeof started?.id !== 'string' || started.id.length === 0) throw new Error('Terminal session ID is invalid');
      } catch (error) {
        throw new TaskError('The terminal could not be opened.', error?.status === 503 ? 503 : 500, undefined, { cause: error });
      }
      return { sessionId: started.id, taskId: task.id, project: task.project };
    },
  };
}
