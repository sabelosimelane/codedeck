import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

const toast = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ listProjectRepositories: vi.fn(), getRepositoryCandidates: vi.fn(), addProjectRepository: vi.fn(), removeProjectRepository: vi.fn() }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('../../utils/projectRepositoriesApi.js', () => api);
// The folder picker is its own component; here it offers one local and one remote folder.
vi.mock('../DirectoryBrowser', () => ({
  default: ({ onSelect, onCancel, initialPath }) => (
    <div role="dialog" aria-label="Choose a folder" data-initial-path={initialPath}>
      <button type="button" onClick={() => onSelect('/tmp/elsewhere/tools', 'local')}>Pick local folder</button>
      <button type="button" onClick={() => onSelect('/srv/tools', 'devbox')}>Pick remote folder</button>
      <button type="button" onClick={onCancel}>Cancel picking</button>
    </div>
  ),
}));
import ProjectRepositoriesDialog, { MAX_OTHER_REPOSITORIES } from '../ProjectRepositoriesDialog.jsx';

const PROJECT = { name: 'Demo', path: '/tmp/group/backend' };
const HEAD = 'a'.repeat(40);
const repo = (name, overrides = {}) => ({ name, path: `/tmp/group/${name}`, own: false, branch: 'main', head: HEAD, dirty: false, usable: true, reason: null, ...overrides });
const OWN = repo('backend', { own: true });
const candidate = name => ({ name, path: `/tmp/group/${name}` });
const candidates = (names, { hasNextPage = false, total = names.length } = {}) => ({ candidates: names.map(candidate), hasNextPage, total });

async function mount({ repositories = [OWN], beside = candidates(['frontend', 'mobile-app']) } = {}) {
  api.listProjectRepositories.mockResolvedValue(repositories);
  api.getRepositoryCandidates.mockResolvedValue(beside);
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<ProjectRepositoriesDialog project={PROJECT} onClose={onClose} onChanged={onChanged} />);
  await waitFor(() => expect(screen.getByRole('list', { name: 'Repositories of Demo' })).toBeTruthy());
  return { onClose, onChanged };
}
const listed = () => within(screen.getByRole('list', { name: 'Repositories of Demo' }));
const beside = () => within(screen.getByRole('list', { name: 'Repositories beside Demo' }));

beforeEach(() => { toast.mockReset(); Object.values(api).forEach(fn => fn.mockReset()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ProjectRepositoriesDialog', () => {
  it('shows the project\'s repositories and how each stands', async () => {
    await mount({ repositories: [OWN, repo('mobile-app', { dirty: true, branch: 'feat/x' }), repo('frontend', { branch: null, head: null, dirty: null, usable: false, reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' } })] });
    const rows = listed().getAllByRole('listitem');
    expect(rows.map(row => row.getAttribute('data-repository'))).toEqual(['backend', 'mobile-app', 'frontend']);
    expect(within(rows[0]).getByText('this project')).toBeTruthy();
    expect(within(rows[0]).getByText('on main')).toBeTruthy();
    expect(within(rows[0]).queryByRole('button', { name: 'Remove backend' })).toBeNull();
    expect(within(rows[1]).getByText('on feat/x')).toBeTruthy();
    expect(within(rows[1]).getByText('uncommitted changes')).toBeTruthy();
    expect(within(rows[1]).getByText('/tmp/group/mobile-app')).toBeTruthy();
    expect(within(rows[2]).getByText('This folder is not the top level of a Git working tree.')).toBeTruthy();
    expect(api.listProjectRepositories).toHaveBeenCalledWith('Demo');
    expect(api.getRepositoryCandidates).toHaveBeenCalledWith('Demo', 0);
  });

  it('says so when the project has no other repository and none is beside it', async () => {
    await mount({ beside: candidates([]) });
    expect(screen.getByText('No other repository is beside this project.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Repositories beside Demo' })).toBeNull();
  });

  it('adds a repository found beside the project and says so', async () => {
    const { onChanged } = await mount();
    api.addProjectRepository.mockResolvedValue(repo('mobile-app'));
    api.listProjectRepositories.mockResolvedValue([OWN, repo('mobile-app')]);
    api.getRepositoryCandidates.mockResolvedValue(candidates(['frontend']));
    fireEvent.click(beside().getByRole('button', { name: 'Add mobile-app' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'mobile-app added to Demo' }));
    expect(api.addProjectRepository).toHaveBeenCalledWith('Demo', '/tmp/group/mobile-app');
    await waitFor(() => expect(listed().getAllByRole('listitem')).toHaveLength(2));
    expect(beside().getAllByRole('listitem')).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps a refusal on screen and changes nothing', async () => {
    const { onChanged } = await mount();
    api.addProjectRepository.mockRejectedValue(new Error('This repository is already part of the project.'));
    fireEvent.click(beside().getByRole('button', { name: 'Add frontend' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'This repository is already part of the project.' }));
    expect(screen.getByRole('alert').textContent).toBe('This repository is already part of the project.');
    expect(listed().getAllByRole('listitem')).toHaveLength(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('adds every repository beside the project in one click when they all fit', async () => {
    await mount();
    api.addProjectRepository.mockImplementation(async (_project, path) => repo(path.split('/').at(-1)));
    fireEvent.click(screen.getByRole('button', { name: 'Add all 2' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: '2 repositories added to Demo' }));
    expect(api.addProjectRepository.mock.calls).toEqual([['Demo', '/tmp/group/frontend'], ['Demo', '/tmp/group/mobile-app']]);
  });

  it('stops at the first repository that cannot be added and says which were', async () => {
    await mount();
    api.addProjectRepository.mockResolvedValueOnce(repo('frontend')).mockRejectedValueOnce(new Error('This folder does not exist'));
    fireEvent.click(screen.getByRole('button', { name: 'Add all 2' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'mobile-app was not added: This folder does not exist. 1 repository added before it.' }));
    expect(api.listProjectRepositories).toHaveBeenCalledTimes(2);
  });

  it('does not offer to add all when more are beside the project than it may list', async () => {
    await mount({ beside: candidates(['a', 'b'], { hasNextPage: true, total: 31 }) });
    expect(screen.queryByRole('button', { name: /^Add all/ })).toBeNull();
    expect(screen.getByText('31 repositories are beside this project.')).toBeTruthy();
  });

  it('shows more of the repositories beside the project on request', async () => {
    await mount({ beside: candidates(['a', 'b'], { hasNextPage: true, total: 3 }) });
    api.getRepositoryCandidates.mockResolvedValue(candidates(['c'], { total: 3 }));
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(beside().getAllByRole('listitem')).toHaveLength(3));
    expect(api.getRepositoryCandidates).toHaveBeenLastCalledWith('Demo', 1);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('removes a repository from the project and says so', async () => {
    const { onChanged } = await mount({ repositories: [OWN, repo('mobile-app')], beside: candidates(['frontend']) });
    api.removeProjectRepository.mockResolvedValue(undefined);
    api.listProjectRepositories.mockResolvedValue([OWN]);
    fireEvent.click(listed().getByRole('button', { name: 'Remove mobile-app' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'mobile-app removed from Demo. Its folder was not touched.' }));
    expect(api.removeProjectRepository).toHaveBeenCalledWith('Demo', 'mobile-app');
    await waitFor(() => expect(listed().getAllByRole('listitem')).toHaveLength(1));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('reports a removal that failed', async () => {
    await mount({ repositories: [OWN, repo('mobile-app')] });
    api.removeProjectRepository.mockRejectedValue(new Error('Server unreachable'));
    fireEvent.click(listed().getByRole('button', { name: 'Remove mobile-app' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' }));
    expect(listed().getAllByRole('listitem')).toHaveLength(2);
  });

  it('adds a folder chosen with the folder picker, starting beside the project', async () => {
    await mount();
    api.addProjectRepository.mockResolvedValue(repo('tools', { path: '/tmp/elsewhere/tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add another folder…' }));
    expect(screen.getByRole('dialog', { name: 'Choose a folder' }).getAttribute('data-initial-path')).toBe('/tmp/group');
    fireEvent.click(screen.getByRole('button', { name: 'Pick local folder' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'tools added to Demo' }));
    expect(api.addProjectRepository).toHaveBeenCalledWith('Demo', '/tmp/elsewhere/tools');
    expect(screen.queryByRole('dialog', { name: 'Choose a folder' })).toBeNull();
  });

  it('refuses a folder on another host without asking the backend', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add another folder…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick remote folder' }));
    expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'Choose a folder on this computer. Repositories of a project are local.' });
    expect(api.addProjectRepository).not.toHaveBeenCalled();
  });

  it('stops offering to add once the project lists as many as it may', async () => {
    const full = Array.from({ length: MAX_OTHER_REPOSITORIES }, (_, index) => repo(`r${index}`));
    await mount({ repositories: [OWN, ...full], beside: candidates(['frontend']) });
    expect(beside().getByRole('button', { name: 'Add frontend' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Add another folder…' }).disabled).toBe(true);
    expect(screen.getByText(`A project can list at most ${MAX_OTHER_REPOSITORIES} other repositories.`)).toBeTruthy();
  });

  it('says why when the repositories cannot be read, and can try again', async () => {
    api.listProjectRepositories.mockRejectedValueOnce(new Error('Server unreachable'));
    api.getRepositoryCandidates.mockResolvedValue(candidates([]));
    render(<ProjectRepositoriesDialog project={PROJECT} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Server unreachable'));
    api.listProjectRepositories.mockResolvedValue([OWN]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(listed().getAllByRole('listitem')).toHaveLength(1));
  });

  it('still lists the project\'s repositories when the ones beside it cannot be read', async () => {
    api.listProjectRepositories.mockResolvedValue([OWN]);
    api.getRepositoryCandidates.mockRejectedValue(new Error('This project\'s folder is not the top level of a Git working tree.'));
    render(<ProjectRepositoriesDialog project={PROJECT} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(listed().getAllByRole('listitem')).toHaveLength(1));
    expect(screen.getByText('This project\'s folder is not the top level of a Git working tree.')).toBeTruthy();
  });

  it('closes on request', async () => {
    const { onClose } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
