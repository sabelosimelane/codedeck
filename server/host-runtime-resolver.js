/**
 * Session → host runtime resolution (Spec §6.2, §6.3).
 *
 * Session ids are `${projectName}-N`; the owning project's `host` field decides
 * which command runner (and therefore which tmux server) every operation for
 * that session must use. Extracted from index.js so the routing decision — the
 * thing that determines whether a session touches the local machine or an SSH
 * host — is unit-testable with injected config loaders.
 */

import { createHostTerminalRuntime } from './terminal-runtime.js';
import { createCommandRunner } from './command-runner.js';
import { findHostByName } from './host-service.js';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createHostRuntimeResolver({
  loadProjects,
  loadHosts,
  createRuntime = (host) => createHostTerminalRuntime(createCommandRunner(host), host.name),
  getReachability = null,
} = {}) {
  // One runtime per host descriptor, so every session on a host shares the
  // multiplexed ControlMaster connection. Keyed by name AND target: editing a
  // host's sshTarget makes new resolutions build a fresh runtime immediately.
  const cache = new Map();

  function getHostRuntime(host) {
    const key = `${host.name}::${host.sshTarget}`;
    let runtime = cache.get(key);
    if (!runtime) {
      runtime = createRuntime(host);
      cache.set(key, runtime);
    }
    return runtime;
  }

  /** Find the project owning a `${projectName}-N` session id. */
  function findSessionProject(sessionId) {
    return loadProjects().find(project =>
      new RegExp(`^${escapeRegExp(project.name)}-\\d+$`).test(sessionId)
    );
  }

  /**
   * Resolve the host runtime for a session's owning project. Returns null for
   * local projects, unknown projects, or projects on since-deleted hosts — all
   * of which fall back to the local runtime path.
   */
  function resolveHostRuntime(sessionId) {
    const project = findSessionProject(sessionId);
    if (!project?.host || project.host === 'local') return null;
    const host = findHostByName(loadHosts(), project.host);
    if (!host) return null;
    return { host: host.name, hostRuntime: getHostRuntime(host) };
  }

  /**
   * Enumerate durable session ids across the local tmux server and every
   * configured host (Spec §6.3). A host whose enumeration fails contributes
   * nothing — its sessions are re-listed when it recovers.
   */
  async function listAllSessionIds(localRuntime) {
    const localIds = typeof localRuntime?.listSessionIdsAsync === 'function'
      ? await localRuntime.listSessionIdsAsync()
      : [];
    const hostIdLists = await Promise.all(
      loadHosts()
        .filter(host => getReachability?.(host.name)?.reachability !== 'unreachable')
        .map(host => getHostRuntime(host).listSessionIdsAsync())
    );
    return [...new Set([...localIds, ...hostIdLists.flat()])];
  }

  return { getHostRuntime, findSessionProject, resolveHostRuntime, listAllSessionIds };
}
