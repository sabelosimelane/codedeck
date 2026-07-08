import { describe, expect, it, vi } from 'vitest';
import { createHostRuntimeResolver } from '../host-runtime-resolver.js';

const HOSTS = [{ name: 'devbox', sshTarget: 'devbox' }];

function makeResolver({
  projects = [],
  hosts = HOSTS,
  createRuntime,
  getReachability,
} = {}) {
  const created = [];
  const resolver = createHostRuntimeResolver({
    loadProjects: () => projects,
    loadHosts: () => hosts,
    createRuntime: createRuntime ?? vi.fn((host) => {
      const runtime = { host: host.name, sshTarget: host.sshTarget, listSessionIdsAsync: vi.fn(async () => []) };
      created.push(runtime);
      return runtime;
    }),
    getReachability,
  });
  return { resolver, created };
}

describe('findSessionProject', () => {
  it('matches ${projectName}-N session ids, including names containing dashes', () => {
    const { resolver } = makeResolver({
      projects: [{ name: 'app', path: '/a' }, { name: 'app-2', path: '/b' }],
    });
    expect(resolver.findSessionProject('app-3')?.name).toBe('app');
    expect(resolver.findSessionProject('app-2-1')?.name).toBe('app-2');
    expect(resolver.findSessionProject('other-1')).toBeUndefined();
  });

  it('escapes regex metacharacters in project names', () => {
    const { resolver } = makeResolver({ projects: [{ name: 'a.b', path: '/x' }] });
    expect(resolver.findSessionProject('a.b-1')?.name).toBe('a.b');
    expect(resolver.findSessionProject('aXb-1')).toBeUndefined();
  });
});

describe('resolveHostRuntime', () => {
  it('returns null for local, unknown, and deleted-host sessions', () => {
    const { resolver } = makeResolver({
      projects: [
        { name: 'lp', path: '/l' },
        { name: 'ghosted', path: '/g', host: 'gone' },
      ],
    });
    expect(resolver.resolveHostRuntime('lp-1')).toBeNull();
    expect(resolver.resolveHostRuntime('unknown-1')).toBeNull();
    expect(resolver.resolveHostRuntime('ghosted-1')).toBeNull();
  });

  it('resolves a remote project to its host runtime', () => {
    const { resolver } = makeResolver({ projects: [{ name: 'rp', path: '/r', host: 'devbox' }] });
    const resolution = resolver.resolveHostRuntime('rp-1');
    expect(resolution.host).toBe('devbox');
    expect(resolution.hostRuntime.host).toBe('devbox');
  });

  it('caches one runtime per host descriptor and rebuilds after the sshTarget changes', () => {
    const hosts = [{ name: 'devbox', sshTarget: 'devbox' }];
    const { resolver, created } = makeResolver({
      projects: [{ name: 'rp', path: '/r', host: 'devbox' }],
      hosts,
    });

    const first = resolver.resolveHostRuntime('rp-1').hostRuntime;
    const second = resolver.resolveHostRuntime('rp-1').hostRuntime;
    expect(second).toBe(first);
    expect(created).toHaveLength(1);

    // sshTarget changes (PUT /api/hosts): resolutions must use the new target.
    hosts[0] = { name: 'devbox', sshTarget: 'devbox.new' };
    const third = resolver.resolveHostRuntime('rp-1').hostRuntime;
    expect(third).not.toBe(first);
    expect(third.sshTarget).toBe('devbox.new');
  });
});

describe('listAllSessionIds', () => {
  it('skips hosts whose reachability is already unreachable without polling them', async () => {
    const hostRuntime = { listSessionIdsAsync: vi.fn(async () => ['rp-1']) };
    const { resolver } = makeResolver({
      createRuntime: () => hostRuntime,
      getReachability: () => ({ reachability: 'unreachable', lastError: 'connect timeout' }),
    });
    const localRuntime = { listSessionIdsAsync: vi.fn(async () => ['lp-1']) };

    await expect(resolver.listAllSessionIds(localRuntime)).resolves.toEqual(['lp-1']);
    expect(hostRuntime.listSessionIdsAsync).not.toHaveBeenCalled();
  });

  it('merges local and per-host ids, deduplicated, skipping failed hosts', async () => {
    const hostRuntime = { listSessionIdsAsync: vi.fn(async () => ['rp-1', 'shared-1']) };
    const { resolver } = makeResolver({ createRuntime: () => hostRuntime });
    const localRuntime = { listSessionIdsAsync: vi.fn(async () => ['lp-1', 'shared-1']) };

    await expect(resolver.listAllSessionIds(localRuntime)).resolves.toEqual(['lp-1', 'shared-1', 'rp-1']);
  });
});
