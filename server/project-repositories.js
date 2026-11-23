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
import { getProjectLocation, LOCAL_HOST, normalizeHostName, normalizeProject, removeManifestRepo, upsertManifestRepo, upsertProjectLocation } from './project-config.js';
import { detectGitOriginUrl, syncProjectLocation } from './git-sync-service.js';

export const MAX_OTHER_REPOSITORIES = 8;
const PATH_MAX = 1024;
const NOT_A_REPOSITORY = { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' };
// The folder that holds worktrees beside the repositories is never one of them.
const WORKTREES_FOLDER = 'worktrees';
const BRANCH_REF = 'ref: refs/heads/';
// A branch name as Git writes it in HEAD: no spaces, control characters or the characters Git forbids in a ref.
const BRANCH_NAME = /^[^\s~^:?*[\\\x00-\x1f\x7f]{1,255}$/;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class RepositoryError extends Error {
  constructor(message, status, errors, options) {
    super(message, options);
    this.status = status;
    this.errors = errors;
    if (options?.extra) this.extra = options.extra;
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
  readFile = target => fs.promises.readFile(target, 'utf8'),
  resolveHostTools = null,
  syncLocation = syncProjectLocation,
} = {}) {
  for (const [name, value] of Object.entries({ loadProjects, saveProjects, execFile, startSession, realpath, readdir, stat, readFile })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  function toolsFor(hostName) {
    const normalized = normalizeHostName(hostName);
    if (typeof resolveHostTools === 'function') {
      try {
        const t = resolveHostTools(normalized);
        return {
          host: t.host,
          runner: t.runner,
          execFile: t.execFile,
          realpath: t.realpath,
          readdir: (target, options) => t.fs.readdir(target, options),
          stat: target => t.fs.stat(target),
          readFile: target => t.fs.readFile(target, 'utf8'),
        };
      } catch (err) {
        throw new RepositoryError(err.message || 'Host unavailable', err.status || 503, undefined, { cause: err });
      }
    }
    return { host: LOCAL_HOST, runner: null, execFile, realpath, readdir, stat, readFile };
  }

  function findProject(projectName, requestedHost) {
    const raw = loadProjects().find(candidate => candidate.name === projectName);
    if (!raw) throw new RepositoryError('Project not found', 404);
    if (typeof raw.path !== 'string' || !path.isAbsolute(raw.path)) throw new Error(`Stored project ${raw.name} has no absolute path`);
    if (raw.host !== undefined && raw.host !== null && typeof raw.host !== 'string') throw new Error(`Stored project ${raw.name} host is invalid`);
    if (!resolveHostTools && raw.host && raw.host !== 'local') throw new RepositoryError('Repositories are only available for local projects.', 409);
    const project = normalizeProject(raw);
    const host = requestedHost ? normalizeHostName(requestedHost) : project.defaultHost;
    const location = getProjectLocation(project, host);
    if (!location) throw new RepositoryError(`Project "${project.name}" has no location on host "${host}".`, 404);
    return {
      project,
      host: location.host,
      location,
      tools: toolsFor(location.host),
      others: readStoredRepositories({ name: project.name, repositories: location.repositories }),
    };
  }

  /** How a checkout stands in Git now. A folder Git cannot use is reported, not thrown. */
  async function inspect(checkout, tools) {
    const t = tools ?? toolsFor(LOCAL_HOST);
    const check = await preflight({
      projectPath: checkout,
      projectHost: t.host,
      allowRemote: Boolean(resolveHostTools),
      setupAgentId: undefined,
      execFile: t.execFile,
      realpath: t.realpath,
    });
    if (!Array.isArray(check?.reasons)) throw new Error('Git preflight reasons are invalid');
    const usable = !check.reasons.some(reason => reason?.code === 'not_git_toplevel' || reason?.code === 'host_unreachable');
    if (usable && (typeof check.head !== 'string' || typeof check.dirty !== 'boolean' || (check.branch !== null && typeof check.branch !== 'string'))) {
      throw new Error('Git preflight result is invalid');
    }
    return usable
      ? { branch: check.branch, head: check.head, dirty: check.dirty, usable: true, reason: null }
      : { branch: null, head: null, dirty: null, usable: false, reason: NOT_A_REPOSITORY };
  }

  /** The folder of the repository a checkout belongs to: the checkout itself, or the repository a worktree was made from. */
  async function homeOf(checkout, tools) {
    const t = tools ?? toolsFor(LOCAL_HOST);
    return t.realpath(await resolveHomeRepoPath({ projectPath: checkout, execFile: t.execFile }));
  }

  /** The project's own repository must be usable before others can be listed beside it. */
  async function requireOwnHome(location, tools) {
    if (!(await inspect(location.path, tools)).usable) throw new RepositoryError('This project\'s folder is not the top level of a Git working tree.', 409);
    return homeOf(location.path, tools);
  }

  async function list(projectName, options = {}) {
    const { project, location, tools, others } = findProject(projectName, options?.host);
    const rest = await Promise.all(others.map(async entry => ({ name: entry.name, path: entry.path, own: false, ...(await inspect(entry.path, tools)) })));
    if (project.workspaceMode === 'folder') {
      return rest;
    }
    const ownState = await inspect(location.path, tools);
    const ownName = path.basename(ownState.usable ? await homeOf(location.path, tools) : location.path);
    const own = { name: ownName, path: location.path, own: true, ...ownState };
    return [own, ...rest];
  }

  async function readHead(folder, tools) {
    const t = tools ?? toolsFor(LOCAL_HOST);
    let text;
    try { text = await t.readFile(path.join(folder, '.git', 'HEAD')); }
    catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') return null;
      throw error;
    }
    if (typeof text !== 'string') throw new Error('readFile must return text');
    const line = text.trim();
    if (COMMIT_ID.test(line)) return { branch: null };
    const branch = line.startsWith(BRANCH_REF) ? line.slice(BRANCH_REF.length) : '';
    return BRANCH_NAME.test(branch) ? { branch } : null;
  }

  async function candidates(projectName, options = {}) {
    const { project, location, tools, others } = findProject(projectName, options?.host);
    const listed = new Set();
    let parent;
    if (project.workspaceMode === 'folder') {
      parent = await tools.realpath(location.path);
    } else {
      const ownHome = await requireOwnHome(location, tools);
      listed.add(ownHome);
      parent = path.dirname(ownHome);
    }
    for (const entry of others) {
      if ((await inspect(entry.path, tools)).usable) listed.add(await homeOf(entry.path, tools));
    }
    const found = [];
    for (const entry of await tools.readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === WORKTREES_FOLDER || !isRepositoryName(entry.name)) continue;
      const folder = path.join(parent, entry.name);
      if (listed.has(folder)) continue;
      let marker;
      try { marker = await tools.stat(path.join(folder, '.git')); }
      catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
        throw error;
      }
      if (!marker.isDirectory()) continue;
      const head = await readHead(folder, tools);
      if (head !== null) found.push({ name: entry.name, path: folder, branch: head.branch });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function addNow(projectName, body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'Use an object with path' }]);
    const unknown = Object.keys(body).filter(field => field !== 'path' && field !== 'host');
    if (unknown.length) throw invalid(unknown.map(field => ({ field, message: 'Unknown field' })));
    const { project, host, location, tools, others } = findProject(projectName, body.host);
    if (!isAbsolutePath(body.path)) throw invalidPath('Use the absolute path of a folder');
    const isFolderWorkspace = project.workspaceMode === 'folder';
    const ownHome = isFolderWorkspace ? null : await requireOwnHome(location, tools);

    let folder;
    try { folder = await tools.stat(body.path); }
    catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'ENAMETOOLONG') throw invalidPath('This folder does not exist');
      throw error;
    }
    if (!folder.isDirectory()) throw invalidPath('This is not a folder');
    const checkout = await tools.realpath(body.path);
    const state = await inspect(checkout, tools);
    if (!state.usable) throw invalidPath('This folder is not the top level of a Git working tree');

    const home = await homeOf(checkout, tools);
    const listedHomes = ownHome ? [ownHome] : [];
    for (const entry of others) {
      if ((await inspect(entry.path, tools)).usable) listedHomes.push(await homeOf(entry.path, tools));
    }
    if (listedHomes.includes(home) || others.some(entry => entry.path === checkout)) throw new RepositoryError('This repository is already part of the project.', 409);
    const name = path.basename(home);
    if (!isRepositoryName(name)) throw invalidPath('This folder has no usable name');
    if ((ownHome && name === path.basename(ownHome)) || others.some(entry => entry.name === name)) throw new RepositoryError(`Another repository of this project is already called ${name}.`, 409);
    if (others.length >= MAX_OTHER_REPOSITORIES) throw new RepositoryError(`A project can list at most ${MAX_OTHER_REPOSITORIES} other repositories.`, 409);

    let detectedGitUrl = null;
    try {
      detectedGitUrl = await detectGitOriginUrl({ repoPath: checkout, execFile: tools.execFile });
    } catch {
      detectedGitUrl = null;
    }

    const projects = loadProjects();
    const index = projects.findIndex(candidate => candidate.name === projectName);
    if (index === -1) throw new RepositoryError('Project not found', 404);
    const norm = normalizeProject(projects[index]);
    const loc = getProjectLocation(norm, host);
    const current = readStoredRepositories({ name: norm.name, repositories: loc.repositories });
    const nextRepos = [...current, { name, path: checkout }];
    let updated = upsertProjectLocation(norm, { ...loc, repositories: nextRepos });
    updated = upsertManifestRepo(updated, { name, gitUrl: detectedGitUrl, primary: false });
    projects[index] = updated;
    readStoredRepositories(projects[index]);
    saveProjects(projects);
    return { name, path: checkout, own: false, ...state };
  }

  async function openTerminal(projectName, body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid([{ field: 'body', message: 'Use an object with repository' }]);
    const unknown = Object.keys(body).filter(field => !['repository', 'host', 'skipSync'].includes(field));
    if (unknown.length) throw invalid(unknown.map(field => ({ field, message: 'Unknown field' })));
    const { project, host, location, tools, others } = findProject(projectName, body.host);
    const wrongName = invalid([{ field: 'repository', message: 'Use the name of one of this project\'s repositories' }]);
    if (!isRepositoryName(body.repository)) throw wrongName;
    let checkout;
    let state;
    if (project.workspaceMode === 'folder') {
      checkout = others.find(entry => entry.name === body.repository)?.path;
      if (checkout === undefined) throw wrongName;
      state = await inspect(checkout, tools);
    } else {
      const ownState = await inspect(location.path, tools);
      const ownName = path.basename(ownState.usable ? await homeOf(location.path, tools) : location.path);
      checkout = body.repository === ownName ? location.path : others.find(entry => entry.name === body.repository)?.path;
      if (checkout === undefined) throw wrongName;
      state = checkout === location.path ? ownState : await inspect(checkout, tools);
    }
    if (!state.usable) throw new RepositoryError(`${body.repository}: ${state.reason.message}`, 409);

    let syncOutcome = null;
    if (resolveHostTools && project.autoSync !== false && !body.skipSync) {
      const outcome = await syncLocation({
        project,
        host,
        repoPaths: [{ repository: body.repository, repoPath: checkout }],
        runner: tools.runner,
        resolveRunner: h => resolveHostTools?.(h)?.runner ?? null,
      });
      if (!outcome.ok) {
        throw new RepositoryError(outcome.message, outcome.status, undefined, {
          extra: { code: outcome.code, host: outcome.host, results: outcome.results },
        });
      }
      syncOutcome = outcome;
    }

    let started;
    try {
      const startOpts = host !== LOCAL_HOST
        ? { cwd: checkout, host, skipSync: true }
        : { cwd: checkout };
      started = await startSession(project.name, startOpts);
      if (typeof started?.id !== 'string' || started.id.length === 0) throw new Error('Terminal session ID is invalid');
    } catch (error) {
      throw new RepositoryError('The terminal could not be opened.', error?.status === 503 ? 503 : 500, undefined, { cause: error });
    }
    return {
      sessionId: started.id,
      project: project.name,
      host,
      repository: body.repository,
      path: checkout,
      ...(syncOutcome ? { sync: syncOutcome } : {}),
    };
  }

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
    async remove(projectName, repositoryName, options = {}) {
      const { host } = findProject(projectName, options?.host);
      const projects = loadProjects();
      const index = projects.findIndex(candidate => candidate.name === projectName);
      const norm = normalizeProject(projects[index]);
      const loc = getProjectLocation(norm, host);
      const current = readStoredRepositories({ name: norm.name, repositories: loc.repositories });
      if (!current.some(entry => entry.name === repositoryName)) throw new RepositoryError('Repository not found', 404);
      let updated = upsertProjectLocation(norm, { ...loc, repositories: current.filter(entry => entry.name !== repositoryName) });
      const stillReferenced = updated.locations.some(
        locationEntry => (locationEntry.repositories ?? []).some(entry => entry.name === repositoryName)
      );
      if (!stillReferenced) {
        updated = removeManifestRepo(updated, repositoryName);
      }
      projects[index] = updated;
      saveProjects(projects);
    },
  };
}
