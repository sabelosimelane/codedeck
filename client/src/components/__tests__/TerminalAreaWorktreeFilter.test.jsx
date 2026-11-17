import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import TerminalArea from '../TerminalArea.jsx';
import { buildWorktreeGroups, resolveSessionWorktrees } from '../../utils/worktreeGroups.js';

vi.mock('../Terminal', () => ({ default: ({ sessionId }) => <span data-testid={`mounted-${sessionId}`} /> }));
vi.mock('../PaneDivider', () => ({ default: () => null }));
vi.mock('../TerminalInspector', () => ({ default: () => null }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../pipelines/PipelineRunsBar', () => ({ default: ({ runs, onActivateStep }) => <div data-testid="visible-runs">{runs.map(run => <React.Fragment key={run.id}>{run.id}{run.steps?.map(step => <button key={step.sessionId} onClick={() => onActivateStep(step.sessionId)}>Step {step.sessionId}</button>)}</React.Fragment>)}</div> }));

const project = { name: 'Demo', path: '/tmp/demo' };
const sessions = [
  { sessionId: 'Demo-1', cwd: project.path, worktreePath: null, alive: true, startedAt: '2026-01-01T00:00:00.000Z' },
  { sessionId: 'Demo-2', cwd: '/tmp/demo-feature', worktreePath: '/tmp/demo-feature', alive: true, startedAt: '2026-01-02T00:00:00.000Z' },
];
const groups = [
  { key: 'main', path: project.path, label: 'Main checkout', branch: null, isMain: true, sessionIds: ['Demo-1'], run: null },
  { key: '/tmp/demo-feature', path: '/tmp/demo-feature', label: 'demo-feature', branch: 'feature', isMain: false, sessionIds: ['Demo-2'], run: { status: 'needs_input', worktree: { path: '/tmp/demo-feature' } } },
];
const originalFetch = global.fetch;
beforeEach(() => {
  localStorage.clear();
  global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : sessions }));
});
afterEach(() => { cleanup(); global.fetch = originalFetch; });

describe('TerminalArea worktree view', () => {
  it('does not show a switcher or filter tabs when there is only main checkout', async () => {
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={[groups[0]]} worktreeBySession={new Map()} />);
    await waitFor(() => expect(view.getAllByTestId('terminal-tab')).toHaveLength(2));
    expect(view.queryByLabelText('Worktrees')).toBeNull();
  });
  it.each(['needs_input', 'limit_paused', 'awaiting_approval'])('shows label, count and waiting badge for %s', async status => {
    const waitingGroups = [groups[0], { ...groups[1], run: { ...groups[1].run, status } }];
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={waitingGroups} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByRole('button', { name: 'demo-feature (1)' }).textContent).toContain('demo-feature · 1 ●'));
  });
  it('shows a legacy run step tab in its run group and keeps that group on step activation', async () => {
    const legacy = { ...sessions[0], sessionId: 'Demo-3' };
    const run = { id: 'run-1', project: 'Demo', status: 'needs_input', workflowName: 'Build', worktree: { path: '/tmp/demo-feature', branch: 'feature' }, createdAt: '2026-01-03', progress: null, steps: [{ name: 'Build', status: 'needs_input', sessionId: 'Demo-3', note: null }] };
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
    fireEvent.click(view.getByRole('button', { name: 'demo-feature (2)' }));
    fireEvent.click(view.getAllByTestId('terminal-tab').find(tab => tab.getAttribute('data-session-id') === 'Demo-2'));
    fireEvent.click(view.getByRole('button', { name: 'Main checkout (1)' }));
    fireEvent.click(view.getByRole('button', { name: 'demo-feature (2)' }));
    await waitFor(() => expect(view.getAllByTestId('terminal-tab').find(tab => tab.getAttribute('data-active') === 'true')?.getAttribute('data-session-id')).toBe('Demo-2'));
  });
  it('opens a plain new terminal in main and switches there from a worktree', async () => {
    const select = vi.fn();
    global.fetch = vi.fn(async (url, options) => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : options?.method === 'POST' ? { sessionId: 'Demo-3' } : sessions }));
    const view = render(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} selectedWorktree="/tmp/demo-feature" onSelectWorktree={select} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    await waitFor(() => expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2'));
    fireEvent.click(view.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(select).toHaveBeenCalledWith('main'));
    expect(global.fetch).toHaveBeenCalledWith('/api/terminal', expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectName: 'Demo' }) }));
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
    const runOnly = { key: '/tmp/demo-other', path: '/tmp/demo-other', label: 'demo-other', branch: 'other', isMain: false, sessionIds: [], run: { status: 'running', worktree: { path: '/tmp/demo-other' } } };
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
    fireEvent.click(view.getByRole('button', { name: /demo-feature/ }));
    expect(select).toHaveBeenCalledWith('/tmp/demo-feature');
    view.rerender(<TerminalArea project={project} sessionStatus={sessions} worktreeGroups={groups} selectedWorktree="/tmp/demo-feature" onSelectWorktree={select} worktreeBySession={new Map([['Demo-2', '/tmp/demo-feature']])} />);
    expect(view.getByTestId('terminal-tab').getAttribute('data-session-id')).toBe('Demo-2');
  });
});
