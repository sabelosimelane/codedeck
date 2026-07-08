import {
  TERMINAL_EXECUTION_UNKNOWN,
} from './terminal-runtime.js';

const DEFAULT_SESSION_REFRESH_TTL_MS = 2500;
const DEFAULT_SESSION_LIST_REFRESH_TTL_MS = 2500;

export const STATUS_REFRESH_PENDING_EXECUTION_STATE = Object.freeze({
  executionStatus: TERMINAL_EXECUTION_UNKNOWN,
  foregroundCommand: null,
  executionReason: 'status_refresh_pending',
  executionConfidence: 'low',
});

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

function isFresh(record, ttlMs, now) {
  return !!record?.updatedAt && now() - record.updatedAt <= ttlMs;
}

function cloneExecutionState(state) {
  return { ...state };
}

export function createTerminalStatusCache({
  runtime,
  listAllSessionIds = null,
  getReachability = null,
  now = () => Date.now(),
  sessionRefreshTtlMs = DEFAULT_SESSION_REFRESH_TTL_MS,
  sessionListRefreshTtlMs = DEFAULT_SESSION_LIST_REFRESH_TTL_MS,
  maxConcurrentRefreshes = 4,
} = {}) {
  const sessions = new Map();
  const refreshQueue = [];
  let activeRefreshes = 0;
  const sessionList = {
    ids: [],
    updatedAt: 0,
    refreshPromise: null,
  };

  function getSessionRecord(sessionId) {
    let record = sessions.get(sessionId);
    if (!record) {
      record = {
        cwd: undefined,
        executionState: null,
        updatedAt: 0,
        refreshPromise: null,
      };
      sessions.set(sessionId, record);
    }
    return record;
  }

  function runLimited(task) {
    return new Promise((resolve, reject) => {
      const run = () => {
        activeRefreshes += 1;
        let result;
        try {
          result = task();
        } catch (error) {
          activeRefreshes -= 1;
          const next = refreshQueue.shift();
          if (next) next();
          reject(error);
          return;
        }

        Promise.resolve(result)
          .then(resolve, reject)
          .finally(() => {
            activeRefreshes -= 1;
            const next = refreshQueue.shift();
            if (next) next();
          });
      };

      if (activeRefreshes < maxConcurrentRefreshes) {
        run();
      } else {
        refreshQueue.push(run);
      }
    });
  }

  function refreshSession(entry, sessionId) {
    const record = getSessionRecord(sessionId);
    if (record.refreshPromise) return record.refreshPromise;
    if (isFresh(record, sessionRefreshTtlMs, now)) return Promise.resolve(record);

    record.refreshPromise = runLimited(async () => {
      // Remote sessions carry their own host runtime — status lookups must run
      // on the session's host, never against the local tmux server.
      const sessionRuntime = entry?.hostRuntime ?? runtime;
      if (entry?.host && entry.host !== 'local' && getReachability?.(entry.host)?.reachability === 'unreachable') {
        record.cwd = entry?.cwd ?? null;
        record.executionState = {
          executionStatus: TERMINAL_EXECUTION_UNKNOWN,
          foregroundCommand: null,
          executionReason: 'host_unreachable',
          executionConfidence: 'low',
        };
        record.updatedAt = now();
        return record;
      }
      const [cwd, executionState] = await Promise.all([
        typeof sessionRuntime?.getSessionCwdAsync === 'function'
          ? sessionRuntime.getSessionCwdAsync(entry, sessionId)
          : Promise.resolve(entry?.cwd ?? null),
        entry?.alive && typeof sessionRuntime?.getSessionExecutionStateAsync === 'function'
          ? sessionRuntime.getSessionExecutionStateAsync(sessionId)
          : Promise.resolve(STATUS_REFRESH_PENDING_EXECUTION_STATE),
      ]);

      record.cwd = cwd ?? entry?.cwd ?? null;
      record.executionState = executionState ?? STATUS_REFRESH_PENDING_EXECUTION_STATE;
      record.updatedAt = now();
      return record;
    })
      .catch(() => {
        record.cwd = entry?.cwd ?? null;
        record.executionState = STATUS_REFRESH_PENDING_EXECUTION_STATE;
        record.updatedAt = now();
        return record;
      })
      .finally(() => {
        record.refreshPromise = null;
      });

    return record.refreshPromise;
  }

  function refreshSessionList() {
    if (sessionList.refreshPromise) return sessionList.refreshPromise;
    if (isFresh(sessionList, sessionListRefreshTtlMs, now)) return Promise.resolve(sessionList.ids);

    sessionList.refreshPromise = runLimited(async () => {
      // The injected enumerator sweeps every configured host (Spec §6.3);
      // without it, only the local tmux server is listed.
      const ids = typeof listAllSessionIds === 'function'
        ? await listAllSessionIds()
        : typeof runtime?.listSessionIdsAsync === 'function'
          ? await runtime.listSessionIdsAsync()
          : [];
      sessionList.ids = Array.isArray(ids) ? ids : [];
      sessionList.updatedAt = now();
      return sessionList.ids;
    })
      .catch(() => {
        sessionList.ids = [];
        sessionList.updatedAt = now();
        return sessionList.ids;
      })
      .finally(() => {
        sessionList.refreshPromise = null;
      });

    return sessionList.refreshPromise;
  }

  function getSessionCwd(entry, sessionId) {
    const record = getSessionRecord(sessionId);
    if (!isFresh(record, sessionRefreshTtlMs, now)) {
      refreshSession(entry, sessionId);
    }
    return record.cwd ?? entry?.cwd ?? null;
  }

  function getSessionExecutionState(entry, sessionId) {
    const record = getSessionRecord(sessionId);
    if (!isFresh(record, sessionRefreshTtlMs, now)) {
      refreshSession(entry, sessionId);
    }
    return cloneExecutionState(record.executionState ?? STATUS_REFRESH_PENDING_EXECUTION_STATE);
  }

  function getDetachedSessionIds({
    projects = [],
    deletedSessionIds = new Set(),
    seenSessionIds = new Set(),
  } = {}) {
    if (!isFresh(sessionList, sessionListRefreshTtlMs, now)) {
      refreshSessionList();
    }

    return sessionList.ids.filter(sessionId => (
      !seenSessionIds.has(sessionId)
      && !deletedSessionIds.has(sessionId)
      && doesSessionBelongToConfiguredProject(sessionId, projects)
    ));
  }

  async function waitForIdle() {
    const pending = [
      ...Array.from(sessions.values())
        .map(record => record.refreshPromise)
        .filter(Boolean),
      sessionList.refreshPromise,
    ].filter(Boolean);

    if (pending.length === 0) return;
    await Promise.allSettled(pending);
    return waitForIdle();
  }

  function invalidateSession(sessionId) {
    sessions.delete(sessionId);
  }

  return {
    getSessionCwd,
    getSessionExecutionState,
    getDetachedSessionIds,
    refreshSession,
    refreshSessionList,
    invalidateSession,
    waitForIdle,
  };
}
