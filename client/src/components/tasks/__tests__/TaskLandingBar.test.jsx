import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const toast = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ getTaskLanding: vi.fn(), commitTask: vi.fn(), mergeTask: vi.fn(), openTaskPullRequest: vi.fn(), closeTask: vi.fn(), renameTask: vi.fn() }));
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('../../../utils/tasksApi.js', () => api);
import TaskLandingBar from '../TaskLandingBar.jsx';

const TASK = { id: '7a000000-0000-4000-8000-000000000001', project: 'Demo', title: 'Replies', revision: 3, worktreePath: '/tmp/worktrees/demo-replies' };
const landing = (overrides = {}) => ({
  taskId: TASK.id, state: 'active', branch: 'task/replies-7a000000', baseBranch: 'main', prUrl: null, filesPresent: true, runActive: false,
  uncommitted: [], uncommittedCount: 0, commitsAhead: 2, commitsBehind: 0, main: { branch: 'main', dirty: false },
  remotes: [{ name: 'origin', host: 'gitlab.com', tool: 'glab' }],
  blockers: { commit: [{ code: 'nothing_to_commit', message: 'There is nothing to commit.' }], merge: [], pullRequest: [], close: [] },
  ...overrides,
});
const blocked = message => [{ code: 'x', message }];
const mount = async (state = landing()) => {
  api.getTaskLanding.mockResolvedValue(state);
  const onChanged = vi.fn();
  const onFinished = vi.fn();
  render(<TaskLandingBar task={TASK} onChanged={onChanged} onFinished={onFinished} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Close task' })).toBeTruthy());
  return { onChanged, onFinished };
};

beforeEach(() => { toast.mockReset(); Object.values(api).forEach(fn => fn.mockReset()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TaskLandingBar', () => {
  it('says how the task stands and offers Merge as the next thing to do', async () => {
    await mount();
    expect(screen.getByText('2 commits not yet in main')).toBeTruthy();
    const merge = screen.getByRole('button', { name: 'Merge into main' });
    expect(merge.disabled).toBe(false);
    expect(merge.className).toContain('pipeline-run-primary');
    expect(screen.queryByRole('button', { name: 'Commit changes' })).toBeNull();
    expect(screen.getByText('Branch task/replies-7a000000, started from main')).toBeTruthy();
    expect(screen.getByText('/tmp/worktrees/demo-replies')).toBeTruthy();
  });

  it('merges after confirmation, then leaves the task', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    api.mergeTask.mockResolvedValue({ mergedInto: 'main', filesRemoved: true, branchDeleted: true });
    const { onChanged, onFinished } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main' }));
    expect(api.mergeTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main' }));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toBe('Merge "Replies" into main? The task\'s own copy of the project is removed afterwards.');
    expect(api.mergeTask).toHaveBeenCalledWith(TASK.id);
    expect(onChanged).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Merged into main' });
  });

  it('keeps a refused merge on screen with its conflicting files, and stays on the task', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.mergeTask.mockRejectedValue(Object.assign(new Error('This task conflicts with main in 1 file. Nothing was merged.'), { reasons: [], conflicts: ['shared.txt'] }));
    const { onFinished } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main' }));
    await waitFor(() => expect(screen.getByText('shared.txt')).toBeTruthy());
    expect(screen.getAllByRole('alert').some(node => node.textContent.includes('Nothing was merged'))).toBe(true);
    expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'This task conflicts with main in 1 file. Nothing was merged.' });
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('offers Commit when files are uncommitted and explains what else blocks the merge', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('  Add replies ');
    api.commitTask.mockResolvedValue(landing({ commitsAhead: 3 }));
    await mount(landing({
      uncommitted: ['a.txt'], uncommittedCount: 4,
      blockers: { commit: [], merge: [{ code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }, { code: 'main_dirty', message: 'Main has uncommitted changes. Commit or stash them before merging.' }], pullRequest: blocked('This task has uncommitted changes. Commit them first.'), close: blocked('This task has uncommitted changes. Commit them first.') },
    }));
    expect(screen.getByText('4 uncommitted files')).toBeTruthy();
    expect(screen.getByText('and 3 more')).toBeTruthy();
    expect(screen.getByText('Main has uncommitted changes. Commit or stash them before merging.')).toBeTruthy();
    const merge = screen.getByRole('button', { name: 'Merge into main' });
    expect(merge.disabled).toBe(true);
    expect(merge.title).toBe('This task has uncommitted changes. Commit them first.');
    expect(screen.getByRole('button', { name: 'Close task' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));
    await waitFor(() => expect(screen.getByText('3 commits not yet in main')).toBeTruthy());
    expect(api.commitTask).toHaveBeenCalledWith(TASK.id, '  Add replies ');
    expect(window.prompt.mock.calls[0][1]).toBe('Replies');
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Changes committed' });
  });

  it('does nothing when the commit message or the new title is cancelled or blank', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce(null).mockReturnValueOnce('   ').mockReturnValueOnce(null).mockReturnValueOnce('Replies');
    await mount(landing({ uncommittedCount: 1, uncommitted: ['a.txt'], blockers: { ...landing().blockers, commit: [] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(prompt).toHaveBeenCalledTimes(4);
    expect(api.commitTask).not.toHaveBeenCalled();
    expect(api.renameTask).not.toHaveBeenCalled();
  });

  it('renames the task with its revision', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Companion tag watch');
    api.renameTask.mockResolvedValue({ title: 'Companion tag watch' });
    const { onChanged } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.renameTask).toHaveBeenCalledWith(TASK.id, { title: 'Companion tag watch', revision: 3 });
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Renamed to Companion tag watch' });
  });

  it('opens a pull request on the chosen remote after naming where the branch is published', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.openTaskPullRequest.mockResolvedValue({ prUrl: 'https://github.com/team/demo/pull/3', remote: 'github' });
    const { onChanged, onFinished } = await mount(landing({ remotes: [{ name: 'origin', host: 'gitlab.com', tool: 'glab' }, { name: 'github', host: 'github.com', tool: 'gh' }, { name: 'mirror', host: 'git.example.test', tool: null }] }));
    const select = screen.getByRole('combobox', { name: 'Remote for the pull request' });
    expect([...select.options].map(option => option.value)).toEqual(['origin', 'github']);
    fireEvent.change(select, { target: { value: 'github' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open a pull request' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toBe('Push task/replies-7a000000 to github (github.com) and open a pull request into main? Pushing publishes the branch.');
    expect(api.openTaskPullRequest).toHaveBeenCalledWith(TASK.id, 'github');
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('links an open pull request instead of offering another, and hides the offer without a supported remote', async () => {
    await mount(landing({ state: 'pr_open', prUrl: 'https://gitlab.com/team/demo/-/merge_requests/7' }));
    expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe('https://gitlab.com/team/demo/-/merge_requests/7');
    expect(screen.queryByRole('button', { name: 'Open a pull request' })).toBeNull();
    cleanup();
    await mount(landing({ remotes: [{ name: 'mirror', host: 'git.example.test', tool: null }] }));
    expect(screen.queryByRole('button', { name: 'Open a pull request' })).toBeNull();
  });

  it('warns that unmerged commits stay on the branch before closing', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    api.closeTask.mockResolvedValue({ branchKept: 'task/replies-7a000000', unmergedCommits: 2 });
    const { onFinished } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toBe('Close "Replies"? Its copy of the project is removed. Its 2 commits stay on the branch task/replies-7a000000, not merged.');
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Task closed. Branch task/replies-7a000000 was kept.' });
  });

  it('has no merge for a task started without a branch, and says when nothing has changed', async () => {
    await mount(landing({ baseBranch: null, commitsAhead: 0 }));
    expect(screen.queryByRole('button', { name: /Merge into/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open a pull request' })).toBeNull();
    expect(screen.getByText('No changes yet')).toBeTruthy();
  });

  it('reports a status that could not be read and keeps Rename available', async () => {
    api.getTaskLanding.mockRejectedValue(new Error('Server unreachable'));
    render(<TaskLandingBar task={TASK} onChanged={() => {}} onFinished={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Server unreachable'));
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close task' })).toBeNull();
  });
});
