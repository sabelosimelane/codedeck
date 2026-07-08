import { describe, expect, it } from 'vitest';
import {
  RESERVED_LOCAL_HOST,
  HOST_NAME_MAX_LENGTH,
  isReservedHostName,
  validateHostInput,
  findHostByName,
  addHost,
  updateHost,
  deleteHost,
  rewriteProjectHost,
  listHostsWithLocal,
} from '../host-service.js';

const HOSTS = [
  { name: 'devbox', sshTarget: 'devbox' },
  { name: 'prod', sshTarget: 'deploy@prod.example.com' },
];

// ---------------------------------------------------------------------------
// isReservedHostName
// ---------------------------------------------------------------------------

describe('isReservedHostName', () => {
  it.each(['local', 'Local', 'LOCAL', '  local  '])('treats %j as reserved', (name) => {
    expect(isReservedHostName(name)).toBe(true);
  });

  it('does not treat other names as reserved', () => {
    expect(isReservedHostName('devbox')).toBe(false);
    expect(isReservedHostName('local-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateHostInput
// ---------------------------------------------------------------------------

describe('validateHostInput', () => {
  it('accepts a valid host and returns trimmed values', () => {
    const result = validateHostInput({ name: '  devbox  ', sshTarget: '  deploy@dev-box.1  ' });
    expect(result.data).toEqual({ name: 'devbox', sshTarget: 'deploy@dev-box.1' });
  });

  it('rejects a missing/empty name with 400', () => {
    expect(validateHostInput({ name: '', sshTarget: 'devbox' })).toMatchObject({ status: 400 });
    expect(validateHostInput({ name: '   ', sshTarget: 'devbox' })).toMatchObject({ status: 400 });
    expect(validateHostInput({ sshTarget: 'devbox' })).toMatchObject({ status: 400 });
  });

  it(`rejects a name longer than ${HOST_NAME_MAX_LENGTH} chars with 400`, () => {
    const longName = 'a'.repeat(HOST_NAME_MAX_LENGTH + 1);
    expect(validateHostInput({ name: longName, sshTarget: 'devbox' })).toMatchObject({ status: 400 });
  });

  it('accepts a name of exactly the max length', () => {
    const maxName = 'a'.repeat(HOST_NAME_MAX_LENGTH);
    expect(validateHostInput({ name: maxName, sshTarget: 'devbox' }).data).toBeTruthy();
  });

  it.each(['local', 'LOCAL', 'Local'])('rejects the reserved name %j with 400', (name) => {
    expect(validateHostInput({ name, sshTarget: 'devbox' })).toMatchObject({ status: 400 });
  });

  it('rejects a missing/empty sshTarget with 400', () => {
    expect(validateHostInput({ name: 'devbox', sshTarget: '' })).toMatchObject({ status: 400 });
    expect(validateHostInput({ name: 'devbox' })).toMatchObject({ status: 400 });
  });

  it.each([
    'has space',
    'evil;rm',
    'user@host&whoami',
    'target|pipe',
    'bt`ick',
    '$(sub)',
  ])('rejects an sshTarget with whitespace or shell metacharacters: %j', (sshTarget) => {
    expect(validateHostInput({ name: 'devbox', sshTarget })).toMatchObject({ status: 400 });
  });

  it('rejects an sshTarget starting with a dash even though the regex allows dashes', () => {
    expect(validateHostInput({ name: 'devbox', sshTarget: '-oProxyCommand=x' })).toMatchObject({ status: 400 });
    // A leading dash on an otherwise-regex-valid target is still rejected.
    expect(validateHostInput({ name: 'devbox', sshTarget: '-leadingdash' })).toMatchObject({ status: 400 });
  });

  it('accepts a dash inside the sshTarget (dev-box)', () => {
    expect(validateHostInput({ name: 'devbox', sshTarget: 'dev-box' }).data).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// findHostByName
// ---------------------------------------------------------------------------

describe('findHostByName', () => {
  it('matches case-insensitively', () => {
    expect(findHostByName(HOSTS, 'DEVBOX')?.name).toBe('devbox');
  });

  it('returns undefined for an unknown name', () => {
    expect(findHostByName(HOSTS, 'nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// addHost
// ---------------------------------------------------------------------------

describe('addHost', () => {
  it('appends a valid host and returns it', () => {
    const result = addHost({ name: 'staging', sshTarget: 'staging' }, HOSTS);
    expect(result.data.host).toEqual({ name: 'staging', sshTarget: 'staging' });
    expect(result.data.hosts).toHaveLength(HOSTS.length + 1);
    expect(result.data.hosts.at(-1)).toEqual({ name: 'staging', sshTarget: 'staging' });
  });

  it('rejects a duplicate name (case-insensitive) with 409', () => {
    expect(addHost({ name: 'DevBox', sshTarget: 'other' }, HOSTS)).toMatchObject({ status: 409 });
  });

  it('does NOT enforce sshTarget uniqueness (two hosts may point at the same box)', () => {
    const result = addHost({ name: 'devbox2', sshTarget: 'devbox' }, HOSTS);
    expect(result.data.host).toEqual({ name: 'devbox2', sshTarget: 'devbox' });
  });

  it('propagates validation errors', () => {
    expect(addHost({ name: 'local', sshTarget: 'x' }, HOSTS)).toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// updateHost
// ---------------------------------------------------------------------------

describe('updateHost', () => {
  it('returns 404 for an unknown host', () => {
    expect(updateHost('ghost', { name: 'x' }, HOSTS)).toMatchObject({ status: 404 });
  });

  it('rejects modifying the reserved local host with 400', () => {
    expect(updateHost('local', { sshTarget: 'x' }, HOSTS)).toMatchObject({ status: 400 });
  });

  it('changes the sshTarget while keeping the name', () => {
    const result = updateHost('devbox', { sshTarget: 'devbox.new' }, HOSTS);
    expect(result.data.host).toEqual({ name: 'devbox', sshTarget: 'devbox.new' });
    expect(result.data.previousName).toBe('devbox');
  });

  it('renames a host and reports the previous name', () => {
    const result = updateHost('devbox', { name: 'devbox-renamed' }, HOSTS);
    expect(result.data.host.name).toBe('devbox-renamed');
    expect(result.data.previousName).toBe('devbox');
    expect(findHostByName(result.data.hosts, 'devbox-renamed')).toBeTruthy();
    expect(findHostByName(result.data.hosts, 'devbox')).toBeUndefined();
  });

  it('rejects renaming to a name that collides with another host (409)', () => {
    expect(updateHost('devbox', { name: 'PROD' }, HOSTS)).toMatchObject({ status: 409 });
  });

  it('allows a no-op rename to the same name (case variation) without a duplicate error', () => {
    const result = updateHost('devbox', { name: 'DevBox' }, HOSTS);
    expect(result.data.host.name).toBe('DevBox');
  });

  it('propagates sshTarget validation errors', () => {
    expect(updateHost('devbox', { sshTarget: 'has space' }, HOSTS)).toMatchObject({ status: 400 });
  });
});

// ---------------------------------------------------------------------------
// deleteHost
// ---------------------------------------------------------------------------

describe('deleteHost', () => {
  it('returns 404 for an unknown host', () => {
    expect(deleteHost('ghost', HOSTS, [])).toMatchObject({ status: 404 });
  });

  it('rejects deleting the reserved local host with 400', () => {
    expect(deleteHost('local', HOSTS, [])).toMatchObject({ status: 400 });
  });

  it('removes an unreferenced host', () => {
    const result = deleteHost('devbox', HOSTS, [{ name: 'p', path: '/x', host: 'prod' }]);
    expect(findHostByName(result.data.hosts, 'devbox')).toBeUndefined();
    expect(result.data.hosts).toHaveLength(HOSTS.length - 1);
  });

  it('blocks deletion while a project references the host (409) and leaves it intact', () => {
    const projects = [{ name: 'p', path: '/x', host: 'devbox' }];
    expect(deleteHost('devbox', HOSTS, projects)).toMatchObject({ status: 409 });
  });

  it('matches project references case-insensitively', () => {
    const projects = [{ name: 'p', path: '/x', host: 'DEVBOX' }];
    expect(deleteHost('devbox', HOSTS, projects)).toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------------------
// rewriteProjectHost
// ---------------------------------------------------------------------------

describe('rewriteProjectHost', () => {
  it('rewrites the host field on all referencing projects', () => {
    const projects = [
      { name: 'a', path: '/a', host: 'devbox' },
      { name: 'b', path: '/b', host: 'prod' },
      { name: 'c', path: '/c', host: 'DevBox' },
      { name: 'd', path: '/d' },
    ];
    const result = rewriteProjectHost(projects, 'devbox', 'devbox-renamed');
    expect(result.map(p => p.host)).toEqual(['devbox-renamed', 'prod', 'devbox-renamed', undefined]);
  });

  it('is a no-op when the name is unchanged', () => {
    const projects = [{ name: 'a', path: '/a', host: 'devbox' }];
    expect(rewriteProjectHost(projects, 'devbox', 'devbox')).toBe(projects);
  });
});

// ---------------------------------------------------------------------------
// listHostsWithLocal
// ---------------------------------------------------------------------------

describe('listHostsWithLocal', () => {
  it('always lists the built-in local host first', () => {
    const list = listHostsWithLocal(HOSTS);
    expect(list[0]).toEqual({ name: 'local', sshTarget: null, builtIn: true, reachability: 'reachable' });
    expect(list.slice(1).map(h => h.name)).toEqual(['devbox', 'prod']);
  });

  it('defaults stored-host reachability to unknown when no resolver is given', () => {
    const list = listHostsWithLocal(HOSTS);
    expect(list[1]).toEqual({ name: 'devbox', sshTarget: 'devbox', builtIn: false, reachability: 'unknown' });
  });

  it('includes live reachability, lastError and unreachableSince from the resolver', () => {
    const list = listHostsWithLocal(HOSTS, (name) =>
      name === 'devbox'
        ? { reachability: 'unreachable', lastError: 'connect timeout', unreachableSince: 1720287000000 }
        : { reachability: 'reachable' }
    );
    expect(list[1]).toEqual({
      name: 'devbox',
      sshTarget: 'devbox',
      builtIn: false,
      reachability: 'unreachable',
      lastError: 'connect timeout',
      unreachableSince: 1720287000000,
    });
    expect(list[2].reachability).toBe('reachable');
    expect(list[2]).not.toHaveProperty('lastError');
  });

  it('handles an empty stored-hosts list (local only)', () => {
    expect(listHostsWithLocal([])).toEqual([
      { name: 'local', sshTarget: null, builtIn: true, reachability: 'reachable' },
    ]);
    expect(listHostsWithLocal()).toHaveLength(1);
  });
});
