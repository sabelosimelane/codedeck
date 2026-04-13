const DEAD_SESSION_TTL_MS = 15 * 1000;
const DETACHED_UNRECOVERABLE_TTL_MS = 5 * 60 * 1000;
const DETACHED_RECOVERABLE_TTL_MS = 30 * 60 * 1000;

function getAgeMs(isoString, nowMs) {
  if (!isoString) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(isoString);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - parsed);
}

export function shouldPruneTerminalSession({
  entry,
  sessionId,
  runtime,
  nowMs = Date.now(),
  deadSessionTtlMs = DEAD_SESSION_TTL_MS,
  detachedUnrecoverableTtlMs = DETACHED_UNRECOVERABLE_TTL_MS,
  detachedRecoverableTtlMs = DETACHED_RECOVERABLE_TTL_MS,
}) {
  if (!entry || entry.wsAttached) return false;

  const recoverable = runtime.isSessionRecoverable?.(sessionId) ?? false;
  const detachedForMs = getAgeMs(
    entry.lastDetachAt ?? entry.lastAttachAt ?? entry.startedAt,
    nowMs
  );

  if (!entry.alive && !recoverable) {
    return detachedForMs >= deadSessionTtlMs;
  }

  if (recoverable) {
    return detachedForMs >= detachedRecoverableTtlMs;
  }

  return detachedForMs >= detachedUnrecoverableTtlMs;
}

export function pruneTerminalSessions({
  sessions,
  runtime,
  nowMs = Date.now(),
  deadSessionTtlMs = DEAD_SESSION_TTL_MS,
  detachedUnrecoverableTtlMs = DETACHED_UNRECOVERABLE_TTL_MS,
  detachedRecoverableTtlMs = DETACHED_RECOVERABLE_TTL_MS,
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
      detachedRecoverableTtlMs,
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
