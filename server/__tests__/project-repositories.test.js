import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createProjectRepositories, readStoredRepositories, RepositoryError, MAX_OTHER_REPOSITORIES } from '../project-repositories.js';
import { normalizeProjects } from '../project-config.js';
import { git, groupFixture, repository } from './helpers/group-fixture.js';

async function rejection(promise) {
  try { await promise; } catch (error) { return error; }
  throw new Error('expected a rejection');
}

describe('a project\'s repositories', () => {
  it('lists the project\'s own repository when it has no others', async () => {
    const { service, backend } = groupFixture();
    expect(await service.list('Demo')).toEqual([{
      name: 'backend', path: backend, own: true, branch: 'main', head: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: false, usable: true, reason: null,
    }]);
  });

  it('adds a repository beside the project and stores it on the project', async () => {
    const { service, mobile, stored } = groupFixture();
    const added = await service.add('Demo', { path: mobile });
    expect(added).toEqual({ name: 'mobile-app', path: mobile, own: false, branch: 'main', head: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: false, usable: true, reason: null });
    expect(stored().find(project => project.name === 'Demo').repositories).toEqual([{ name: 'mobile-app', path: mobile }]);
    expect((await service.list('Demo')).map(entry => [entry.name, entry.own])).toEqual([['backend', true], ['mobile-app', false]]);
    // The other projects are stored as they were.
    expect(stored().find(project => project.name === 'Remote')).toMatchObject({ path: '/srv/app', host: 'devbox' });
  });

  it('takes a worktree that holds the main branch as a repository\'s checkout, named after the repository', async () => {
    const { service, frontendMain, frontend } = groupFixture();
    expect(await service.add('Demo', { path: frontendMain })).toMatchObject({ name: 'frontend', path: frontendMain, branch: 'main', usable: true });
    // The repository's own folder is the same repository: it cannot be listed twice.
    expect(await rejection(service.add('Demo', { path: frontend }))).toMatchObject({ status: 409, message: 'This repository is already part of the project.' });
  });

  it('reports uncommitted changes and a repository that can no longer be used', async () => {
    const { service, mobile } = groupFixture();
    await service.add('Demo', { path: mobile });
    writeFileSync(path.join(mobile, 'draft.txt'), 'x');
    expect((await service.list('Demo'))[1]).toMatchObject({ dirty: true, usable: true });
    rmSync(mobile, { recursive: true, force: true });
    expect((await service.list('Demo'))[1]).toEqual({
      name: 'mobile-app', path: mobile, own: false, branch: null, head: null, dirty: null, usable: false,
      reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' },
    });
  });

  it.each([
    ['a relative path', () => 'group/mobile-app', 'Use the absolute path of a folder'],
    ['an empty path', () => '', 'Use the absolute path of a folder'],
    ['a path with a NUL', ctx => `${ctx.mobile}\0x`, 'Use the absolute path of a folder'],
    ['a path that is too long', () => `/${'a'.repeat(1024)}`, 'Use the absolute path of a folder'],
    ['a number', () => 12, 'Use the absolute path of a folder'],
    ['null', () => null, 'Use the absolute path of a folder'],
    ['a folder that does not exist', ctx => path.join(ctx.group, 'missing'), 'This folder does not exist'],
    ['a file', ctx => path.join(ctx.mobile, 'README.md'), 'This is not a folder'],
    ['a folder that is not a repository', ctx => ctx.notes, 'This folder is not the top level of a Git working tree'],
  ])('refuses %s', async (_name, value, message) => {
    const ctx = groupFixture();
    const error = await rejection(ctx.service.add('Demo', { path: value(ctx) }));
    expect(error).toBeInstanceOf(RepositoryError);
    expect(error).toMatchObject({ status: 400, errors: [{ field: 'path', message }] });
    expect(ctx.stored().find(project => project.name === 'Demo').repositories).toBeUndefined();
  });

  it('refuses a folder inside a repository', async () => {
    const ctx = groupFixture();
    mkdirSync(path.join(ctx.mobile, 'src'));
    expect(await rejection(ctx.service.add('Demo', { path: path.join(ctx.mobile, 'src') })))
      .toMatchObject({ status: 400, errors: [{ field: 'path', message: 'This folder is not the top level of a Git working tree' }] });
  });

  it.each([
    ['no body', undefined],
    ['null', null],
    ['an array', []],
    ['text', 'path'],
  ])('refuses %s as the body', async (_name, body) => {
    const { service } = groupFixture();
    expect(await rejection(service.add('Demo', body))).toMatchObject({ status: 400, errors: [{ field: 'body', message: 'Use an object with path' }] });
  });

  it('names every unknown field of the body', async () => {
    const { service, mobile } = groupFixture();
    expect(await rejection(service.add('Demo', { path: mobile, name: 'x', branch: 'y' })))
      .toMatchObject({ status: 400, errors: [{ field: 'name', message: 'Unknown field' }, { field: 'branch', message: 'Unknown field' }] });
  });

  it('refuses the project\'s own repository, one already listed and one with a name already used', async () => {
    const { service, backend, mobile, otherBackend } = groupFixture();
    expect(await rejection(service.add('Demo', { path: backend }))).toMatchObject({ status: 409, message: 'This repository is already part of the project.' });
    await service.add('Demo', { path: mobile });
    expect(await rejection(service.add('Demo', { path: mobile }))).toMatchObject({ status: 409, message: 'This repository is already part of the project.' });
    expect(await rejection(service.add('Demo', { path: otherBackend }))).toMatchObject({ status: 409, message: 'Another repository of this project is already called backend.' });
  });

  it(`lists at most ${MAX_OTHER_REPOSITORIES} other repositories`, async () => {
    const { service, base, stored } = groupFixture();
    for (let index = 1; index <= MAX_OTHER_REPOSITORIES; index += 1) {
      await service.add('Demo', { path: repository(path.join(base, 'many', `repo-${index}`)) });
    }
    expect(stored().find(project => project.name === 'Demo').repositories).toHaveLength(MAX_OTHER_REPOSITORIES);
    expect(await rejection(service.add('Demo', { path: repository(path.join(base, 'many', 'one-more')) })))
      .toMatchObject({ status: 409, message: `A project can list at most ${MAX_OTHER_REPOSITORIES} other repositories.` });
  }, 30_000);

  it('refuses an unknown project, a remote project and a project that is not a repository', async () => {
    const { service, mobile } = groupFixture();
    for (const action of [() => service.list('Nope'), () => service.candidates('Nope'), () => service.add('Nope', { path: mobile }), () => service.remove('Nope', 'mobile-app')]) {
      expect(await rejection(action())).toMatchObject({ status: 404, message: 'Project not found' });
    }
    for (const action of [() => service.list('Remote'), () => service.candidates('Remote'), () => service.add('Remote', { path: mobile }), () => service.remove('Remote', 'mobile-app')]) {
      expect(await rejection(action())).toMatchObject({ status: 409, message: 'Repositories are only available for local projects.' });
    }
    for (const action of [() => service.candidates('Plain'), () => service.add('Plain', { path: mobile })]) {
      expect(await rejection(action())).toMatchObject({ status: 409, message: 'This project\'s folder is not the top level of a Git working tree.' });
    }
    expect(await service.list('Plain')).toEqual([{
      name: 'notes', path: expect.stringMatching(/notes$/), own: true, branch: null, head: null, dirty: null, usable: false,
      reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' },
    }]);
  });

  it('stores one repository when the same one is added twice at once', async () => {
    const { service, mobile, stored } = groupFixture();
    const outcomes = await Promise.allSettled([service.add('Demo', { path: mobile }), service.add('Demo', { path: mobile })]);
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(outcomes.find(outcome => outcome.status === 'rejected').reason).toMatchObject({ status: 409 });
    expect(stored().find(project => project.name === 'Demo').repositories).toHaveLength(1);
  });

  describe('the repositories beside the project', () => {
    it('offers the repositories in the project\'s parent folder that are not listed yet', async () => {
      const { service, mobile, frontend } = groupFixture();
      expect(await service.candidates('Demo')).toEqual([{ name: 'frontend', path: frontend }, { name: 'mobile-app', path: mobile }]);
    });

    it('leaves out a repository once it is listed, also when its listed checkout is a worktree', async () => {
      const { service, mobile, frontendMain } = groupFixture();
      await service.add('Demo', { path: frontendMain });
      expect(await service.candidates('Demo')).toEqual([{ name: 'mobile-app', path: mobile }]);
      await service.add('Demo', { path: mobile });
      expect(await service.candidates('Demo')).toEqual([]);
    });

    it('looks one level down only', async () => {
      const { service, group } = groupFixture();
      repository(path.join(group, 'notes', 'nested'));
      expect((await service.candidates('Demo')).map(entry => entry.name)).toEqual(['frontend', 'mobile-app']);
    });
  });

  describe('removing a repository', () => {
    it('takes it off the project and leaves the folder alone', async () => {
      const { service, mobile, frontendMain, stored } = groupFixture();
      await service.add('Demo', { path: mobile });
      await service.add('Demo', { path: frontendMain });
      await service.remove('Demo', 'mobile-app');
      expect(stored().find(project => project.name === 'Demo').repositories).toEqual([{ name: 'frontend', path: frontendMain }]);
      expect(git(mobile, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    });

    it('reports a repository the project does not list, also when asked twice', async () => {
      const { service, mobile } = groupFixture();
      await service.add('Demo', { path: mobile });
      await service.remove('Demo', 'mobile-app');
      expect(await rejection(service.remove('Demo', 'mobile-app'))).toMatchObject({ status: 404, message: 'Repository not found' });
      expect(await rejection(service.remove('Demo', 'backend'))).toMatchObject({ status: 404, message: 'Repository not found' });
      expect(await rejection(service.remove('Demo', ''))).toMatchObject({ status: 404, message: 'Repository not found' });
    });
  });

  describe('what is stored on a project', () => {
    it('reads a project without the field as having no other repositories', () => {
      expect(readStoredRepositories({ name: 'Demo', path: '/tmp/x', repositories: [] })).toEqual([]);
      expect(normalizeProjects([{ name: 'Demo', path: '/tmp/x' }])[0].repositories).toEqual([]);
    });

    it.each([
      ['a list that is not a list', { repositories: 'mobile-app' }, 'repositories must be a list'],
      ['a missing list', {}, 'repositories must be a list'],
      ['an entry that is not an object', { repositories: ['x'] }, 'repository 0 must be an object'],
      ['a name that is not a folder name', { repositories: [{ name: 'a/b', path: '/tmp/a' }] }, 'repository 0 field name'],
      ['a missing name', { repositories: [{ path: '/tmp/a' }] }, 'repository 0 field name'],
      ['a relative path', { repositories: [{ name: 'a', path: 'a' }] }, 'repository 0 field path'],
      ['a missing path', { repositories: [{ name: 'a' }] }, 'repository 0 field path'],
      ['an unknown field', { repositories: [{ name: 'a', path: '/tmp/a', branch: 'main' }] }, 'repository 0 field branch'],
      ['a name used twice', { repositories: [{ name: 'a', path: '/tmp/a' }, { name: 'a', path: '/tmp/b' }] }, 'repository 1 field name'],
      ['a path used twice', { repositories: [{ name: 'a', path: '/tmp/a' }, { name: 'b', path: '/tmp/a' }] }, 'repository 1 field path'],
      ['too many', { repositories: Array.from({ length: MAX_OTHER_REPOSITORIES + 1 }, (_, index) => ({ name: `r${index}`, path: `/tmp/r${index}` })) }, 'repositories must hold at most'],
    ])('fails loudly on %s', (_name, fields, message) => {
      expect(() => readStoredRepositories({ name: 'Demo', path: '/tmp/x', ...fields })).toThrow(new RegExp(`Stored project Demo ${message}`));
    });

    it('does not answer from a stored list it cannot trust', async () => {
      const { service, setProjects, backend } = groupFixture();
      setProjects([{ name: 'Demo', path: backend, repositories: [{ name: 'a/b', path: '/tmp/a' }] }]);
      const error = await rejection(service.list('Demo'));
      expect(error).not.toBeInstanceOf(RepositoryError);
      expect(error.message).toContain('Stored project Demo repository 0 field name');
    });
  });

  it('requires its dependencies', () => {
    expect(() => createProjectRepositories({})).toThrow('loadProjects must be a function');
    expect(() => createProjectRepositories({ loadProjects: () => [], saveProjects: () => {} })).toThrow('execFile must be a function');
  });
});
