import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addProjectRepository, getRepositoryCandidates, listProjectRepositories, openProjectTerminal, parseCandidate, parseRepository, removeProjectRepository,
} from '../projectRepositoriesApi';

const HEAD = 'a'.repeat(40);
const repository = (overrides = {}) => ({
  name: 'mobile-app', path: '/tmp/group/mobile-app', own: false, branch: 'main', head: HEAD, dirty: false, usable: true, reason: null, ...overrides,
});
const unusable = { branch: null, head: null, dirty: null, usable: false, reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' } };
const reply = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });
const page = (data, { hasNextPage = false, totalElements = data.length } = {}) => ({ data, page: { currentPage: 0, size: 100, totalElements, totalPages: 1, hasNextPage } });
afterEach(() => vi.unstubAllGlobals());

describe('parseRepository', () => {
  it('returns exactly the known fields', () => {
    expect(parseRepository({ ...repository(), surprise: true })).toEqual(repository());
    expect(parseRepository(repository({ own: true, branch: null, dirty: true }))).toMatchObject({ own: true, branch: null, dirty: true });
    expect(parseRepository(repository(unusable))).toEqual(repository(unusable));
  });

  it.each([
    ['name', ''], ['name', 'a/b'], ['name', null], ['path', 'relative'], ['path', null], ['own', 'yes'], ['own', undefined],
    ['branch', ''], ['branch', 7], ['head', 'abc'], ['dirty', 'no'], ['usable', 1], ['usable', undefined],
    ['reason', 'broken'], ['reason', { code: '', message: 'x' }], ['reason', { code: 'x', message: '' }],
  ])('refuses an invalid %s (%j)', (field, value) => {
    expect(() => parseRepository(repository({ [field]: value }))).toThrow(new RegExp(`field ${field}`));
  });

  it('refuses a usable repository without its Git facts, and an unusable one without a reason', () => {
    expect(() => parseRepository(repository({ head: null }))).toThrow('field head');
    expect(() => parseRepository(repository({ dirty: null }))).toThrow('field dirty');
    expect(() => parseRepository(repository({ ...unusable, reason: null }))).toThrow('field reason');
    expect(() => parseRepository(repository({ reason: unusable.reason }))).toThrow('field reason');
  });

  it('refuses a non-object', () => {
    expect(() => parseRepository(null, 2)).toThrow('Invalid repository index 2 field repository');
  });
});

describe('parseCandidate', () => {
  it('returns the name, the path and the branch', () => {
    expect(parseCandidate({ name: 'frontend', path: '/tmp/group/frontend', branch: 'feat/setup', extra: 1 })).toEqual({ name: 'frontend', path: '/tmp/group/frontend', branch: 'feat/setup' });
    expect(parseCandidate({ name: 'frontend', path: '/tmp/group/frontend', branch: null })).toEqual({ name: 'frontend', path: '/tmp/group/frontend', branch: null });
  });
  it.each([['name', ''], ['name', 'a/b'], ['path', 'frontend'], ['path', undefined], ['branch', undefined], ['branch', ''], ['branch', 7]])('refuses an invalid %s (%j)', (field, value) => {
    expect(() => parseCandidate({ name: 'frontend', path: '/tmp/group/frontend', branch: 'main', [field]: value })).toThrow(new RegExp(`field ${field}`));
  });
});

describe('project repositories API client', () => {
  it('lists every page of a project\'s repositories', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply(page([repository({ name: 'backend', path: '/tmp/group/backend', own: true })], { hasNextPage: true })))
      .mockResolvedValueOnce(reply(page([repository()])));
    vi.stubGlobal('fetch', fetchMock);
    expect((await listProjectRepositories('My project')).map(entry => entry.name)).toEqual(['backend', 'mobile-app']);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      '/api/projects/My%20project/repositories?size=100&page=0',
      '/api/projects/My%20project/repositories?size=100&page=1',
    ]);
  });

  it('reads one page of the repositories beside the project', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(page([{ name: 'frontend', path: '/tmp/group/frontend', branch: 'feat/setup' }], { hasNextPage: true, totalElements: 31 })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getRepositoryCandidates('Demo', 2)).toEqual({ candidates: [{ name: 'frontend', path: '/tmp/group/frontend', branch: 'feat/setup' }], hasNextPage: true, total: 31 });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/projects/Demo/repository-candidates?size=20&page=2');
    await expect(getRepositoryCandidates('Demo', -1)).rejects.toThrow('page must be a whole number from 0');
  });

  it('adds a repository by its folder', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(repository(), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await addProjectRepository('Demo', '/tmp/group/mobile-app')).toEqual(repository());
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/Demo/repositories', {
      method: 'POST', signal: undefined, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/tmp/group/mobile-app' }),
    });
  });

  it('removes a repository by its name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error('no body'); } });
    vi.stubGlobal('fetch', fetchMock);
    await expect(removeProjectRepository('Demo', 'mobile app')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/Demo/repositories/mobile%20app', { method: 'DELETE', signal: undefined });
  });

  it('opens a terminal in one of the project\'s repositories', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ sessionId: 'Demo-4', project: 'Demo', repository: 'mobile-app', path: '/tmp/group/mobile-app', extra: 1 }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await openProjectTerminal('Demo', 'mobile-app')).toEqual({ sessionId: 'Demo-4', project: 'Demo', repository: 'mobile-app', path: '/tmp/group/mobile-app' });
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/Demo/terminals', {
      method: 'POST', signal: undefined, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repository: 'mobile-app' }),
    });
  });

  it.each([
    ['sessionId', { sessionId: '' }], ['project', { project: 'Other' }], ['repository', { repository: 'frontend' }], ['path', { path: 'relative' }],
  ])('refuses a terminal answer with a wrong %s', async (field, wrong) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ sessionId: 'Demo-4', project: 'Demo', repository: 'mobile-app', path: '/tmp/group/mobile-app', ...wrong })));
    await expect(openProjectTerminal('Demo', 'mobile-app')).rejects.toThrow(`Invalid project terminal response: ${field}`);
  });

  it.each([
    [() => openProjectTerminal('Demo', ''), 'repository must be a nonempty string'],
    [() => openProjectTerminal('', 'mobile-app'), 'project must be a nonempty string'],
    [() => listProjectRepositories(''), 'project must be a nonempty string'],
    [() => getRepositoryCandidates(null, 0), 'project must be a nonempty string'],
    [() => addProjectRepository('Demo', 'relative'), 'path must be an absolute path'],
    [() => addProjectRepository('Demo', null), 'path must be an absolute path'],
    [() => removeProjectRepository('Demo', ''), 'repository must be a nonempty string'],
  ])('refuses a call it cannot send', async (call, message) => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(call()).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the field the backend refused, else its message, else a general one', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(reply({ message: 'One or more fields failed validation.', errors: [{ field: 'path', message: 'This folder does not exist' }] }, { ok: false, status: 400 }))
      .mockResolvedValueOnce(reply({ message: 'This repository is already part of the project.' }, { ok: false, status: 409 }))
      .mockResolvedValueOnce(reply({}, { ok: false, status: 500 }))
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }));
    await expect(addProjectRepository('Demo', '/tmp/x')).rejects.toMatchObject({ message: 'This folder does not exist', status: 400 });
    await expect(addProjectRepository('Demo', '/tmp/x')).rejects.toMatchObject({ message: 'This repository is already part of the project.', status: 409 });
    await expect(addProjectRepository('Demo', '/tmp/x')).rejects.toThrow('Something went wrong. Please try again.');
    await expect(addProjectRepository('Demo', '/tmp/x')).rejects.toThrow('Something went wrong. Please try again.');
  });

  it('says so when the backend cannot be reached, and refuses a response it cannot read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(reply({ data: 'nope' })).mockResolvedValueOnce(reply(page([{ name: '' }]))));
    await expect(listProjectRepositories('Demo')).rejects.toThrow('Server unreachable');
    await expect(listProjectRepositories('Demo')).rejects.toThrow('Invalid repositories response');
    await expect(listProjectRepositories('Demo')).rejects.toThrow('Invalid repository index 0 field name');
  });
});
