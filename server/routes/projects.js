/**
 * Project CRUD routes, extracted from index.js (past the ~400-line rule) and
 * made host-aware (Spec §4, §6.2).
 *
 * A project may reference a remote host by name. `path` is interpreted on the
 * project's host filesystem: existence validation runs through that host's
 * command runner (POSIX `test -d`), and path uniqueness is scoped per host.
 * Local behavior is unchanged from the pre-hosts implementation.
 */

import express from 'express';
import { existsSync } from 'fs';
import { normalizeProjects } from '../project-config.js';
import { findHostByName } from '../host-service.js';
import {
  createCommandRunner,
  isTransportFailure,
  STATUS_POLL_TIMEOUT_MS,
} from '../command-runner.js';

const LOCAL_HOST = 'local';

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

function normalizeHostName(host) {
  const trimmed = typeof host === 'string' ? host.trim() : '';
  return trimmed === '' ? LOCAL_HOST : trimmed;
}

function projectHostName(project) {
  return normalizeHostName(project?.host);
}

export function createProjectsRouter(deps = {}) {
  const {
    loadProjects,
    saveProjects,
    loadHosts,
    localPathExists = existsSync,
    createRunner = createCommandRunner,
    getReachability,
  } = deps;

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

  function sendPathError(res, failure) {
    return res.status(failure.status).json({
      error: failure.error,
      ...(failure.detail ? { detail: failure.detail } : {}),
      ...(failure.host ? { host: failure.host } : {}),
    });
  }

  const router = express.Router();

  router.get('/api/projects', (req, res) => {
    // Every project reports its host, defaulting to local (Spec §6.2), plus
    // live reachability so the sidebar can render host-unreachable as
    // suspended/unknown without waiting for a session row.
    res.json(normalizeProjects(loadProjects()).map(p => {
      const host = projectHostName(p);
      const reachability = getReachability?.(host) ?? (host === LOCAL_HOST ? { reachability: 'reachable' } : {});
      return { ...p, host, ...reachability };
    }));
  });

  router.post('/api/projects', async (req, res) => {
    const { name, path: projectPath } = req.body;
    if (!name || !projectPath) return res.status(400).json({ error: 'name and path required' });

    const hostName = normalizeHostName(req.body.host);

    const projects = normalizeProjects(loadProjects());
    // Path uniqueness is scoped per host (Spec §4): the same path may exist on
    // two different hosts, but not twice on the same host.
    if (projects.find(p => p.path === projectPath && projectHostName(p) === hostName)) {
      return res.status(409).json({ error: 'project already exists' });
    }
    // Project names must be globally unique: session ids are `${name}-N`, so a
    // name shared across hosts would route terminals to the wrong host.
    if (projects.find(p => p.name === name)) {
      return res.status(409).json({ error: 'project name already exists' });
    }

    const pathFailure = await checkPathOnHost(hostName, projectPath);
    if (pathFailure) return sendPathError(res, pathFailure);

    // Absence of the host field means local (Spec §4) — don't store `local`.
    const stored = hostName === LOCAL_HOST
      ? { name, path: projectPath }
      : { name, path: projectPath, host: hostName };
    projects.push(stored);
    saveProjects(projects);
    res.status(201).json({ ...stored, host: hostName });
  });

  router.put('/api/projects/:name', async (req, res) => {
    const projects = normalizeProjects(loadProjects());
    const idx = projects.findIndex(p => p.name === req.params.name);
    if (idx === -1) return res.status(404).json({ error: 'project not found' });

    const existing = projects[idx];
    const { name: newName, path: newPath, shelved, shelvedAt, waiting, waitingAt } = req.body;

    // If name or path is provided, validate and apply them
    if (newName !== undefined || newPath !== undefined) {
      const resolvedName = newName ?? existing.name;
      const resolvedPath = newPath ?? existing.path;
      if (!resolvedName || !resolvedPath) return res.status(400).json({ error: 'name and path required' });

      // Session ids derive from names — renames must stay globally unique.
      if (projects.some((p, i) => i !== idx && p.name === resolvedName)) {
        return res.status(409).json({ error: 'project name already exists' });
      }

      // Path existence is checked on the project's host (Spec §4).
      const pathFailure = await checkPathOnHost(projectHostName(existing), resolvedPath);
      if (pathFailure) return sendPathError(res, pathFailure);

      projects[idx] = { ...existing, name: resolvedName, path: resolvedPath };
    }

    // Apply shelf fields if provided
    if (shelved !== undefined) projects[idx] = { ...projects[idx], shelved };
    if (shelvedAt !== undefined) projects[idx] = { ...projects[idx], shelvedAt };
    if (waiting !== undefined) projects[idx] = { ...projects[idx], waiting };
    if (waitingAt !== undefined) projects[idx] = { ...projects[idx], waitingAt };

    saveProjects(projects);
    res.json(projects[idx]);
  });

  router.delete('/api/projects/:name', (req, res) => {
    const projects = loadProjects();
    saveProjects(projects.filter(p => p.name !== req.params.name));
    res.json({ ok: true });
  });

  return router;
}
