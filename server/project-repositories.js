/**
 * The repositories of a project. A project's path is its own repository; the others are
 * listed on the project in CodeDeck's configuration. The grouping exists only there: no
 * repository is moved or changed to belong to a project.
 *
 * An entry's path is the checkout that tasks start from and merge into. It may be a worktree
 * that holds the repository's main branch; the entry is named after the repository's own folder.
 */

import path from 'node:path';
import fs from 'node:fs';
import { preflight, resolveHomeRepoPath } from './pipelines/run-worktree.js';
import { isRepositoryName } from './tasks/task-store.js';

export const MAX_OTHER_REPOSITORIES = 8;
const PATH_MAX = 1024;
const NOT_A_REPOSITORY = { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' };
// The folder that holds worktrees beside the repositories is never one of them.
const WORKTREES_FOLDER = 'worktrees';

export class RepositoryError extends Error {
  constructor(message, status, errors, options) {
    super(message, options);
    this.status = status;
    this.errors = errors;
  }
}

const invalid = errors => new RepositoryError('One or more fields failed validation.', 400, errors);
const invalidPath = message => invalid([{ field: 'path', message }]);

function isAbsolutePath(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= PATH_MAX && path.isAbsolute(value) && !value.includes('\0');
}

/** The other repositories stored on a project, each field checked. Throws when the stored list cannot be trusted. */
export function readStoredRepositories(project) {
  const fail = message => { throw new Error(`Stored project ${project?.name} ${message}`); };
  if (!Array.isArray(project?.repositories)) fail('repositories must be a list');
  if (project.repositories.length > MAX_OTHER_REPOSITORIES) fail(`repositories must hold at most ${MAX_OTHER_REPOSITORIES} entries`);
  const names = new Set();
  const paths = new Set();
  return project.repositories.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) fail(`repository ${index} must be an object`);
    for (const field of Object.keys(entry)) {
      if (field !== 'name' && field !== 'path') fail(`repository ${index} field ${field} is not known`);
    }
    if (!isRepositoryName(entry.name)) fail(`repository ${index} field name must be a folder name`);
    if (!isAbsolutePath(entry.path)) fail(`repository ${index} field path must be an absolute path`);
    if (names.has(entry.name)) fail(`repository ${index} field name is used twice`);
    if (paths.has(entry.path)) fail(`repository ${index} field path is used twice`);
    names.add(entry.name);
    paths.add(entry.path);
    return { name: entry.name, path: entry.path };
  });
}

export function createProjectRepositories({
  loadProjects,
  saveProjects,
  execFile,
  startSession,
  realpath = target => fs.promises.realpath(target),
  readdir = (target, options) => fs.promises.readdir(target, options),
  stat = target => fs.promises.stat(target),
} = {}) {
  for (const [name, value] of Object.entries({ loadProjects, saveProjects, execFile, startSession, realpath, readdir, stat })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  function findProject(projectName) {
    const project = loadProjects().find(candidate => candidate.name === projectName);
    if (!project) throw new RepositoryError('Project not found', 404);
    if (typeof project.path !== 'string' || !path.isAbsolute(project.path)) throw new Error(`Stored project ${project.name} has no absolute path`);
    if (project.host !== undefined && project.host !== null && typeof project.host !== 'string') throw new Error(`Stored project ${project.name} host is invalid`);
    if (project.host && project.host !== 'local') throw new RepositoryError('Repositories are only available for local projects.', 409);
    return { project, others: readStoredRepositories(project) };
  }

  /** How a checkout stands in Git now. A folder Git cannot use is reported, not thrown. */
  async function inspect(checkout) {
    const check = await preflight({ projectPath: checkout, projectHost: undefined, setupAgentId: undefined, execFile, realpath });
    if (!Array.isArray(check?.reasons)) throw new Error('Git preflight reasons are invalid');
    const usable = !check.reasons.some(reason => reason?.code === 'not_git_toplevel');
    if (usable && (typeof check.head !== 'string' || typeof check.dirty !== 'boolean' || (check.branch !== null && typeof check.branch !== 'string'))) {
      throw new Error('Git preflight result is invalid');
    }
    return usable
      ? { branch: check.branch, head: check.head, dirty: check.dirty, usable: true, reason: null }
      : { branch: null, head: null, dirty: null, usable: false, reason: NOT_A_REPOSITORY };
  }

  /** The folder of the repository a checkout belongs to: the checkout itself, or the repository a worktree was made from. */
  async function homeOf(checkout) {
    return realpath(await resolveHomeRepoPath({ projectPath: checkout, execFile }));
  }

  /** The project's own repository must be usable before others can be listed beside it. */
  async function requireOwnHome(project) {
    if (!(await inspect(project.path)).usable) throw new RepositoryError('This project\'s folder is not the top level of a Git working tree.', 409);
    return homeOf(project.path);
  }

  async function list(projectName) {
    const { project, others } = findProject(projectName);
    const ownState = await inspect(project.path);
    const ownName = path.basename(ownState.usable ? await homeOf(project.path) : project.path);
    const own = { name: ownName, path: project.path, own: true, ...ownState };
    const rest = await Promise.all(others.map(async entry => ({ name: entry.name, path: entry.path, own: false, ...(await inspect(entry.path)) })));
    return [own, ...rest];
  }

  async function candidates(projectName) {
    const { project, others } = findProject(projectName);
    const ownHome = await requireOwnHome(project);
    const listed = new Set([ownHome]);
    for (const entry of others) {
      // A listed checkout Git can no longer read hides nothing.
      if ((await inspect(entry.path)).usable) listed.add(await homeOf(entry.path));
    }
    const parent = path.dirname(ownHome);
    const found = [];
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === WORKTREES_FOLDER || !isRepositoryName(entry.name)) continue;
      const folder = path.join(parent, entry.name);
      if (listed.has(folder)) continue;
      // A repository's own folder has a `.git` directory; a worktree or a plain folder has none.
      let marker;
      try { marker = await stat(path.join(folder, '.git')); }
      catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
        throw error;
      }
      if (marker.isDirectory()) found.push({ name: entry.name, path: folder });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function addNow(projectName, body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'Use an object with path' }]);
    const unknown = Object.keys(body).filter(field => field !== 'path');
    if (unknown.length) throw invalid(unknown.map(field => ({ field, message: 'Unknown field' })));
    const { project, others } = findProject(projectName);
    if (!isAbsolutePath(body.path)) throw invalidPath('Use the absolute path of a folder');
    const ownHome = await requireOwnHome(project);

    let folder;
    try { folder = await stat(body.path); }
    catch (error) {
      // A name too long for the file system names nothing that exists.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'ENAMETOOLONG') throw invalidPath('This folder does not exist');
      throw error;
    }
    if (!folder.isDirectory()) throw invalidPath('This is not a folder');
    const checkout = await realpath(body.path);
    const state = await inspect(checkout);
    if (!state.usable) throw invalidPath('This folder is not the top level of a Git working tree');

    const home = await homeOf(checkout);
    const listedHomes = [ownHome];
    for (const entry of others) {
      if ((await inspect(entry.path)).usable) listedHomes.push(await homeOf(entry.path));
    }
    if (listedHomes.includes(home) || others.some(entry => entry.path === checkout)) throw new RepositoryError('This repository is already part of the project.', 409);
    const name = path.basename(home);
    if (!isRepositoryName(name)) throw invalidPath('This folder has no usable name');
    if (name === path.basename(ownHome) || others.some(entry => entry.name === name)) throw new RepositoryError(`Another repository of this project is already called ${name}.`, 409);
    if (others.length >= MAX_OTHER_REPOSITORIES) throw new RepositoryError(`A project can list at most ${MAX_OTHER_REPOSITORIES} other repositories.`, 409);

    // Read and written with nothing awaited in between, so no other change to the projects is lost.
    const projects = loadProjects();
    const index = projects.findIndex(candidate => candidate.name === projectName);
    if (index === -1) throw new RepositoryError('Project not found', 404);
    const current = readStoredRepositories(projects[index]);
    projects[index] = { ...projects[index], repositories: [...current, { name, path: checkout }] };
    readStoredRepositories(projects[index]);
    saveProjects(projects);
    return { name, path: checkout, own: false, ...state };
  }

  /**
   * Opens a terminal in the own checkout of one of the project's repositories, so that every
   * repository of a project is reached from the project itself.
   */
  async function openTerminal(projectName, body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'Use an object with repository' }]);
    const unknown = Object.keys(body).filter(field => field !== 'repository');
    if (unknown.length) throw invalid(unknown.map(field => ({ field, message: 'Unknown field' })));
    const { project, others } = findProject(projectName);
    const wrongName = invalid([{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]);
    if (!isRepositoryName(body.repository)) throw wrongName;
    const ownState = await inspect(project.path);
    const ownName = path.basename(ownState.usable ? await homeOf(project.path) : project.path);
    const checkout = body.repository === ownName ? project.path : others.find(entry => entry.name === body.repository)?.path;
    if (checkout === undefined) throw wrongName;
    const state = checkout === project.path ? ownState : await inspect(checkout);
    if (!state.usable) throw new RepositoryError(`${body.repository}: ${state.reason.message}`, 409);
    let started;
    try {
      started = await startSession(project.name, { cwd: checkout });
      if (typeof started?.id !== 'string' || started.id.length === 0) throw new Error('Terminal session ID is invalid');
    } catch (error) {
      throw new RepositoryError('The terminal could not be opened.', error?.status === 503 ? 503 : 500, undefined, { cause: error });
    }
    return { sessionId: started.id, project: project.name, repository: body.repository, path: checkout };
  }

  // Additions check Git before they store, so they run one at a time: the same repository asked for twice is stored once.
  let queue = Promise.resolve();

  return {
    list,
    candidates,
    openTerminal,
    add(projectName, body) {
      const run = queue.then(() => addNow(projectName, body));
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
    async remove(projectName, repositoryName) {
      findProject(projectName);
      const projects = loadProjects();
      const index = projects.findIndex(candidate => candidate.name === projectName);
      const current = readStoredRepositories(projects[index]);
      if (!current.some(entry => entry.name === repositoryName)) throw new RepositoryError('Repository not found', 404);
      projects[index] = { ...projects[index], repositories: current.filter(entry => entry.name !== repositoryName) };
      saveProjects(projects);
    },
  };
}
