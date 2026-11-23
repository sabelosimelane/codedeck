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
import { isRepositoryName, isTaskTitle, TASK_TITLE_MAX } from './task-store.js';
import { getProjectLocation, LOCAL_HOST, normalizeHostName, normalizeProject } from '../project-config.js';
import { syncProjectLocation } from '../git-sync-service.js';

export class TaskError extends Error {
  constructor(message, status, errors, options) {
    super(message, options);
    this.status = status;
    this.errors = errors;
    if (options?.extra) this.extra = options.extra;
  }
}

const invalid = (field, message) => new TaskError('One or more fields failed validation.', 400, [{ field, message }]);
const TITLE_RULE = `Use 1–${TASK_TITLE_MAX} characters on one line`;
const OPEN_STATES = ['active', 'pr_open'];
const PATH_MAX = 1024;
const isAbsoluteFolder = value => typeof value === 'string' && value.length >= 1 && value.length <= PATH_MAX && path.isAbsolute(value) && !value.includes('\0');
const firstLine = text => String(text ?? '').trim().split('\n')[0].slice(0, 300);
/** What Git said went wrong: its `fatal:` or `error:` line when it has one, else its first line. */
const gitReason = (text) => {
  const lines = String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const stated = lines.find(line => /^(fatal|error):\s*/.test(line));
  return (stated ? stated.replace(/^(fatal|error):\s*/, '') : lines[0] ?? 'Git gave no reason').slice(0, 300);
};

export function createTaskService({
  taskStore, findProject, execFile, startSession, pathExists, realpath = target => fs.promises.realpath(target), newId = randomUUID,
  // Whether a workflow run is working in a task right now: a repository is not added under it.
  isRunWorking,
  listRuns,
  reservedWorktreePaths,
  rmdir = target => fs.promises.rmdir(target),
  resolveHostTools = null,
  syncLocation = syncProjectLocation,
} = {}) {
  for (const method of ['create', 'remove', 'addWorktree', 'removeWorktree']) {
    if (typeof taskStore?.[method] !== 'function') throw new TypeError('taskStore with create, remove, addWorktree and removeWorktree is required');
  }
  for (const [name, value] of Object.entries({ findProject, execFile, startSession, pathExists, newId, isRunWorking, rmdir })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  function toolsFor(hostName) {
    const normalized = normalizeHostName(hostName);
    if (typeof resolveHostTools === 'function') {
      try {
        return resolveHostTools(normalized);
      } catch (err) {
        throw new TaskError(err.message || 'Host unavailable', err.status || 503, undefined, { cause: err });
      }
    }
    return {
      host: LOCAL_HOST,
      runner: null,
      execFile,
      pathExists,
      realpath,
      mkdir: (dir, opts) => fs.promises.mkdir(dir, opts),
      rmdir,
    };
  }

  async function resolveProject(projectName, requestedHost) {
    const raw = await findProject(projectName);
    if (raw === null || raw === undefined) throw new TaskError('Project not found', 404);
    if (typeof raw.name !== 'string' || raw.name.length === 0) throw new Error('Stored project name is invalid');
    if (typeof raw.path !== 'string' || !path.isAbsolute(raw.path)) throw new Error('Stored project path is invalid');
    if (raw.host !== undefined && raw.host !== null && typeof raw.host !== 'string') throw new Error('Stored project host is invalid');
    if (!resolveHostTools && raw.host && raw.host !== 'local') throw new TaskError('Tasks are only available for local projects.', 409);

    const project = normalizeProject(raw);
    const targetHost = requestedHost ? normalizeHostName(requestedHost) : project.defaultHost;
    const location = getProjectLocation(project, targetHost);
    if (!location) {
      throw new TaskError(`Project "${project.name}" has no checkout configured on host "${targetHost}".`, 404);
    }
    return { project, host: location.host, location, tools: toolsFor(location.host) };
  }

  /** The branch a checkout is on, for starting a task from it. Refuses, naming the repository when one is given, if Git cannot use the checkout. */
  async function checkCheckout(checkout, label, tools) {
    const t = tools ?? toolsFor(LOCAL_HOST);
    const eligibility = await preflight({
      projectPath: checkout,
      projectHost: t.host,
      allowRemote: Boolean(resolveHostTools),
      setupAgentId: undefined,
      execFile: t.execFile,
      realpath: t.realpath,
    });
    if (!Array.isArray(eligibility?.reasons)) throw new Error('Git preflight reasons are invalid');
    for (const reason of eligibility.reasons) {
      if (typeof reason?.code !== 'string' || typeof reason?.message !== 'string') throw new Error('Git preflight reason is invalid');
      if (reason.code !== 'setup_agent_missing') throw new TaskError(label ? `${label}: ${reason.message}` : reason.message, reason.code === 'host_unreachable' ? 503 : 409);
    }
    if (eligibility.branch !== null && typeof eligibility.branch !== 'string') throw new Error('Git preflight branch is invalid');
    return eligibility.branch;
  }

  async function homeOf(checkout, tools) {
    const t = tools ?? toolsFor(LOCAL_HOST);
    const home = await resolveHomeRepoPath({ projectPath: checkout, execFile: t.execFile });
    if (typeof home !== 'string' || !path.isAbsolute(home) || home === path.parse(home).root) throw new Error('Git home repository path is invalid');
    return home;
  }

  /**
   * Checks the request and names the task's branch and folders. Changes nothing.
   * `repositories` names the repositories the task includes, the one it starts in first;
   * left out, the task includes the project's own repository only.
   */
  async function plan({ project: projectName, title, titleSource, repositories, host: requestedHost } = {}) {
    // The caller says whether the owner gave the title or it was made from a run's input.
    if (titleSource !== 'owner' && titleSource !== 'input') throw new Error('Task title source must be owner or input');
    if (typeof projectName !== 'string' || projectName.length === 0) throw invalid('project', 'A project name is required');
    if (!isTaskTitle(title)) throw invalid('title', TITLE_RULE);
    if (repositories !== undefined && (!Array.isArray(repositories) || repositories.some(name => typeof name !== 'string' || name.length === 0))) {
      throw invalid('repositories', 'Use a list of repository names');
    }
    const { project, host, location, tools } = await resolveProject(projectName, requestedHost);
    const others = readStoredRepositories({ name: project.name, repositories: location.repositories });

    const available = new Map();
    let ownName = null;
    let anchorHome = null;

    if (project.workspaceMode === 'folder') {
      if (others.length === 0) {
        throw new TaskError('This workspace project has no repositories yet. Add a repository first.', 409);
      }
      for (const entry of others) available.set(entry.name, { repositoryPath: entry.path, checkoutPath: entry.path });
      ownName = others[0].name;
    } else {
      // The project's own repository is checked first, as it always was: it names the task's place on disk.
      const ownBranch = await checkCheckout(location.path, null, tools);
      const ownHome = await homeOf(location.path, tools);
      ownName = path.basename(ownHome);
      anchorHome = ownHome;
      available.set(ownName, { repositoryPath: null, checkoutPath: location.path, homePath: ownHome, baseBranch: ownBranch });
      for (const entry of others) available.set(entry.name, { repositoryPath: entry.path, checkoutPath: entry.path });
    }

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
        repository.baseBranch = await checkCheckout(repository.checkoutPath, name, tools);
        repository.homePath = await homeOf(repository.checkoutPath, tools);
      }
      chosen.push({ repository: name, ...repository });
    }

    // A project with other repositories keeps each task in one folder, its worktrees side by side
    // under their repositories' names. A lone repository's task is named as it always was.
    let folder = null;
    let places;
    const effectiveAnchor = anchorHome ?? chosen[0].homePath;
    if (project.workspaceMode === 'folder' || others.length > 0) {
      const planned = planTaskFolder({ taskId: id, title, ownHomePath: effectiveAnchor, repositories: names });
      folder = planned.folder;
      places = planned.worktrees.map(entry => ({ worktreePath: entry.worktreePath, branch: planned.branch }));
    } else {
      const named = planNames({ runId: id, workflowName: title, homeRepoPath: effectiveAnchor, branchPrefix: 'task' });
      places = [{ worktreePath: named.worktreePath, branch: named.branch }];
    }
    const worktrees = chosen.map((entry, index) => ({ ...entry, ...places[index] }));
    const first = worktrees[0];
    return {
      id,
      project: project.name,
      host,
      projectPath: location.path,
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
  async function undo(worktree, tools) {
    const t = tools ?? toolsFor(LOCAL_HOST);
    const removed = await removeWorktree({ homePath: worktree.homePath, worktreePath: worktree.worktreePath, execFile: t.execFile });
    if (!removed.ok) return false;
    try {
      await runGit(t.execFile, ['-C', worktree.homePath, 'branch', '-d', worktree.branch]);
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
  async function headOf(checkout, tools) {
    const t = tools ?? toolsFor(LOCAL_HOST);
    const { stdout } = await runGit(t.execFile, ['-C', checkout, 'rev-parse', 'HEAD']);
    return stdout.trim();
  }

  async function onDisk(target, tools) {
    const t = tools ?? toolsFor(LOCAL_HOST);
    const there = await t.pathExists(target);
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

  async function candidateRecords(projectName, requestedHost) {
    if (typeof projectName !== 'string' || !projectName) throw invalid('project', 'A project name is required');
    if (typeof listRuns !== 'function') throw new TypeError('listRuns is required for worktree candidates');
    if (typeof reservedWorktreePaths !== 'function') throw new TypeError('reservedWorktreePaths is required for worktree candidates');
    if (typeof taskStore.findOpenByWorktreePath !== 'function') throw new TypeError('taskStore.findOpenByWorktreePath is required');
    const { project, host, location, tools } = await resolveProject(projectName, requestedHost);
    const repositories = [{ name: path.basename(location.path), checkout: location.path, own: true, repositoryPath: null },
      ...readStoredRepositories({ name: project.name, repositories: location.repositories }).map(entry => ({ name: entry.name, checkout: entry.path, own: false, repositoryPath: entry.path }))];
    const runs = listRuns();
    const reserved = reservedWorktreePaths();
    if (!Array.isArray(runs)) throw new Error('Run list is invalid');
    if (!(reserved instanceof Set)) throw new Error('Reserved worktree paths are invalid');
    const candidates = [];
    for (const repo of repositories) {
      const listed = await listWorktrees({ projectPath: repo.checkout, execFile: tools.execFile });
      const base = (await runGit(tools.execFile, ['-C', repo.checkout, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
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
            changes = await readWorktreeChanges({ worktreePath: worktree.path, execFile: tools.execFile });
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
            try { status = await runGit(tools.execFile, ['-C', worktree.path, 'status', '--porcelain=v1', '--untracked-files=all']); }
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
          repositoryPath: repo.repositoryPath, checkout: repo.checkout, baseBranch: base, host });
      }
    }
    return candidates;
  }

  async function adoptWorktreeNow({ project, worktreePath, title, host: requestedHost } = {}) {
    if (typeof project !== 'string' || !project) throw invalid('project', 'A project name is required');
    if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath) || worktreePath.includes('\0')) throw invalid('worktreePath', 'Use an absolute worktree path');
    if (title !== undefined && !isTaskTitle(title)) throw invalid('title', TITLE_RULE);
    const records = await candidateRecords(project, requestedHost);
    if (taskStore.findOpenByWorktreePath(worktreePath)) throw new TaskError('This worktree already belongs to a task.', 409);
    const candidate = records.find(entry => entry.path === worktreePath);
    if (!candidate) throw new TaskError('Worktree not found', 404);
    if (!candidate.selectable) throw new TaskError(candidate.reason.message, 409);
    const tools = toolsFor(candidate.host);
    let baseCommit;
    try { baseCommit = (await runGit(tools.execFile, ['-C', candidate.checkout, 'merge-base', candidate.baseBranch, candidate.branch])).stdout.trim(); }
    catch (error) { if (error?.code === 1) throw new TaskError('The worktree branch has no common base with the checkout.', 409); throw error; }
    if (!commitId.test(baseCommit)) throw new TaskError('The worktree branch has no common base with the checkout.', 409);
    const derived = candidate.branch.split('/').at(-1).replace(/[-_]/g, ' ').trim().slice(0, TASK_TITLE_MAX).trim();
    if (title === undefined && !isTaskTitle(derived)) throw new TaskError('The branch cannot provide a task title. Enter one.', 409);
    const id = newId();
    if (!isUuid(id)) throw new Error('Task id is invalid');
    let task;
    try {
      task = taskStore.create({ id, project, host: candidate.host, title: title === undefined ? derived : title.trim(),
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
    const tools = toolsFor(planned.host);
    if (await onDisk(planned.folder ?? planned.worktrees[0].worktreePath, tools)) throw new TaskError('A folder for this task already exists. Try again.', 409);

    const worktrees = [];
    for (const worktree of planned.worktrees) worktrees.push({ ...worktree, baseCommit: await headOf(worktree.checkoutPath, tools) });
    const [first, ...rest] = worktrees;
    const task = taskStore.create({
      id: planned.id, project: planned.project, host: planned.host ?? LOCAL_HOST, title: planned.title, titleSource: planned.titleSource, folder: planned.folder,
      ...row(first), others: rest.map(row),
    });

    const created = [];
    for (const worktree of worktrees) {
      try {
        await createWorktree({ homePath: worktree.homePath, worktreePath: worktree.worktreePath, branch: worktree.branch, baseCommit: worktree.baseCommit, execFile: tools.execFile, mkdir: tools.mkdir });
        created.push(worktree);
      } catch (error) {
        // The worktrees already made for this task are taken back; what then is still on disk decides whether the task stays.
        for (const earlier of [...created].reverse()) await undo(earlier, tools);
        const remaining = [];
        for (const candidate of worktrees) {
          if (await onDisk(candidate.worktreePath, tools)) remaining.push(candidate);
        }
        if (remaining.length === 0) {
          taskStore.remove(planned.id);
          // The task's folder goes with its last worktree; a folder that holds something else stays.
          if (planned.folder !== null) {
            await tools.rmdir(planned.folder).catch((failure) => { if (failure?.code !== 'ENOENT' && failure?.code !== 'ENOTEMPTY') throw failure; });
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

  /** A folder the owner named: on disk and the top level of a Git working tree. Says which branch and commit it is on. */
  async function inspectFolder(given, field, tools) {
    if (!(await onDisk(given, tools))) throw invalid(field, 'This folder does not exist');
    const folder = await tools.realpath(given);
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('realpath must return an absolute path');
    const check = await preflight({ projectPath: folder, projectHost: tools.host, allowRemote: Boolean(resolveHostTools), setupAgentId: undefined, execFile: tools.execFile, realpath: tools.realpath });
    if (!Array.isArray(check?.reasons)) throw new Error('Git preflight reasons are invalid');
    for (const reason of check.reasons) {
      if (typeof reason?.code !== 'string' || typeof reason?.message !== 'string') throw new Error('Git preflight reason is invalid');
      if (reason.code === 'not_git_toplevel') throw invalid(field, 'This folder is not the top level of a Git working tree');
      if (reason.code !== 'setup_agent_missing') throw new TaskError(reason.message, reason.code === 'host_unreachable' ? 503 : 409);
    }
    if (check.branch !== null && typeof check.branch !== 'string') throw new Error('Git preflight branch is invalid');
    if (typeof check.head !== 'string' || !commitId.test(check.head)) throw new Error('Git preflight head is invalid');
    return { path: folder, branch: check.branch, head: check.head };
  }

  /** The folder a checkout's repository is kept in, as the disk names it, so that two checkouts of one repository compare equal. */
  async function realHomeOf(checkout, tools) {
    const home = await tools.realpath(await homeOf(checkout, tools));
    if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('realpath must return an absolute path');
    return home;
  }

  /** The project's repositories, each with the folder its repository is kept in, for telling whose a folder is. */
  async function knownRepositories(project, location, tools) {
    const known = [{ name: path.basename(await homeOf(location.path, tools)), path: location.path, own: true },
      ...readStoredRepositories({ name: project.name, repositories: location.repositories }).map(entry => ({ name: entry.name, path: entry.path, own: false }))];
    for (const entry of known) {
      try {
        entry.home = await realHomeOf(entry.path, tools);
      } catch (error) {
        // The project's own repository was read just above. A listed folder Git cannot read is no folder's repository.
        if (entry.own) throw error;
        console.warn(`[tasks] listed repository ${entry.name} of ${project.name} could not be read: ${firstLine(error?.stderr || error?.message)}`);
        entry.home = null;
      }
    }
    return known;
  }

  const ADD_WAYS = ['repository', 'path', 'worktreePath'];
  const OWN_CHECKOUT = 'This folder is the checkout its repository is kept in, not a worktree made for this work. Add it as a repository to give the task a copy of it.';
  const usedName = name => new TaskError(`Another repository of this project is already called ${name}.`, 409);

  /** One of the project's repositories, by its name: the task gets a new copy from the checkout the project lists. */
  async function sourceByName(name, project, location, tools) {
    const wrongName = invalid('repository', 'Use the name of one of this project\'s repositories');
    const ownHome = await homeOf(location.path, tools);
    const listed = readStoredRepositories({ name: project.name, repositories: location.repositories }).find(entry => entry.name === name);
    const checkoutPath = name === path.basename(ownHome) ? location.path : listed?.path;
    if (checkoutPath === undefined) throw wrongName;
    return { name, checkoutPath, repositoryPath: checkoutPath === location.path ? null : checkoutPath, existing: null,
      homePath: async () => (checkoutPath === location.path ? ownHome : homeOf(checkoutPath, tools)) };
  }

  /** A repository the project does not list, by the folder it is checked out in: the task gets a new copy from that checkout. */
  async function sourceByFolder(given, project, location, tools) {
    const folder = await inspectFolder(given, 'path', tools);
    const home = await realHomeOf(folder.path, tools);
    const known = await knownRepositories(project, location, tools);
    const listed = known.find(entry => entry.home === home || entry.path === folder.path);
    if (listed) throw new TaskError(`This folder belongs to ${listed.name}, a repository of this project. Add it from the list.`, 409);
    const name = path.basename(home);
    if (!isRepositoryName(name)) throw invalid('path', 'This folder has no usable name');
    if (known.some(entry => entry.name === name)) throw usedName(name);
    return { name, checkoutPath: folder.path, repositoryPath: folder.path, existing: null, homePath: async () => home };
  }

  /**
   * A worktree that already exists, of any repository: it joins the task as it is. Its work lands in the
   * checkout the project lists for its repository, or else in the folder that repository is kept in.
   */
  async function sourceByWorktree(given, project, location, tools) {
    if (typeof listRuns !== 'function') throw new TypeError('listRuns is required to add an existing worktree');
    if (typeof reservedWorktreePaths !== 'function') throw new TypeError('reservedWorktreePaths is required to add an existing worktree');
    if (typeof taskStore.findOpenByWorktreePath !== 'function') throw new TypeError('taskStore.findOpenByWorktreePath is required');
    const folder = await inspectFolder(given, 'worktreePath', tools);
    if (taskStore.findOpenByWorktreePath(folder.path)) throw new TaskError('This worktree already belongs to a task.', 409);
    const home = await realHomeOf(folder.path, tools);
    const known = await knownRepositories(project, location, tools);
    const listed = known.find(entry => entry.home === home) ?? null;
    const checkout = listed ? listed.path : home;
    if (folder.path === checkout || known.some(entry => entry.path === folder.path)) throw new TaskError(OWN_CHECKOUT, 409);
    if (folder.branch === null) throw new TaskError(candidateReasons.detached, 409);
    const runs = listRuns();
    const reserved = reservedWorktreePaths();
    if (!Array.isArray(runs)) throw new Error('Run list is invalid');
    if (!(reserved instanceof Set)) throw new Error('Reserved worktree paths are invalid');
    if (runs.some(run => holdsWorktree(run, folder.path)) || reserved.has(folder.path)) throw new TaskError(candidateReasons.in_use, 409);
    const name = listed ? listed.name : path.basename(home);
    if (!listed) {
      if (!isRepositoryName(name)) throw invalid('worktreePath', 'This folder has no usable name');
      if (known.some(entry => entry.name === name)) throw usedName(name);
    }
    let baseBranch;
    try {
      baseBranch = (await runGit(tools.execFile, ['-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    } catch (error) {
      // Git ran and refused: the repository has no checkout of its own to land in (a bare repository, or one with no commit).
      if (typeof error?.code === 'number') throw new TaskError(candidateReasons.base_unknown, 409, undefined, { cause: error });
      throw error;
    }
    if (!baseBranch) throw new Error(`Git base branch is invalid for ${name}`);
    if (baseBranch === 'HEAD') throw new TaskError(candidateReasons.base_unknown, 409);
    const noBase = 'The worktree branch has no common base with the checkout.';
    let baseCommit;
    try { baseCommit = (await runGit(tools.execFile, ['-C', checkout, 'merge-base', baseBranch, folder.branch])).stdout.trim(); }
    catch (error) { if (error?.code === 1) throw new TaskError(noBase, 409, undefined, { cause: error }); throw error; }
    if (!commitId.test(baseCommit)) throw new TaskError(noBase, 409);
    return { name, checkoutPath: checkout, repositoryPath: listed?.own ? null : checkout,
      existing: { worktreePath: folder.path, branch: folder.branch, baseBranch, baseCommit } };
  }

  /**
   * Gives an open task one more repository, named in one of three ways. `repository`: one of the
   * project's, by name. `path`: a repository the project does not list, by the folder it is checked
   * out in; it joins this task only and the project's list stays as it is. Either gets a worktree
   * beside the task's others, on the task's branch, from that checkout's current commit, with nothing
   * prepared in it. `worktreePath`: a worktree that already exists, taken as it is; Git is only read.
   */
  async function addRepositoryNow(id, body) {
    const task = requireTask(id);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'Use an object with repository, path or worktreePath');
    const unknown = Object.keys(body).filter(field => !ADD_WAYS.includes(field));
    if (unknown.length) throw new TaskError('One or more fields failed validation.', 400, unknown.map(field => ({ field, message: 'Unknown field' })));
    const given = ADD_WAYS.filter(field => Object.hasOwn(body, field));
    if (given.length > 1) throw new TaskError('One or more fields failed validation.', 400, given.map(field => ({ field, message: 'Give one of repository, path and worktreePath' })));
    const way = given[0] ?? 'repository';
    if (way === 'repository' && (typeof body.repository !== 'string' || body.repository.length === 0 || body.repository.includes('/'))) {
      throw invalid('repository', 'Use the name of one of this project\'s repositories');
    }
    if (way === 'path' && !isAbsoluteFolder(body.path)) throw invalid('path', 'Use the absolute path of a folder');
    if (way === 'worktreePath' && !isAbsoluteFolder(body.worktreePath)) throw invalid('worktreePath', 'Use the absolute path of a worktree');
    if (!OPEN_STATES.includes(task.state)) throw new TaskError('This task is finished.', 409);

    const { project, location, tools } = await resolveProject(task.project, task.host);
    const source = way === 'repository' ? await sourceByName(body.repository, project, location, tools)
      : way === 'path' ? await sourceByFolder(body.path, project, location, tools)
        : await sourceByWorktree(body.worktreePath, project, location, tools);
    const { name } = source;
    const had = task.worktrees.find(worktree => worktree.repository === name);
    if (had) {
      throw new TaskError(OPEN_STATES.includes(had.state)
        ? `${name} is already part of this task.`
        : `${name} was already merged or closed in this task and cannot be added again.`, 409);
    }
    // A run that is working may be writing in the task; the repository is added when it pauses or finishes.
    if (isRunWorking(task.id) === true) throw new TaskError('A workflow run is working in this task. Add the repository when it pauses or finishes.', 409);

    if (source.existing !== null) {
      try {
        return taskStore.addWorktree(task.id, { repository: name, repositoryPath: source.repositoryPath, ...source.existing });
      } catch (error) {
        if (taskStore.findOpenByWorktreePath(source.existing.worktreePath)) throw new TaskError('This worktree already belongs to a task.', 409, undefined, { cause: error });
        throw error;
      }
    }

    const { checkoutPath } = source;
    const baseBranch = await checkCheckout(checkoutPath, name, tools);
    const homePath = await source.homePath();
    // Beside the task's other worktrees when it has a folder of its own; else named as its own worktree is.
    const branch = task.branch.startsWith('task/') ? task.branch : `task/${task.id.slice(0, 8)}`;
    const worktreePath = task.folder !== null
      ? path.join(task.folder, name)
      : path.join(path.dirname(homePath), 'worktrees', `${path.basename(homePath)}-${branch.slice('task/'.length)}`);
    if (await onDisk(worktreePath, tools)) throw new TaskError(`A folder for ${name} in this task already exists.`, 409);

    // Recorded before Git is asked, at the commit the repository is on now.
    const baseCommit = await headOf(checkoutPath, tools);
    const recorded = taskStore.addWorktree(task.id, { repository: name, repositoryPath: source.repositoryPath, worktreePath, branch, baseBranch, baseCommit });
    try {
      await createWorktree({ homePath, worktreePath, branch, baseCommit, execFile: tools.execFile, mkdir: tools.mkdir });
    } catch (error) {
      // No folder was made: the repository never became part of the task.
      if (!(await onDisk(worktreePath, tools))) taskStore.removeWorktree(task.id, recorded.worktrees.find(worktree => worktree.worktreePath === worktreePath).id);
      throw new TaskError(`The copy of ${name} could not be created: ${gitReason(error?.message).replace(/\.$/, '')}.`, 409, undefined, { cause: error });
    }
    return recorded;
  }

  // Git refuses concurrent `worktree add` in one repository, so creations run one at a time.
  let queue = Promise.resolve();
  return {
    plan,
    async listWorktreeCandidates(projectName, options = {}) {
      return (await candidateRecords(projectName, options?.host)).map(({ repositoryPath, checkout, baseBranch, ...publicCandidate }) => publicCandidate);
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
    /** A task made by hand: its title is the owner's. Runs auto-sync on target host unless skipped. */
    create(input) {
      const run = queue.then(async () => {
        const planned = await plan({ ...input, titleSource: 'owner' });
        if (resolveHostTools && !input?.skipSync) {
          const { project, host, tools } = await resolveProject(planned.project, planned.host);
          if (project.autoSync !== false) {
            const repoPaths = planned.worktrees.map(w => ({ repository: w.repository, repoPath: w.checkoutPath }));
            const outcome = await syncLocation({
              project,
              host,
              repoPaths,
              runner: tools.runner,
              resolveRunner: h => resolveHostTools?.(h)?.runner ?? null,
            });
            if (!outcome.ok) {
              throw new TaskError(outcome.message, outcome.status, undefined, {
                extra: { code: outcome.code, host: outcome.host, results: outcome.results },
              });
            }
          }
        }
        return createPlannedNow(planned);
      });
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
      const tools = toolsFor(task.host);
      const exists = await tools.pathExists(worktree.worktreePath);
      if (typeof exists !== 'boolean') throw new Error('pathExists must return a boolean');
      if (!exists) throw new TaskError("This task's files are no longer on disk.", 409);
      let started;
      try {
        const startOpts = task.host && task.host !== LOCAL_HOST
          ? { cwd: worktree.worktreePath, host: task.host, skipSync: true }
          : { cwd: worktree.worktreePath };
        started = await startSession(task.project, startOpts);
        if (typeof started?.id !== 'string' || started.id.length === 0) throw new Error('Terminal session ID is invalid');
      } catch (error) {
        throw new TaskError('The terminal could not be opened.', error?.status === 503 ? 503 : 500, undefined, { cause: error });
      }
      return { sessionId: started.id, taskId: task.id, project: task.project, host: task.host ?? LOCAL_HOST, worktreeId: worktree.id };
    },
  };
}
