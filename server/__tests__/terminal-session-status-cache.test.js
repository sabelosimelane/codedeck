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
      getSessionCwdAsync: vi.fn(async () => '/live/beta'),
      getSessionExecutionStateAsync: vi.fn(async () => ({
        executionStatus: 'running',
        foregroundCommand: 'node',
        executionReason: 'agent_working',
        executionConfidence: 'high',
      })),
      listSessionIdsAsync: vi.fn(async () => []),
    };
    const entry = { cwd: '/fallback/beta', alive: true };
    const cache = createTerminalStatusCache({ runtime });

    expect(cache.getSessionCwd(entry, 'Beta-39')).toBe('/fallback/beta');
    expect(cache.getSessionExecutionState(entry, 'Beta-39')).toEqual(
      STATUS_REFRESH_PENDING_EXECUTION_STATE
    );

    await cache.waitForIdle();

    expect(cache.getSessionCwd(entry, 'Beta-39')).toBe('/live/beta');
    expect(cache.getSessionExecutionState(entry, 'Beta-39')).toMatchObject({
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
    const entry = { cwd: '/fallback/beta', alive: true };
    const cache = createTerminalStatusCache({ runtime });

    cache.getSessionCwd(entry, 'Beta-39');
    cache.getSessionExecutionState(entry, 'Beta-39');
    cache.getSessionCwd(entry, 'Beta-39');
    cache.getSessionExecutionState(entry, 'Beta-39');

    expect(runtime.getSessionCwdAsync).toHaveBeenCalledTimes(1);
    expect(runtime.getSessionExecutionStateAsync).toHaveBeenCalledTimes(1);

    cwd.resolve('/live/beta');
    execution.resolve({
      executionStatus: 'idle',
      foregroundCommand: 'zsh',
      executionReason: 'shell_prompt',
      executionConfidence: 'high',
    });
    await cache.waitForIdle();

    expect(cache.getSessionCwd(entry, 'Beta-39')).toBe('/live/beta');
    expect(cache.getSessionExecutionState(entry, 'Beta-39')).toMatchObject({
      executionStatus: 'idle',
      executionReason: 'shell_prompt',
    });
  });

  it('bounds concurrent refresh work', async () => {
    const firstCwd = createDeferred();
    const runtime = {
      getSessionCwdAsync: vi.fn((entry, sessionId) => (
        sessionId === 'Beta-39' ? firstCwd.promise : Promise.resolve(`/live/${sessionId}`)
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

    cache.getSessionCwd({ cwd: '/fallback/beta', alive: true }, 'Beta-39');
    cache.getSessionCwd({ cwd: '/fallback/gamma', alive: true }, 'Gamma-1');

    expect(runtime.getSessionCwdAsync).toHaveBeenCalledTimes(1);
    expect(runtime.getSessionCwdAsync).toHaveBeenCalledWith(
      { cwd: '/fallback/beta', alive: true },
      'Beta-39'
    );

    firstCwd.resolve('/live/beta');
    await cache.waitForIdle();

    expect(runtime.getSessionCwdAsync).toHaveBeenCalledTimes(2);
    expect(
      cache.getSessionCwd({ cwd: '/fallback/gamma', alive: true }, 'Gamma-1')
    ).toBe('/live/Gamma-1');
  });

  it('filters cached detached tmux sessions without synchronous runtime calls', async () => {
    const runtime = {
      getSessionCwdAsync: vi.fn(async () => null),
      getSessionExecutionStateAsync: vi.fn(async () => STATUS_REFRESH_PENDING_EXECUTION_STATE),
      listSessionIdsAsync: vi.fn(async () => ['Beta-39', 'Gamma-1', 'orphan-1']),
    };
    const cache = createTerminalStatusCache({ runtime });
    const params = {
      projects: [
        { name: 'Beta', path: '/repo/beta' },
        { name: 'Gamma', path: '/repo/gamma' },
      ],
      deletedSessionIds: new Set(['Gamma-1']),
      seenSessionIds: new Set(),
    };

    expect(cache.getDetachedSessionIds(params)).toEqual([]);
    await cache.waitForIdle();

    expect(cache.getDetachedSessionIds(params)).toEqual(['Beta-39']);
    expect(runtime.listSessionIdsAsync).toHaveBeenCalledTimes(1);
    expect(runtime.getSessionCwdAsync).not.toHaveBeenCalled();
    expect(runtime.getSessionExecutionStateAsync).not.toHaveBeenCalled();
  });
});
