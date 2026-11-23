/**
 * Project CRUD, cross-host locations, auto-clone, and manual Git sync routes.
 *
 * A project is a cross-host entity with one or more `{ host, path, repositories }`
 * locations, an optional `gitUrl`, `defaultHost`, and `autoSync` (default true).
 * Backward-compatible top-level `path` and `host` fields are preserved so
 * existing callers and tests continue to work seamlessly.
 */

import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs, { existsSync } from 'fs';
import {
  LOCAL_HOST,
  normalizeHostName,
  normalizeProject,
  normalizeProjects,
  normalizeRepoManifest,
  getProjectLocation,
  upsertProjectLocation,
  removeProjectLocation,
  upsertManifestRepo,
} from '../project-config.js';
import { createHostFs } from '../host-fs.js';
import { findHostByName } from '../host-service.js';
import {
  createCommandRunner,
  isTransportFailure,
  STATUS_POLL_TIMEOUT_MS,
} from '../command-runner.js';
import {
  cloneToHost,
  detectGitOriginUrl,
  isValidGitUrl,
  repoFolderNameFromGitUrl,
  resolveArtifactSourceRepo,
  syncProjectLocation,
  syncRepoArtifacts,
} from '../git-sync-service.js';

function isKnownUnreachable(getReachability, hostName) {
  return getReachability?.(hostName)?.reachability === 'unreachable';
}

function knownUnreachableFailure(getReachability, hostName) {
  const live = getReachability?.(hostName) ?? {};
  return {
    error: 'host unreachable',
    ...(live.lastError ? { detail: `${hostName}: ${live.lastError}` } : {}),
    status: 503,
    host: hostName,
  };
}

function projectHostName(project) {
  return normalizeHostName(project?.defaultHost || project?.host);
}

function formatProjectResponse(project, getReachability) {
  const normalized = normalizeProject(project);
  const defaultHost = projectHostName(normalized);
  const primaryReachability = getReachability?.(defaultHost)
    ?? (defaultHost === LOCAL_HOST ? { reachability: 'reachable' } : {});
  const locations = normalized.locations.map(loc => {
    const reach = getReachability?.(loc.host)
      ?? (loc.host === LOCAL_HOST ? { reachability: 'reachable' } : {});
    return { ...loc, ...reach };
  });
  return {
    ...normalized,
    host: defaultHost,
    defaultHost,
    locations,
    ...primaryReachability,
  };
}

function pathTakenOnHost(projects, hostName, candidatePath, excludeProjectName = null) {
  const lowerHost = normalizeHostName(hostName).toLowerCase();
  return projects.some(p => {
    if (excludeProjectName && p.name === excludeProjectName) return false;
    const norm = normalizeProject(p);
    return norm.locations.some(
      loc => loc.host.toLowerCase() === lowerHost && loc.path === candidatePath
    );
  });
}

export function createProjectsRouter(deps = {}) {
  const {
    loadProjects,
    saveProjects,
    loadHosts,
    getLocalDefaultRoot = () => null,
    localPathExists = existsSync,
    createRunner = createCommandRunner,
    getReachability,
    deleteProject,
    detectOrigin = detectGitOriginUrl,
    syncLocation = syncProjectLocation,
    cloneRepo = cloneToHost,
    syncArtifacts = syncRepoArtifacts,
  } = deps;

  function runnerForHostName(rawHost) {
    const hostName = normalizeHostName(rawHost);
    if (hostName === LOCAL_HOST) return createRunner(null);
    const hostObj = findHostByName(loadHosts(), hostName);
    return hostObj ? createRunner(hostObj) : null;
  }

  async function syncClonedRepoArtifacts(project, targetHost, repository, targetRepoPath, targetRunner) {
    if (typeof syncArtifacts !== 'function') return [];
    const source = resolveArtifactSourceRepo({ project, targetHost, repository });
    if (!source) return [];
    const sourceRunner = runnerForHostName(source.sourceHost);
    if (!sourceRunner) return [];
    try {
      const res = await syncArtifacts({
        sourceRepoPath: source.sourceRepoPath,
        sourceRunner,
        targetRepoPath,
        targetRunner,
      });
      return res?.synced ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Validate that `projectPath` exists on `hostName`'s filesystem.
   * Returns null on success or `{ error, status, host? }` on failure.
   */
  async function checkPathOnHost(hostName, projectPath) {
    if (hostName === LOCAL_HOST) {
      return localPathExists(projectPath) ? null : { error: 'path does not exist', status: 400 };
    }

    const host = findHostByName(loadHosts(), hostName);
    if (!host) return { error: `unknown host "${hostName}"`, status: 400 };
    if (isKnownUnreachable(getReachability, host.name)) {
      return knownUnreachableFailure(getReachability, host.name);
    }

    try {
      await createRunner(host).run('test', ['-d', projectPath], { timeout: STATUS_POLL_TIMEOUT_MS });
      return null;
    } catch (err) {
      if (isTransportFailure(err)) {
        return {
          error: 'host unreachable',
          detail: `${host.name}: ${err.message}`,
          status: 503,
          host: host.name,
        };
      }
      return { error: 'path does not exist', status: 400 };
    }
  }

  function resolveHostOrError(rawHost) {
    const hostName = normalizeHostName(rawHost);
    if (hostName === LOCAL_HOST) {
      return { hostName: LOCAL_HOST, hostObj: null, runner: createRunner(null) };
    }
    const hostObj = findHostByName(loadHosts(), hostName);
    if (!hostObj) return { error: `unknown host "${hostName}"`, status: 400 };
    if (isKnownUnreachable(getReachability, hostObj.name)) {
      return knownUnreachableFailure(getReachability, hostObj.name);
    }
    return { hostName: hostObj.name, hostObj, runner: createRunner(hostObj) };
  }

  function sendPathError(res, failure) {
    return res.status(failure.status).json({
      error: failure.error,
      ...(failure.detail ? { detail: failure.detail } : {}),
      ...(failure.host ? { host: failure.host } : {}),
    });
  }

  /**
   * Scan direct subdirectories of `folderPath` on `hostName` for Git repositories.
   * Returns `[{ name, path, gitUrl }]` sorted by name; returns `[]` if unreadable.
   */
  async function scanChildGitRepos(folderPath, hostName, runner) {
    const fsApi = hostName === LOCAL_HOST ? fs.promises : createHostFs(runner);
    let entries;
    try {
      entries = await fsApi.readdir(folderPath, { withFileTypes: true });
    } catch {
      return [];
    }
    const found = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'worktrees') continue;
      const childPath = hostName === LOCAL_HOST ? path.join(folderPath, entry.name) : path.posix.join(folderPath, entry.name);
      const gitMarker = hostName === LOCAL_HOST ? path.join(childPath, '.git') : path.posix.join(childPath, '.git');
      try {
        await fsApi.stat(gitMarker);
      } catch {
        continue;
      }
      let gitUrl = null;
      if (typeof detectOrigin === 'function') {
        try {
          gitUrl = await detectOrigin({ repoPath: childPath, runner });
        } catch {
          gitUrl = null;
        }
      }
      found.push({ name: entry.name, path: childPath, gitUrl });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function isGitFolder(folderPath, hostName, runner) {
    const fsApi = hostName === LOCAL_HOST ? fs.promises : createHostFs(runner);
    const gitMarker = hostName === LOCAL_HOST ? path.join(folderPath, '.git') : path.posix.join(folderPath, '.git');
    try {
      await fsApi.stat(gitMarker);
      return true;
    } catch {
      return false;
    }
  }

  const router = express.Router();

  router.get('/api/projects', (req, res) => {
    res.json(normalizeProjects(loadProjects()).map(p => formatProjectResponse(p, getReachability)));
  });

  router.post('/api/projects', async (req, res) => {
    const { name, path: projectPath, gitUrl, autoSync } = req.body;
    if (!name || !projectPath) return res.status(400).json({ error: 'name and path required' });

    if (gitUrl !== undefined && gitUrl !== null && gitUrl !== '' && !isValidGitUrl(gitUrl)) {
      return res.status(400).json({ error: 'invalid gitUrl' });
    }

    const hostName = normalizeHostName(req.body.host);
    const projects = normalizeProjects(loadProjects());

    if (pathTakenOnHost(projects, hostName, projectPath)) {
      return res.status(409).json({ error: 'project already exists' });
    }
    if (projects.find(p => p.name === name)) {
      return res.status(409).json({ error: 'project name already exists' });
    }

    const pathFailure = await checkPathOnHost(hostName, projectPath);
    if (pathFailure) return sendPathError(res, pathFailure);

    const resolved = resolveHostOrError(hostName);
    let resolvedGitUrl = typeof gitUrl === 'string' && gitUrl.trim() ? gitUrl.trim() : null;
    if (!resolvedGitUrl && !resolved.error && typeof detectOrigin === 'function') {
      try {
        resolvedGitUrl = await detectOrigin({ repoPath: projectPath, runner: resolved.runner });
      } catch {
        // Non-git folder or no origin remote — keep gitUrl null.
      }
    }

    let workspaceMode = 'repo';
    let locationRepositories = [];
    let repoManifest = [];

    if (!resolvedGitUrl && !resolved.error && !(await isGitFolder(projectPath, hostName, resolved.runner))) {
      const children = await scanChildGitRepos(projectPath, hostName, resolved.runner);
      if (children.length > 0) {
        workspaceMode = 'folder';
        locationRepositories = children.map(c => ({ name: c.name, path: c.path }));
        repoManifest = children.map((c, idx) => ({ name: c.name, gitUrl: c.gitUrl, primary: idx === 0 }));
      }
    } else if (resolvedGitUrl) {
      repoManifest = [{ name: path.basename(projectPath), gitUrl: resolvedGitUrl, primary: true }];
    }

    const stored = {
      name,
      path: projectPath,
      ...(hostName === LOCAL_HOST ? {} : { host: hostName }),
      ...(resolvedGitUrl ? { gitUrl: resolvedGitUrl } : {}),
      autoSync: autoSync === undefined ? true : Boolean(autoSync),
      defaultHost: hostName,
      workspaceMode,
      repoManifest,
      locations: [{ host: hostName, path: projectPath, repositories: locationRepositories }],
    };
    projects.push(stored);
    saveProjects(projects);
    res.status(201).json(formatProjectResponse(stored, getReachability));
  });

  router.put('/api/projects/:name', async (req, res) => {
    const projects = normalizeProjects(loadProjects());
    const idx = projects.findIndex(p => p.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: 'project not found' });

    const existing = projects[idx];
    const {
      name: newName,
      path: newPath,
      gitUrl,
      autoSync,
      defaultHost,
      repoManifest,
      shelved,
      shelvedAt,
      waiting,
      waitingAt,
    } = req.body;

    if (gitUrl !== undefined && gitUrl !== null && gitUrl !== '' && !isValidGitUrl(gitUrl)) {
      return res.status(400).json({ error: 'invalid gitUrl' });
    }
    if (repoManifest !== undefined) {
      if (!Array.isArray(repoManifest)) return res.status(400).json({ error: 'repoManifest must be an array' });
      for (const entry of repoManifest) {
        if (entry?.gitUrl !== undefined && entry?.gitUrl !== null && entry?.gitUrl !== '' && !isValidGitUrl(entry.gitUrl)) {
          return res.status(400).json({ error: `invalid gitUrl for repository "${entry?.name ?? ''}"` });
        }
      }
    }

    let updated = existing;

    if (newName !== undefined || newPath !== undefined) {
      const resolvedName = newName ?? existing.name;
      const resolvedPath = newPath ?? existing.path;
      if (!resolvedName || !resolvedPath) return res.status(400).json({ error: 'name and path required' });

      if (projects.some((p, i) => i !== idx && p.name === resolvedName)) {
        return res.status(409).json({ error: 'project name already exists' });
      }

      const activeHost = projectHostName(existing);
      const pathFailure = await checkPathOnHost(activeHost, resolvedPath);
      if (pathFailure) return sendPathError(res, pathFailure);

      const currentLoc = getProjectLocation(existing, activeHost);
      updated = upsertProjectLocation(
        { ...existing, name: resolvedName, path: resolvedPath },
        { host: activeHost, path: resolvedPath, repositories: currentLoc?.repositories ?? [] }
      );
    }

    if (gitUrl !== undefined) {
      const nextUrl = typeof gitUrl === 'string' && gitUrl.trim() ? gitUrl.trim() : null;
      updated = { ...updated, gitUrl: nextUrl };
      if (updated.repoManifest.length > 0) {
        const primaryEntry = updated.repoManifest.find(r => r.primary) ?? updated.repoManifest[0];
        if (primaryEntry) {
          updated = upsertManifestRepo(updated, { name: primaryEntry.name, gitUrl: nextUrl, primary: true });
        }
      }
    }
    if (repoManifest !== undefined) {
      const normalizedManifest = normalizeRepoManifest(repoManifest);
      const primaryEntry = normalizedManifest.find(r => r.primary) ?? normalizedManifest[0] ?? null;
      updated = normalizeProject({
        ...updated,
        repoManifest: normalizedManifest,
        ...(primaryEntry ? { gitUrl: primaryEntry.gitUrl } : {}),
      });
    }
    if (autoSync !== undefined) {
      updated = { ...updated, autoSync: Boolean(autoSync) };
    }
    if (defaultHost !== undefined) {
      const targetHost = normalizeHostName(defaultHost);
      const loc = getProjectLocation(updated, targetHost);
      if (!loc) {
        return res.status(400).json({ error: `project has no location configured on host "${targetHost}"` });
      }
      updated = normalizeProject({ ...updated, defaultHost: loc.host });
    }
    if (shelved !== undefined) updated = { ...updated, shelved };
    if (shelvedAt !== undefined) updated = { ...updated, shelvedAt };
    if (waiting !== undefined) updated = { ...updated, waiting };
    if (waitingAt !== undefined) updated = { ...updated, waitingAt };

    projects[idx] = updated;
    saveProjects(projects);
    res.json(formatProjectResponse(projects[idx], getReachability));
  });

  // Discover `origin` remotes for all bound repositories across reachable host locations
  // and persist them into `repoManifest` so existing projects need zero manual URL entry.
  router.post('/api/projects/:name/discover-remotes', async (req, res) => {
    const projects = normalizeProjects(loadProjects());
    const idx = projects.findIndex(p => p.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: 'project not found' });

    const existing = projects[idx];
    let updated = existing;

    for (const loc of existing.locations) {
      const resolved = resolveHostOrError(loc.host);
      if (resolved.error) continue;

      if (existing.workspaceMode !== 'folder') {
        const primaryName = path.basename(loc.path);
        let detected = null;
        if (typeof detectOrigin === 'function') {
          try {
            detected = await detectOrigin({ repoPath: loc.path, runner: resolved.runner });
          } catch {
            detected = null;
          }
        }
        const currentEntry = updated.repoManifest.find(r => r.name.toLowerCase() === primaryName.toLowerCase());
        updated = upsertManifestRepo(updated, {
          name: primaryName,
          gitUrl: detected ?? currentEntry?.gitUrl ?? existing.gitUrl ?? null,
          primary: true,
        });
      }

      for (const repo of loc.repositories ?? []) {
        let detected = null;
        if (typeof detectOrigin === 'function') {
          try {
            detected = await detectOrigin({ repoPath: repo.path, runner: resolved.runner });
          } catch {
            detected = null;
          }
        }
        const currentEntry = updated.repoManifest.find(r => r.name.toLowerCase() === repo.name.toLowerCase());
        updated = upsertManifestRepo(updated, {
          name: repo.name,
          gitUrl: detected ?? currentEntry?.gitUrl ?? null,
          primary: currentEntry ? currentEntry.primary : (existing.workspaceMode === 'folder' && updated.repoManifest.length === 0),
        });
      }
    }

    if (JSON.stringify(updated.repoManifest) !== JSON.stringify(existing.repoManifest) || updated.gitUrl !== existing.gitUrl) {
      projects[idx] = updated;
      saveProjects(projects);
    }
    res.json(formatProjectResponse(updated, getReachability));
  });

  // Bind an existing checkout on another host to this project.
  router.post('/api/projects/:name/locations', async (req, res) => {
    const projects = normalizeProjects(loadProjects());
    const idx = projects.findIndex(p => p.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: 'project not found' });

    const { path: locationPath } = req.body ?? {};
    const hostName = normalizeHostName(req.body?.host);
    if (!locationPath || typeof locationPath !== 'string') {
      return res.status(400).json({ error: 'path required' });
    }

    const existing = projects[idx];
    if (getProjectLocation(existing, hostName)) {
      return res.status(409).json({ error: `project already has a location on host "${hostName}"` });
    }
    if (pathTakenOnHost(projects, hostName, locationPath, existing.name)) {
      return res.status(409).json({ error: 'another project already uses this path on this host' });
    }

    const pathFailure = await checkPathOnHost(hostName, locationPath);
    if (pathFailure) return sendPathError(res, pathFailure);

    let discoveredRepos = [];
    const resolved = resolveHostOrError(hostName);
    if (!resolved.error) {
      if (existing.workspaceMode === 'folder') {
        const children = await scanChildGitRepos(locationPath, hostName, resolved.runner);
        discoveredRepos = children.map(c => ({ name: c.name, path: c.path }));
      } else if (existing.repoManifest.length > 1) {
        const parentDir = hostName === LOCAL_HOST ? path.dirname(locationPath) : path.posix.dirname(locationPath);
        const ownBase = path.basename(locationPath).toLowerCase();
        const manifestNames = new Set(existing.repoManifest.map(r => r.name.toLowerCase()));
        const siblings = await scanChildGitRepos(parentDir, hostName, resolved.runner);
        discoveredRepos = siblings
          .filter(s => s.name.toLowerCase() !== ownBase && manifestNames.has(s.name.toLowerCase()))
          .map(s => ({ name: s.name, path: s.path }));
      }
    }

    const updated = upsertProjectLocation(existing, { host: hostName, path: locationPath, repositories: discoveredRepos });
    projects[idx] = updated;
    saveProjects(projects);
    res.status(201).json(formatProjectResponse(updated, getReachability));
  });

  // Clone the project's `gitUrl` (or multi-repo `repoManifest`) onto a host and register the new location.
  router.post('/api/projects/:name/locations/clone', async (req, res) => {
    const projects = normalizeProjects(loadProjects());
    const idx = projects.findIndex(p => p.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: 'project not found' });

    const existing = projects[idx];
    const hostName = normalizeHostName(req.body?.host);
    if (getProjectLocation(existing, hostName)) {
      return res.status(409).json({ error: `project already has a location on host "${hostName}"` });
    }

    const resolved = resolveHostOrError(hostName);
    if (resolved.error) return sendPathError(res, resolved);

    const requestedRepos = Array.isArray(req.body?.repositories) ? req.body.repositories : null;
    const repoUrls = req.body?.repoUrls && typeof req.body.repoUrls === 'object' ? req.body.repoUrls : {};
    const isMultiRepo = existing.repoManifest.length > 1 || (requestedRepos !== null && existing.repoManifest.length > 0);

    if (isMultiRepo) {
      const selectedSet = requestedRepos ? new Set(requestedRepos.map(n => String(n).toLowerCase())) : null;
      const candidates = selectedSet
        ? existing.repoManifest.filter(r => selectedSet.has(r.name.toLowerCase()))
        : existing.repoManifest;

      const toClone = [];
      const skipped = [];
      for (const entry of candidates) {
        const override = typeof repoUrls[entry.name] === 'string' && repoUrls[entry.name].trim() ? repoUrls[entry.name].trim() : null;
        const url = override ?? entry.gitUrl;
        if (!url || !isValidGitUrl(url)) {
          skipped.push({ name: entry.name, reason: 'no_remote' });
        } else {
          toClone.push({ ...entry, gitUrl: url });
        }
      }

      if (toClone.length === 0) {
        return res.status(400).json({ error: 'no selected repository has a valid gitUrl to clone' });
      }

      let baseDir = typeof req.body?.targetPath === 'string' && req.body.targetPath.trim()
        ? req.body.targetPath.trim()
        : null;
      if (!baseDir) {
        const root = hostName === LOCAL_HOST ? getLocalDefaultRoot() : resolved.hostObj?.defaultRoot;
        if (!root) {
          return res.status(400).json({
            error: `No targetPath provided and host "${hostName}" has no default workspace folder configured.`,
          });
        }
        baseDir = path.posix.join(root, existing.name);
      }

      const clonedEntries = [];
      let totalArtifactsSynced = 0;
      try {
        for (const entry of toClone) {
          const dest = path.posix.join(baseDir, entry.name);
          await cloneRepo({ gitUrl: entry.gitUrl, targetPath: dest, runner: resolved.runner });
          const syncedArtifacts = await syncClonedRepoArtifacts(existing, resolved.hostName, entry.name, dest, resolved.runner);
          totalArtifactsSynced += syncedArtifacts.length;
          clonedEntries.push({ name: entry.name, path: dest, primary: entry.primary, artifactsSynced: syncedArtifacts });
        }
      } catch (err) {
        return res.status(err.status || 500).json({
          error: err.message,
          host: resolved.hostName,
        });
      }

      let newLocation;
      if (existing.workspaceMode === 'folder') {
        newLocation = {
          host: resolved.hostName,
          path: baseDir,
          repositories: clonedEntries.map(e => ({ name: e.name, path: e.path })),
        };
      } else {
        const primaryCloned = clonedEntries.find(e => e.primary) ?? clonedEntries[0];
        const restCloned = clonedEntries.filter(e => e.name !== primaryCloned.name);
        newLocation = {
          host: resolved.hostName,
          path: primaryCloned.path,
          repositories: restCloned.map(e => ({ name: e.name, path: e.path })),
        };
      }

      if (pathTakenOnHost(projects, hostName, newLocation.path, existing.name)) {
        return res.status(409).json({ error: 'another project already uses this path on this host' });
      }

      const updated = upsertProjectLocation(existing, newLocation);
      projects[idx] = updated;
      saveProjects(projects);
      return res.status(201).json({
        ...formatProjectResponse(updated, getReachability),
        cloneSummary: {
          cloned: clonedEntries.map(e => e.name),
          skipped,
          ...(totalArtifactsSynced > 0 ? { artifactsSynced: totalArtifactsSynced } : {}),
        },
      });
    }

    const gitUrl = typeof req.body?.gitUrl === 'string' && req.body.gitUrl.trim()
      ? req.body.gitUrl.trim()
      : existing.gitUrl;

    if (!gitUrl || !isValidGitUrl(gitUrl)) {
      return res.status(400).json({ error: 'a valid gitUrl is required to clone' });
    }

    let targetPath = typeof req.body?.targetPath === 'string' && req.body.targetPath.trim()
      ? req.body.targetPath.trim()
      : null;

    if (!targetPath) {
      const root = hostName === LOCAL_HOST ? getLocalDefaultRoot() : resolved.hostObj?.defaultRoot;
      if (!root) {
        return res.status(400).json({
          error: `No targetPath provided and host "${hostName}" has no default workspace folder configured.`,
        });
      }
      targetPath = path.posix.join(root, repoFolderNameFromGitUrl(gitUrl));
    }

    if (pathTakenOnHost(projects, hostName, targetPath, existing.name)) {
      return res.status(409).json({ error: 'another project already uses this path on this host' });
    }

    try {
      await cloneRepo({ gitUrl, targetPath, runner: resolved.runner });
    } catch (err) {
      return res.status(err.status || 500).json({
        error: err.message,
        host: resolved.hostName,
      });
    }

    const syncedArtifacts = await syncClonedRepoArtifacts(existing, resolved.hostName, path.basename(targetPath), targetPath, resolved.runner);
    const withUrl = existing.gitUrl ? existing : { ...existing, gitUrl };
    const updated = upsertProjectLocation(withUrl, { host: resolved.hostName, path: targetPath, repositories: [] });
    projects[idx] = updated;
    saveProjects(projects);
    res.status(201).json({
      ...formatProjectResponse(updated, getReachability),
      ...(syncedArtifacts.length > 0 ? { artifactsSynced: syncedArtifacts.length } : {}),
    });
  });

  // Clone missing manifest repositories onto an already-bound host location.
  router.post('/api/projects/:name/locations/:host/clone-missing', async (req, res) => {
    const projects = normalizeProjects(loadProjects());
    const idx = projects.findIndex(p => p.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: 'project not found' });

    const existing = projects[idx];
    const hostName = normalizeHostName(req.params.host);
    const location = getProjectLocation(existing, hostName);
    if (!location) {
      return res.status(404).json({ error: `location on host "${hostName}" not found` });
    }

    const resolved = resolveHostOrError(hostName);
    if (resolved.error) return sendPathError(res, resolved);

    const boundNames = new Set((location.repositories ?? []).map(r => r.name.toLowerCase()));
    if (existing.workspaceMode !== 'folder') {
      boundNames.add(path.basename(location.path).toLowerCase());
    }

    const requestedRepos = Array.isArray(req.body?.repositories)
      ? new Set(req.body.repositories.map(n => String(n).toLowerCase()))
      : null;

    const missing = existing.repoManifest.filter(r => {
      const key = r.name.toLowerCase();
      if (boundNames.has(key)) return false;
      if (requestedRepos && !requestedRepos.has(key)) return false;
      return true;
    });

    const baseDir = existing.workspaceMode === 'folder'
      ? location.path
      : path.posix.dirname(location.path);

    const clonedEntries = [];
    const skipped = [];
    let totalArtifactsSynced = 0;
    try {
      for (const entry of missing) {
        if (!entry.gitUrl || !isValidGitUrl(entry.gitUrl)) {
          skipped.push({ name: entry.name, reason: 'no_remote' });
          continue;
        }
        const dest = path.posix.join(baseDir, entry.name);
        await cloneRepo({ gitUrl: entry.gitUrl, targetPath: dest, runner: resolved.runner });
        const syncedArtifacts = await syncClonedRepoArtifacts(existing, resolved.hostName, entry.name, dest, resolved.runner);
        totalArtifactsSynced += syncedArtifacts.length;
        clonedEntries.push({ name: entry.name, path: dest });
      }
    } catch (err) {
      return res.status(err.status || 500).json({
        error: err.message,
        host: resolved.hostName,
      });
    }

    const nextRepos = [...(location.repositories ?? []), ...clonedEntries];
    const updated = upsertProjectLocation(existing, { ...location, repositories: nextRepos });
    projects[idx] = updated;
    saveProjects(projects);
    res.json({
      ...formatProjectResponse(updated, getReachability),
      cloneSummary: {
        cloned: clonedEntries.map(e => e.name),
        skipped,
        ...(totalArtifactsSynced > 0 ? { artifactsSynced: totalArtifactsSynced } : {}),
      },
    });
  });

  // Remove a host location from a project (cannot remove the last remaining location).
  router.delete('/api/projects/:name/locations/:host', (req, res) => {
    const projects = normalizeProjects(loadProjects());
    const idx = projects.findIndex(p => p.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: 'project not found' });

    const existing = projects[idx];
    const targetHost = normalizeHostName(req.params.host);
    if (!getProjectLocation(existing, targetHost)) {
      return res.status(404).json({ error: `location on host "${targetHost}" not found` });
    }
    if (existing.locations.length <= 1) {
      return res.status(409).json({ error: 'cannot remove the last location of a project' });
    }

    const updated = removeProjectLocation(existing, targetHost);
    projects[idx] = updated;
    saveProjects(projects);
    res.json(formatProjectResponse(updated, getReachability));
  });

  // Manually sync a project's checkout(s) on a specific host (`git pull --ff-only`).
  router.post('/api/projects/:name/sync', async (req, res) => {
    const projects = normalizeProjects(loadProjects());
    const project = projects.find(p => p.name === req.params.name);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const hostName = normalizeHostName(req.body?.host || project.defaultHost);
    const location = getProjectLocation(project, hostName);
    if (!location) {
      return res.status(404).json({ error: `project has no location on host "${hostName}"` });
    }

    const resolved = resolveHostOrError(hostName);
    if (resolved.error) return sendPathError(res, resolved);

    const requestedRepos = Array.isArray(req.body?.repositories) ? req.body.repositories : null;
    let repoPaths = null;
    if (requestedRepos && requestedRepos.length > 0) {
      const ownName = path.basename(location.path);
      const map = new Map([[ownName, location.path]]);
      for (const r of location.repositories ?? []) map.set(r.name, r.path);
      repoPaths = requestedRepos
        .filter(name => map.has(name))
        .map(name => ({ repository: name, repoPath: map.get(name) }));
    }

    const outcome = await syncLocation({
      project,
      host: resolved.hostName,
      repoPaths,
      runner: resolved.runner,
      resolveRunner: runnerForHostName,
    });
    return res.status(outcome.status).json(outcome);
  });

  router.delete('/api/projects/:name', async (req, res) => {
    let outcome;
    try { outcome = await deleteProject(req.params.name); }
    catch (error) {
      outcome = { status: isTransportFailure(error) ? 503 : 500, title: 'Project Remove Failed', detail: 'The project could not be removed.' };
    }
    if (outcome.ok) return res.json({ ok: true });
    const { status, title, detail } = outcome;
    const traceId = randomUUID();
    console.warn(`[projects] delete failed project=${req.params.name} status=${status} traceId=${traceId}`);
    res.set('X-Trace-Id', traceId);
    return res.status(status).type('application/problem+json').json({
      type: 'about:blank', title, status, detail, error: title, message: detail,
      timestamp: new Date().toISOString(), path: req.originalUrl.split('?')[0], traceId,
    });
  });

  return router;
}
