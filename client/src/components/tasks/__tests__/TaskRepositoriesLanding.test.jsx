import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

const toast = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => ({
  getTaskLanding: vi.fn(), commitTask: vi.fn(), mergeTask: vi.fn(), openTaskPullRequest: vi.fn(), closeTask: vi.fn(), renameTask: vi.fn(),
  listTaskWorktreeLandings: vi.fn(), commitTaskWorktree: vi.fn(), mergeTaskWorktree: vi.fn(), openTaskWorktreePullRequest: vi.fn(), closeTaskWorktree: vi.fn(),
}));
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

const ID = '7a000000-0000-4000-8000-000000000001';
const BACKEND = '7b000000-0000-4000-8000-000000000001';
const MOBILE = '7b000000-0000-4000-8000-000000000002';
const FOLDER = '/group/worktrees/replies-7a000000';
const worktree = (id, repository, first, state = 'active') => ({ id, repository, own: repository === 'backend', first, worktreePath: `${FOLDER}/${repository}`, branch: 'task/replies-7a000000', baseBranch: 'main', baseCommit: 'a'.repeat(40), state, prUrl: null });
const TASK = { id: ID, project: 'Demo', title: 'Replies', revision: 3, state: 'active', worktreePath: `${FOLDER}/backend`, folder: FOLDER, worktrees: [worktree(BACKEND, 'backend', true), worktree(MOBILE, 'mobile-app', false)] };
const none = { commit: [], merge: [], pullRequest: [], close: [] };
const blocked = message => [{ code: 'x', message }];
const standing = (worktreeId, repository, overrides = {}) => ({
  taskId: ID, worktreeId, repository, own: repository === 'backend', first: repository === 'backend', worktreePath: `${FOLDER}/${repository}`,
  state: 'active', branch: 'task/replies-7a000000', baseBranch: 'main', prUrl: null, filesPresent: true, runActive: false,
  uncommitted: [], uncommittedCount: 0, commitsAhead: 0, commitsBehind: 0, alreadyInBase: false, ignoredAtRisk: [], ignoredAtRiskCount: 0, main: { branch: 'main', dirty: false },
  remotes: [{ name: 'origin', host: 'github.com', tool: 'gh' }], blockers: { ...none, commit: [{ code: 'nothing_to_commit', message: 'There is nothing to commit.' }] }, ...overrides,
});
const clean = { commitsAhead: 2 };
const dirty = { uncommitted: ['a.txt'], uncommittedCount: 1, blockers: { ...none, merge: blocked('mobile-app has uncommitted changes in this task. Commit them first.'), close: blocked('mobile-app has uncommitted changes in this task. Commit them first.') } };

async function mount(landings = [standing(BACKEND, 'backend', clean), standing(MOBILE, 'mobile-app', dirty)], task = TASK) {
  api.listTaskWorktreeLandings.mockResolvedValue(landings);
  const handlers = { onChanged: vi.fn(), onFinished: vi.fn(), onRepositoryFinished: vi.fn() };
  render(<TaskLandingBar task={task} {...handlers} />);
  await waitFor(() => expect(screen.getByRole('list', { name: 'Repositories of this task' })).toBeTruthy());
  return handlers;
}
const row = repository => within(screen.getByRole('list', { name: 'Repositories of this task' }).querySelector(`[data-repository="${repository}"]`));
const dialog = name => within(screen.getByRole('dialog', { name }));
// Everything but a repository's next step is in its row's menu; the task's own actions are in the task's menu.
const openMenu = (label, scope = screen) => {
  if (!screen.queryByRole('menu', { name: label })) fireEvent.click(scope.getByRole('button', { name: label }));
  return within(screen.getByRole('menu', { name: label }));
};
const rowMenu = repository => openMenu(`More actions for ${repository}`, row(repository));
const taskMenu = () => openMenu('Task actions');
const reasonOf = item => item.querySelector('.landing-menu-reason')?.textContent ?? null;

beforeEach(() => { toast.mockReset(); Object.values(api).forEach(fn => fn.mockReset()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TaskLandingBar for a task with several repositories', () => {
  it('says how each repository stands, on its own row', async () => {
    await mount([standing(BACKEND, 'backend', clean), standing(MOBILE, 'mobile-app', { ...dirty, commitsBehind: 3 })]);
    expect(api.listTaskWorktreeLandings).toHaveBeenCalledWith(ID);
    expect(api.getTaskLanding).not.toHaveBeenCalled();
    expect(row('backend').getByText('2 commits ready for main')).toBeTruthy();
    const merge = row('backend').getByRole('button', { name: 'Merge backend into main' });
    expect(merge.disabled).toBe(false);
    expect(merge.dataset.variant).toBe('primary');
    expect(row('backend').queryByRole('button', { name: 'Commit changes in backend' })).toBeNull();
    expect(row('backend').queryByRole('button', { name: 'Close backend' })).toBeNull();
    expect(row('mobile-app').getByText('1 uncommitted file')).toBeTruthy();
    expect(row('mobile-app').getByText('main has moved on by 3 commits')).toBeTruthy();
    // One button per row: the next step. Nothing to merge yet means no merge is offered at all.
    expect(row('mobile-app').getByRole('button', { name: 'Commit changes in mobile-app' }).disabled).toBe(false);
    expect(row('mobile-app').queryByRole('button', { name: 'Merge mobile-app into main' })).toBeNull();
    expect(rowMenu('mobile-app').queryByRole('menuitem', { name: 'Merge mobile-app into main' })).toBeNull();
    const close = rowMenu('mobile-app').getByRole('menuitem', { name: 'Close mobile-app' });
    expect(close.disabled).toBe(true);
    expect(reasonOf(close)).toBe('mobile-app has uncommitted changes in this task. Commit them first.');
  });

  it('tells a repository whose commits are already in its base branch from one that is untouched', async () => {
    const reason = "mobile-app's commits in this task are already in main, so there is nothing left to merge. Close mobile-app to finish it.";
    const untouched = 'backend has no commits of its own in this task yet.';
    await mount([
      standing(BACKEND, 'backend', { blockers: { ...none, merge: [{ code: 'nothing_to_land', message: untouched }], pullRequest: [{ code: 'nothing_to_land', message: untouched }] } }),
      standing(MOBILE, 'mobile-app', { alreadyInBase: true, commitsBehind: 1, blockers: { ...none, merge: [{ code: 'already_in_base', message: reason }], pullRequest: [{ code: 'already_in_base', message: reason }] } }),
    ]);
    expect(row('backend').getByText('No changes yet')).toBeTruthy();
    expect(row('backend').queryByText('Already in main')).toBeNull();
    expect(row('backend').queryAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['More actions for backend']);
    expect(row('mobile-app').getByText('Already in main')).toBeTruthy();
    expect(row('mobile-app').queryByText('No changes yet')).toBeNull();
    // Work already in the base branch is finished by closing it; neither merge nor a pull request is offered.
    const close = row('mobile-app').getByRole('button', { name: 'Close mobile-app' });
    expect(close.dataset.variant).toBe('primary');
    // With nothing else to do there, the row has no menu at all.
    expect(row('mobile-app').queryAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Close mobile-app']);
    expect(screen.queryByText(reason)).toBeNull();
  });

  it('shows a repository that is already merged or closed without anything to do', async () => {
    await mount([standing(BACKEND, 'backend', { state: 'merged', filesPresent: false, commitsAhead: null, commitsBehind: null, blockers: { commit: blocked('f'), merge: blocked('f'), pullRequest: blocked('f'), close: blocked('f') } }), standing(MOBILE, 'mobile-app', clean)]);
    expect(row('backend').getByText('merged')).toBeTruthy();
    expect(row('backend').queryAllByRole('button')).toEqual([]);
    expect(rowMenu('mobile-app').getByRole('menuitem', { name: 'Close mobile-app' })).toBeTruthy();
  });

  it('commits one repository and shows how it stands afterwards', async () => {
    await mount();
    api.commitTaskWorktree.mockResolvedValue(standing(MOBILE, 'mobile-app', clean));
    fireEvent.click(row('mobile-app').getByRole('button', { name: 'Commit changes in mobile-app' }));
    fireEvent.change(dialog('Commit changes in mobile-app').getByLabelText('Commit message'), { target: { value: 'Mobile part' } });
    fireEvent.click(dialog('Commit changes in mobile-app').getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Changes committed in mobile-app' }));
    expect(api.commitTaskWorktree).toHaveBeenCalledWith(ID, MOBILE, 'Mobile part');
    await waitFor(() => expect(row('mobile-app').getByText('2 commits ready for main')).toBeTruthy());
    expect(row('mobile-app').queryByText('1 uncommitted file')).toBeNull();
  });

  it('merges one repository after confirmation and stays on the task while another is open', async () => {
    const handlers = await mount();
    const result = { task: { ...TASK, revision: 4 }, repository: 'backend', mergedInto: 'main', filesRemoved: true, filesDetail: null, branchDeleted: true, taskFinished: false, terminalsClosed: ['Demo-4'], terminalsNotClosed: [] };
    api.mergeTaskWorktree.mockResolvedValue(result);
    fireEvent.click(row('backend').getByRole('button', { name: 'Merge backend into main' }));
    expect(dialog('Merge backend into main').getByText(/The task stays open for its other repositories\./)).toBeTruthy();
    fireEvent.click(dialog('Merge backend into main').getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Merged backend into main. 1 terminal closed.' }));
    expect(api.mergeTaskWorktree).toHaveBeenCalledWith(ID, BACKEND);
    expect(handlers.onRepositoryFinished).toHaveBeenCalledWith(result);
    expect(handlers.onChanged).toHaveBeenCalled();
    expect(handlers.onFinished).not.toHaveBeenCalled();
  });

  it('leaves the task when merging its last repository finished it', async () => {
    const handlers = await mount([standing(BACKEND, 'backend', { state: 'merged', filesPresent: false, blockers: { commit: blocked('f'), merge: blocked('f'), pullRequest: blocked('f'), close: blocked('f') } }), standing(MOBILE, 'mobile-app', clean)]);
    const result = { task: { ...TASK, state: 'merged' }, repository: 'mobile-app', mergedInto: 'main', filesRemoved: true, filesDetail: null, branchDeleted: true, taskFinished: true, terminalsClosed: [], terminalsNotClosed: ['Demo-5'] };
    api.mergeTaskWorktree.mockResolvedValue(result);
    fireEvent.click(row('mobile-app').getByRole('button', { name: 'Merge mobile-app into main' }));
    expect(dialog('Merge mobile-app into main').getByText(/This is the task's last repository: the task is finished\./)).toBeTruthy();
    fireEvent.click(dialog('Merge mobile-app into main').getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(handlers.onFinished).toHaveBeenCalledWith(result));
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Merged mobile-app into main. The task is finished.' });
    expect(toast).toHaveBeenCalledWith({ type: 'error', message: '1 terminal could not be closed: Demo-5. Close it from its tab.' });
    expect(handlers.onRepositoryFinished).not.toHaveBeenCalled();
  });

  it('keeps a refused merge on the row of its repository, with the conflicting files', async () => {
    const handlers = await mount();
    api.mergeTaskWorktree.mockRejectedValue(Object.assign(new Error('backend conflicts with main in 1 file. Nothing was merged.'), { reasons: [], conflicts: ['README.md'] }));
    fireEvent.click(row('backend').getByRole('button', { name: 'Merge backend into main' }));
    fireEvent.click(dialog('Merge backend into main').getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'backend conflicts with main in 1 file. Nothing was merged.' }));
    expect(row('backend').getByRole('alert').textContent).toContain('backend conflicts with main in 1 file. Nothing was merged.');
    expect(row('backend').getByText('README.md')).toBeTruthy();
    expect(row('mobile-app').queryByRole('alert')).toBeNull();
    expect(handlers.onFinished).not.toHaveBeenCalled();
  });

  it('opens a pull request for one repository on the remote chosen', async () => {
    await mount([standing(BACKEND, 'backend', { ...clean, remotes: [{ name: 'origin', host: 'gitlab.com', tool: 'glab' }, { name: 'github', host: 'github.com', tool: 'gh' }, { name: 'mirror', host: 'git.example.test', tool: null }] }), standing(MOBILE, 'mobile-app', { ...dirty, remotes: [] })]);
    api.openTaskWorktreePullRequest.mockResolvedValue({ task: TASK, repository: 'backend', prUrl: 'https://github.com/team/backend/pull/7', remote: 'github' });
    expect(rowMenu('mobile-app').queryByRole('menuitem', { name: 'Open a pull request for mobile-app' })).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(rowMenu('backend').getByRole('menuitem', { name: 'Open a pull request for backend' }));
    fireEvent.change(dialog('Open a pull request for backend').getByLabelText('Remote for the pull request of backend'), { target: { value: 'github' } });
    expect(dialog('Open a pull request for backend').getByText(/is pushed to github \(github\.com\)/)).toBeTruthy();
    fireEvent.click(dialog('Open a pull request for backend').getByRole('button', { name: 'Push and open' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Pull request opened for backend: https://github.com/team/backend/pull/7' }));
    expect(api.openTaskWorktreePullRequest).toHaveBeenCalledWith(ID, BACKEND, 'github');
  });

  it('links the pull request a repository already has', async () => {
    await mount([standing(BACKEND, 'backend', { ...clean, state: 'pr_open', prUrl: 'https://github.com/team/backend/pull/7' }), standing(MOBILE, 'mobile-app', clean)]);
    expect(row('backend').getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe('https://github.com/team/backend/pull/7');
    expect(rowMenu('backend').queryByRole('menuitem', { name: 'Open a pull request for backend' })).toBeNull();
  });

  it('closes one repository, keeps its branch and stays on the task', async () => {
    const handlers = await mount([standing(BACKEND, 'backend', clean), standing(MOBILE, 'mobile-app', clean)]);
    const result = { task: TASK, repository: 'mobile-app', branchKept: 'task/replies-7a000000', unmergedCommits: 2, taskFinished: false, terminalsClosed: [], terminalsNotClosed: [] };
    api.closeTaskWorktree.mockResolvedValue(result);
    fireEvent.click(rowMenu('mobile-app').getByRole('menuitem', { name: 'Close mobile-app' }));
    expect(dialog('Close mobile-app').getByText(/Its 2 commits stay on the branch task\/replies-7a000000, not merged\./)).toBeTruthy();
    fireEvent.click(dialog('Close mobile-app').getByRole('button', { name: 'Close repository' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Closed mobile-app in this task. Branch task/replies-7a000000 was kept.' }));
    expect(api.closeTaskWorktree).toHaveBeenCalledWith(ID, MOBILE);
    expect(handlers.onRepositoryFinished).toHaveBeenCalledWith(result);
    expect(handlers.onFinished).not.toHaveBeenCalled();
  });

  it('closes a repository that holds ignored files of its own only after listing them', async () => {
    const ignored = { ignoredAtRisk: ['.project', 'logs/'], ignoredAtRiskCount: 2, blockers: { ...none, close: [{ code: 'ignored_files', message: 'x' }] } };
    await mount([standing(BACKEND, 'backend', ignored), standing(MOBILE, 'mobile-app')]);
    expect(row('backend').getByText('2 ignored files only here')).toBeTruthy();
    api.closeTaskWorktree.mockResolvedValue({ task: TASK, repository: 'backend', branchKept: 'task/replies-7a000000', unmergedCommits: 0, taskFinished: false, terminalsClosed: [], terminalsNotClosed: [] });
    const close = rowMenu('backend').getByRole('menuitem', { name: 'Close backend' });
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(dialog('Close backend').getByText(/Files Git ignores that exist only in this copy are deleted with it: \.project, logs\/\./)).toBeTruthy();
    fireEvent.click(dialog('Close backend').getByRole('button', { name: 'Delete files and close' }));
    await waitFor(() => expect(api.closeTaskWorktree).toHaveBeenCalledWith(ID, BACKEND, { deleteIgnored: true }));
  });

  it('closes the whole task with the ignored files of each repository only after listing them', async () => {
    const ignored = files => ({ ignoredAtRisk: files, ignoredAtRiskCount: files.length, blockers: { ...none, close: [{ code: 'ignored_files', message: 'x' }] } });
    const handlers = await mount([standing(BACKEND, 'backend', ignored(['.project', 'logs/'])), standing(MOBILE, 'mobile-app', ignored(['.gradle/']))]);
    const result = { task: { ...TASK, state: 'closed' }, branchKept: 'task/replies-7a000000', unmergedCommits: 0, terminalsClosed: [], terminalsNotClosed: [] };
    api.closeTask.mockResolvedValue(result);
    const close = taskMenu().getByRole('menuitem', { name: 'Close task' });
    expect(close.disabled).toBe(false);
    fireEvent.click(close);
    expect(dialog('Close task').getByText(/Files Git ignores that exist only in this task are deleted with it: backend: \.project, logs\/; mobile-app: \.gradle\/\./)).toBeTruthy();
    const yes = dialog('Close task').getByRole('button', { name: 'Delete files and close' });
    expect(yes.dataset.variant).toBe('danger');
    fireEvent.click(yes);
    await waitFor(() => expect(handlers.onFinished).toHaveBeenCalledWith(result));
    expect(api.closeTask).toHaveBeenCalledWith(ID, { deleteIgnored: true });
  });

  it('closes the whole task when every repository can be closed', async () => {
    const handlers = await mount([standing(BACKEND, 'backend', clean), standing(MOBILE, 'mobile-app', clean)]);
    const result = { task: { ...TASK, state: 'closed' }, branchKept: 'task/replies-7a000000', unmergedCommits: 4, terminalsClosed: ['Demo-4'], terminalsNotClosed: [] };
    api.closeTask.mockResolvedValue(result);
    fireEvent.click(taskMenu().getByRole('menuitem', { name: 'Close task' }));
    expect(dialog('Close task').getByText(/Every repository of "Replies" is closed/)).toBeTruthy();
    fireEvent.click(dialog('Close task').getByRole('button', { name: 'Close task' }));
    await waitFor(() => expect(handlers.onFinished).toHaveBeenCalledWith(result));
    expect(api.closeTask).toHaveBeenCalledWith(ID);
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Task closed. Branch task/replies-7a000000 was kept. 1 terminal closed.' });
  });

  it('does not offer to close the whole task while a repository cannot be closed, and says which', async () => {
    await mount();
    const close = taskMenu().getByRole('menuitem', { name: 'Close task' });
    expect(close.disabled).toBe(true);
    expect(reasonOf(close)).toBe('mobile-app has uncommitted changes in this task. Commit them first.');
  });

  it('keeps the reason on screen when closing the whole task is refused', async () => {
    await mount([standing(BACKEND, 'backend', clean), standing(MOBILE, 'mobile-app', clean)]);
    api.closeTask.mockRejectedValue(Object.assign(new Error('Nothing was closed. A workflow run is still working in this task. Stop it or let it finish first.'), { reasons: [{ code: 'run_active', message: 'A workflow run is still working in this task. Stop it or let it finish first.' }], conflicts: [] }));
    fireEvent.click(taskMenu().getByRole('menuitem', { name: 'Close task' }));
    fireEvent.click(dialog('Close task').getByRole('button', { name: 'Close task' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Nothing was closed.'));
  });

  it('renames the task with its revision', async () => {
    const handlers = await mount();
    api.renameTask.mockResolvedValue({ ...TASK, title: 'Replies v2' });
    fireEvent.click(taskMenu().getByRole('menuitem', { name: 'Rename task' }));
    fireEvent.change(dialog('Rename task').getByLabelText('Task title'), { target: { value: 'Replies v2' } });
    fireEvent.click(dialog('Rename task').getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Renamed to Replies v2' }));
    expect(api.renameTask).toHaveBeenCalledWith(ID, { title: 'Replies v2', revision: 3 });
    expect(handlers.onChanged).toHaveBeenCalled();
  });

  it('reports a status that could not be read and keeps Rename available', async () => {
    api.listTaskWorktreeLandings.mockRejectedValueOnce(new Error('Server unreachable'));
    render(<TaskLandingBar task={TASK} onChanged={vi.fn()} onFinished={vi.fn()} onRepositoryFinished={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Server unreachable'));
    expect(taskMenu().getByRole('menuitem', { name: 'Rename task' }).disabled).toBe(false);
    expect(screen.queryByRole('list', { name: 'Repositories of this task' })).toBeNull();
  });

  it('adds a repository to the task when the project has more to offer', async () => {
    api.listTaskWorktreeLandings.mockResolvedValue([standing(BACKEND, 'backend', clean), standing(MOBILE, 'mobile-app', clean)]);
    const onChanged = vi.fn();
    render(<TaskLandingBar task={TASK} canAddRepository onChanged={onChanged} onFinished={vi.fn()} onRepositoryFinished={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('list', { name: 'Repositories of this task' })).toBeTruthy());
    fireEvent.click(taskMenu().getByRole('menuitem', { name: 'Add repository' }));
    fireEvent.click(dialog('Add a repository to this task').getByRole('button', { name: 'Add mobile-app' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Add a repository to this task' })).toBeNull();
  });

  it('offers no repository to add in a project that lists no others', async () => {
    await mount();
    expect(taskMenu().queryByRole('menuitem', { name: 'Add repository' })).toBeNull();
  });

  it('shows a task with one repository the way it always was', async () => {
    api.getTaskLanding.mockResolvedValue({
      taskId: ID, state: 'active', branch: 'task/replies-7a000000', baseBranch: 'main', prUrl: null, filesPresent: true, runActive: false,
      uncommitted: [], uncommittedCount: 0, commitsAhead: 2, commitsBehind: 0, main: { branch: 'main', dirty: false }, remotes: [], blockers: none,
    });
    render(<TaskLandingBar task={{ ...TASK, worktrees: [TASK.worktrees[0]] }} onChanged={vi.fn()} onFinished={vi.fn()} onRepositoryFinished={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Merge into main' })).toBeTruthy());
    expect(api.listTaskWorktreeLandings).not.toHaveBeenCalled();
    expect(screen.queryByRole('list', { name: 'Repositories of this task' })).toBeNull();
  });
});
