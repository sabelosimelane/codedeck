import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import TerminalArea from '../TerminalArea.jsx';
import { buildWorktreeGroups, resolveSessionWorktrees } from '../../utils/worktreeGroups.js';

vi.mock('../Terminal', () => ({ default: ({ sessionId, cwd }) => <span data-testid={`mounted-${sessionId}`} data-cwd={cwd} /> }));
vi.mock('../PaneDivider', () => ({ default: () => null }));
vi.mock('../tasks/TaskLandingBar.jsx', () => ({ default: ({ task }) => <span data-testid="landing-bar">{task.title}</span> }));
vi.mock('../TerminalInspector', () => ({ default: () => null }));
const toast = vi.hoisted(() => vi.fn());
const tasksApi = vi.hoisted(() => ({ openTaskTerminal: vi.fn(), createTask: vi.fn() }));
const repositoriesApi = vi.hoisted(() => ({ openProjectTerminal: vi.fn() }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('../../utils/tasksApi.js', () => tasksApi);
vi.mock('../../utils/projectRepositoriesApi.js', () => repositoriesApi);
vi.mock('../tasks/TaskView.jsx', () => ({ default: ({ run, children }) => <div><span data-testid="visible-runs">{run.id}</span>{children}</div> }));

const project = { name: 'Demo', path: '/group/backend', repositories: [{ name: 'mobile-app', path: '/group/mobile-app' }] };
const FOLDER = '/group/worktrees/replies-7a000000';
const MOBILE_WT = '7b000000-0000-4000-8000-000000000001';
const BACKEND_WT = '7b000000-0000-4000-8000-000000000002';
const worktree = (id, repository, first) => ({ id, repository, own: repository === 'backend', first, worktreePath: `${FOLDER}/${repository}`, branch: 'task/replies-7a000000', baseBranch: 'main', baseCommit: 'a'.repeat(40), state: 'active', prUrl: null });
const TASK = { id: '7a000000-0000-4000-8000-000000000001', project: 'Demo', title: 'Replies', state: 'active', worktreePath: `${FOLDER}/mobile-app`, branch: 'task/replies-7a000000', createdAt: '2026-01-02T00:00:00.000Z',
  folder: FOLDER, worktrees: [worktree(MOBILE_WT, 'mobile-app', true), worktree(BACKEND_WT, 'backend', false)] };
const TASK_KEY = TASK.worktreePath;
const sessions = [
  { sessionId: 'Demo-1', cwd: project.path, worktreePath: null, alive: true, startedAt: '2026-01-01T00:00:00.000Z' },
  { sessionId: 'Demo-2', cwd: `${FOLDER}/mobile-app`, worktreePath: `${FOLDER}/mobile-app`, alive: true, startedAt: '2026-01-02T00:00:00.000Z' },
  { sessionId: 'Demo-3', cwd: `${FOLDER}/backend`, worktreePath: `${FOLDER}/backend`, alive: true, startedAt: '2026-01-03T00:00:00.000Z' },
  { sessionId: 'Demo-4', cwd: '/group/mobile-app', worktreePath: '/group/mobile-app', alive: true, startedAt: '2026-01-04T00:00:00.000Z' },
];
const grouping = (runs = []) => {
  const input = { project, sessions: sessions.map(({ sessionId, worktreePath, startedAt }) => ({ sessionId, worktreePath, startedAt })), runs, tasks: [TASK] };
  return { worktreeGroups: buildWorktreeGroups(input), worktreeBySession: resolveSessionWorktrees(input) };
};
const mount = (selected, extra = {}) => render(<TerminalArea project={project} sessionStatus={sessions} selectedWorktree={selected} {...grouping()} {...extra} />);
const tabIds = view => view.getAllByTestId('terminal-tab').map(tab => tab.getAttribute('data-session-id'));
const chip = tab => tab.querySelector('[data-testid="terminal-tab-repository"]')?.textContent ?? null;
const originalFetch = global.fetch;

beforeEach(() => {
  toast.mockReset();
  Object.values(tasksApi).forEach(fn => fn.mockReset());
  repositoriesApi.openProjectTerminal.mockReset();
  localStorage.clear();
  global.fetch = vi.fn(async (url, options) => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : options?.method === 'POST' ? { sessionId: 'Demo-9' } : sessions }));
});
afterEach(() => { cleanup(); global.fetch = originalFetch; });

describe('TerminalArea with several repositories', () => {
  it('shows the terminals of every worktree of a task together, each named after its repository', async () => {
    const view = mount(TASK_KEY);
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-2', 'Demo-3']));
    expect(view.getAllByTestId('terminal-tab').map(chip)).toEqual(['mobile-app', 'backend']);
    expect(view.getByRole('button', { name: 'Replies (2)' }).getAttribute('aria-pressed')).toBe('true');
    expect(view.getByTestId('landing-bar').textContent).toBe('Replies');
  });

  it('keeps a terminal in another repository\'s own checkout in Main and names that repository', async () => {
    const view = mount('main');
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-1', 'Demo-4']));
    // The project's own repository is what Main always was: only the other one is named.
    expect(view.getAllByTestId('terminal-tab').map(chip)).toEqual([null, 'mobile-app']);
  });

  it('opens a new terminal in the repository of the active tab, or in the one chosen', async () => {
    tasksApi.openTaskTerminal.mockResolvedValueOnce({ sessionId: 'Demo-5', taskId: TASK.id, project: 'Demo', worktreeId: BACKEND_WT })
      .mockResolvedValueOnce({ sessionId: 'Demo-6', taskId: TASK.id, project: 'Demo', worktreeId: MOBILE_WT });
    const view = mount(TASK_KEY);
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-2', 'Demo-3']));
    const chooser = view.getByLabelText('Open new terminals in');
    expect([...chooser.options].map(option => option.textContent)).toEqual(['mobile-app', 'backend']);
    // The last tab of the task is the active one: new terminals follow it.
    expect(chooser.value).toBe(BACKEND_WT);
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-2', 'Demo-3', 'Demo-5']));
    expect(tasksApi.openTaskTerminal).toHaveBeenLastCalledWith(TASK.id, BACKEND_WT);
    expect(chip(view.getAllByTestId('terminal-tab')[2])).toBe('backend');

    fireEvent.change(view.getByLabelText('Open new terminals in'), { target: { value: MOBILE_WT } });
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-2', 'Demo-3', 'Demo-5', 'Demo-6']));
    expect(tasksApi.openTaskTerminal).toHaveBeenLastCalledWith(TASK.id, MOBILE_WT);
    expect(chip(view.getAllByTestId('terminal-tab')[3])).toBe('mobile-app');
    // The new terminal stays in the task.
    expect(view.getByRole('button', { name: 'Replies (4)' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('splits a tab into another terminal of the same repository', async () => {
    tasksApi.openTaskTerminal.mockResolvedValue({ sessionId: 'Demo-5', taskId: TASK.id, project: 'Demo', worktreeId: MOBILE_WT });
    const view = mount(TASK_KEY);
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-2', 'Demo-3']));
    fireEvent.click(view.getAllByTestId('terminal-tab')[0]);
    fireEvent.click(view.getByRole('button', { name: 'Split right' }));
    await waitFor(() => expect(view.getByTestId('mounted-Demo-5')).toBeTruthy());
    expect(tasksApi.openTaskTerminal).toHaveBeenCalledWith(TASK.id, MOBILE_WT);
  });

  it('opens a terminal in another repository of the project from Main', async () => {
    repositoriesApi.openProjectTerminal.mockResolvedValue({ sessionId: 'Demo-7', project: 'Demo', repository: 'mobile-app', path: '/group/mobile-app' });
    const view = mount('main');
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-1', 'Demo-4']));
    const chooser = view.getByLabelText('Open new terminals in');
    expect([...chooser.options].map(option => option.textContent)).toEqual(['backend', 'mobile-app']);
    fireEvent.click(view.getAllByTestId('terminal-tab')[0]);
    expect(view.getByLabelText('Open new terminals in').value).toBe('backend');
    fireEvent.change(view.getByLabelText('Open new terminals in'), { target: { value: 'mobile-app' } });
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-1', 'Demo-4', 'Demo-7']));
    expect(repositoriesApi.openProjectTerminal).toHaveBeenCalledWith('Demo', 'mobile-app');
    expect(global.fetch).not.toHaveBeenCalledWith('/api/terminal', expect.anything());
    expect(chip(view.getAllByTestId('terminal-tab')[2])).toBe('mobile-app');
    expect(toast).toHaveBeenCalledWith({ type: 'success', message: 'Opened terminal' });
    expect(view.getByRole('button', { name: 'Main (3)' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens a terminal in the project\'s own repository the way it always did', async () => {
    const view = mount('main');
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-1', 'Demo-4']));
    fireEvent.click(view.getAllByTestId('terminal-tab')[0]);
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/terminal', expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectName: 'Demo' }) })));
    expect(repositoriesApi.openProjectTerminal).not.toHaveBeenCalled();
  });

  it('reports a terminal that could not open in another repository and adds no tab', async () => {
    repositoriesApi.openProjectTerminal.mockRejectedValue(new Error('mobile-app: This folder is not the top level of a Git working tree.'));
    const view = mount('main');
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-1', 'Demo-4']));
    fireEvent.change(view.getByLabelText('Open new terminals in'), { target: { value: 'mobile-app' } });
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'mobile-app: This folder is not the top level of a Git working tree.' }));
    expect(tabIds(view)).toEqual(['Demo-1', 'Demo-4']);
  });

  it('shows a run on its task whichever of the task\'s repositories it works in', async () => {
    const run = { id: 'run-1', project: 'Demo', status: 'running', workflowName: 'Build', worktree: { path: `${FOLDER}/backend`, branch: 'task/replies-7a000000' }, createdAt: '2026-01-05T00:00:00.000Z', progress: null, steps: [] };
    const view = render(<TerminalArea project={project} sessionStatus={sessions} selectedWorktree={TASK_KEY} pipelineRuns={[run]} {...grouping([run])} />);
    await waitFor(() => expect(view.getByTestId('visible-runs').textContent).toBe('run-1'));
  });

  it('offers no choice where there is one repository', async () => {
    const lone = { name: 'Demo', path: '/group/backend', repositories: [] };
    global.fetch = vi.fn(async url => ({ ok: true, json: async () => (url === '/api/health' ? { terminalCreationAllowed: true } : [sessions[0]]) }));
    const input = { project: lone, sessions: [{ sessionId: 'Demo-1', worktreePath: null, startedAt: null }], runs: [], tasks: [] };
    const view = render(<TerminalArea project={lone} sessionStatus={[sessions[0]]} worktreeGroups={buildWorktreeGroups(input)} worktreeBySession={resolveSessionWorktrees(input)} />);
    await waitFor(() => expect(tabIds(view)).toEqual(['Demo-1']));
    expect(view.queryByLabelText('Open new terminals in')).toBeNull();
    expect(chip(view.getByTestId('terminal-tab'))).toBeNull();
  });
});
