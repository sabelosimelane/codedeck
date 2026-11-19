/**
 * A task is a piece of work with one worktree and branch in each repository it includes. This
 * service creates the worktrees, opens terminals inside them, and keeps the owner from having
 * to name a branch or a folder. Git is always called with argv arrays, never through a shell.
 */

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { create as createWorktree, planNames, planTaskFolder, preflight, remove as removeWorktree, resolveHomeRepoPath, runGit } from '../pipelines/run-worktree.js';
import { readStoredRepositories } from '../project-repositories.js';
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
const OPEN_STATES = ['active', 'pr_open'];
const firstLine = text => String(text ?? '').trim().split('\n')[0].slice(0, 300);
/** What Git said went wrong: its `fatal:` or `error:` line when it has one, else its first line. */
const gitReason = (text) => {
  const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const stated = lines.find(line => /^(fatal|error):\s*/.test(line));
  return (stated ? stated.replace(/^(fatal|error):\s*/, '') : lines[0] ?? 'Git gave no reason').slice(0, 300);
};

export function createTaskService({
  taskStore, findProject, execFile, startSession, pathExists, realpath, newId = randomUUID,
  // Whether a workflow run is working in a task right now: a repository is not added under it.
  isRunWorking,
  rmdir = target => fs.promises.rmdir(target),
} = {}) {
  if (typeof taskStore?.create !== 'function' || typeof taskStore?.addWorktree !== 'function') throw new TypeError('taskStore is required');
  for (const [name, value] of Object.entries({ findProject, execFile, startSession, pathExists, newId, isRunWorking, rmdir })) {
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

  /** The branch a checkout is on, for starting a task from it. Refuses, naming the repository when one is given, if Git cannot use the checkout. */
  async function checkCheckout(checkout, label) {
    const eligibility = await preflight({ projectPath: checkout, projectHost: undefined, setupAgentId: undefined, execFile, realpath });
    if (!Array.isArray(eligibility?.reasons)) throw new Error('Git preflight reasons are invalid');
    for (const reason of eligibility.reasons) {
      if (typeof reason?.code !== 'string' || typeof reason?.message !== 'string') throw new Error('Git preflight reason is invalid');
      if (reason.code !== 'setup_agent_missing') throw new TaskError(label ? `${label}: ${reason.message}` : reason.message, 409);
    }
    if (eligibility.branch !== null && typeof eligibility.branch !== 'string') throw new Error('Git preflight branch is invalid');
    return eligibility.branch;
  }

  async function homeOf(checkout) {
    const home = await resolveHomeRepoPath({ projectPath: checkout, execFile });
    if (typeof home !== 'string' || !path.isAbsolute(home) || home === path.parse(home).root) throw new Error('Git home repository path is invalid');
    return home;
  }

  /**
   * Checks the request and names the task's branch and folders. Changes nothing.
   * `repositories` names the repositories the task includes, the one it starts in first;
   * left out, the task includes the project's own repository only.
   */
  async function plan({ project: projectName, title, titleSource, repositories } = {}) {
    // The caller says whether the owner gave the title or it was made from a run's input.
    if (titleSource !== 'owner' && titleSource !== 'input') throw new Error('Task title source must be owner or input');
    if (typeof projectName !== 'string' || projectName.length === 0) throw invalid('project', 'A project name is required');
    if (!isTaskTitle(title)) throw invalid('title', TITLE_RULE);
    if (repositories !== undefined && (!Array.isArray(repositories) || repositories.some(name => typeof name !== 'string' || name.length === 0))) {
      throw invalid('repositories', 'Use a list of repository names');
    }
    const project = await resolveProject(projectName);
    const others = readStoredRepositories(project);

    // The project's own repository is checked first, as it always was: it names the task's place on disk.
    const ownBranch = await checkCheckout(project.path, null);
    const ownHome = await homeOf(project.path);
    const ownName = path.basename(ownHome);
    const available = new Map([[ownName, { repositoryPath: null, checkoutPath: project.path, homePath: ownHome, baseBranch: ownBranch }]]);
    for (const entry of others) available.set(entry.name, { repositoryPath: entry.path, checkoutPath: entry.path });

    const names = repositories ?? [ownName];
    if (names.length === 0) throw invalid('repositories', 'Choose at least one repository');
    const seen = new Set();
    for (const name of names) {
      if (!available.has(name)) throw invalid('repositories', `${name} is not a repository of this project`);
      if (seen.has(name)) throw invalid('repositories', `${name} is listed twice`);
      seen.add(name);
    }

    const id = newId();
    if (!isUuid(id)) throw new Error('Task id is invalid');
    const chosen = [];
    for (const name of names) {
      const repository = available.get(name);
      if (repository.repositoryPath !== null) {
        repository.baseBranch = await checkCheckout(repository.checkoutPath, name);
        repository.homePath = await homeOf(repository.checkoutPath);
      }
      chosen.push({ repository: name, ...repository });
    }

    // A project with other repositories keeps each task in one folder, its worktrees side by side
    // under their repositories' names. A lone repository's task is named as it always was.
    let folder = null;
    let places;
    if (others.length > 0) {
      const planned = planTaskFolder({ taskId: id, title, ownHomePath: ownHome, repositories: names });
      folder = planned.folder;
      places = planned.worktrees.map(entry => ({ worktreePath: entry.worktreePath, branch: planned.branch }));
    } else {
      const named = planNames({ runId: id, workflowName: title, homeRepoPath: ownHome, branchPrefix: 'task' });
      places = [{ worktreePath: named.worktreePath, branch: named.branch }];
    }
    const worktrees = chosen.map((entry, index) => ({ ...entry, ...places[index] }));
    const first = worktrees[0];
    return {
      id,
      project: project.name,
      projectPath: project.path,
      title: title.trim(),
      titleSource,
      folder,
      // The worktree the task starts in, for callers that work in one.
      homePath: first.homePath,
      worktreePath: first.worktreePath,
      branch: first.branch,
      baseBranch: first.baseBranch,
      worktrees,
    };
  }

  function requirePlan(planned) {
    if (!planned || typeof planned !== 'object') throw new TypeError('A task plan is required');
    for (const field of ['id', 'project', 'projectPath', 'title']) {
      if (typeof planned[field] !== 'string' || planned[field].length === 0) throw new TypeError(`Task plan ${field} is invalid`);
    }
    if (planned.titleSource !== 'owner' && planned.titleSource !== 'input') throw new TypeError('Task plan titleSource is invalid');
    if (planned.folder !== null && (typeof planned.folder !== 'string' || !path.isAbsolute(planned.folder))) throw new TypeError('Task plan folder is invalid');
    if (!Array.isArray(planned.worktrees) || planned.worktrees.length === 0) throw new TypeError('Task plan worktrees is invalid');
    for (const worktree of planned.worktrees) {
      for (const field of ['repository', 'checkoutPath', 'homePath', 'worktreePath', 'branch']) {
        if (typeof worktree?.[field] !== 'string' || worktree[field].length === 0) throw new TypeError(`Task plan worktree ${field} is invalid`);
      }
      if (worktree.repositoryPath !== null && typeof worktree.repositoryPath !== 'string') throw new TypeError('Task plan worktree repositoryPath is invalid');
      if (worktree.baseBranch !== null && typeof worktree.baseBranch !== 'string') throw new TypeError('Task plan worktree baseBranch is invalid');
    }
  }

  /** Takes back a worktree this task has just created: it is new and clean, so nothing is forced. Says whether it is gone. */
  async function undo(worktree) {
    const removed = await removeWorktree({ homePath: worktree.homePath, worktreePath: worktree.worktreePath, execFile });
    if (!removed.ok) return false;
    try {
      await runGit(execFile, ['-C', worktree.homePath, 'branch', '-d', worktree.branch]);
    } catch (error) {
      console.warn(`[tasks] new branch kept after an undone task repository=${worktree.repository}: ${firstLine(error?.stderr || error?.message)}`);
    }
    return true;
  }

  const record = (planned, worktrees) => {
    const [first, ...rest] = worktrees;
    const row = worktree => ({
      repository: worktree.repository, repositoryPath: worktree.repositoryPath, worktreePath: worktree.worktreePath,
      branch: worktree.branch, baseBranch: worktree.baseBranch, baseCommit: worktree.baseCommit,
    });
    let task = taskStore.create({ id: planned.id, project: planned.project, title: planned.title, titleSource: planned.titleSource, folder: planned.folder, ...row(first) });
    for (const worktree of rest) task = taskStore.addWorktree(planned.id, row(worktree));
    return task;
  };

  /** Creates the worktrees and the task a plan describes: all of them, or none. */
  async function createPlannedNow(planned) {
    requirePlan(planned);
    const taken = planned.folder ?? planned.worktrees[0].worktreePath;
    const exists = await pathExists(taken);
    if (typeof exists !== 'boolean') throw new Error('pathExists must return a boolean');
    if (exists) throw new TaskError('A folder for this task already exists. Try again.', 409);

    const created = [];
    for (const worktree of planned.worktrees) {
      try {
        const made = await createWorktree({ homePath: worktree.homePath, worktreePath: worktree.worktreePath, branch: worktree.branch, projectPath: worktree.checkoutPath, execFile });
        created.push({ ...worktree, baseCommit: made?.baseCommit });
      } catch (error) {
        // A task with one worktree failed before anything existed: the failure is reported as it always was.
        if (planned.worktrees.length === 1) throw error;
        const kept = [];
        for (const earlier of [...created].reverse()) {
          if (!(await undo(earlier))) kept.unshift(earlier);
        }
        const reason = `The copy of ${worktree.repository} could not be created: ${gitReason(error?.message).replace(/\.$/, '')}.`;
        if (kept.length === 0) {
          // The task's folder goes with its last worktree; a folder that holds something else stays.
          if (planned.folder !== null) {
            await rmdir(planned.folder).catch(failure => { if (failure?.code !== 'ENOENT' && failure?.code !== 'ENOTEMPTY') throw failure; });
          }
          throw new TaskError(`${reason} Nothing was kept.`, 409, undefined, { cause: error });
        }
        record(planned, kept);
        throw new TaskError(`${reason} The task was kept with ${kept.map(entry => entry.repository).join(', ')}, whose copy could not be removed again.`, 409, undefined, { cause: error });
      }
    }
    return record(planned, created);
  }

  function requireTask(id) {
    if (!isUuid(id)) throw new TaskError('Task not found', 404);
    const task = taskStore.get(id);
    if (!task) throw new TaskError('Task not found', 404);
    return task;
  }

  /**
   * Gives an open task a copy of one more of the project's repositories: a worktree beside its
   * others, on the task's branch, from that repository's current commit. Nothing is prepared in it.
   */
  async function addRepositoryNow(id, body) {
    const task = requireTask(id);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'Use an object with repository');
    const unknown = Object.keys(body).filter(field => field !== 'repository');
    if (unknown.length) throw new TaskError('One or more fields failed validation.', 400, unknown.map(field => ({ field, message: 'Unknown field' })));
    const name = body.repository;
    const wrongName = invalid('repository', 'Use the name of one of this project\'s repositories');
    if (typeof name !== 'string' || name.length === 0 || name.includes('/')) throw wrongName;
    if (!OPEN_STATES.includes(task.state)) throw new TaskError('This task is finished.', 409);
    const had = task.worktrees.find(worktree => worktree.repository === name);
    if (had) {
      throw new TaskError(OPEN_STATES.includes(had.state)
        ? `${name} is already part of this task.`
        : `${name} was already merged or closed in this task and cannot be added again.`, 409);
    }
    const project = await resolveProject(task.project);
    const ownHome = await homeOf(project.path);
    const listed = readStoredRepositories(project).find(entry => entry.name === name);
    const checkoutPath = name === path.basename(ownHome) ? project.path : listed?.path;
    if (checkoutPath === undefined) throw wrongName;
    // A run that is working may be writing in the task; the repository is added when it pauses or finishes.
    if (isRunWorking(task.id) === true) throw new TaskError('A workflow run is working in this task. Add the repository when it pauses or finishes.', 409);

    const baseBranch = await checkCheckout(checkoutPath, name);
    const homePath = checkoutPath === project.path ? ownHome : await homeOf(checkoutPath);
    // Beside the task's other worktrees when it has a folder of its own; else named as its own worktree is.
    const branch = task.branch.startsWith('task/') ? task.branch : `task/${task.id.slice(0, 8)}`;
    const worktreePath = task.folder !== null
      ? path.join(task.folder, name)
      : path.join(path.dirname(homePath), 'worktrees', `${path.basename(homePath)}-${branch.slice('task/'.length)}`);
    const exists = await pathExists(worktreePath);
    if (typeof exists !== 'boolean') throw new Error('pathExists must return a boolean');
    if (exists) throw new TaskError(`A folder for ${name} in this task already exists.`, 409);

    const worktree = { repository: name, repositoryPath: checkoutPath === project.path ? null : checkoutPath, homePath, worktreePath, branch, baseBranch };
    let made;
    try {
      made = await createWorktree({ homePath, worktreePath, branch, projectPath: checkoutPath, execFile });
    } catch (error) {
      throw new TaskError(`The copy of ${name} could not be created: ${gitReason(error?.message).replace(/\.$/, '')}.`, 409, undefined, { cause: error });
    }
    try {
      return taskStore.addWorktree(task.id, { repository: name, repositoryPath: worktree.repositoryPath, worktreePath, branch, baseBranch, baseCommit: made?.baseCommit });
    } catch (error) {
      // The copy exists but the task could not take it: it is new and clean, so it is taken back.
      await undo(worktree);
      throw error;
    }
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
    addRepository(id, body) {
      const run = queue.then(() => addRepositoryNow(id, body));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
    rename(id, { title, revision } = {}) {
      const errors = [];
      if (!isTaskTitle(title)) errors.push({ field: 'title', message: TITLE_RULE });
      if (!Number.isInteger(revision) || revision < 1) errors.push({ field: 'revision', message: 'Use a whole number of 1 or more' });
      if (errors.length) throw new TaskError('One or more fields failed validation.', 400, errors);
      const task = requireTask(id);
      if (task.revision !== revision) throw new TaskError('This task was changed elsewhere. Reload and try again.', 409);
      return taskStore.rename(id, { title, revision });
    },
    /**
     * Opens a terminal in one of the task's worktrees: the one named, or else the one the task
     * started in, or the oldest still open once that one is finished.
     */
    async openTerminal(id, { worktreeId } = {}) {
      const task = requireTask(id);
      if (!OPEN_STATES.includes(task.state)) throw new TaskError('This task is finished.', 409);
      let worktree;
      if (worktreeId === undefined) {
        worktree = task.worktrees.find(candidate => OPEN_STATES.includes(candidate.state));
      } else {
        worktree = isUuid(worktreeId) ? task.worktrees.find(candidate => candidate.id === worktreeId) : undefined;
        if (!worktree) throw invalid('worktreeId', 'Use the id of one of this task\'s worktrees');
        if (!OPEN_STATES.includes(worktree.state)) throw new TaskError('This repository of the task is finished.', 409);
      }
      if (!worktree) throw new Error(`Open task ${task.id} has no open worktree`);
      const exists = await pathExists(worktree.worktreePath);
      if (typeof exists !== 'boolean') throw new Error('pathExists must return a boolean');
      if (!exists) throw new TaskError("This task's files are no longer on disk.", 409);
      let started;
      try {
        started = await startSession(task.project, { cwd: worktree.worktreePath });
        if (typeof started?.id !== 'string' || started.id.length === 0) throw new Error('Terminal session ID is invalid');
      } catch (error) {
        throw new TaskError('The terminal could not be opened.', error?.status === 503 ? 503 : 500, undefined, { cause: error });
      }
      return { sessionId: started.id, taskId: task.id, project: task.project, worktreeId: worktree.id };
    },
  };
}
