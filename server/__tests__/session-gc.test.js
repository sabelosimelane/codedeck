import { describe, expect, it, vi } from 'vitest';
import { pruneTerminalSessions, shouldPruneTerminalSession } from '../session-gc.js';

function createEntry(overrides = {}) {
  return {
    alive: true,
    wsAttached: false,
    startedAt: '2026-04-12T10:00:00.000Z',
    lastAttachAt: '2026-04-12T10:00:00.000Z',
    lastDetachAt: '2026-04-12T10:00:10.000Z',
    pty: { kill: vi.fn() },
    ...overrides,
  };
}

describe('shouldPruneTerminalSession', () => {
  it('prunes unrecoverable dead sessions shortly after detach', () => {
    const runtime = { isSessionRecoverable: vi.fn(() => false) };
    const entry = createEntry({ alive: false });

    expect(shouldPruneTerminalSession({
      entry,
      sessionId: 'demo-1',
      runtime,
      nowMs: Date.parse('2026-04-12T10:00:30.000Z'),
    })).toBe(true);
  });

  it('retains recoverable tmux sessions inside the reconnect window', () => {
    const runtime = { isSessionRecoverable: vi.fn(() => true) };
    const entry = createEntry({ alive: false });

    expect(shouldPruneTerminalSession({
      entry,
      sessionId: 'demo-1',
      runtime,
      nowMs: Date.parse('2026-04-12T10:05:00.000Z'),
    })).toBe(false);
  });

  it('never prunes sessions with an attached websocket', () => {
    const runtime = { isSessionRecoverable: vi.fn(() => false) };
    const entry = createEntry({ wsAttached: true });

    expect(shouldPruneTerminalSession({
      entry,
      sessionId: 'demo-1',
      runtime,
      nowMs: Date.parse('2026-04-12T11:00:00.000Z'),
    })).toBe(false);
  });
});

describe('pruneTerminalSessions', () => {
  it('kills and removes prunable sessions from the registry', () => {
    const runtime = {
      kill: vi.fn(),
      isSessionRecoverable: vi.fn((sessionId) => sessionId === 'keep-1'),
    };
    const sessions = new Map([
      ['drop-1', createEntry({ alive: false })],
      ['keep-1', createEntry({ alive: false })],
    ]);
    const onPruned = vi.fn();

    const pruned = pruneTerminalSessions({
      sessions,
      runtime,
      nowMs: Date.parse('2026-04-12T10:00:30.000Z'),
      onPruned,
    });

    expect(pruned).toEqual(['drop-1']);
    expect(runtime.kill).toHaveBeenCalledTimes(1);
    expect(runtime.kill).toHaveBeenCalledWith(expect.objectContaining({ alive: false }), 'drop-1');
    expect(sessions.has('drop-1')).toBe(false);
    expect(sessions.has('keep-1')).toBe(true);
    expect(onPruned).toHaveBeenCalledWith('drop-1', expect.objectContaining({ alive: false }));
  });

  it('still removes stale sessions when runtime.kill throws', () => {
    const runtime = {
      kill: vi.fn(() => { throw new Error('already dead'); }),
      isSessionRecoverable: vi.fn(() => false),
    };
    const sessions = new Map([
      ['drop-1', createEntry({ alive: false })],
    ]);

    const pruned = pruneTerminalSessions({
      sessions,
      runtime,
      nowMs: Date.parse('2026-04-12T10:00:30.000Z'),
    });

    expect(pruned).toEqual(['drop-1']);
    expect(sessions.size).toBe(0);
  });
});
