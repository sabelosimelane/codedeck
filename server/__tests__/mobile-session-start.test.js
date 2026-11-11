import { describe, expect, it, vi } from 'vitest';
import { createMobileSessionStarter } from '../mobile-session-start.js';

const INCARNATION = '8d7f3a7e-8a54-4d5b-9d5e-7f4b6a0c2e11';
const project = (name, extra = {}) => ({ name, path: `/work/${name}`, shelved: false, shelvedAt: null, waiting: false, waitingAt: null, ...extra });

function setup({ projects = [project('alpha')], remote = null, createFails = null } = {}) {
  let saved = projects;
  let next = 1;
  const calls = [];
  const localRuntime = {
    createDetachedSession: vi.fn(input => { calls.push(['create', input.sessionId]); if (createFails) throw createFails; }),
    getSessionIncarnationAsync: vi.fn(async () => INCARNATION),
  };
  const hostRuntime = {
    createDetachedSessionAsync: vi.fn(async () => { if (createFails) throw createFails; }),
    getSessionIncarnationAsync: vi.fn(async () => INCARNATION),
  };
  const deps = {
    loadProjects: vi.fn(() => saved),
    saveProjects: vi.fn(value => { saved = value; }),
    reserveSessionId: vi.fn(async name => { calls.push(['reserve', name]); await Promise.resolve(); return { sessionId: `${name}-${next++}` }; }),
    releaseReservation: vi.fn(id => calls.push(['release', id])),
    localRuntime,
    resolveHostRuntime: vi.fn(id => (remote && id.startsWith(`${remote}-`) ? { host: 'media-server', hostRuntime } : null)),
    store: { adoptIncarnation: vi.fn((_id, value) => value) },
    now: () => 5000,
  };
  return { starter: createMobileSessionStarter(deps), deps, localRuntime, hostRuntime, calls, saved: () => saved };
}

describe('createMobileSessionStarter', () => {
  it('starts a durable session in the project folder and describes it for the phone', async () => {
    const { starter, deps, localRuntime } = setup();
    const result = await starter.start('alpha');
    expect(localRuntime.createDetachedSession).toHaveBeenCalledWith({ cwd: '/work/alpha', cols: 120, rows: 32, sessionId: 'alpha-1' });
    expect(deps.store.adoptIncarnation).toHaveBeenCalledWith('alpha-1', INCARNATION);
    expect(result).toEqual({ id: 'alpha-1', incarnationId: INCARNATION, projectId: 'alpha', title: 'alpha-1', status: 'idle', live: true, cwd: '/work/alpha', host: 'local', runtimeType: 'tmux', finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: 5000 });
    expect(deps.releaseReservation).toHaveBeenCalledWith('alpha-1');
    expect(deps.saveProjects).not.toHaveBeenCalled();
  });

  it('starts remote-project sessions on their host', async () => {
    const { starter, hostRuntime, localRuntime } = setup({ projects: [project('beta', { host: 'media-server' })], remote: 'beta' });
    const result = await starter.start('beta');
    expect(hostRuntime.createDetachedSessionAsync).toHaveBeenCalledWith({ cwd: '/work/beta', cols: 120, rows: 32, sessionId: 'beta-1' });
    expect(localRuntime.createDetachedSession).not.toHaveBeenCalled();
    expect(result.host).toBe('media-server');
  });

  it('restores a shelved project the same way the desktop does, after its session exists', async () => {
    const { starter, deps, saved } = setup({ projects: [project('alpha', { shelved: true, shelvedAt: '2026-11-01T10:00:00.000Z' }), project('other')] });
    await starter.start('alpha');
    expect(deps.saveProjects).toHaveBeenCalledTimes(1);
    expect(saved()[0]).toEqual(project('alpha'));
    expect(saved()[1]).toEqual(project('other'));
  });

  it('leaves a waiting project parked', async () => {
    const waiting = project('alpha', { waiting: true, waitingAt: '2026-11-01T10:00:00.000Z' });
    const { starter, deps } = setup({ projects: [waiting] });
    await starter.start('alpha');
    expect(deps.saveProjects).not.toHaveBeenCalled();
  });

  it('keeps a shelved project shelved and frees the id when the session cannot start', async () => {
    const { starter, deps } = setup({ projects: [project('alpha', { shelved: true, shelvedAt: '2026-11-01T10:00:00.000Z' })], createFails: new Error('tmux refused') });
    await expect(starter.start('alpha')).rejects.toThrow('tmux refused');
    expect(deps.saveProjects).not.toHaveBeenCalled();
    expect(deps.releaseReservation).toHaveBeenCalledWith('alpha-1');
    expect(deps.store.adoptIncarnation).not.toHaveBeenCalled();
  });

  it('reports an unknown project as 404', async () => {
    const { starter } = setup();
    await expect(starter.start('missing')).rejects.toMatchObject({ status: 404, message: 'Project not found' });
  });

  it('serializes concurrent starts so each request gets its own session', async () => {
    const { starter, calls } = setup();
    const [first, second] = await Promise.all([starter.start('alpha'), starter.start('alpha')]);
    expect([first.id, second.id]).toEqual(['alpha-1', 'alpha-2']);
    expect(calls.map(([step]) => step)).toEqual(['reserve', 'create', 'release', 'reserve', 'create', 'release']);
  });

  it('keeps serving after a failed start', async () => {
    const { starter } = setup();
    await expect(starter.start('missing')).rejects.toMatchObject({ status: 404 });
    await expect(starter.start('alpha')).resolves.toMatchObject({ id: 'alpha-1' });
  });

  it('fails loudly when a stored project has no folder', async () => {
    const { starter, deps } = setup({ projects: [project('alpha', { path: '' })] });
    await expect(starter.start('alpha')).rejects.toThrow(/path/);
    expect(deps.reserveSessionId).not.toHaveBeenCalled();
  });

  it('fails loudly when the reservation does not belong to the project', async () => {
    const { starter, deps } = setup();
    deps.reserveSessionId.mockResolvedValueOnce({ sessionId: 'other-1' });
    await expect(starter.start('alpha')).rejects.toThrow(/sessionId/);
  });

  it.each(['loadProjects', 'saveProjects', 'reserveSessionId', 'releaseReservation', 'resolveHostRuntime', 'localRuntime', 'store', 'now'])('requires %s', field => {
    const { deps } = setup();
    expect(() => createMobileSessionStarter({ ...deps, [field]: undefined })).toThrow(new RegExp(field));
  });
});
