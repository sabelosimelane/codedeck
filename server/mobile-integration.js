import { requireField } from './mobile-store.js';
import { isTransportFailure } from './command-runner.js';

// Mirrors sanitizeTmuxName in terminal-runtime.js.
const tmuxSafeName = name => name.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * tmux lists "Equinox Local-15" as "Equinox_Local-15". Map a listed name back
 * to the project's real session id: an exact project name wins; otherwise the
 * one project whose sanitized name matches. A name two projects could own is
 * left out rather than guessed.
 */
export function sessionIdForTmuxName(name, projects) {
  const match = name.match(/^(.*)-(\d+)$/);
  if (!match) return name;
  const [, base, number] = match;
  if (projects.some(project => project.name === base)) return name;
  const owners = projects.filter(project => tmuxSafeName(project.name) === base);
  if (owners.length === 1) return `${owners[0].name}-${number}`;
  if (owners.length > 1) console.warn(`[companion] ambiguous_tmux_session name=${name} owners=${owners.length}`);
  return name;
}

/** Shared cached status probes, including durable sessions with no frontend. */
export function createMobileDiscovery({ store, sessions, deletedSessionIds, statusCache, loadProjects, resolveHostRuntime, getReachability, namingStore, getSessionIncarnation, attention, describeState, getSessionActivity, now = Date.now, freshnessMs = 30000 }) {
  for (const [field, value] of Object.entries({ loadProjects, resolveHostRuntime, getReachability, getSessionIncarnation, describeState, getSessionActivity })) requireField(typeof value === 'function', field, 'Discovery function required');
  requireField(typeof attention?.observe === 'function' && typeof attention?.knows === 'function', 'attention', 'Attention tracker required');
  const timeOf = value => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN);
  /**
   * First sighting needs a starting "last activity": the session's own output
   * time when a client has attached, else tmux's. An unreachable host yields
   * no reading at all — activity stays unknown rather than becoming "now".
   */
  async function recordStatus(id, liveEntry, executionStatus) {
    if (attention.knows(id)) { attention.observe({ sessionId: id, status: executionStatus }); return; }
    if (executionStatus === 'unknown') return;
    const own = timeOf(liveEntry?.lastSubstantialOutputAt ?? liveEntry?.lastOutputAt ?? liveEntry?.startedAt);
    let activityHint = Number.isSafeInteger(own) && own >= 0 ? own : null;
    if (activityHint === null) {
      try { activityHint = await getSessionActivity(id); }
      catch (error) { if (!isTransportFailure(error)) throw error; return; }
    }
    attention.observe({ sessionId: id, status: executionStatus, activityHint });
  }
  requireField(sessions instanceof Map && deletedSessionIds instanceof Set, 'sessions', 'Session map and deleted set required');
  requireField(store && statusCache && namingStore, 'services', 'Discovery stores required');
  requireField(typeof now === 'function', 'now', 'Clock function required');
  requireField(Number.isSafeInteger(freshnessMs) && freshnessMs > 0, 'freshnessMs', 'Positive freshness duration required');
  let pending = null;
  async function collect() {
    const projects = loadProjects();
    const ids = new Set([...(await statusCache.refreshSessionList()).map(name => sessionIdForTmuxName(name, projects)).filter(Boolean), ...sessions.keys()]);
    async function inspect(id) {
      const project = projects.find(item => id.startsWith(`${item.name}-`) && /^\d+$/.test(id.slice(item.name.length + 1)));
      if (!project) return null;
      const liveEntry = sessions.get(id);
      const route = resolveHostRuntime(id);
      const entry = liveEntry ?? { alive: true, clientDetached: true, runtimeType: 'tmux', ...route };
      const host = entry.host ?? route?.host ?? 'local';
      let reachable = getReachability(host)?.reachability !== 'unreachable';
      let status;
      let runtimeIncarnation;
      try {
        status = await statusCache.refreshSession(entry, id);
        requireField(Number.isSafeInteger(status?.updatedAt) && status.updatedAt >= 0, 'updatedAt', 'Cached status timestamp required');
        requireField(['running', 'idle', 'dead', 'unknown'].includes(status?.executionState?.executionStatus), 'executionStatus', 'Explicit cached execution status required');
        const time = now();
        requireField(Number.isSafeInteger(time) && time >= 0, 'now', 'Clock must return a nonnegative timestamp');
        const fresh = status.updatedAt > 0 && status.updatedAt <= time && time - status.updatedAt <= freshnessMs;
        if (!fresh) status = { ...status, executionState: { ...status.executionState, executionStatus: 'unknown' } };
        if (reachable && !entry.remoteDetached && (entry.alive || entry.clientDetached) && ['running', 'idle'].includes(status.executionState.executionStatus)) runtimeIncarnation = await getSessionIncarnation(id);
      } catch (error) {
        if (!isTransportFailure(error)) throw error;
        // A classified SSH/transport failure is unknown, never a fabricated
        // idle or exit. Domain and database validation errors still propagate.
        reachable = false;
        status = { cwd: entry.cwd ?? null, updatedAt: 0, executionState: { executionStatus: 'unknown' } };
      }
      const definitiveExit = !!liveEntry && !entry.alive && !entry.clientDetached && !entry.remoteDetached;
      const executionStatus = !reachable || entry.remoteDetached ? 'unknown' : definitiveExit ? 'dead' : status.executionState.executionStatus;
      const incarnationId = runtimeIncarnation !== undefined
        ? store.adoptIncarnation(id, runtimeIncarnation)
        : entry.incarnationId ?? store.ensureIncarnation(id);
      if (liveEntry) liveEntry.incarnationId = incarnationId;
      if (executionStatus === 'dead') store.retireSession(id);
      await recordStatus(id, liveEntry, executionStatus);
      const state = describeState(id);
      return {
        view: { id, incarnationId, projectId: project.name, title: namingStore.get(id)?.title ?? id, status: executionStatus,
          live: reachable && executionStatus !== 'unknown', cwd: status.cwd ?? entry.cwd ?? null, host, runtimeType: entry.runtimeType ?? 'tmux',
          finished: state.finished, muted: state.muted, waiting: state.waiting, lastActivityAt: state.lastActivityAt,
          needsInput: liveEntry?.workflow?.snapshot().status === 'needs_input' || status.executionState.needsInput === true,
          agentCli: status.executionState.agentCli ?? null,
          backgroundAgents: status.executionState.backgroundAgents ?? 0,
          backgroundShells: status.executionState.backgroundShells ?? 0 },
        observation: { sessionId: id, incarnationId, executionStatus, workflowStatus: entry.workflow?.snapshot().status ?? null,
          needsInput: liveEntry?.workflow?.snapshot().status === 'needs_input' || status.executionState.needsInput === true,
          observedAt: status.updatedAt, reachable },
      };
    }
    const selected = [...ids].filter(id => !deletedSessionIds.has(id));
    const records = new Array(selected.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (cursor < selected.length) {
        const index = cursor++;
        records[index] = await inspect(selected[index]);
      }
    });
    // Wait for in-flight probes even when one invariant fails, so a following
    // tick cannot exceed the shared bound by overlapping an unfinished batch.
    const outcomes = await Promise.allSettled(workers);
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return records.filter(Boolean);
  }
  function read() {
    if (!pending) pending = collect().finally(() => { pending = null; });
    return pending;
  }
  return {
    // Same precedence as the desktop sidebar: shelved wins over waiting.
    listProjects: () => loadProjects().map(project => {
      const state = project.shelved === true ? 'shelved' : project.waiting === true ? 'waiting' : 'active';
      const stateChangedAt = state === 'shelved' ? project.shelvedAt ?? null : state === 'waiting' ? project.waitingAt ?? null : null;
      return { id: project.name, name: project.name, state, stateChangedAt };
    }),
    listSessions: async () => (await read()).map(record => record.view),
    listObservations: async () => (await read()).map(record => record.observation),
  };
}
