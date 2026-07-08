/**
 * Host CRUD + connection-test routes (Spec §6.1, §7).
 *
 * Thin handlers: validate/mutate via the pure `host-service`, persist through
 * injected `loadHosts`/`saveHosts`/`loadProjects`/`saveProjects`, and — for the
 * test-connection endpoint — probe the host through an injected command runner.
 * Dependency injection keeps the router testable without Express globals or a
 * real SSH transport (same convention as `ws-handler.js`).
 */

import express from 'express';
import {
  addHost,
  updateHost,
  deleteHost,
  rewriteProjectHost,
  listHostsWithLocal,
  findHostByName,
  isReservedHostName,
} from '../host-service.js';
import { createCommandRunner, STATUS_POLL_TIMEOUT_MS } from '../command-runner.js';

function isKnownUnreachable(getReachability, hostName) {
  return getReachability?.(hostName)?.reachability === 'unreachable';
}

function hostUnreachableBody(hostName, getReachability) {
  const live = getReachability?.(hostName) ?? {};
  return {
    error: 'host unreachable',
    ...(live.lastError ? { detail: `${hostName}: ${live.lastError}` } : {}),
    host: hostName,
  };
}

export function createHostsRouter(deps = {}) {
  const {
    loadHosts,
    saveHosts,
    loadProjects,
    saveProjects,
    createRunner = createCommandRunner,
    getReachability,
    now = () => Date.now(),
  } = deps;

  // A rename must commit the hosts and projects configs together so the two
  // never drift (Spec §6.1 — the rewrite is atomic). Production injects a
  // single-transaction implementation; the default composes the two writers for
  // callers/tests that don't need real transactional durability.
  const saveHostsAndProjects = deps.saveHostsAndProjects
    || ((hosts, projects) => {
      saveHosts(hosts);
      saveProjects(projects);
    });

  const router = express.Router();

  // List: local first, then stored hosts (with live reachability when wired).
  router.get('/api/hosts', (req, res) => {
    res.json(listHostsWithLocal(loadHosts(), getReachability));
  });

  // Create.
  router.post('/api/hosts', (req, res) => {
    const result = addHost(
      { name: req.body?.name, sshTarget: req.body?.sshTarget },
      loadHosts()
    );
    if (result.error) return res.status(result.status).json({ error: result.error });
    saveHosts(result.data.hosts);
    res.status(201).json(result.data.host);
  });

  // Rename and/or change sshTarget. A rename rewrites referencing projects in
  // the same operation so hosts and projects never drift apart.
  router.put('/api/hosts/:name', (req, res) => {
    const result = updateHost(
      req.params.name,
      { name: req.body?.name, sshTarget: req.body?.sshTarget },
      loadHosts()
    );
    if (result.error) return res.status(result.status).json({ error: result.error });

    if (result.data.previousName !== result.data.host.name) {
      // Rename: rewrite referencing projects and commit both configs atomically.
      const nextProjects = rewriteProjectHost(
        loadProjects(), result.data.previousName, result.data.host.name
      );
      saveHostsAndProjects(result.data.hosts, nextProjects);
    } else {
      saveHosts(result.data.hosts);
    }
    res.json(result.data.host);
  });

  // Delete (blocked while referenced by a project).
  router.delete('/api/hosts/:name', (req, res) => {
    const result = deleteHost(req.params.name, loadHosts(), loadProjects());
    if (result.error) return res.status(result.status).json({ error: result.error });
    saveHosts(result.data.hosts);
    res.json({ ok: true });
  });

  // Test connection: ssh reachability + remote tmux presence. Always 200 — the
  // payload carries the truth (Spec §7).
  router.post('/api/hosts/:name/test', async (req, res) => {
    const name = req.params.name;
    if (isReservedHostName(name)) {
      return res.status(400).json({ error: 'the local host is built-in and cannot be tested' });
    }
    const host = findHostByName(loadHosts(), name);
    if (!host) return res.status(404).json({ error: 'host not found' });
    if (isKnownUnreachable(getReachability, host.name)) {
      return res.status(503).json(hostUnreachableBody(host.name, getReachability));
    }

    const runner = createRunner(host);
    const start = now();
    let sshOk = false;
    let sshDetail = null;
    let tmuxOk = false;
    let tmuxDetail = null;

    try {
      await runner.run('true', [], { timeout: STATUS_POLL_TIMEOUT_MS });
      sshOk = true;
    } catch (err) {
      sshDetail = err?.message || 'ssh connection failed';
    }

    if (sshOk) {
      try {
        await runner.run('tmux', ['-V'], { timeout: STATUS_POLL_TIMEOUT_MS });
        tmuxOk = true;
      } catch {
        tmuxDetail = `tmux not found on ${host.name} — install tmux to enable durable terminals`;
      }
    }

    res.json({ sshOk, sshDetail, tmuxOk, tmuxDetail, latencyMs: now() - start });
  });

  return router;
}
