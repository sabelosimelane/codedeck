import { describe, expect, it, vi } from 'vitest';
import { computeSessionHealth, computeStallReason, sanitizePreviewLine } from '../ws-handler.js';
import { listTerminalSessions } from '../terminal-session-status-service.js';

describe('listTerminalSessions', () => {
  it('includes detached durable tmux sessions for configured projects', () => {
    const sessions = new Map([
      ['Cadence-1', {
        cwd: '/tmp/cadence',
        startedAt: '2026-04-20T10:00:00.000Z',
        lastOutputAt: '2026-04-20T10:01:00.000Z',
        lastOutputLine: 'ready',
        alive: true,
        runtimeType: 'tmux',
        historyGuaranteed: false,
        historyWarningReason: 'snapshot_unavailable',
        historyWarningMessage: 'Recent scrollback could not be restored accurately. Live terminal output is attached, but preserved history is unavailable.',
        wsAttached: true,
        lastAttachAt: '2026-04-20T10:00:05.000Z',
        lastClientAckAt: '2026-04-20T10:01:00.000Z',
        lastSeq: 3,
      }],
    ]);

    const runtime = {
      type: 'tmux',
      getSessionCwd: vi.fn((entry, sessionId) => entry?.cwd || `/cwd/${sessionId}`),
      getSessionExecutionState: vi.fn((sessionId) => (
        sessionId === 'Cadence-1'
          ? { executionStatus: 'running', foregroundCommand: 'npm', executionReason: 'foreground_command', executionConfidence: 'medium' }
          : { executionStatus: 'idle', foregroundCommand: 'zsh', executionReason: 'shell_prompt', executionConfidence: 'high' }
      )),
      listSessionIds: vi.fn(() => ['Cadence-1', 'marketing-4', 'orphan-1']),
    };

    const result = listTerminalSessions({
      sessions,
      runtime,
      projects: [
        { name: 'Cadence', path: '/tmp/cadence' },
        { name: 'marketing', path: '/tmp/marketing' },
      ],
      deletedSessionIds: new Set(),
      computeHealth: computeSessionHealth,
      computeStallReason,
      sanitizePreviewLine,
    });

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'Cadence-1',
        wsAttached: true,
        health: 'healthy',
        terminalRuntime: 'tmux',
        terminalRuntimeContract: 'tmux_required',
        tmuxAvailable: true,
        terminalCreationAllowed: true,
        executionStatus: 'running',
        foregroundCommand: 'npm',
        executionReason: 'foreground_command',
        executionConfidence: 'medium',
        snapshotWindowLines: 10000,
        historyGuaranteed: false,
        historyWarningReason: 'snapshot_unavailable',
        historyWarningMessage: 'Recent scrollback could not be restored accurately. Live terminal output is attached, but preserved history is unavailable.',
      }),
      expect.objectContaining({
        sessionId: 'marketing-4',
        cwd: '/cwd/marketing-4',
        alive: true,
        wsAttached: false,
        runtimeType: 'tmux',
        health: 'detached',
        terminalRuntime: 'tmux',
        tmuxAvailable: true,
        terminalCreationAllowed: true,
        executionStatus: 'idle',
        foregroundCommand: 'zsh',
        executionReason: 'shell_prompt',
        executionConfidence: 'high',
        snapshotWindowLines: 10000,
        historyGuaranteed: true,
        historyWarningReason: null,
        historyWarningMessage: null,
      }),
    ]));
    expect(result.find(session => session.sessionId === 'orphan-1')).toBeUndefined();
  });

  it('does not surface deleted durable session ids', () => {
    const runtime = {
      type: 'tmux',
      getSessionCwd: vi.fn(() => '/tmp/gamma'),
      listSessionIds: vi.fn(() => ['Gamma-9']),
    };

    const result = listTerminalSessions({
      sessions: new Map(),
      runtime,
      projects: [{ name: 'Gamma', path: '/tmp/gamma' }],
      deletedSessionIds: new Set(['Gamma-9']),
      computeHealth: computeSessionHealth,
      computeStallReason,
      sanitizePreviewLine,
    });

    expect(result).toEqual([]);
  });

  it('uses cached status values without synchronous tmux lookups on the request path', () => {
    const sessions = new Map([
      ['Beta-39', {
        cwd: '/fallback/beta',
        startedAt: '2026-04-30T08:00:00.000Z',
        lastOutputAt: '2026-04-30T08:01:00.000Z',
        lastOutputLine: 'running',
        alive: true,
        runtimeType: 'tmux',
        wsAttached: true,
        lastAttachAt: '2026-04-30T08:00:05.000Z',
        lastClientAckAt: '2026-04-30T08:01:00.000Z',
        lastSeq: 12,
      }],
    ]);

    const runtime = {
      type: 'tmux',
      getSessionCwd: vi.fn(() => {
        throw new Error('sync cwd lookup should not run');
      }),
      getSessionExecutionState: vi.fn(() => {
        throw new Error('sync execution lookup should not run');
      }),
      listSessionIds: vi.fn(() => {
        throw new Error('sync session list should not run');
      }),
    };
    const statusCache = {
      getSessionCwd: vi.fn((_entry, sessionId) => (
        sessionId === 'Beta-39' ? '/cached/beta' : null
      )),
      getSessionExecutionState: vi.fn((_entry, sessionId) => (
        sessionId === 'Beta-39'
          ? {
              executionStatus: 'running',
              foregroundCommand: 'node',
              executionReason: 'agent_working',
              executionConfidence: 'high',
            }
          : {
              executionStatus: 'unknown',
              foregroundCommand: null,
              executionReason: 'status_refresh_pending',
              executionConfidence: 'low',
            }
      )),
      getDetachedSessionIds: vi.fn(() => ['Gamma-1']),
    };

    const result = listTerminalSessions({
      sessions,
      runtime,
      projects: [
        { name: 'Beta', path: '/repo/beta' },
        { name: 'Gamma', path: '/repo/gamma' },
      ],
      deletedSessionIds: new Set(),
      computeHealth: computeSessionHealth,
      computeStallReason,
      sanitizePreviewLine,
      statusCache,
    });

    expect(runtime.getSessionCwd).not.toHaveBeenCalled();
    expect(runtime.getSessionExecutionState).not.toHaveBeenCalled();
    expect(runtime.listSessionIds).not.toHaveBeenCalled();
    expect(statusCache.getSessionCwd).toHaveBeenCalledWith(
      sessions.get('Beta-39'),
      'Beta-39'
    );
    expect(statusCache.getSessionExecutionState).toHaveBeenCalledWith(
      sessions.get('Beta-39'),
      'Beta-39'
    );
    expect(statusCache.getDetachedSessionIds).toHaveBeenCalledWith({
      projects: [
        { name: 'Beta', path: '/repo/beta' },
        { name: 'Gamma', path: '/repo/gamma' },
      ],
      deletedSessionIds: new Set(),
      seenSessionIds: new Set(['Beta-39']),
    });
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'Beta-39',
        cwd: '/cached/beta',
        executionStatus: 'running',
        executionReason: 'agent_working',
      }),
      expect.objectContaining({
        sessionId: 'Gamma-1',
        cwd: null,
        executionStatus: 'unknown',
        executionReason: 'status_refresh_pending',
      }),
    ]));
  });

  it('includes per-session host reachability fields for sidebar truthful host states', () => {
    const sessions = new Map([
      ['Remote-1', {
        host: 'devbox',
        alive: true,
        wsAttached: true,
        cwd: '/srv/app',
        runtimeType: 'tmux',
        startedAt: '2026-07-08T10:00:00.000Z',
        lastOutputAt: '2026-07-08T10:00:01.000Z',
        lastSeq: 0,
      }],
    ]);
    const runtime = {
      type: 'tmux',
      getSessionCwd: vi.fn(),
      getSessionExecutionState: vi.fn(),
      listSessionIds: vi.fn(() => []),
    };

    const result = listTerminalSessions({
      sessions,
      runtime,
      projects: [{ name: 'Remote', path: '/srv/app', host: 'devbox' }],
      computeHealth: computeSessionHealth,
      computeStallReason,
      sanitizePreviewLine,
      getReachability: () => ({ reachability: 'unreachable', lastError: 'connect timeout', unreachableSince: 1720287000000 }),
    });

    expect(result[0]).toMatchObject({
      host: 'devbox',
      reachability: 'unreachable',
      lastError: 'connect timeout',
      unreachableSince: 1720287000000,
    });
  });

});
