import { describe, expect, it, vi } from 'vitest';
import {
  shouldPruneTerminalSession,
  pruneTerminalSessions,
  pruneRemoteTerminalSessions,
} from '../session-gc.js';
import { createTerminalStatusCache } from '../terminal-session-status-cache.js';
import { listTerminalSessions } from '../terminal-session-status-service.js';

function transportError() {
  return Object.assign(new Error('connect timeout'), { code: 255 });
}

const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function localRuntime({ recoverable = false } = {}) {
  return {
    type: 'tmux',
    kill: vi.fn(),
    isSessionRecoverable: vi.fn(() => recoverable),
  };
}

function fakeHostRuntime({ recoverable = false, recoverableError = null } = {}) {
  return {
    isSessionRecoverableAsync: vi.fn(async () => {
      if (recoverableError) throw recoverableError;
      return recoverable;
    }),
    killAsync: vi.fn(async () => {}),
  };
}

function remoteEntry(hostRuntime, overrides = {}) {
  return {
    host: 'devbox',
    hostRuntime,
    alive: false,
    wsAttached: false,
    lastDetachAt: OLD,
    runtimeType: 'tmux',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sync prune must never touch remote entries
// ---------------------------------------------------------------------------

describe('local session GC with remote entries present', () => {
  it('shouldPruneTerminalSession returns false for remote-host entries', () => {
    const entry = remoteEntry(fakeHostRuntime());
    expect(shouldPruneTerminalSession({ entry, sessionId: 'rp-1', runtime: localRuntime() })).toBe(false);
  });

  it('pruneTerminalSessions skips remote entries and never consults the local runtime for them', () => {
    const runtime = localRuntime();
    const sessions = new Map([
      ['rp-1', remoteEntry(fakeHostRuntime())],
      ['lp-1', { alive: false, wsAttached: false, lastDetachAt: OLD }],
    ]);

    const pruned = pruneTerminalSessions({ sessions, runtime });

    expect(pruned).toEqual(['lp-1']);
    expect(sessions.has('rp-1')).toBe(true);
    expect(runtime.isSessionRecoverable).not.toHaveBeenCalledWith('rp-1');
  });
});

// ---------------------------------------------------------------------------
// Remote prune — iterates hosts via each entry's runtime, skips unreachable
// ---------------------------------------------------------------------------

describe('pruneRemoteTerminalSessions', () => {
  it('prunes a dead, unrecoverable remote session past the TTL via its host runtime', async () => {
    const hostRuntime = fakeHostRuntime({ recoverable: false });
    const entry = remoteEntry(hostRuntime);
    const sessions = new Map([['rp-1', entry]]);
    const onPruned = vi.fn();

    const pruned = await pruneRemoteTerminalSessions({ sessions, onPruned });

    expect(pruned).toEqual(['rp-1']);
    expect(sessions.size).toBe(0);
    expect(hostRuntime.killAsync).toHaveBeenCalledWith(entry, 'rp-1');
    expect(onPruned).toHaveBeenCalledWith('rp-1', entry);
  });

  it('skips already-known unreachable hosts without probing any session on that host', async () => {
    const hostRuntime = fakeHostRuntime({ recoverable: false });
    const sessions = new Map([['rp-1', remoteEntry(hostRuntime)]]);

    const pruned = await pruneRemoteTerminalSessions({
      sessions,
      getReachability: () => ({ reachability: 'unreachable', lastError: 'connect timeout' }),
    });

    expect(pruned).toEqual([]);
    expect(hostRuntime.isSessionRecoverableAsync).not.toHaveBeenCalled();
    expect(hostRuntime.killAsync).not.toHaveBeenCalled();
    expect(sessions.has('rp-1')).toBe(true);
  });

  it('skips sessions on unreachable hosts — presumed alive, never pruned blind (§6.3)', async () => {
    const hostRuntime = fakeHostRuntime({ recoverableError: transportError() });
    const sessions = new Map([['rp-1', remoteEntry(hostRuntime)]]);

    const pruned = await pruneRemoteTerminalSessions({ sessions });

    expect(pruned).toEqual([]);
    expect(sessions.has('rp-1')).toBe(true);
    expect(hostRuntime.killAsync).not.toHaveBeenCalled();
  });

  it('keeps recoverable remote sessions', async () => {
    const sessions = new Map([['rp-1', remoteEntry(fakeHostRuntime({ recoverable: true }))]]);
    expect(await pruneRemoteTerminalSessions({ sessions })).toEqual([]);
    expect(sessions.has('rp-1')).toBe(true);
  });

  it('short-circuits the remaining sessions of a host after its first transport failure', async () => {
    const hostRuntime = fakeHostRuntime({ recoverableError: transportError() });
    const sessions = new Map([
      ['rp-1', remoteEntry(hostRuntime)],
      ['rp-2', remoteEntry(hostRuntime)],
      ['rp-3', remoteEntry(hostRuntime)],
    ]);

    const pruned = await pruneRemoteTerminalSessions({ sessions });

    expect(pruned).toEqual([]);
    // One probe for the host, not one 5s timeout per session.
    expect(hostRuntime.isSessionRecoverableAsync).toHaveBeenCalledTimes(1);
  });

  it('never touches attached or local sessions', async () => {
    const attached = remoteEntry(fakeHostRuntime(), { wsAttached: true });
    const local = { alive: false, wsAttached: false, lastDetachAt: OLD };
    const sessions = new Map([['rp-1', attached], ['lp-1', local]]);

    const pruned = await pruneRemoteTerminalSessions({ sessions });

    expect(pruned).toEqual([]);
    expect(sessions.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Status cache — remote entries route through entry.hostRuntime
// ---------------------------------------------------------------------------

describe('terminal status cache with host-aware sessions', () => {
  it('does not poll a remote session whose host is already unreachable', async () => {
    const localOps = {
      getSessionCwdAsync: vi.fn(async () => '/local'),
      getSessionExecutionStateAsync: vi.fn(async () => ({ executionStatus: 'idle' })),
    };
    const hostOps = {
      getSessionCwdAsync: vi.fn(async () => '/remote/cwd'),
      getSessionExecutionStateAsync: vi.fn(async () => ({ executionStatus: 'running' })),
    };
    const cache = createTerminalStatusCache({
      runtime: localOps,
      getReachability: () => ({ reachability: 'unreachable', lastError: 'connect timeout' }),
    });
    const entry = { alive: true, cwd: '/orig', host: 'devbox', hostRuntime: hostOps };

    await cache.refreshSession(entry, 'rp-1');

    expect(hostOps.getSessionCwdAsync).not.toHaveBeenCalled();
    expect(hostOps.getSessionExecutionStateAsync).not.toHaveBeenCalled();
    expect(localOps.getSessionCwdAsync).not.toHaveBeenCalled();
    expect(cache.getSessionCwd(entry, 'rp-1')).toBe('/orig');
    expect(cache.getSessionExecutionState(entry, 'rp-1').executionReason).toBe('host_unreachable');
  });

  it('refreshes a remote session through its host runtime, not the local runtime', async () => {
    const localOps = {
      getSessionCwdAsync: vi.fn(async () => '/local'),
      getSessionExecutionStateAsync: vi.fn(async () => ({ executionStatus: 'idle' })),
    };
    const hostOps = {
      getSessionCwdAsync: vi.fn(async () => '/remote/cwd'),
      getSessionExecutionStateAsync: vi.fn(async () => ({ executionStatus: 'running' })),
    };
    const cache = createTerminalStatusCache({ runtime: localOps });
    const entry = { alive: true, cwd: '/orig', host: 'devbox', hostRuntime: hostOps };

    await cache.refreshSession(entry, 'rp-1');

    expect(hostOps.getSessionCwdAsync).toHaveBeenCalled();
    expect(hostOps.getSessionExecutionStateAsync).toHaveBeenCalledWith('rp-1');
    expect(localOps.getSessionCwdAsync).not.toHaveBeenCalled();
    expect(cache.getSessionCwd(entry, 'rp-1')).toBe('/remote/cwd');
    expect(cache.getSessionExecutionState(entry, 'rp-1').executionStatus).toBe('running');
  });

  it('keeps routing local sessions through the local runtime', async () => {
    const localOps = {
      getSessionCwdAsync: vi.fn(async () => '/local'),
      getSessionExecutionStateAsync: vi.fn(async () => ({ executionStatus: 'idle' })),
    };
    const cache = createTerminalStatusCache({ runtime: localOps });
    await cache.refreshSession({ alive: true, cwd: '/orig' }, 'lp-1');
    expect(localOps.getSessionCwdAsync).toHaveBeenCalled();
  });

  it('lists remote sessions with their host and never queries the local tmux for them', () => {
    const runtime = {
      type: 'tmux',
      isAvailable: () => true,
      getPtySpawnStatus: () => ({ available: true, error: null }),
      getSessionCwd: vi.fn(() => '/local-answer'),
      getSessionExecutionState: vi.fn(() => ({ executionStatus: 'idle' })),
      listSessionIds: () => [],
    };
    const sessions = new Map([
      ['rp-1', {
        host: 'devbox',
        alive: true,
        wsAttached: true,
        cwd: '/srv/app',
        runtimeType: 'tmux',
        lastSeq: 0,
      }],
    ]);

    const rows = listTerminalSessions({
      sessions,
      runtime,
      projects: [{ name: 'rp' }],
      computeHealth: () => 'healthy',
      computeStallReason: () => null,
      sanitizePreviewLine: (line) => line,
    });

    expect(rows[0].host).toBe('devbox');
    expect(rows[0].cwd).toBe('/srv/app');
    // The LOCAL runtime must never be consulted for a remote session.
    expect(runtime.getSessionCwd).not.toHaveBeenCalled();
    expect(runtime.getSessionExecutionState).not.toHaveBeenCalled();
  });

  it('reports an SSH-dropped remote session as suspended-unknown, never dead (§8.2)', () => {
    const runtime = {
      type: 'tmux',
      isAvailable: () => true,
      getPtySpawnStatus: () => ({ available: true, error: null }),
      listSessionIds: () => [],
    };
    const sessions = new Map([
      ['rp-1', {
        host: 'devbox',
        alive: false,
        remoteDetached: true,
        wsAttached: true,
        cwd: '/srv/app',
        runtimeType: 'tmux',
        lastSeq: 0,
      }],
    ]);

    const rows = listTerminalSessions({
      sessions,
      runtime,
      projects: [{ name: 'rp' }],
      computeHealth: () => 'detached',
      computeStallReason: () => null,
      sanitizePreviewLine: (line) => line,
    });

    expect(rows[0].executionStatus).not.toBe('dead');
    expect(rows[0].executionReason).toBe('host_connection_lost');
    expect(rows[0].executionConfidence).toBe('low');
  });

  it('reports host local for plain sessions', () => {
    const runtime = {
      type: 'tmux',
      isAvailable: () => true,
      getPtySpawnStatus: () => ({ available: true, error: null }),
      getSessionCwd: () => '/l',
      getSessionExecutionState: () => ({ executionStatus: 'idle' }),
      listSessionIds: () => [],
    };
    const sessions = new Map([['lp-1', { alive: true, wsAttached: true, cwd: '/l', lastSeq: 0 }]]);
    const rows = listTerminalSessions({
      sessions,
      runtime,
      projects: [{ name: 'lp' }],
      computeHealth: () => 'healthy',
      computeStallReason: () => null,
      sanitizePreviewLine: (line) => line,
    });
    expect(rows[0].host).toBe('local');
  });

  it('attributes detached remote sessions to their host and never polls local tmux for them', () => {
    const runtime = {
      type: 'tmux',
      isAvailable: () => true,
      getPtySpawnStatus: () => ({ available: true, error: null }),
      getSessionCwd: vi.fn(() => '/local-answer'),
      getSessionExecutionState: vi.fn(() => ({ executionStatus: 'idle' })),
      listSessionIds: () => ['rp-1'],
    };
    const hostRuntime = { host: 'devbox' };

    const rows = listTerminalSessions({
      sessions: new Map(),
      runtime,
      projects: [{ name: 'rp', host: 'devbox' }],
      computeHealth: () => 'detached',
      computeStallReason: () => null,
      sanitizePreviewLine: (line) => line,
      resolveHostRuntime: (sessionId) => (sessionId === 'rp-1' ? { host: 'devbox', hostRuntime } : null),
    });

    expect(rows[0].sessionId).toBe('rp-1');
    expect(rows[0].host).toBe('devbox');
    expect(runtime.getSessionCwd).not.toHaveBeenCalled();
    expect(runtime.getSessionExecutionState).not.toHaveBeenCalled();
  });

  it('threads the host runtime into detached remote entries so the cache polls the right host', () => {
    const hostRuntime = { host: 'devbox' };
    const seenEntries = [];
    const statusCache = {
      getSessionCwd: vi.fn((entry) => { seenEntries.push(entry); return '/from-cache'; }),
      getSessionExecutionState: vi.fn(() => ({ executionStatus: 'idle' })),
      getDetachedSessionIds: () => ['rp-1'],
    };

    listTerminalSessions({
      sessions: new Map(),
      runtime: {
        type: 'tmux',
        isAvailable: () => true,
        getPtySpawnStatus: () => ({ available: true, error: null }),
      },
      projects: [{ name: 'rp', host: 'devbox' }],
      computeHealth: () => 'detached',
      computeStallReason: () => null,
      sanitizePreviewLine: (line) => line,
      statusCache,
      resolveHostRuntime: () => ({ host: 'devbox', hostRuntime }),
    });

    expect(seenEntries[0].hostRuntime).toBe(hostRuntime);
    expect(seenEntries[0].host).toBe('devbox');
  });

  it('uses the injected cross-host session enumerator when provided', async () => {
    const listAllSessionIds = vi.fn(async () => ['lp-1', 'rp-1']);
    const cache = createTerminalStatusCache({
      runtime: { listSessionIdsAsync: vi.fn(async () => ['lp-1']) },
      listAllSessionIds,
    });

    await cache.refreshSessionList();
    const detached = cache.getDetachedSessionIds({
      projects: [{ name: 'lp' }, { name: 'rp' }],
    });

    expect(listAllSessionIds).toHaveBeenCalled();
    expect(detached).toEqual(['lp-1', 'rp-1']);
  });
});
