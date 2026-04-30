import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalStatusCache,
  STATUS_REFRESH_PENDING_EXECUTION_STATE,
} from '../terminal-session-status-cache.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('createTerminalStatusCache', () => {
  it('returns fallback values immediately and then serves refreshed async tmux status', async () => {
    const runtime = {
      getSessionCwdAsync: vi.fn(async () => '/live/mace'),
      getSessionExecutionStateAsync: vi.fn(async () => ({
        executionStatus: 'running',
        foregroundCommand: 'node',
        executionReason: 'agent_working',
        executionConfidence: 'high',
      })),
      listSessionIdsAsync: vi.fn(async () => []),
    };
    const entry = { cwd: '/fallback/mace', alive: true };
    const cache = createTerminalStatusCache({ runtime });

    expect(cache.getSessionCwd(entry, 'Mace-39')).toBe('/fallback/mace');
    expect(cache.getSessionExecutionState(entry, 'Mace-39')).toEqual(
      STATUS_REFRESH_PENDING_EXECUTION_STATE
    );

    await cache.waitForIdle();

    expect(cache.getSessionCwd(entry, 'Mace-39')).toBe('/live/mace');
    expect(cache.getSessionExecutionState(entry, 'Mace-39')).toMatchObject({
      executionStatus: 'running',
      executionReason: 'agent_working',
    });
    expect(runtime.getSessionCwdAsync).toHaveBeenCalledTimes(1);
    expect(runtime.getSessionExecutionStateAsync).toHaveBeenCalledTimes(1);
  });

  it('dedupes in-flight per-session refreshes', async () => {
    const cwd = createDeferred();
    const execution = createDeferred();
    const runtime = {
      getSessionCwdAsync: vi.fn(() => cwd.promise),
      getSessionExecutionStateAsync: vi.fn(() => execution.promise),
      listSessionIdsAsync: vi.fn(async () => []),
    };
    const entry = { cwd: '/fallback/mace', alive: true };
    const cache = createTerminalStatusCache({ runtime });

    cache.getSessionCwd(entry, 'Mace-39');
    cache.getSessionExecutionState(entry, 'Mace-39');
    cache.getSessionCwd(entry, 'Mace-39');
    cache.getSessionExecutionState(entry, 'Mace-39');

    expect(runtime.getSessionCwdAsync).toHaveBeenCalledTimes(1);
    expect(runtime.getSessionExecutionStateAsync).toHaveBeenCalledTimes(1);

    cwd.resolve('/live/mace');
    execution.resolve({
      executionStatus: 'idle',
      foregroundCommand: 'zsh',
      executionReason: 'shell_prompt',
      executionConfidence: 'high',
    });
    await cache.waitForIdle();

    expect(cache.getSessionCwd(entry, 'Mace-39')).toBe('/live/mace');
    expect(cache.getSessionExecutionState(entry, 'Mace-39')).toMatchObject({
      executionStatus: 'idle',
      executionReason: 'shell_prompt',
    });
  });

  it('bounds concurrent refresh work', async () => {
    const firstCwd = createDeferred();
    const runtime = {
      getSessionCwdAsync: vi.fn((entry, sessionId) => (
        sessionId === 'Mace-39' ? firstCwd.promise : Promise.resolve(`/live/${sessionId}`)
      )),
      getSessionExecutionStateAsync: vi.fn(async () => ({
        executionStatus: 'idle',
        foregroundCommand: 'zsh',
        executionReason: 'shell_prompt',
        executionConfidence: 'high',
      })),
      listSessionIdsAsync: vi.fn(async () => []),
    };
    const cache = createTerminalStatusCache({
      runtime,
      maxConcurrentRefreshes: 1,
    });

    cache.getSessionCwd({ cwd: '/fallback/mace', alive: true }, 'Mace-39');
    cache.getSessionCwd({ cwd: '/fallback/bookme', alive: true }, 'BookMe-1');

    expect(runtime.getSessionCwdAsync).toHaveBeenCalledTimes(1);
    expect(runtime.getSessionCwdAsync).toHaveBeenCalledWith(
      { cwd: '/fallback/mace', alive: true },
      'Mace-39'
    );

    firstCwd.resolve('/live/mace');
    await cache.waitForIdle();

    expect(runtime.getSessionCwdAsync).toHaveBeenCalledTimes(2);
    expect(
      cache.getSessionCwd({ cwd: '/fallback/bookme', alive: true }, 'BookMe-1')
    ).toBe('/live/BookMe-1');
  });

  it('filters cached detached tmux sessions without synchronous runtime calls', async () => {
    const runtime = {
      getSessionCwdAsync: vi.fn(async () => null),
      getSessionExecutionStateAsync: vi.fn(async () => STATUS_REFRESH_PENDING_EXECUTION_STATE),
      listSessionIdsAsync: vi.fn(async () => ['Mace-39', 'BookMe-1', 'orphan-1']),
    };
    const cache = createTerminalStatusCache({ runtime });
    const params = {
      projects: [
        { name: 'Mace', path: '/repo/mace' },
        { name: 'BookMe', path: '/repo/bookme' },
      ],
      deletedSessionIds: new Set(['BookMe-1']),
      seenSessionIds: new Set(),
    };

    expect(cache.getDetachedSessionIds(params)).toEqual([]);
    await cache.waitForIdle();

    expect(cache.getDetachedSessionIds(params)).toEqual(['Mace-39']);
    expect(runtime.listSessionIdsAsync).toHaveBeenCalledTimes(1);
    expect(runtime.getSessionCwdAsync).not.toHaveBeenCalled();
    expect(runtime.getSessionExecutionStateAsync).not.toHaveBeenCalled();
  });
});
