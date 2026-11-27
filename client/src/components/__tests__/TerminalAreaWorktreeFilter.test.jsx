import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import TerminalArea from '../TerminalArea.jsx';
import { buildWorktreeGroups, resolveSessionWorktrees } from '../../utils/worktreeGroups.js';

vi.mock('../Terminal', () => ({ default: ({ sessionId }) => <span data-testid={`mounted-${sessionId}`} /> }));
vi.mock('../PaneDivider', () => ({ default: () => null }));
vi.mock('../tasks/TaskLandingBar.jsx', () => ({ default: ({ task }) => <span data-testid="landing-bar">{task.title}</span> }));
vi.mock('../TerminalInspector', () => ({ default: () => null }));
const toast = vi.hoisted(() => vi.fn());
const tasksApi = vi.hoisted(() => ({ openTaskTerminal: vi.fn(), createTask: vi.fn() }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
vi.mock('../../utils/tasksApi.js', () => tasksApi);
vi.mock('../tasks/TaskView.jsx', () => ({ default: ({ run, onActivateStep, onCleanup, children }) => <div><span data-testid="visible-runs">{run.id}</span>{run.steps?.map(step => <button key={step.sessionId} onClick={() => onActivateStep(step.sessionId)}>Step {step.sessionId}</button>)}<button onClick={() => onCleanup(run.id)}>Close run</button>{children}</div> }));

const project = { name: 'Demo', path: '/tmp/demo', repositories: [] };
const sessions = [
  { sessionId: 'Demo-1', cwd: project.path, worktreePath: null, alive: true, startedAt: '2026-01-01T00:00:00.000Z' },
  { sessionId: 'Demo-2', cwd: '/tmp/demo-feature', worktreePath: '/tmp/demo-feature', alive: true, startedAt: '2026-01-02T00:00:00.000Z' },
];
const groups = [
  { key: 'main', path: project.path, label: 'Main checkout', branch: null, isMain: true, sessionIds: ['Demo-1'], run: null },
  { key: '/tmp/demo-feature', path: '/tmp/demo-feature', label: 'demo-feature', branch: 'feature', isMain: false, sessionIds: ['Demo-2'], run: { id: '57f488b5-1234', workflowName: 'Build', status: 'needs_input', worktree: { path: '/tmp/demo-feature' } } },
];
const TASK = { id: '7a000000-0000-4000-8000-000000000001', project: 'Demo', title: 'Replies', state: 'active', worktreePath: '/tmp/demo-feature', branch: 'feature', createdAt: '2026-01-02T00:00:00.000Z' };
const taskGroups = [groups[0], { ...groups[1], run: null, task: TASK }];
const originalFetch = global.fetch;
beforeEach(() => {
  toast.mockReset();
  tasksApi.openTaskTerminal.mockReset();
  tasksApi.createTask.mockReset();
  localStorage.clear();
  global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : sessions }));
});
afterEach(() => { cleanup(); global.fetch = originalFetch; });

describe('TerminalArea worktree view', () => {
  it('shows only Main, New task and Run workflow, and filters no tabs, when the project has no tasks', async () => {
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={[groups[0]]} worktreeBySession={new Map()} />);
    await waitFor(() => expect(view.getAllByTestId('terminal-tab')).toHaveLength(2));
    expect([...view.getByLabelText('Main and tasks').querySelectorAll('button')].map(button => button.textContent)).toEqual(['Main2', 'New task', 'Run workflow']);
  });
  it.each([['running', 'running', 'active', false], ['complete', 'complete', 'done', false], ['error', 'failed', 'danger', true], ['interrupted', 'interrupted', 'waiting', true]])('says on the strip that the task’s run is %s', async (status, word, tone, flagged) => {
    const stateGroups = [groups[0], { ...groups[1], run: { ...groups[1].run, status } }];
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={stateGroups} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    const button = await waitFor(() => view.getByRole('button', { name: 'Build · 57f488b5 (1)' }));
    const state = button.querySelector('.worktree-switcher-state');
    expect(state.textContent).toBe(word);
    expect(state.dataset.tone).toBe(tone);
    expect(Boolean(button.querySelector('[aria-label="Waiting for owner"]'))).toBe(flagged);
    // Main has no run, so it says nothing.
    expect(view.getByRole('button', { name: 'Main (1)' }).querySelector('.worktree-switcher-state')).toBeNull();
  });
  it.each(['needs_input', 'limit_paused', 'awaiting_approval'])('shows label, count and waiting badge for %s', async status => {
    const waitingGroups = [groups[0], { ...groups[1], run: { ...groups[1].run, status } }];
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={waitingGroups} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByRole('button', { name: 'Build · 57f488b5 (1)' }).textContent).toContain('Build · 57f488b5'));
    expect(view.getByRole('button', { name: 'Build · 57f488b5 (1)' }).querySelector('[aria-label="Waiting for owner"]')).toBeTruthy();
    expect(view.getByRole('button', { name: 'Build · 57f488b5 (1)' }).getAttribute('title')).toBe('demo-feature\nfeature\n/tmp/demo-feature');
  });
  it('shows a legacy run step tab in its run group and keeps that group on step activation', async () => {
    const legacy = { ...sessions[0], sessionId: 'Demo-3' };
    const run = { id: 'run-1', project: 'Demo', status: 'needs_input', workflowName: 'Build', worktree: { path: '/tmp/demo-feature', branch: 'feature' }, createdAt: '2026-01-03', progress: null, inheritedSessionIds: [], steps: [{ name: 'Build', status: 'needs_input', sessionId: 'Demo-3', priorSessionIds: [], note: null }] };
    const all = [sessions[0], legacy];
    global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : all }));
    const worktreeBySession = resolveSessionWorktrees({ project, sessions: all, runs: [run] });
    const worktreeGroups = buildWorktreeGroups({ project, sessions: all, runs: [run] });
    const select = vi.fn();
    const view = render(<TerminalArea project={project} sessionStatus={all} worktreeGroups={worktreeGroups} selectedWorktree="/tmp/demo-feature" worktreeBySession={worktreeBySession} pipelineRuns={[run]} onSelectWorktree={select} />);
    await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-3'));
    fireEvent.click(view.getByRole('button', { name: 'Step Demo-3' }));
    expect(select).toHaveBeenLastCalledWith('/tmp/demo-feature');
    expect(view.getByTestId('visible-runs').textContent).toContain('run-1');
  });
  it('adoption with activate selects the adopted session worktree', async () => {
    const select = vi.fn();
    const adopted = [{ sessionId: 'Demo-2', activate: true }];
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} selectedWorktree="main" worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} onSelectWorktree={select} adoptSessions={adopted} />);
    await waitFor(() => expect(select).toHaveBeenCalledWith('/tmp/demo-feature'));
    expect(view.getByTestId('mounted-Demo-2')).toBeTruthy();
  });
  it('selecting a group restores its most recently active tab', async () => {
    const third = { ...sessions[1], sessionId: 'Demo-3' };
    const all = [...sessions, third];
    global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : all }));
    const bySession = new Map([['Demo-2', '/tmp/demo-feature'], ['Demo-3', '/tmp/demo-feature']]);
    const view = render(<TerminalArea project={project} sessionStatus={all} worktreeGroups={groups} worktreeBySession={bySession} />);
    await waitFor(() => expect(view.getAllByTestId('terminal-tab')).toHaveLength(1));
    fireEvent.click(view.getByRole('button', { name: 'Build · 57f488b5 (2)' }));
    fireEvent.click(view.getAllByTestId('terminal-tab').find(tab => tab.getAttribute('data-session-id') === 'Demo-2'));
    fireEvent.click(view.getByRole('button', { name: 'Main (1)' }));
    fireEvent.click(view.getByRole('button', { name: 'Build · 57f488b5 (2)' }));
    await waitFor(() => expect(view.getAllByTestId('terminal-tab').find(tab => tab.getAttribute('data-active') === 'true')?.getAttribute('data-session-id')).toBe('Demo-2'));
  });
  it('opens a new terminal in Main when Main is selected', async () => {
    const select = vi.fn();
    global.fetch = vi.fn(async (url, options) => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : options?.method === 'POST' ? { sessionId: 'Demo-3' } : sessions }));
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={taskGroups} selectedWorktree="main" onSelectWorktree={select} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-1'));
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/terminal', expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectName: 'Demo' }) })));
    expect(tasksApi.openTaskTerminal).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
  it('opens a new terminal inside the selected task and stays there', async () => {
    const select = vi.fn();
    tasksApi.openTaskTerminal.mockResolvedValue({ sessionId: 'Demo-3', taskId: TASK.id, project: 'Demo' });
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={taskGroups} selectedWorktree="/tmp/demo-feature" onSelectWorktree={select} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2'));
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(view.getAllByTestId('terminal-tab').map(tab => tab.getAttribute('data-session-id'))).toEqual(['Demo-2', 'Demo-3']));
    expect(tasksApi.openTaskTerminal).toHaveBeenCalledWith(TASK.id);
    expect(global.fetch).not.toHaveBeenCalledWith('/api/terminal', expect.anything());
    expect(select).not.toHaveBeenCalledWith('main');
    expect(view.getByRole('button', { name: 'Replies (2)' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('splits a task tab into another terminal of the same task', async () => {
    tasksApi.openTaskTerminal.mockResolvedValue({ sessionId: 'Demo-3', taskId: TASK.id, project: 'Demo' });
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={taskGroups} selectedWorktree="/tmp/demo-feature" worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2'));
    fireEvent.click(view.getByRole('button', { name: 'Split right' }));
    await waitFor(() => expect(view.getByTestId('mounted-Demo-3')).toBeTruthy());
    expect(tasksApi.openTaskTerminal).toHaveBeenCalledWith(TASK.id);
  });
  it('reports a task terminal that could not open and adds no tab', async () => {
    tasksApi.openTaskTerminal.mockRejectedValue(new Error('This task is finished.'));
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={taskGroups} selectedWorktree="/tmp/demo-feature" worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2'));
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith({ type: 'error', message: 'This task is finished.' }));
    expect(view.getAllByTestId('terminal-tab')).toHaveLength(1);
  });
  it('refuses to open a terminal in a folder that is not a task', async () => {
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} selectedWorktree="/tmp/demo-feature" worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2'));
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('not a task yet') })));
    expect(global.fetch).not.toHaveBeenCalledWith('/api/terminal', expect.anything());
  });
  it('shows the landing bar for the selected task, and not in Main', async () => {
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={taskGroups} selectedWorktree="/tmp/demo-feature" worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByTestId('landing-bar').textContent).toBe('Replies'));
    view.rerender(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={taskGroups} selectedWorktree="main" worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    expect(view.queryByTestId('landing-bar')).toBeNull();
  });
  it('names the selected task on its empty card', async () => {
    const empty = { key: '/tmp/demo-empty', path: '/tmp/demo-empty', label: 'demo-empty', branch: 'task/e', isMain: false, sessionIds: [], run: null, task: { ...TASK, id: 'e', title: 'Login bug', worktreePath: '/tmp/demo-empty' } };
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={[...taskGroups, empty]} selectedWorktree={empty.key} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByText('No terminals are open in Login bug. Open one here.')).toBeTruthy());
  });
  it('closing the active tab activates the nearest tab in the same group', async () => {
    const all = [...sessions, { ...sessions[1], sessionId: 'Demo-3' }, { ...sessions[1], sessionId: 'Demo-4' }];
    global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : all }));
    const bySession = new Map(['Demo-2', 'Demo-3', 'Demo-4'].map(id => [id, '/tmp/demo-feature']));
    const view = render(<TerminalArea project={project} sessionStatus={all} worktreeGroups={groups} selectedWorktree="/tmp/demo-feature" worktreeBySession={bySession} />);
    await waitFor(() => expect(view.getAllByTestId('terminal-tab')).toHaveLength(3));
    fireEvent.click(view.getAllByTestId('terminal-tab').find(tab => tab.getAttribute('data-session-id') === 'Demo-3'));
    fireEvent.click(view.getByTitle('Close Demo-3'));
    await waitFor(() => expect(view.getAllByTestId('terminal-tab').find(tab => tab.getAttribute('data-active') === 'true')?.getAttribute('data-session-id')).toBe('Demo-4'));
  });
  describe('Close run', () => {
    const run = { id: 'run-1', project: 'Demo', status: 'complete', workflowName: 'Build', worktree: { path: '/tmp/demo-feature', branch: 'feature' }, createdAt: '2026-01-03', progress: null, inheritedSessionIds: [], steps: [{ name: 'Build', status: 'complete', sessionId: 'Demo-2', note: null }] };
    const renderRun = onCleanupPipelineRun => render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} selectedWorktree="/tmp/demo-feature"
      worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} pipelineRuns={[run]} onCleanupPipelineRun={onCleanupPipelineRun} />);

    it('takes away the tabs of the terminals the backend closed with the run, and no other', async () => {
      const onCleanupPipelineRun = vi.fn(async () => ({ ...run, terminalsClosed: ['Demo-2'], terminalsNotClosed: [] }));
      const view = renderRun(onCleanupPipelineRun);
      await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2'));
      expect(view.getByTestId('mounted-Demo-1')).toBeTruthy();

      fireEvent.click(view.getByRole('button', { name: 'Close run' }));
      await waitFor(() => expect(view.queryByTestId('mounted-Demo-2')).toBeNull());
      expect(onCleanupPipelineRun).toHaveBeenCalledWith('run-1');
      expect(view.queryByTestId('terminal-tab')).toBeNull();
      // The terminal in Main was not the run's.
      expect(view.getByTestId('mounted-Demo-1')).toBeTruthy();
    });

    it('keeps the tab of a terminal the backend could not close', async () => {
      const view = renderRun(vi.fn(async () => ({ ...run, terminalsClosed: [], terminalsNotClosed: ['Demo-2'] })));
      await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2'));
      fireEvent.click(view.getByRole('button', { name: 'Close run' }));
      await waitFor(() => expect(view.getByTestId('mounted-Demo-2')).toBeTruthy());
      expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2');
    });

    it('keeps every tab when the run could not be closed', async () => {
      const onCleanupPipelineRun = vi.fn(async () => null);
      const view = renderRun(onCleanupPipelineRun);
      await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2'));
      fireEvent.click(view.getByRole('button', { name: 'Close run' }));
      await waitFor(() => expect(onCleanupPipelineRun).toHaveBeenCalled());
      expect(view.getByTestId('mounted-Demo-2')).toBeTruthy();
      expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2');
    });
  });
  it('shows only the selected worktree run in the run header', async () => {
    const runs = [{ id: 'main-run', worktree: { path: project.path } }, { id: 'feature-run', worktree: { path: '/tmp/demo-feature' } }];
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} selectedWorktree="/tmp/demo-feature" worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} pipelineRuns={runs} />);
    await waitFor(() => expect(view.getByTestId('visible-runs').textContent).toBe('feature-run'));
    view.rerender(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} selectedWorktree="main" worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} pipelineRuns={runs} />);
    expect(view.getByTestId('visible-runs').textContent).toBe('main-run');
  });
  it('restores a stored worktree and ignores a stale selection', async () => {
    localStorage.setItem('codedeck-worktree-Demo', '/tmp/demo-feature');
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2'));
    view.unmount();
    localStorage.setItem('codedeck-worktree-Demo', '/tmp/deleted');
    const restored = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(restored.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-1'));
  });
  it('shows the empty state for a selected run worktree without tabs', async () => {
    const runOnly = { key: '/tmp/demo-other', path: '/tmp/demo-other', label: 'demo-other', branch: 'other', isMain: false, sessionIds: [], run: { id: 'other-run', workflowName: 'Build', status: 'running', worktree: { path: '/tmp/demo-other' } } };
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={[...groups, runOnly]} selectedWorktree={runOnly.key} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.queryAllByTestId('terminal-tab')).toHaveLength(0));
    expect(view.getByText('No terminals open')).toBeTruthy();
    expect(view.getByTestId('mounted-Demo-1')).toBeTruthy();
  });
  it('filters the tab bar while keeping hidden terminal panes mounted', async () => {
    const select = vi.fn();
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} selectedWorktree="main" onSelectWorktree={select} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getAllByTestId('terminal-tab')).toHaveLength(1));
    expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-1');
    expect(view.getByTestId('mounted-Demo-2')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /Build · 57f488b5/ }));
    expect(select).toHaveBeenCalledWith('/tmp/demo-feature');
    view.rerender(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} selectedWorktree="/tmp/demo-feature" onSelectWorktree={select} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2');
  });
});
