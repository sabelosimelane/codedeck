import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useMemo, useState } from 'react';
import { useTaskTabs } from '../../hooks/useTaskTabs';
import { buildWorktreeGroups } from '../../utils/worktreeGroups';
import TerminalArea from '../TerminalArea.jsx';

const mocks = vi.hoisted(() => ({ showToast: vi.fn(), create: vi.fn(), open: vi.fn(), candidates: vi.fn(), adopt: vi.fn(), standing: vi.fn(), repositories: vi.fn(), closeTask: vi.fn(), realLanding: false }));
const TASK = { id: '7a000000-0000-4000-8000-000000000001', project: 'Demo', title: 'new', state: 'active', worktreePath: '/tmp/worktrees/demo-new', branch: 'task/new-7a000000', createdAt: '2026-11-18T10:00:00.000Z',
  // A task as the backend sends it: with the folder of its worktrees and one entry per repository.
  folder: null, worktrees: [{ id: '7b000000-0000-4000-8000-000000000001', repository: 'demo', own: true, first: true, worktreePath: '/tmp/worktrees/demo-new', branch: 'task/new-7a000000', baseBranch: 'main', baseCommit: 'a'.repeat(40), state: 'active', prUrl: null }] };
vi.mock('../Terminal', () => ({ default: () => null }));
vi.mock('../PaneDivider', () => ({ default: () => null }));
vi.mock('../tasks/TaskLandingBar.jsx', async importOriginal => {
  const { default: Landing } = await importOriginal();
  return { default: props => mocks.realLanding ? <Landing {...props} /> : <span data-testid="landing-bar">{props.task.title}</span> };
});
vi.mock('../TerminalInspector', () => ({ default: () => null }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../../utils/tasksApi.js', () => ({ createTask: mocks.create, openTaskTerminal: mocks.open, listWorktreeCandidates: mocks.candidates, makeTaskFromWorktree: mocks.adopt, parseTask: task => task, getTaskLanding: mocks.standing, listTaskWorktreeLandings: mocks.repositories, closeTask: mocks.closeTask }));

const originalFetch = global.fetch;
beforeEach(() => {
  localStorage.clear();
  mocks.showToast.mockReset();
  mocks.standing.mockReset();
  mocks.repositories.mockReset();
  mocks.closeTask.mockReset();
  mocks.realLanding = false;
  mocks.create.mockReset();
  mocks.open.mockReset();
  mocks.candidates.mockReset().mockResolvedValue([]);
  mocks.adopt.mockReset();
  mocks.open.mockResolvedValue({ sessionId: 'Demo-1', taskId: TASK.id, project: 'Demo' });
  global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : [] }));
});
afterEach(() => { cleanup(); global.fetch = originalFetch; });

describe('TerminalArea new task', () => {
  it('opens an adopted task terminal without creating another worktree', async () => {
    const candidate = { path: TASK.worktreePath, name: 'demo-new', repository: 'demo', own: true,
      branch: TASK.branch, head: 'a'.repeat(40), uncommittedCount: 1, selectable: true, reason: null };
    mocks.candidates.mockResolvedValue([candidate]);
    mocks.adopt.mockResolvedValue(TASK);
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Use an existing worktree' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make task' }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith(TASK.id));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.getByText(`cwd: ${TASK.worktreePath}`)).toBeTruthy();
  });
  it('offers a terminal on the empty card and New task in the strip of Main and tasks', () => {
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} />);
    expect(screen.getByText('No terminals open')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeTruthy();
    const strip = screen.getByLabelText('Main and tasks');
    expect([...strip.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Main0', 'New task', 'Run workflow']);
    expect(screen.getAllByRole('button', { name: 'New task' })).toHaveLength(1);
  });

  it('offers Run workflow beside New task, by name, and nowhere else', () => {
    const onOpenRunWorkflow = vi.fn();
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} onOpenRunWorkflow={onOpenRunWorkflow} />);
    const buttons = screen.getAllByRole('button', { name: 'Run workflow' });
    expect(buttons).toHaveLength(1);
    expect(screen.getByLabelText('Main and tasks').contains(buttons[0])).toBe(true);
    expect(buttons[0].textContent).toBe('Run workflow');
    expect(buttons[0].title).toBe('Run a workflow in a new task, an open task or Main');
    fireEvent.click(buttons[0]);
    expect(onOpenRunWorkflow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull();
  });

  it('starts a task with an active terminal from the strip', async () => {
    mocks.create.mockResolvedValue(TASK);
    const onSessionStatusRefresh = vi.fn();
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    await waitFor(() => expect(onSessionStatusRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ project: 'Demo', host: 'local', title: 'new' }));
    await waitFor(() => expect(screen.getByTestId('terminal-tab').getAttribute('data-active')).toBe('true'));
    expect(screen.queryByText('No terminals open')).toBeNull();
  });

  it('offers New task and Run workflow in a remote project', () => {
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo', host: 'other' }} sessionStatus={[]} />);
    expect(screen.getByRole('button', { name: 'Open terminal' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'New task' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Run workflow' }).disabled).toBe(false);
    expect(screen.getByLabelText('Main and tasks')).toBeTruthy();
  });

  it('opens a new active tab and toasts after creation', async () => {
    mocks.create.mockResolvedValue(TASK);
    const onSessionStatusRefresh = vi.fn();
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    await waitFor(() => expect(onSessionStatusRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ project: 'Demo', host: 'local', title: 'new' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull());
    expect(screen.getByTestId('terminal-tab').getAttribute('data-active')).toBe('true');
    expect(mocks.open).toHaveBeenCalledWith(TASK.id);
    expect(screen.getByText('cwd: /tmp/worktrees/demo-new')).toBeTruthy();
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'success', message: 'Started task new' });
  });

  it('forgets a closed worktree session path when an ordinary terminal reuses its id', async () => {
    mocks.create.mockResolvedValue(TASK);
    const onSessionStatusRefresh = vi.fn();
    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === '/api/health') return { ok: true, json: async () => ({ terminalCreationAllowed: true }) };
      if (url === '/api/sessions') return { ok: true, json: async () => [] };
      if (url === '/api/terminal/Demo-1' && options.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) };
      if (url === '/api/terminal' && options.method === 'POST') return { ok: true, json: async () => ({ sessionId: 'Demo-1' }) };
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    await waitFor(() => expect(onSessionStatusRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.getByText('cwd: /tmp/worktrees/demo-new')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Close pane Demo-1' }));
    await waitFor(() => expect(screen.queryByText('cwd: /tmp/worktrees/demo-new')).toBeNull());
    expect(global.fetch).toHaveBeenCalledWith('/api/terminal/Demo-1', { method: 'DELETE' });

    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/terminal', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(screen.getByText('cwd: /tmp/demo')).toBeTruthy());
    expect(screen.queryByText('cwd: /tmp/worktrees/demo-new')).toBeNull();
  });

  it('forgets the temporary worktree path once the session list reports its cwd', async () => {
    mocks.create.mockResolvedValue(TASK);
    const onSessionStatusRefresh = vi.fn();
    const project = { name: 'Demo', path: '/tmp/demo' };
    const { rerender } = render(<TerminalArea project={project} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    await waitFor(() => expect(onSessionStatusRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.getByText('cwd: /tmp/worktrees/demo-new')).toBeTruthy());

    rerender(<TerminalArea project={project} sessionStatus={[{ sessionId: 'Demo-1', cwd: '/tmp/worktrees/demo-new' }]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    expect(screen.getByText('cwd: /tmp/worktrees/demo-new')).toBeTruthy();
    rerender(<TerminalArea project={project} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    expect(screen.getByText('cwd: /tmp/demo')).toBeTruthy();
  });

  it('forgets a worktree session path after its tab is closed', async () => {
    mocks.create.mockResolvedValue(TASK);
    const onSessionStatusRefresh = vi.fn();
    let ordinaryCreates = 0;
    global.fetch = vi.fn(async (url, options = {}) => {
      if (url === '/api/health') return { ok: true, json: async () => ({ terminalCreationAllowed: true }) };
      if (url === '/api/sessions') return { ok: true, json: async () => [] };
      if (url === '/api/terminal/Demo-1' && options.method === 'DELETE') return { ok: true, json: async () => ({ ok: true }) };
      if (url === '/api/terminal' && options.method === 'POST') {
        ordinaryCreates += 1;
        return { ok: true, json: async () => ({ sessionId: ordinaryCreates === 1 ? 'Demo-2' : 'Demo-1' }) };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    await waitFor(() => expect(onSessionStatusRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.getByText('cwd: /tmp/worktrees/demo-new')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(screen.getByText('cwd: /tmp/demo')).toBeTruthy());
    fireEvent.click(screen.getByTitle('Close Demo-1'));
    await waitFor(() => expect(screen.queryByTitle('Close Demo-1')).toBeNull());
    expect(global.fetch).toHaveBeenCalledWith('/api/terminal/Demo-1', { method: 'DELETE' });

    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(ordinaryCreates).toBe(2));
    fireEvent.click(screen.getAllByTestId('terminal-tab').find(tab => tab.getAttribute('data-session-id') === 'Demo-1'));
    await waitFor(() => expect(screen.getAllByText('cwd: /tmp/demo').length).toBe(2));
    expect(screen.queryByText('cwd: /tmp/worktrees/demo-new')).toBeNull();
  });

  it('shows an API error inline and in a toast without adding a tab', async () => {
    mocks.create.mockRejectedValue(new Error('Project not found'));
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Project not found'));
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Project not found' });
    expect(screen.queryByTestId('terminal-tab')).toBeNull();
  });

  it('reports a task whose first terminal could not open, and adds no tab', async () => {
    mocks.create.mockResolvedValue(TASK);
    mocks.open.mockRejectedValue(new Error('The terminal could not be opened.'));
    const onTasksChanged = vi.fn();
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} onTasksChanged={onTasksChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The terminal could not be opened.'));
    expect(onTasksChanged).toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-tab')).toBeNull();
  });

  it('shows a network failure in the dialog and toast', async () => {
    mocks.create.mockRejectedValue(new Error('Server unreachable'));
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Server unreachable'));
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' });
  });

  it('disables New task while the terminal runtime is blocked', async () => {
    global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: false } : [] }));
    render(<TerminalArea project={{ name: 'Other', path: '/tmp/other' }} sessionStatus={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'New task' }).disabled).toBe(true));
  });

  it('shows the remote host in Target host when viewing a remote task', async () => {
    const remoteTask = {
      ...TASK,
      id: '7a000000-0000-4000-8000-000000000099',
      host: 'devbox.ts.net',
      title: 'remote workflow task',
      worktreePath: '/home/dev/worktrees/demo-remote',
      worktrees: [{ ...TASK.worktrees[0], worktreePath: '/home/dev/worktrees/demo-remote' }],
    };
    const project = {
      name: 'Demo',
      path: '/tmp/demo',
      defaultHost: 'local',
      locations: [
        { host: 'local', path: '/tmp/demo' },
        { host: 'devbox.ts.net', path: '/home/dev/demo' },
      ],
    };
    const worktreeGroups = [
      { key: 'main', path: '/tmp/demo', isMain: true, task: null, run: null },
      { key: remoteTask.worktreePath, path: remoteTask.worktreePath, isMain: false, task: remoteTask, run: null },
    ];
    const { rerender } = render(
      <TerminalArea
        project={project}
        worktreeGroups={worktreeGroups}
        selectedWorktree="main"
        sessionStatus={[]}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Target host' }).value).toBe('local');

    rerender(
      <TerminalArea
        project={project}
        worktreeGroups={worktreeGroups}
        selectedWorktree={remoteTask.worktreePath}
        sessionStatus={[]}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Target host' }).value).toBe('devbox.ts.net');
    });
  });
});

const navProject = { name: 'Demo', path: '/tmp/demo', repositories: [] };
const cleanLanding = {
  taskId: TASK.id, state: 'active', branch: TASK.branch, baseBranch: 'main', prUrl: null,
  filesPresent: true, uncommitted: [], uncommittedCount: 0, commitsAhead: 0, commitsBehind: 0,
  alreadyInBase: false, ignoredAtRisk: [], ignoredAtRiskCount: 0, remotes: [], runActive: false,
  blockers: { commit: [], merge: [], pullRequest: [], close: [] },
};
const branchDrift = { code: 'branch_switched', message: `Switch back to ${TASK.branch}.` };
const working = { code: 'run_active', message: 'Wait for the workflow to finish.' };

function Navigation({ task, onFinished = () => {} }) {
  const polled = useMemo(() => [task], [task]);
  const { tasks, dismiss, isTaskDismissed, reopen } = useTaskTabs(polled);
  const hidden = isTaskDismissed(task);
  const [selected, select] = useState(() => hidden ? 'main' : task.worktreePath);
  const groups = buildWorktreeGroups({ project: navProject, tasks, sessions: [], runs: [] });
  return <>
    <TerminalArea project={navProject} sessionStatus={[]} worktreeGroups={groups} selectedWorktree={selected}
      onSelectWorktree={select} isTaskDismissed={isTaskDismissed} onTaskFinished={onFinished}
      onDismissTask={entry => { dismiss(entry); select('main'); }} />
    {hidden && <button type="button" onClick={() => { reopen(task); select(task.worktreePath); }}>Restore task</button>}
  </>;
}

describe('task tab dismissal with the real landing bar', () => {
  it.each([
    ['clean', cleanLanding],
    ['switched', { ...cleanLanding, blockers: { ...cleanLanding.blockers, close: [branchDrift] } }],
    ['detached and dirty', { ...cleanLanding, uncommitted: ['draft.txt'], uncommittedCount: 1, blockers: { ...cleanLanding.blockers, commit: [branchDrift], close: [branchDrift] } }],
    ['working run', { ...cleanLanding, runActive: true, blockers: { ...cleanLanding.blockers, close: [working] } }],
    ['failed status read', new Error('Inspection unavailable')],
    ['pending status read', null],
    ['multi-repository with a finished row', [cleanLanding, { ...cleanLanding, state: 'merged' }]],
  ])('keeps dismiss and reopen available for %s', async (_label, state) => {
    mocks.realLanding = true;
    let task = TASK;
    if (Array.isArray(state)) {
      const worktrees = [...TASK.worktrees, { ...TASK.worktrees[0], repository: 'web', id: 'web-repo', first: false, worktreePath: '/tmp/web', state: 'merged' }];
      task = { ...TASK, worktrees };
      mocks.repositories.mockResolvedValue(state.map((row, i) => ({ ...row, worktreeId: worktrees[i].id, repository: worktrees[i].repository })));
    } else if (state === null) mocks.standing.mockReturnValue(new Promise(() => {}));
    else if (state instanceof Error) mocks.standing.mockRejectedValue(state);
    else mocks.standing.mockResolvedValue(state);
    const view = render(<Navigation task={task} />);
    await act(async () => {});
    const dismiss = () => screen.getByRole('button', { name: 'Dismiss tab: new' });
    expect(dismiss().disabled).toBe(false);
    fireEvent.click(dismiss());
    expect(screen.queryByRole('button', { name: 'new (0)' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Main (0)' }).getAttribute('aria-pressed')).toBe('true');
    await act(async () => { view.rerender(<Navigation task={{ ...task }} />); });
    expect(screen.queryByRole('button', { name: 'new (0)' })).toBeNull();
    view.unmount();
    await act(async () => { render(<Navigation task={task} />); });
    expect(screen.queryByRole('button', { name: 'new (0)' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Restore task' })); });
    expect(screen.getAllByRole('button', { name: 'new (0)' })).toHaveLength(1);
    expect((Array.isArray(state) ? mocks.repositories : mocks.standing).mock.calls).toEqual([[task.id], [task.id]]);
    expect(mocks.closeTask).not.toHaveBeenCalled();
  });

  it('allows dismissal during approved cleanup and does not authorize a second action on reopen', async () => {
    mocks.realLanding = true;
    mocks.standing.mockResolvedValue(cleanLanding);
    let finish;
    mocks.closeTask.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onFinished = vi.fn();
    await act(async () => { render(<Navigation task={TASK} onFinished={onFinished} />); });
    fireEvent.click(screen.getByRole('button', { name: 'Task actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Finish task…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish task', exact: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Task actions' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss tab: new' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore task' }));
    expect(screen.getByText('Reading the task…')).toBeTruthy();
    expect(mocks.standing).toHaveBeenCalledTimes(1);
    expect(mocks.closeTask).toHaveBeenCalledTimes(1);
    await act(async () => finish({ unmergedCommits: 0, terminalsClosed: [], terminalsNotClosed: [] }));
    expect(onFinished).toHaveBeenCalledWith(TASK);
  });
});
