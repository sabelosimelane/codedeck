/**
 * A task is a piece of work with its own worktree and branch. This service creates the
 * worktree, opens terminals inside it, and keeps the owner from having to name a branch
 * or a folder. Git is always called with argv arrays, never through a shell.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { create as createWorktree, planNames, preflight, resolveHomeRepoPath, runGit } from '../pipelines/run-worktree.js';
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
  if (typeof taskStore?.create !== 'function' || typeof taskStore?.remove !== 'function') throw new TypeError('taskStore with create and remove is required');
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

  /** Checks the request and names the task's branch and folder. Changes nothing. */
  async function plan({ project: projectName, title, titleSource } = {}) {
    // The caller says whether the owner gave the title or it was made from a run's input.
    if (titleSource !== 'owner' && titleSource !== 'input') throw new Error('Task title source must be owner or input');
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
    return {
      id,
      project: project.name,
      projectPath: project.path,
      title: title.trim(),
      titleSource,
      homePath: home,
      worktreePath: names.worktreePath,
      branch: names.branch,
      baseBranch: eligibility.branch,
    };
  }

  /** Records the task before creating its worktree at the same commit. */
  async function createPlannedNow(planned) {
    if (!planned || typeof planned !== 'object') throw new TypeError('A task plan is required');
    for (const field of ['id', 'project', 'projectPath', 'title', 'homePath', 'worktreePath', 'branch']) {
      if (typeof planned[field] !== 'string' || planned[field].length === 0) throw new TypeError(`Task plan ${field} is invalid`);
    }
    if (planned.baseBranch !== null && typeof planned.baseBranch !== 'string') throw new TypeError('Task plan baseBranch is invalid');
    if (planned.titleSource !== 'owner' && planned.titleSource !== 'input') throw new TypeError('Task plan titleSource is invalid');
    const exists = await pathExists(planned.worktreePath);
    if (typeof exists !== 'boolean') throw new Error('pathExists must return a boolean');
    if (exists) throw new TaskError('A folder for this task already exists. Try again.', 409);

    const { stdout } = await runGit(execFile, ['-C', planned.projectPath, 'rev-parse', 'HEAD']);
    const baseCommit = stdout.trim();
    const task = taskStore.create({
      id: planned.id,
      project: planned.project,
      title: planned.title,
      titleSource: planned.titleSource,
      worktreePath: planned.worktreePath,
      branch: planned.branch,
      baseBranch: planned.baseBranch,
      baseCommit,
    });
    try {
      await createWorktree({ homePath: planned.homePath, worktreePath: planned.worktreePath, branch: planned.branch, baseCommit, execFile });
    } catch (error) {
      const folderExists = await pathExists(planned.worktreePath);
      if (typeof folderExists !== 'boolean') throw new Error('pathExists must return a boolean', { cause: error });
      if (!folderExists) taskStore.remove(planned.id);
      throw error;
    }
    return task;
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
    plan,
    createPlanned(planned) {
      const run = queue.then(() => createPlannedNow(planned));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
    /** A task made by hand: its title is the owner's. */
    create(input) {
      const run = queue.then(async () => createPlannedNow(await plan({ ...input, titleSource: 'owner' })));
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
