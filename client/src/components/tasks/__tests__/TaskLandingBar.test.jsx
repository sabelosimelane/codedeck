import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

const toast = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({ getTaskLanding: vi.fn(), commitTask: vi.fn(), mergeTask: vi.fn(), openTaskPullRequest: vi.fn(), closeTask: vi.fn(), renameTask: vi.fn() }));
vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('../../../utils/tasksApi.js', () => api);
vi.mock('../AddRepositoryDialog.jsx', () => ({
  default: ({ task, onAdded, onClose }) => (
    <div role="dialog" aria-label="Add a repository to this task">
      <button type="button" onClick={() => { onAdded({ ...task, revision: task.revision + 1 }); onClose(); }}>Add mobile-app</button>
    </div>
  ),
}));
import TaskLandingBar from '../TaskLandingBar.jsx';

const TASK = { id: '7a000000-0000-4000-8000-000000000001', project: 'Demo', title: 'Replies', revision: 3, worktreePath: '/tmp/worktrees/demo-replies' };
const landing = (overrides = {}) => ({
  taskId: TASK.id, state: 'active', branch: 'task/replies-7a000000', baseBranch: 'main', prUrl: null, filesPresent: true, runActive: false,
  uncommitted: [], uncommittedCount: 0, commitsAhead: 2, commitsBehind: 0, alreadyInBase: false, ignoredAtRisk: [], ignoredAtRiskCount: 0, main: { branch: 'main', dirty: false },
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

const dialog = name => within(screen.getByRole('dialog', { name }));
const typeInto = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => { toast.mockReset(); Object.values(api).forEach(fn => fn.mockReset()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TaskLandingBar', () => {
  it('says how the task stands and offers Merge as the next thing to do', async () => {
    await mount();
    expect(screen.getByText('2 commits not yet in main')).toBeTruthy();
    const merge = screen.getByRole('button', { name: 'Merge into main' });
    expect(merge.disabled).toBe(false);
    expect(merge.dataset.variant).toBe('primary');
    expect(screen.queryByRole('button', { name: 'Commit changes' })).toBeNull();
    expect(screen.getByText('Branch task/replies-7a000000, started from main')).toBeTruthy();
    expect(screen.getByText('/tmp/worktrees/demo-replies')).toBeTruthy();
  });

  it('merges after confirmation, then leaves the task', async () => {
    api.mergeTask.mockResolvedValue({ mergedInto: 'main', filesRemoved: true, branchDeleted: true, terminalsClosed: ['Demo-2', 'Demo-3'], terminalsNotClosed: [] });
    const { onChanged, onFinished } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main' }));
    expect(dialog('Merge into main').getByText('"Replies" is merged into main. The task\'s own copy of the project is removed afterwards and its terminals are closed.')).toBeTruthy();
    fireEvent.click(dialog('Merge into main').getByRole('button', { name: 'Cancel' }));
    expect(api.mergeTask).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main' }));
    fireEvent.click(dialog('Merge into main').getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(api.mergeTask).toHaveBeenCalledWith(TASK.id);
    expect(onChanged).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Merged into main. 2 terminals closed.' });
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ terminalsClosed: ['Demo-2', 'Demo-3'] }));
  });

  it('keeps a refused merge on screen with its conflicting files, and stays on the task', async () => {
    api.mergeTask.mockRejectedValue(Object.assign(new Error('This task conflicts with main in 1 file. Nothing was merged.'), { reasons: [], conflicts: ['shared.txt'] }));
    const { onFinished } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Merge into main' }));
    fireEvent.click(dialog('Merge into main').getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(screen.getByText('shared.txt')).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByRole('alert').some(node => node.textContent.includes('Nothing was merged'))).toBe(true);
    expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'This task conflicts with main in 1 file. Nothing was merged.' });
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('offers Commit when files are uncommitted and explains what else blocks the merge', async () => {
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
    expect(dialog('Commit changes').getByText('Commits 4 changed files in this task.')).toBeTruthy();
    expect(screen.getByLabelText('Commit message').value).toBe('Replies');
    typeInto('Commit message', '  Add replies ');
    fireEvent.click(dialog('Commit changes').getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(screen.getByText('3 commits not yet in main')).toBeTruthy());
    expect(api.commitTask).toHaveBeenCalledWith(TASK.id, 'Add replies');
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Changes committed' });
  });

  it('says nothing about merging while a workflow run is working in the task', async () => {
    await mount(landing({
      runActive: true, uncommitted: ['a.txt'], uncommittedCount: 20, commitsAhead: 0,
      blockers: {
        commit: blocked('A workflow run is still working in this task. Stop it or let it finish first.'),
        merge: [{ code: 'run_active', message: 'A workflow run is still working in this task. Stop it or let it finish first.' }, { code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }, { code: 'nothing_to_land', message: 'This task has no commits of its own yet.' }, { code: 'main_dirty', message: 'Main has uncommitted changes. Commit or stash them before merging.' }],
        pullRequest: blocked('A workflow run is still working in this task. Stop it or let it finish first.'),
        close: blocked('A workflow run is still working in this task. Stop it or let it finish first.'),
      },
    }));
    expect(screen.getByText('20 uncommitted files')).toBeTruthy();
    expect(screen.queryByText(/still working in this task/)).toBeNull();
    expect(screen.queryByText('This task has no commits of its own yet.')).toBeNull();
    expect(screen.queryByText(/Main has uncommitted changes/)).toBeNull();
    // The reason is still there for whoever hovers a disabled button.
    expect(screen.getByRole('button', { name: 'Merge into main' }).title).toBe('A workflow run is still working in this task. Stop it or let it finish first.');
  });

  it('never repeats that there are no commits yet when the uncommitted files already say so', async () => {
    await mount(landing({
      uncommitted: ['a.txt'], uncommittedCount: 2, commitsAhead: 0,
      blockers: { commit: [], merge: [{ code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }, { code: 'nothing_to_land', message: 'This task has no commits of its own yet.' }], pullRequest: [], close: blocked('x') },
    }));
    expect(screen.queryByText('This task has no commits of its own yet.')).toBeNull();
  });

  it('does nothing when the commit or the rename is cancelled, blank or unchanged', async () => {
    await mount(landing({ uncommittedCount: 1, uncommitted: ['a.txt'], blockers: { ...landing().blockers, commit: [] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));
    typeInto('Commit message', '   ');
    expect(dialog('Commit changes').getByRole('button', { name: 'Commit' }).disabled).toBe(true);
    fireEvent.click(dialog('Commit changes').getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(dialog('Rename task').getByRole('button', { name: 'Rename' }).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.commitTask).not.toHaveBeenCalled();
    expect(api.renameTask).not.toHaveBeenCalled();
  });

  it('renames the task with its revision', async () => {
    api.renameTask.mockResolvedValue({ title: 'Companion tag watch' });
    const { onChanged } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    typeInto('Task title', 'Companion tag watch');
    fireEvent.click(dialog('Rename task').getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.renameTask).toHaveBeenCalledWith(TASK.id, { title: 'Companion tag watch', revision: 3 });
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Renamed to Companion tag watch' });
  });

  it('opens a pull request on the chosen remote after naming where the branch is published', async () => {
    api.openTaskPullRequest.mockResolvedValue({ prUrl: 'https://github.com/team/demo/pull/3', remote: 'github' });
    const { onChanged, onFinished } = await mount(landing({ remotes: [{ name: 'origin', host: 'gitlab.com', tool: 'glab' }, { name: 'github', host: 'github.com', tool: 'gh' }, { name: 'mirror', host: 'git.example.test', tool: null }] }));
    const select = screen.getByRole('combobox', { name: 'Remote for the pull request' });
    expect([...select.options].map(option => option.value)).toEqual(['origin', 'github']);
    fireEvent.change(select, { target: { value: 'github' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open a pull request' }));
    expect(dialog('Open a pull request').getByText('task/replies-7a000000 is pushed to github (github.com) and a pull request into main is opened. Pushing publishes the branch.')).toBeTruthy();
    fireEvent.click(dialog('Open a pull request').getByRole('button', { name: 'Push and open' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
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
    api.closeTask.mockResolvedValue({ branchKept: 'task/replies-7a000000', unmergedCommits: 2, terminalsClosed: [], terminalsNotClosed: ['Demo-3'] });
    const { onFinished } = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Close task' }));
    const confirmClose = dialog('Close task');
    expect(confirmClose.getByText('"Replies" is closed, its copy of the project is removed and its terminals are closed. Its 2 commits stay on the branch task/replies-7a000000, not merged.')).toBeTruthy();
    expect(confirmClose.getByRole('button', { name: 'Close task' }).dataset.variant).toBe('danger');
    fireEvent.click(confirmClose.getByRole('button', { name: 'Close task' }));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Task closed. Branch task/replies-7a000000 was kept.' });
    expect(toast).toHaveBeenCalledWith({ type: 'error', message: '1 terminal could not be closed: Demo-3. Close it from its tab.' });
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ terminalsClosed: [] }));
  });

  it('says when the commits of a task are already in its base branch, and why it cannot be merged', async () => {
    const reason = "This task's commits are already in main, so there is nothing left to merge. Close the task to finish it.";
    await mount(landing({
      commitsAhead: 0, commitsBehind: 1, alreadyInBase: true,
      blockers: { commit: [{ code: 'nothing_to_commit', message: 'There is nothing to commit.' }], merge: [{ code: 'already_in_base', message: reason }], pullRequest: [{ code: 'already_in_base', message: reason }], close: [] },
    }));
    expect(screen.getByText('Commits already in main')).toBeTruthy();
    expect(screen.queryByText('No changes yet')).toBeNull();
    expect(screen.getByText('main has moved on by 1 commit')).toBeTruthy();
    const merge = screen.getByRole('button', { name: 'Merge into main' });
    expect(merge.disabled).toBe(true);
    expect(merge.getAttribute('title')).toBe(reason);
    const request = screen.getByRole('button', { name: 'Open a pull request' });
    expect(request.disabled).toBe(true);
    expect(request.getAttribute('title')).toBe(reason);
    expect(screen.getByRole('button', { name: 'Close task' }).disabled).toBe(false);
    // The reason is the bar's fact and the buttons' title; it is not repeated as a warning line.
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('keeps saying the commits are already in the base branch beside uncommitted files, without repeating it', async () => {
    const reason = "This task's commits are already in main, so there is nothing left to merge. Close the task to finish it.";
    await mount(landing({
      uncommitted: ['a.txt'], uncommittedCount: 1, commitsAhead: 0, alreadyInBase: true,
      blockers: { commit: [], merge: [{ code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }, { code: 'already_in_base', message: reason }], pullRequest: [], close: [] },
    }));
    expect(screen.getByText('1 uncommitted file')).toBeTruthy();
    expect(screen.getByText('Commits already in main')).toBeTruthy();
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('closes a task that holds ignored files of its own only after listing them, and says the owner agreed', async () => {
    const ignored = [{ code: 'ignored_files', message: 'This task has files Git ignores that exist nowhere else: logs/, owner.local. Move or delete them first.' }];
    const { onFinished } = await mount(landing({ commitsAhead: 0, ignoredAtRisk: ['logs/', 'owner.local'], ignoredAtRiskCount: 3, blockers: { commit: [], merge: [], pullRequest: [], close: ignored } }));
    expect(screen.getByText('3 ignored files only here')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Close task' });
    expect(close.disabled).toBe(false);
    api.closeTask.mockResolvedValue({ branchKept: 'task/replies-7a000000', unmergedCommits: 0, terminalsClosed: [], terminalsNotClosed: [] });
    fireEvent.click(close);
    const confirm = dialog('Close task');
    expect(confirm.getByText('"Replies" is closed, its copy of the project is removed and its terminals are closed. Files Git ignores that exist only in this task are deleted with it: logs/, owner.local and 1 more.')).toBeTruthy();
    const yes = confirm.getByRole('button', { name: 'Delete files and close' });
    expect(yes.dataset.variant).toBe('danger');
    expect(api.closeTask).not.toHaveBeenCalled();
    fireEvent.click(yes);
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(api.closeTask).toHaveBeenCalledWith(TASK.id, { deleteIgnored: true });
  });

  it('still refuses Close for any other reason beside ignored files', async () => {
    await mount(landing({ uncommitted: ['a.txt'], uncommittedCount: 1, ignoredAtRisk: ['logs/'], ignoredAtRiskCount: 1,
      blockers: { commit: [], merge: [], pullRequest: [], close: [{ code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }, { code: 'ignored_files', message: 'This task has files Git ignores that exist nowhere else: logs/, owner.local. Move or delete them first.' }] } }));
    const close = screen.getByRole('button', { name: 'Close task' });
    expect(close.disabled).toBe(true);
    expect(close.getAttribute('title')).toBe('This task has uncommitted changes. Commit them first.');
  });

  it('has no merge for a task started without a branch, and says when nothing has changed', async () => {
    await mount(landing({ baseBranch: null, commitsAhead: 0 }));
    expect(screen.queryByRole('button', { name: /Merge into/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open a pull request' })).toBeNull();
    expect(screen.getByText('No changes yet')).toBeTruthy();
  });

  it('adds a repository to a task with one, when the project has more to offer', async () => {
    api.getTaskLanding.mockResolvedValue(landing());
    const onChanged = vi.fn();
    render(<TaskLandingBar task={TASK} canAddRepository onChanged={onChanged} onFinished={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close task' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    fireEvent.click(dialog('Add a repository to this task').getByRole('button', { name: 'Add mobile-app' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('offers no repository to add in a project that lists no others', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: 'Add repository' })).toBeNull();
  });

  it('reports a status that could not be read and keeps Rename available', async () => {
    api.getTaskLanding.mockRejectedValue(new Error('Server unreachable'));
    render(<TaskLandingBar task={TASK} onChanged={() => {}} onFinished={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Server unreachable'));
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close task' })).toBeNull();
  });
});
