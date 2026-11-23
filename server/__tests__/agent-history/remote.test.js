import { describe, expect, it, vi } from 'vitest';
import { createRemoteAgentHistory } from '../../agent-history/remote.js';

const UUID_1 = '11111111-1111-4111-8111-111111111111';

describe('createRemoteAgentHistory', () => {
  it('fetches, validates, tags records with host, and caches within TTL', async () => {
    let clock = 1000;
    const run = vi.fn(async () => ({
      stdout: JSON.stringify({
        sources: [{ cli: 'claude', available: true }, { cli: 'codex', available: false }],
        records: [{ cli: 'claude', conversationId: UUID_1, title: 'Remote chat', firstPrompt: null, cwd: '/home/u/proj', updatedAt: 5000 }],
      }),
    }));
    const remote = createRemoteAgentHistory({
      resolveHostRunner: host => ({ hostName: host, runner: { kind: 'ssh', run } }),
      ttlMs: 30_000,
      now: () => clock,
    });

    const first = await remote.listHost('devbox', ['/home/u/proj']);
    expect(first.records).toEqual([
      { cli: 'claude', conversationId: UUID_1, title: 'Remote chat', firstPrompt: null, cwd: '/home/u/proj', updatedAt: 5000, host: 'devbox' },
    ]);
    expect(run).toHaveBeenCalledTimes(1);

    // Within TTL: served from cache
    clock += 10_000;
    const second = await remote.listHost('devbox', ['/home/u/proj']);
    expect(second).toBe(first);
    expect(run).toHaveBeenCalledTimes(1);

    // Invalidate forces re-fetch
    remote.invalidate('devbox');
    await remote.listHost('devbox', ['/home/u/proj']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent in-flight requests for the same host and cwd set', async () => {
    let release;
    const run = vi.fn(() => new Promise(resolve => {
      release = () => resolve({ stdout: JSON.stringify({ sources: [], records: [] }) });
    }));
    const remote = createRemoteAgentHistory({
      resolveHostRunner: host => ({ hostName: host, runner: { kind: 'ssh', run } }),
    });

    const p1 = remote.listHost('devbox', ['/a', '/b']);
    const p2 = remote.listHost('devbox', ['/b', '/a']);
    release();
    await Promise.all([p1, p2]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
