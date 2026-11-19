import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const api = vi.hoisted(() => ({ listProjectRepositories: vi.fn() }));
vi.mock('../../../utils/projectRepositoriesApi.js', () => api);
import NewTaskDialog from '../NewTaskDialog.jsx';

const repo = (name, overrides = {}) => ({ name, path: `/group/${name}`, own: false, branch: 'main', head: 'a'.repeat(40), dirty: false, usable: true, reason: null, ...overrides });
const REPOSITORIES = [repo('backend', { own: true }), repo('mobile-app', { branch: 'develop', dirty: true }), repo('frontend', { branch: null, head: null, dirty: null, usable: false, reason: { code: 'not_git_toplevel', message: 'This folder is not the top level of a Git working tree.' } })];
const type = value => fireEvent.change(screen.getByLabelText('Task title'), { target: { value } });
const create = () => fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

beforeEach(() => api.listProjectRepositories.mockReset());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('NewTaskDialog', () => {
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
