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
      getSessionCwd: vi.fn(() => '/tmp/bookme'),
      listSessionIds: vi.fn(() => ['BookMe-9']),
    };

    const result = listTerminalSessions({
      sessions: new Map(),
      runtime,
      projects: [{ name: 'BookMe', path: '/tmp/bookme' }],
      deletedSessionIds: new Set(['BookMe-9']),
      computeHealth: computeSessionHealth,
      computeStallReason,
      sanitizePreviewLine,
    });

    expect(result).toEqual([]);
  });
});
