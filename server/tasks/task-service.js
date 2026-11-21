/**
 * A task is a piece of work with one worktree and branch in each repository it includes. This
 * service creates the worktrees, opens terminals inside them, and keeps the owner from having
 * to name a branch or a folder. Git is always called with argv arrays, never through a shell.
 */

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { create as createWorktree, listWorktrees, planNames, planTaskFolder, preflight, readWorktreeChanges, remove as removeWorktree, resolveHomeRepoPath, runGit } from '../pipelines/run-worktree.js';
import { readStoredRepositories } from '../project-repositories.js';
import { holdsWorktree } from '../pipelines/run-worktree-hold.js';
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
  listRuns,
  reservedWorktreePaths,
  rmdir = target => fs.promises.rmdir(target),
} = {}) {
  for (const method of ['create', 'remove', 'addWorktree', 'removeWorktree']) {
    if (typeof taskStore?.[method] !== 'function') throw new TypeError('taskStore with create, remove, addWorktree and removeWorktree is required');
  }
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

  const row = worktree => ({
    repository: worktree.repository, repositoryPath: worktree.repositoryPath, worktreePath: worktree.worktreePath,
    branch: worktree.branch, baseBranch: worktree.baseBranch, baseCommit: worktree.baseCommit,
  });

  /** The commit a checkout is on now; a worktree is created at the commit recorded for it. */
  async function headOf(checkout) {
    const { stdout } = await runGit(execFile, ['-C', checkout, 'rev-parse', 'HEAD']);
    return stdout.trim();
  }

  async function onDisk(target) {
    const there = await pathExists(target);
    if (typeof there !== 'boolean') throw new Error('pathExists must return a boolean');
    return there;
  }

  const candidateReasons = {
    missing: 'The worktree directory is missing.',
    detached: 'No branch is checked out in this worktree.',
    unreadable: 'Git cannot read this worktree.',
    in_use: 'An open workflow run is already using it.',
    base_unknown: 'No base branch is checked out in the repository.',
  };
  const commitId = /^[0-9a-f]{40}$/;

  async function candidateRecords(projectName) {
    if (typeof projectName !== 'string' || !projectName) throw invalid('project', 'A project name is required');
    if (typeof listRuns !== 'function') throw new TypeError('listRuns is required for worktree candidates');
    if (typeof reservedWorktreePaths !== 'function') throw new TypeError('reservedWorktreePaths is required for worktree candidates');
    if (typeof taskStore.findOpenByWorktreePath !== 'function') throw new TypeError('taskStore.findOpenByWorktreePath is required');
    const project = await resolveProject(projectName);
    const repositories = [{ name: path.basename(project.path), checkout: project.path, own: true, repositoryPath: null },
      ...readStoredRepositories(project).map(entry => ({ name: entry.name, checkout: entry.path, own: false, repositoryPath: entry.path }))];
    const runs = listRuns();
    const reserved = reservedWorktreePaths();
    if (!Array.isArray(runs)) throw new Error('Run list is invalid');
    if (!(reserved instanceof Set)) throw new Error('Reserved worktree paths are invalid');
    const candidates = [];
    for (const repo of repositories) {
      const listed = await listWorktrees({ projectPath: repo.checkout, execFile });
      const base = (await runGit(execFile, ['-C', repo.checkout, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
      if (!base) throw new Error(`Git base branch is invalid for ${repo.name}`);
      for (const [index, worktree] of listed.entries()) {
        for (const field of ['path', 'head']) if (typeof worktree[field] !== 'string' || !worktree[field]) throw new Error(`Git worktree ${field} is invalid`);
        if (!path.isAbsolute(worktree.path) || worktree.path.includes('\0')) throw new Error('Git worktree path is invalid');
        if (!commitId.test(worktree.head)) throw new Error('Git worktree head is invalid');
        if (worktree.branch !== null && (typeof worktree.branch !== 'string' || !worktree.branch)) throw new Error('Git worktree branch is invalid');
        if (typeof worktree.missing !== 'boolean') throw new Error('Git worktree missing is invalid');
        if (index === 0 || repositories.some(entry => entry.checkout === worktree.path) || taskStore.findOpenByWorktreePath(worktree.path)) continue;
        let uncommittedCount = null;
        let unreadable = false;
        if (!worktree.missing) {
          let changes;
          try {
            changes = await readWorktreeChanges({ worktreePath: worktree.path, execFile });
          } catch (error) {
            console.warn(`[task-worktree] Git status failed for ${worktree.path}:`, error?.message ?? String(error));
            unreadable = true;
          }
          if (!unreadable) {
            if (typeof changes?.readable !== 'boolean') throw new Error('Git worktree readability is invalid');
            if (changes.readable && typeof changes.dirty !== 'boolean') throw new Error('Git worktree dirty state is invalid');
            unreadable = !changes.readable;
          }
          if (!unreadable) {
            let status;
            try { status = await runGit(execFile, ['-C', worktree.path, 'status', '--porcelain=v1', '--untracked-files=all']); }
            catch (error) {
              console.warn(`[task-worktree] Git status failed for ${worktree.path}:`, error?.message ?? String(error));
              unreadable = true;
            }
            if (!unreadable) {
              if (typeof status?.stdout !== 'string') throw new Error('Git status output is invalid');
              uncommittedCount = status.stdout.split('\n').filter(Boolean).length;
            }
          }
        }
        const code = worktree.missing ? 'missing' : worktree.branch === null ? 'detached' : unreadable ? 'unreadable'
          : runs.some(run => holdsWorktree(run, worktree.path)) || reserved.has(worktree.path) ? 'in_use'
            : base === 'HEAD' ? 'base_unknown' : null;
        candidates.push({ path: worktree.path, name: path.basename(worktree.path), repository: repo.name,
          own: repo.own, branch: worktree.branch, head: worktree.head, uncommittedCount,
          selectable: code === null, reason: code === null ? null : { code, message: candidateReasons[code] },
          repositoryPath: repo.repositoryPath, checkout: repo.checkout, baseBranch: base });
      }
    }
    return candidates;
  }

  async function adoptWorktreeNow({ project, worktreePath, title } = {}) {
    if (typeof project !== 'string' || !project) throw invalid('project', 'A project name is required');
    if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath) || worktreePath.includes('\0')) throw invalid('worktreePath', 'Use an absolute worktree path');
    if (title !== undefined && !isTaskTitle(title)) throw invalid('title', TITLE_RULE);
    const records = await candidateRecords(project);
    if (taskStore.findOpenByWorktreePath(worktreePath)) throw new TaskError('This worktree already belongs to a task.', 409);
    const candidate = records.find(entry => entry.path === worktreePath);
    if (!candidate) throw new TaskError('Worktree not found', 404);
    if (!candidate.selectable) throw new TaskError(candidate.reason.message, 409);
    let baseCommit;
    try { baseCommit = (await runGit(execFile, ['-C', candidate.checkout, 'merge-base', candidate.baseBranch, candidate.branch])).stdout.trim(); }
    catch (error) { if (error?.code === 1) throw new TaskError('The worktree branch has no common base with the checkout.', 409); throw error; }
    if (!commitId.test(baseCommit)) throw new TaskError('The worktree branch has no common base with the checkout.', 409);
    const derived = candidate.branch.split('/').at(-1).replace(/[-_]/g, ' ').trim().slice(0, TASK_TITLE_MAX).trim();
    if (title === undefined && !isTaskTitle(derived)) throw new TaskError('The branch cannot provide a task title. Enter one.', 409);
    const id = newId();
    if (!isUuid(id)) throw new Error('Task id is invalid');
    let task;
    try {
      task = taskStore.create({ id, project, title: title === undefined ? derived : title.trim(),
        titleSource: title === undefined ? 'input' : 'owner', folder: null, repository: candidate.repository,
        repositoryPath: candidate.repositoryPath, worktreePath, branch: candidate.branch,
        baseBranch: candidate.baseBranch, baseCommit, others: [] });
    } catch (error) {
      if (taskStore.findOpenByWorktreePath(worktreePath)) throw new TaskError('This worktree already belongs to a task.', 409);
      throw error;
    }
    return task;
  }

  /**
   * Records the task with all its worktrees before Git is asked for any of them, then creates
   * each at the commit recorded for it: all of them, or none.
   */
  async function createPlannedNow(planned) {
    requirePlan(planned);
    if (await onDisk(planned.folder ?? planned.worktrees[0].worktreePath)) throw new TaskError('A folder for this task already exists. Try again.', 409);

    const worktrees = [];
    for (const worktree of planned.worktrees) worktrees.push({ ...worktree, baseCommit: await headOf(worktree.checkoutPath) });
    const [first, ...rest] = worktrees;
    const task = taskStore.create({
      id: planned.id, project: planned.project, title: planned.title, titleSource: planned.titleSource, folder: planned.folder,
      ...row(first), others: rest.map(row),
    });

    const created = [];
    for (const worktree of worktrees) {
      try {
        await createWorktree({ homePath: worktree.homePath, worktreePath: worktree.worktreePath, branch: worktree.branch, baseCommit: worktree.baseCommit, execFile });
        created.push(worktree);
      } catch (error) {
        // The worktrees already made for this task are taken back; what then is still on disk decides whether the task stays.
        for (const earlier of [...created].reverse()) await undo(earlier);
        const remaining = [];
        for (const candidate of worktrees) {
          if (await onDisk(candidate.worktreePath)) remaining.push(candidate);
        }
        if (remaining.length === 0) {
          taskStore.remove(planned.id);
          // The task's folder goes with its last worktree; a folder that holds something else stays.
          if (planned.folder !== null) {
            await rmdir(planned.folder).catch((failure) => { if (failure?.code !== 'ENOENT' && failure?.code !== 'ENOTEMPTY') throw failure; });
          }
        } else {
          // The task stays for the copies still on disk. A repository whose copy is not there leaves the task again;
          // the one the task started in cannot, so its row stays and says its files are missing.
          for (const recorded of taskStore.get(planned.id).worktrees) {
            if (!recorded.first && !remaining.some(entry => entry.worktreePath === recorded.worktreePath)) taskStore.removeWorktree(planned.id, recorded.id);
          }
        }
        // A task with one worktree reports the failure as it always did.
        if (worktrees.length === 1) throw error;
        const reason = `The copy of ${worktree.repository} could not be created: ${gitReason(error?.message).replace(/\.$/, '')}.`;
        throw new TaskError(remaining.length === 0
          ? `${reason} Nothing was kept.`
          : `${reason} The task was kept with ${remaining.map(entry => entry.repository).join(', ')}, whose copy could not be removed again.`, 409, undefined, { cause: error });
      }
    }
    return task;
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
    if (await onDisk(worktreePath)) throw new TaskError(`A folder for ${name} in this task already exists.`, 409);

    // Recorded before Git is asked, at the commit the repository is on now.
    const baseCommit = await headOf(checkoutPath);
    const recorded = taskStore.addWorktree(task.id, { repository: name, repositoryPath: checkoutPath === project.path ? null : checkoutPath, worktreePath, branch, baseBranch, baseCommit });
    try {
      await createWorktree({ homePath, worktreePath, branch, baseCommit, execFile });
    } catch (error) {
      // No folder was made: the repository never became part of the task.
      if (!(await onDisk(worktreePath))) taskStore.removeWorktree(task.id, recorded.worktrees.find(worktree => worktree.worktreePath === worktreePath).id);
      throw new TaskError(`The copy of ${name} could not be created: ${gitReason(error?.message).replace(/\.$/, '')}.`, 409, undefined, { cause: error });
    }
    return recorded;
  }

  // Git refuses concurrent `worktree add` in one repository, so creations run one at a time.
  let queue = Promise.resolve();
  return {
    plan,
    async listWorktreeCandidates(projectName) {
      return (await candidateRecords(projectName)).map(({ repositoryPath, checkout, baseBranch, ...publicCandidate }) => publicCandidate);
    },
    adoptWorktree(input) {
      const run = queue.then(() => adoptWorktreeNow(input));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
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
