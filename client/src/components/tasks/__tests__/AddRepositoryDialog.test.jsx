import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

const toast = vi.hoisted(() => vi.fn());
const tasksApi = vi.hoisted(() => ({ addTaskRepository: vi.fn() }));
const repositoriesApi = vi.hoisted(() => ({ listProjectRepositories: vi.fn() }));
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('../../../utils/tasksApi.js', () => tasksApi);
vi.mock('../../../utils/projectRepositoriesApi.js', () => repositoriesApi);
import AddRepositoryDialog from '../AddRepositoryDialog.jsx';

const part = (repository, state = 'active') => ({ id: `wt-${repository}`, repository, own: repository === 'backend', first: repository === 'backend', worktreePath: `/group/worktrees/t/${repository}`, branch: 'task/t', baseBranch: 'main', baseCommit: 'a'.repeat(40), state, prUrl: null });
const TASK = { id: '7a000000-0000-4000-8000-000000000001', project: 'Demo', title: 'Replies', worktrees: [part('backend'), part('docs', 'closed')] };
const repo = (name, extra = {}) => ({ name, path: `/group/${name}`, own: name === 'backend', branch: 'main', head: 'a'.repeat(40), dirty: false, usable: true, reason: null, ...extra });
const LISTED = [repo('backend'), repo('docs'), repo('mobile-app', { branch: 'develop' }),
  repo('frontend', { branch: null, head: null, dirty: null, usable: false, reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' } })];

async function mount(listed = LISTED) {
  repositoriesApi.listProjectRepositories.mockResolvedValue(listed);
  const handlers = { onAdded: vi.fn(), onClose: vi.fn() };
  render(<AddRepositoryDialog task={TASK} {...handlers} />);
  await waitFor(() => expect(repositoriesApi.listProjectRepositories).toHaveBeenCalledWith('Demo'));
  return handlers;
}
const rows = () => within(screen.getByRole('list', { name: 'Repositories that can be added' })).getAllByRole('listitem');

beforeEach(() => { toast.mockReset(); tasksApi.addTaskRepository.mockReset(); repositoriesApi.listProjectRepositories.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AddRepositoryDialog', () => {
  it('offers the project\'s repositories the task never had, and says where each would start from', async () => {
    await mount();
    await waitFor(() => expect(rows()).toHaveLength(2));
    // `backend` is in the task and `docs` was closed in it: neither can be added.
    expect(rows().map(row => row.getAttribute('data-repository'))).toEqual(['mobile-app', 'frontend']);
    expect(within(rows()[0]).getByText('from develop')).toBeTruthy();
    expect(within(rows()[1]).getByText('This folder is not the top level of a Git working tree.')).toBeTruthy();
    expect(within(rows()[1]).getByRole('button', { name: 'Add frontend' }).disabled).toBe(true);
    expect(screen.getByText(/No Setup step runs for a repository added now/)).toBeTruthy();
  });

  it('adds the repository, says that it was not prepared, and closes', async () => {
    const handlers = await mount();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const next = { ...TASK, worktrees: [...TASK.worktrees, part('mobile-app')] };
    tasksApi.addTaskRepository.mockResolvedValue(next);
    fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Add mobile-app' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'mobile-app added to Replies. It was not prepared: install what it needs before building or testing there.' }));
    expect(tasksApi.addTaskRepository).toHaveBeenCalledWith(TASK.id, 'mobile-app');
    expect(handlers.onAdded).toHaveBeenCalledWith(next);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a refusal on screen and stays open', async () => {
    const handlers = await mount();
    await waitFor(() => expect(rows()).toHaveLength(2));
    tasksApi.addTaskRepository.mockRejectedValue(new Error('A workflow run is working in this task. Add the repository when it pauses or finishes.'));
    fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Add mobile-app' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'A workflow run is working in this task. Add the repository when it pauses or finishes.' }));
    expect(screen.getByRole('alert').textContent).toBe('A workflow run is working in this task. Add the repository when it pauses or finishes.');
    expect(handlers.onAdded).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('says so when every repository of the project is or was part of the task', async () => {
    await mount([repo('backend'), repo('docs')]);
    await waitFor(() => expect(screen.getByText('Every repository of this project is, or was, part of this task.')).toBeTruthy());
    expect(screen.queryByRole('list', { name: 'Repositories that can be added' })).toBeNull();
  });

  it('says why when the repositories cannot be read', async () => {
    repositoriesApi.listProjectRepositories.mockRejectedValueOnce(new Error('Server unreachable'));
    render(<AddRepositoryDialog task={TASK} onAdded={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Server unreachable'));
  });
});
