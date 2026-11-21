import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const api = vi.hoisted(() => ({ listProjectRepositories: vi.fn(), listWorktreeCandidates: vi.fn(), makeTaskFromWorktree: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/projectRepositoriesApi.js', () => ({ listProjectRepositories: api.listProjectRepositories }));
vi.mock('../../../utils/tasksApi.js', () => ({ listWorktreeCandidates: api.listWorktreeCandidates, makeTaskFromWorktree: api.makeTaskFromWorktree }));
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
import NewTaskDialog from '../NewTaskDialog.jsx';

const repo = (name, overrides = {}) => ({ name, path: `/group/${name}`, own: false, branch: 'main', head: 'a'.repeat(40), dirty: false, usable: true, reason: null, ...overrides });
const REPOSITORIES = [repo('backend', { own: true }), repo('mobile-app', { branch: 'develop', dirty: true }), repo('frontend', { branch: null, head: null, dirty: null, usable: false, reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' } })];
const type = value => fireEvent.change(screen.getByLabelText('Task title'), { target: { value } });
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

beforeEach(() => { api.listProjectRepositories.mockReset(); api.listWorktreeCandidates.mockReset().mockResolvedValue([]); api.makeTaskFromWorktree.mockReset(); toast.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('NewTaskDialog', () => {
  it('makes a task from a selected worktree and opens it through the task callback', async () => {
    const candidate = { path: '/tmp/worktrees/handmade', name: 'handmade', repository: 'demo', own: true,
      branch: 'feature/spec', head: 'a'.repeat(40), uncommittedCount: 1, selectable: true, reason: null };
    api.listWorktreeCandidates.mockResolvedValue([candidate, { ...candidate, path: '/tmp/worktrees/busy', name: 'busy',
      selectable: false, reason: { code: 'in_use', message: 'Already in use.' } }]);
    const task = { id: 'task-1', title: 'Spec', worktreePath: candidate.path };
    api.makeTaskFromWorktree.mockResolvedValue(task);
    const onCreate = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<NewTaskDialog projectName="Demo" onCreate={onCreate} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Use an existing worktree' }));
    expect(screen.getByRole('option', { name: /busy/ }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Spec' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make task' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ adoptedTask: task }));
    expect(api.makeTaskFromWorktree).toHaveBeenCalledWith({ project: 'Demo', worktreePath: candidate.path, title: 'Spec' });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the worktree choice open and toasts a failed make-task request', async () => {
    const candidate = { path: '/tmp/worktrees/handmade', name: 'handmade', repository: 'demo', own: true,
      branch: 'feature/spec', head: 'a'.repeat(40), uncommittedCount: 0, selectable: true, reason: null };
    api.listWorktreeCandidates.mockResolvedValue([candidate]);
    api.makeTaskFromWorktree.mockRejectedValue(new Error('Worktree is in use'));
    const onCreate = vi.fn();
    render(<NewTaskDialog projectName="Demo" onCreate={onCreate} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Use an existing worktree' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make task' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Worktree is in use'));
    expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'Worktree is in use' });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('retries opening the already made task without posting adoption again', async () => {
    const candidate = { path: '/tmp/worktrees/handmade', name: 'handmade', repository: 'demo', own: true,
      branch: 'feature/spec', head: 'a'.repeat(40), uncommittedCount: 0, selectable: true, reason: null };
    api.listWorktreeCandidates.mockResolvedValue([candidate]);
    const task = { id: 'task-1', title: 'Spec', worktreePath: candidate.path };
    api.makeTaskFromWorktree.mockResolvedValue(task);
    const onCreate = vi.fn().mockRejectedValueOnce(new Error('Terminal unavailable')).mockResolvedValueOnce(task);
    const onClose = vi.fn();
    render(<NewTaskDialog projectName="Demo" onCreate={onCreate} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('radio', { name: 'Use an existing worktree' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make task' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Terminal unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(api.makeTaskFromWorktree).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledTimes(2);
  });
  it('asks only for a title in a project with one repository', async () => {
    const onCreate = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<NewTaskDialog projectName="Demo" onCreate={onCreate} onClose={onClose} />);
    expect(screen.queryByRole('group', { name: 'Repositories' })).toBeNull();
    type('  WhatsApp replies ');
    create();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledWith({ project: 'Demo', title: 'WhatsApp replies' });
    expect(api.listProjectRepositories).not.toHaveBeenCalled();
  });

  it('offers the project\'s repositories, with only its own ticked, and says where each would start from', async () => {
    api.listProjectRepositories.mockResolvedValue(REPOSITORIES);
    const onCreate = vi.fn(async () => {});
    render(<NewTaskDialog projectName="Demo" withRepositories onCreate={onCreate} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Repositories' })).toBeTruthy());
    expect(api.listProjectRepositories).toHaveBeenCalledWith('Demo');
    expect(screen.getByLabelText('backend').checked).toBe(true);
    expect(screen.getByLabelText('mobile-app').checked).toBe(false);
    expect(screen.getByText('from main')).toBeTruthy();
    expect(screen.getByText('from develop')).toBeTruthy();
    // A repository Git cannot use is shown with why, and cannot be ticked.
    expect(screen.getByLabelText('frontend').disabled).toBe(true);
    expect(screen.getByText('This folder is not the top level of a Git working tree.')).toBeTruthy();
    type('Replies');
    create();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ project: 'Demo', title: 'Replies', repositories: ['backend'] }));
  });

  it('creates the task in the repositories ticked, the project\'s own first when it is one of them', async () => {
    api.listProjectRepositories.mockResolvedValue([repo('mobile-app'), repo('backend', { own: true })]);
    const onCreate = vi.fn(async () => {});
    render(<NewTaskDialog projectName="Demo" withRepositories onCreate={onCreate} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('mobile-app')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('mobile-app'));
    type('Replies');
    create();
    await waitFor(() => expect(onCreate).toHaveBeenLastCalledWith({ project: 'Demo', title: 'Replies', repositories: ['backend', 'mobile-app'] }));
    fireEvent.click(screen.getByLabelText('backend'));
    create();
    await waitFor(() => expect(onCreate).toHaveBeenLastCalledWith({ project: 'Demo', title: 'Replies', repositories: ['mobile-app'] }));
  });

  it('needs at least one repository', async () => {
    api.listProjectRepositories.mockResolvedValue(REPOSITORIES);
    render(<NewTaskDialog projectName="Demo" withRepositories onCreate={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('backend')).toBeTruthy());
    type('Replies');
    fireEvent.click(screen.getByLabelText('backend'));
    expect(screen.getByRole('button', { name: 'Create task' }).disabled).toBe(true);
    expect(screen.getByText('Tick at least one repository.')).toBeTruthy();
  });

  it('says why when the repositories cannot be read, and creates nothing', async () => {
    api.listProjectRepositories.mockRejectedValueOnce(new Error('Server unreachable'));
    render(<NewTaskDialog projectName="Demo" withRepositories onCreate={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Server unreachable'));
    type('Replies');
    expect(screen.getByRole('button', { name: 'Create task' }).disabled).toBe(true);
  });

  it('keeps the dialog open and says why when the task could not be created', async () => {
    api.listProjectRepositories.mockResolvedValue(REPOSITORIES);
    const onClose = vi.fn();
    render(<NewTaskDialog projectName="Demo" withRepositories onCreate={vi.fn(async () => { throw new Error('The copy of mobile-app could not be created: a branch named task/x already exists. Nothing was kept.'); })} onClose={onClose} />);
    await waitFor(() => expect(screen.getByLabelText('backend')).toBeTruthy());
    type('Replies');
    create();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The copy of mobile-app could not be created'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
