import {
  getTerminalRuntimeStatus,
  TERMINAL_EXECUTION_DEAD,
  TERMINAL_EXECUTION_UNKNOWN,
  TERMINAL_SNAPSHOT_WINDOW_LINES,
} from './terminal-runtime.js';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isProjectSessionId(sessionId, projectName) {
  if (!sessionId || !projectName) return false;
  return new RegExp(`^${escapeRegExp(projectName)}-\\d+$`).test(sessionId);
}

function doesSessionBelongToConfiguredProject(sessionId, projects = []) {
  return projects.some(project => isProjectSessionId(sessionId, project.name));
}

export function listTerminalSessions({
  sessions,
  runtime,
  projects = [],
  deletedSessionIds = new Set(),
  computeHealth,
  computeStallReason,
  sanitizePreviewLine,
  statusCache = null,
} = {}) {
  const result = [];
  const seenSessionIds = new Set();
  const runtimeStatus = getTerminalRuntimeStatus(runtime);

  for (const [sessionId, entry] of sessions) {
    const cwd = statusCache?.getSessionCwd
      ? statusCache.getSessionCwd(entry, sessionId)
      : runtime.getSessionCwd?.(entry, sessionId) || entry.cwd;
    const executionState = entry.alive
      ? statusCache?.getSessionExecutionState
        ? statusCache.getSessionExecutionState(entry, sessionId)
        : runtime.getSessionExecutionState?.(sessionId) ?? {
          executionStatus: TERMINAL_EXECUTION_UNKNOWN,
          foregroundCommand: null,
          executionReason: 'runtime_unavailable',
          executionConfidence: 'low',
        }
      : {
        executionStatus: TERMINAL_EXECUTION_DEAD,
        foregroundCommand: null,
        executionReason: 'pane_dead',
        executionConfidence: 'high',
      };
    seenSessionIds.add(sessionId);

    result.push({
      sessionId,
      cwd,
      startedAt: entry.startedAt,
      lastOutputAt: entry.lastOutputAt,
      lastSubstantialOutputAt: entry.lastSubstantialOutputAt ?? entry.lastOutputAt,
      lastOutputLine: sanitizePreviewLine(entry.lastOutputLine || ''),
      alive: entry.alive,
      ...executionState,
      runtimeType: entry.runtimeType ?? runtime.type ?? 'pty',
      snapshotWindowLines: entry.snapshotWindowLines ?? (entry.runtimeType === 'tmux' ? TERMINAL_SNAPSHOT_WINDOW_LINES : null),
      historyGuaranteed: entry.historyGuaranteed ?? (entry.runtimeType === 'tmux'),
      historyWarningReason: entry.historyWarningReason ?? null,
      historyWarningMessage: entry.historyWarningMessage ?? null,
      ...runtimeStatus,
      wsAttached: entry.wsAttached ?? false,
      lastAttachAt: entry.lastAttachAt ?? null,
      lastClientAckAt: entry.lastClientAckAt ?? null,
      lastSeq: entry.lastSeq ?? 0,
      health: computeHealth(entry),
      stallReason: computeStallReason(entry),
    });
  }

  const detachedSessionIds = statusCache?.getDetachedSessionIds
    ? statusCache.getDetachedSessionIds({ projects, deletedSessionIds, seenSessionIds })
    : runtime.listSessionIds?.() || [];

  for (const sessionId of detachedSessionIds) {
    if (seenSessionIds.has(sessionId)) continue;
    if (deletedSessionIds.has(sessionId)) continue;
    if (!doesSessionBelongToConfiguredProject(sessionId, projects)) continue;

    const detachedEntry = {
      alive: true,
      wsAttached: false,
      runtimeType: runtime.type ?? 'pty',
      lastOutputAt: null,
      lastSubstantialOutputAt: null,
      lastOutputLine: '',
      lastAttachAt: null,
      lastClientAckAt: null,
      lastSeq: 0,
    };
    const cwd = statusCache?.getSessionCwd
      ? statusCache.getSessionCwd(detachedEntry, sessionId)
      : runtime.getSessionCwd?.({ cwd: null }, sessionId) || null;
    const executionState = statusCache?.getSessionExecutionState
      ? statusCache.getSessionExecutionState(detachedEntry, sessionId)
      : runtime.getSessionExecutionState?.(sessionId) ?? {
        executionStatus: TERMINAL_EXECUTION_UNKNOWN,
        foregroundCommand: null,
        executionReason: 'runtime_unavailable',
        executionConfidence: 'low',
      };

    result.push({
      sessionId,
      cwd,
      startedAt: null,
      lastOutputAt: null,
      lastSubstantialOutputAt: null,
      lastOutputLine: '',
      alive: true,
      ...executionState,
      runtimeType: runtime.type ?? 'pty',
      snapshotWindowLines: runtime.type === 'tmux' ? TERMINAL_SNAPSHOT_WINDOW_LINES : null,
      historyGuaranteed: runtime.type === 'tmux',
      historyWarningReason: null,
      historyWarningMessage: null,
      ...runtimeStatus,
      wsAttached: false,
      lastAttachAt: null,
      lastClientAckAt: null,
      lastSeq: 0,
      health: computeHealth(detachedEntry),
      stallReason: computeStallReason(detachedEntry),
    });
  }

  return result;
}
