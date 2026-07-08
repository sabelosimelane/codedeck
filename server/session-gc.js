const DEAD_SESSION_TTL_MS = 15 * 1000;
const DETACHED_UNRECOVERABLE_TTL_MS = 5 * 60 * 1000;

function getAgeMs(isoString, nowMs) {
  if (!isoString) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(isoString);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - parsed);
}

function isRemoteEntry(entry) {
  return typeof entry?.host === 'string' && entry.host !== 'local';
}

/** Shared TTL policy: prune when dead/unrecoverable past the relevant window. */
function shouldPruneByTtl({ entry, recoverable, nowMs, deadSessionTtlMs, detachedUnrecoverableTtlMs }) {
  const detachedForMs = getAgeMs(
    entry.lastDetachAt ?? entry.lastAttachAt ?? entry.startedAt,
    nowMs
  );

  if (!entry.alive && !recoverable) {
    return detachedForMs >= deadSessionTtlMs;
  }

  if (recoverable) {
    return false;
  }

  return detachedForMs >= detachedUnrecoverableTtlMs;
}

export function shouldPruneTerminalSession({
  entry,
  sessionId,
  runtime,
  nowMs = Date.now(),
  deadSessionTtlMs = DEAD_SESSION_TTL_MS,
  detachedUnrecoverableTtlMs = DETACHED_UNRECOVERABLE_TTL_MS,
}) {
  if (!entry || entry.wsAttached) return false;

  // Remote sessions are never judged by the LOCAL runtime — their tmux server
  // lives on the host. pruneRemoteTerminalSessions handles them asynchronously.
  if (isRemoteEntry(entry)) return false;

  const recoverable = runtime.isSessionRecoverable?.(sessionId) ?? false;
  return shouldPruneByTtl({ entry, recoverable, nowMs, deadSessionTtlMs, detachedUnrecoverableTtlMs });
}

export function pruneTerminalSessions({
  sessions,
  runtime,
  nowMs = Date.now(),
  deadSessionTtlMs = DEAD_SESSION_TTL_MS,
  detachedUnrecoverableTtlMs = DETACHED_UNRECOVERABLE_TTL_MS,
  onPruned = () => {},
}) {
  const prunedSessionIds = [];

  for (const [sessionId, entry] of sessions) {
    if (!shouldPruneTerminalSession({
      entry,
      sessionId,
      runtime,
      nowMs,
      deadSessionTtlMs,
      detachedUnrecoverableTtlMs,
    })) {
      continue;
    }

    try {
      runtime.kill(entry, sessionId);
    } catch {
      // Best-effort cleanup — always drop the stale registry entry
    }

    sessions.delete(sessionId);
    prunedSessionIds.push(sessionId);
    onPruned(sessionId, entry);
  }

  return prunedSessionIds;
}

/**
 * Prune detached remote-host sessions through each entry's own host runtime
 * (Spec §6.3). A host that cannot be reached is SKIPPED — its sessions are
 * presumed alive and re-judged when the host recovers; pruning blind would
 * kill state we cannot see.
 */
export async function pruneRemoteTerminalSessions({
  sessions,
  nowMs = Date.now(),
  deadSessionTtlMs = DEAD_SESSION_TTL_MS,
  detachedUnrecoverableTtlMs = DETACHED_UNRECOVERABLE_TTL_MS,
  onPruned = () => {},
  getReachability = null,
}) {
  const prunedSessionIds = [];
  const unreachableHosts = new Set();

  for (const [sessionId, entry] of sessions) {
    if (!isRemoteEntry(entry) || entry.wsAttached || !entry.hostRuntime) continue;
    // One transport failure marks the whole host unreachable for this pass —
    // no point paying an SSH timeout per remaining session on the same host.
    if (unreachableHosts.has(entry.host)) continue;
    if (getReachability?.(entry.host)?.reachability === 'unreachable') {
      unreachableHosts.add(entry.host);
      continue;
    }

    let recoverable;
    try {
      recoverable = await entry.hostRuntime.isSessionRecoverableAsync(sessionId);
    } catch {
      // Transport failure — host unreachable, remote state unknown: skip.
      unreachableHosts.add(entry.host);
      continue;
    }

    if (!shouldPruneByTtl({ entry, recoverable, nowMs, deadSessionTtlMs, detachedUnrecoverableTtlMs })) {
      continue;
    }

    try {
      await entry.hostRuntime.killAsync(entry, sessionId);
    } catch {
      // Best-effort cleanup — always drop the stale registry entry
    }

    sessions.delete(sessionId);
    prunedSessionIds.push(sessionId);
    onPruned(sessionId, entry);
  }

  return prunedSessionIds;
}
