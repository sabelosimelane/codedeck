import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  await waitFor(() => expect(screen.queryByText('Reading the task…')).toBeNull());
  return { onChanged, onFinished };
};

// Everything but the next step sits in the task's menu.
const menuItem = (name) => {
  if (!screen.queryByRole('menu')) fireEvent.click(screen.getByRole('button', { name: 'Task actions' }));
  return screen.getByRole('menuitem', { name });
};
const reasonOf = item => item.querySelector('.landing-menu-reason')?.textContent ?? null;

const dialog = name => within(screen.getByRole('dialog', { name }));
const typeInto = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => { toast.mockReset(); Object.values(api).forEach(fn => fn.mockReset()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TaskLandingBar', () => {
  it('says how the task stands and offers Merge as the only button', async () => {
    await mount();
    expect(screen.getByText('2 commits ready for main')).toBeTruthy();
    const merge = screen.getByRole('button', { name: 'Merge into main' });
    expect(merge.disabled).toBe(false);
    expect(merge.dataset.variant).toBe('primary');
    // Nothing else competes with it on the bar.
    expect(screen.queryByRole('button', { name: 'Commit changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open a pull request' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finish task…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(menuItem('Open a pull request').disabled).toBe(false);
    expect(menuItem('Finish task…').disabled).toBe(false);
    expect(screen.queryByRole('menuitem', { name: 'Merge into main' })).toBeNull();
    expect(screen.getByText('Branch task/replies-7a000000, started from main')).toBeTruthy();
    expect(screen.getByText('/tmp/worktrees/demo-replies')).toBeTruthy();
  });

  it('closes the menu on Escape and on a click outside it', async () => {
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Task actions' }));
    expect(screen.getByRole('menu', { name: 'Task actions' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Task actions' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
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

  it('offers Commit when files are uncommitted and says what else blocks the merge', async () => {
    api.commitTask.mockResolvedValue(landing({ commitsAhead: 3 }));
    await mount(landing({
      uncommitted: ['a.txt'], uncommittedCount: 4,
      blockers: { commit: [], merge: [{ code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }, { code: 'main_dirty', message: 'Main has uncommitted changes. Commit or stash them before merging.' }], pullRequest: blocked('This task has uncommitted changes. Commit them first.'), close: blocked('This task has uncommitted changes. Commit them first.') },
    }));
    expect(screen.getByText('4 uncommitted files')).toBeTruthy();
    expect(screen.getByText('and 3 more')).toBeTruthy();
    expect(screen.getByText('Main has uncommitted changes. Commit or stash them before merging.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Merge into main' })).toBeNull();
    const merge = menuItem('Merge into main');
    expect(merge.disabled).toBe(true);
    expect(reasonOf(merge)).toBe('This task has uncommitted changes. Commit them first.');
    const close = menuItem('Finish task…');
    expect(close.disabled).toBe(true);
    expect(reasonOf(close)).toBe('This task has uncommitted changes. Commit them first.');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Commit changes' }));
    expect(dialog('Commit changes').getByText('Commits 4 changed files in this task.')).toBeTruthy();
    expect(screen.getByLabelText('Commit message').value).toBe('Replies');
    typeInto('Commit message', '  Add replies ');
    fireEvent.click(dialog('Commit changes').getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(screen.getByText('3 commits ready for main')).toBeTruthy());
    expect(api.commitTask).toHaveBeenCalledWith(TASK.id, 'Add replies');
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Changes committed' });
  });

  it('says nothing about merging while a workflow run is working in the task, and offers no commit then', async () => {
    const working = 'A workflow run is still working in this task. Stop it or let it finish first.';
    await mount(landing({
      runActive: true, uncommitted: ['a.txt'], uncommittedCount: 20, commitsAhead: 0,
      blockers: {
        commit: blocked(working),
        merge: [{ code: 'run_active', message: working }, { code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }, { code: 'nothing_to_land', message: 'This task has no commits of its own yet.' }, { code: 'main_dirty', message: 'Main has uncommitted changes. Commit or stash them before merging.' }],
        pullRequest: blocked(working),
        close: blocked(working),
      },
    }));
    expect(screen.getByText('20 uncommitted files')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Commit changes' })).toBeNull();
    expect(screen.queryByText(/still working in this task/)).toBeNull();
    expect(screen.queryByText('This task has no commits of its own yet.')).toBeNull();
    expect(screen.queryByText(/Main has uncommitted changes/)).toBeNull();
    // The reason is kept under the item in the menu.
    expect(reasonOf(menuItem('Commit changes'))).toBe(working);
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
    fireEvent.click(menuItem('Rename task'));
    expect(dialog('Rename task').getByRole('button', { name: 'Rename' }).disabled).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.commitTask).not.toHaveBeenCalled();
    expect(api.renameTask).not.toHaveBeenCalled();
  });

  it('renames the task with its revision', async () => {
    api.renameTask.mockResolvedValue({ title: 'Companion tag watch' });
    const { onChanged } = await mount();
    fireEvent.click(menuItem('Rename task'));
    typeInto('Task title', 'Companion tag watch');
    fireEvent.click(dialog('Rename task').getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.renameTask).toHaveBeenCalledWith(TASK.id, { title: 'Companion tag watch', revision: 3 });
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Renamed to Companion tag watch' });
  });

  it('chooses the remote in the pull request dialog, which names where the branch is published', async () => {
    api.openTaskPullRequest.mockResolvedValue({ prUrl: 'https://github.com/team/demo/pull/3', remote: 'github' });
    const { onChanged, onFinished } = await mount(landing({ remotes: [{ name: 'origin', host: 'gitlab.com', tool: 'glab' }, { name: 'github', host: 'github.com', tool: 'gh' }, { name: 'mirror', host: 'git.example.test', tool: null }] }));
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(menuItem('Open a pull request'));
    const select = dialog('Open a pull request').getByRole('combobox', { name: 'Remote for the pull request' });
    expect([...select.options].map(option => option.value)).toEqual(['origin', 'github']);
    fireEvent.change(select, { target: { value: 'github' } });
    expect(dialog('Open a pull request').getByText('task/replies-7a000000 is pushed to github (github.com) and a pull request into main is opened. Pushing publishes the branch.')).toBeTruthy();
    fireEvent.click(dialog('Open a pull request').getByRole('button', { name: 'Push and open' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.openTaskPullRequest).toHaveBeenCalledWith(TASK.id, 'github');
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('links an open pull request instead of offering another, and hides the offer without a supported remote', async () => {
    await mount(landing({ state: 'pr_open', prUrl: 'https://gitlab.com/team/demo/-/merge_requests/7' }));
    expect(screen.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe('https://gitlab.com/team/demo/-/merge_requests/7');
    menuItem('Rename task');
    expect(screen.queryByRole('menuitem', { name: 'Open a pull request' })).toBeNull();
    cleanup();
    await mount(landing({ remotes: [{ name: 'mirror', host: 'git.example.test', tool: null }] }));
    menuItem('Rename task');
    expect(screen.queryByRole('menuitem', { name: 'Open a pull request' })).toBeNull();
  });

  it('warns that unmerged commits stay on the branch before closing', async () => {
    api.closeTask.mockResolvedValue({ branchKept: 'task/replies-7a000000', unmergedCommits: 2, terminalsClosed: [], terminalsNotClosed: ['Demo-3'] });
    const { onFinished } = await mount();
    fireEvent.click(menuItem('Finish task…'));
    const confirmClose = dialog('Finish task…');
    expect(confirmClose.getByText('"Replies" is closed, its copy of the project is removed and its terminals are closed. Its 2 commits stay on the branch task/replies-7a000000, not merged.')).toBeTruthy();
    expect(confirmClose.getByRole('button', { name: 'Finish task' }).dataset.variant).toBe('danger');
    fireEvent.click(confirmClose.getByRole('button', { name: 'Finish task' }));
    await waitFor(() => expect(onFinished).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Task closed. Branch task/replies-7a000000 was kept.' });
    expect(toast).toHaveBeenCalledWith({ type: 'error', message: '1 terminal could not be closed: Demo-3. Close it from its tab.' });
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ terminalsClosed: [] }));
  });

  it('offers Close as the next step when the commits of a task are already in its base branch', async () => {
    const reason = "This task's commits are already in main, so there is nothing left to merge. Close the task to finish it.";
    await mount(landing({
      commitsAhead: 0, commitsBehind: 1, alreadyInBase: true,
      blockers: { commit: [{ code: 'nothing_to_commit', message: 'There is nothing to commit.' }], merge: [{ code: 'already_in_base', message: reason }], pullRequest: [{ code: 'already_in_base', message: reason }], close: [] },
    }));
    expect(screen.getByText('Already in main')).toBeTruthy();
    expect(screen.queryByText('No changes yet')).toBeNull();
    expect(screen.getByText('main has moved on by 1 commit')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Finish task…' });
    expect(close.dataset.variant).toBe('primary');
    expect(screen.queryByRole('button', { name: 'Merge into main' })).toBeNull();
    menuItem('Rename task');
    expect(screen.queryByRole('menuitem', { name: 'Merge into main' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Open a pull request' })).toBeNull();
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('puts uncommitted files first even when earlier commits are already in the base branch', async () => {
    const reason = "This task's commits are already in main, so there is nothing left to merge. Close the task to finish it.";
    await mount(landing({
      uncommitted: ['a.txt'], uncommittedCount: 1, commitsAhead: 0, alreadyInBase: true,
      blockers: { commit: [], merge: [{ code: 'uncommitted', message: 'This task has uncommitted changes. Commit them first.' }, { code: 'already_in_base', message: reason }], pullRequest: [], close: [] },
    }));
    expect(screen.getByText('1 uncommitted file')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Commit changes' })).toBeTruthy();
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('closes a task that holds ignored files of its own only after listing them, and says the owner agreed', async () => {
    const ignored = [{ code: 'ignored_files', message: 'This task has files Git ignores that exist nowhere else: logs/, owner.local. Move or delete them first.' }];
    const { onFinished } = await mount(landing({ commitsAhead: 0, ignoredAtRisk: ['logs/', 'owner.local'], ignoredAtRiskCount: 3, blockers: { commit: [], merge: [], pullRequest: [], close: ignored } }));
    expect(screen.getByText('3 ignored files only here')).toBeTruthy();
    const close = menuItem('Finish task…');
    expect(close.disabled).toBe(false);
    api.closeTask.mockResolvedValue({ branchKept: 'task/replies-7a000000', unmergedCommits: 0, terminalsClosed: [], terminalsNotClosed: [] });
    fireEvent.click(close);
    const confirm = dialog('Finish task…');
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
    const close = menuItem('Finish task…');
    expect(close.disabled).toBe(true);
    expect(reasonOf(close)).toBe('This task has uncommitted changes. Commit them first.');
  });

  it('has no merge for a task started without a branch, and says when nothing has changed', async () => {
    await mount(landing({ baseBranch: null, commitsAhead: 0 }));
    expect(screen.queryByRole('button', { name: /Merge into/ })).toBeNull();
    menuItem('Rename task');
    expect(screen.queryByRole('menuitem', { name: /Merge into/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Open a pull request' })).toBeNull();
    expect(screen.getByText('No changes yet')).toBeTruthy();
  });

  it('adds a repository to a task with one, when the project has more to offer', async () => {
    api.getTaskLanding.mockResolvedValue(landing());
    const onChanged = vi.fn();
    render(<TaskLandingBar task={TASK} canAddRepository onChanged={onChanged} onFinished={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('Reading the task…')).toBeNull());
    fireEvent.click(menuItem('Add repository'));
    fireEvent.click(dialog('Add a repository to this task').getByRole('button', { name: 'Add mobile-app' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('offers no repository to add in a project that lists no others', async () => {
    await mount();
    menuItem('Rename task');
    expect(screen.queryByRole('menuitem', { name: 'Add repository' })).toBeNull();
  });

  it('reports a status that could not be read and keeps Rename available', async () => {
    api.getTaskLanding.mockRejectedValue(new Error('Server unreachable'));
    render(<TaskLandingBar task={TASK} onChanged={() => {}} onFinished={() => {}} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Server unreachable'));
    expect(menuItem('Rename task')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Finish task…' })).toBeNull();
  });
});

it('explains overlapping Finish blockers and never suggests a switched checkout is ready', async () => {
  const run = { code: 'run_active', message: 'Stop the working run or let it finish.' };
  const drift = { code: 'branch_switched', message: 'Switch feature/scratch back to task/replies-7a000000.' };
  await mount(landing({ blockers: { commit: [drift], merge: [run, drift], pullRequest: [run, drift], close: [run, drift] } }));
  expect(screen.queryByText('2 commits ready for main')).toBeNull();
  expect(screen.getByText('Checkout on a different branch')).toBeTruthy();
  const finish = menuItem('Finish task…');
  expect(finish.disabled).toBe(true);
  expect(finish.textContent).toContain(run.message);
  expect(finish.textContent).toContain(drift.message);
});

it('ignores an older status across errors, recovery, and task selection', async () => {
  vi.useFakeTimers();
  try {
    const reads = [];
    api.getTaskLanding.mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })));
    const view = render(<TaskLandingBar task={TASK} />);
    const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    const fail = (i, message) => act(async () => reads[i].reject(new Error(message)));
    const succeed = i => act(async () => reads[i].resolve(landing()));
    const merge = () => screen.queryByRole('button', { name: 'Merge into main' });
    await fail(0, 'Initial inspection failed');
    expect(screen.getByRole('alert').textContent).toBe('Initial inspection failed');
    await tick();
    await succeed(1);
    expect(merge()).toBeTruthy();
    await tick();
    await tick();
    await fail(3, 'Latest inspection failed');
    expect(merge()).toBeNull();
    await succeed(2);
    expect(merge()).toBeNull();
    await tick();
    await tick();
    await succeed(5);
    await fail(4, 'Late failure');
    expect(merge()).toBeTruthy();
    await tick();
    view.rerender(<TaskLandingBar task={{ ...TASK, id: 'replacement', title: 'Other task' }} />);
    await succeed(6);
    expect(merge()).toBeNull();
    await succeed(7);
    expect(merge()).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
