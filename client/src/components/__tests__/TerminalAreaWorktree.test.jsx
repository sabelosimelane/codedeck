import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import TerminalArea from '../TerminalArea.jsx';

const mocks = vi.hoisted(() => ({ showToast: vi.fn(), create: vi.fn(), open: vi.fn() }));
const TASK = { id: '7a000000-0000-4000-8000-000000000001', project: 'Demo', title: 'new', state: 'active', worktreePath: '/tmp/worktrees/demo-new', branch: 'task/new-7a000000', createdAt: '2026-11-18T10:00:00.000Z' };
vi.mock('../Terminal', () => ({ default: () => null }));
vi.mock('../PaneDivider', () => ({ default: () => null }));
vi.mock('../tasks/TaskLandingBar.jsx', () => ({ default: ({ task }) => <span data-testid="landing-bar">{task.title}</span> }));
vi.mock('../TerminalInspector', () => ({ default: () => null }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../../utils/tasksApi.js', () => ({ createTask: mocks.create, openTaskTerminal: mocks.open }));

const originalFetch = global.fetch;
beforeEach(() => {
  localStorage.clear();
  mocks.showToast.mockReset();
  mocks.create.mockReset();
  mocks.open.mockReset();
  mocks.open.mockResolvedValue({ sessionId: 'Demo-1', taskId: TASK.id, project: 'Demo' });
  global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : [] }));
});
afterEach(() => { cleanup(); global.fetch = originalFetch; });

describe('TerminalArea new task', () => {
  it('offers both terminal choices when no terminals are open', () => {
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} />);
    expect(screen.getByText('No terminals open')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeTruthy();
    const worktreeButton = screen.getByRole('button', { name: 'Start a new task' });
    expect(worktreeButton.type).toBe('button');
    expect(worktreeButton.classList.contains('terminal-empty-cta-secondary')).toBe(true);
    expect(worktreeButton.parentElement.classList.contains('terminal-empty-actions')).toBe(true);
    expect(worktreeButton.querySelector('.lucide-git-branch-plus')).toBeTruthy();
  });

  it('starts a task with an active terminal from the empty card', async () => {
    mocks.create.mockResolvedValue(TASK);
    const onSessionStatusRefresh = vi.fn();
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    await waitFor(() => expect(onSessionStatusRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Start a new task' }));
    expect(screen.getByRole('dialog', { name: 'New task' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ project: 'Demo', title: 'new' }));
    await waitFor(() => expect(screen.getByTestId('terminal-tab').getAttribute('data-active')).toBe('true'));
    expect(screen.queryByText('No terminals open')).toBeNull();
  });

  it('disables only the worktree choice for a remote project with no terminals', () => {
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo', host: 'other' }} sessionStatus={[]} />);
    expect(screen.getByRole('button', { name: 'Open terminal' }).disabled).toBe(false);
    const worktreeButton = screen.getByRole('button', { name: 'Start a new task' });
    expect(worktreeButton.disabled).toBe(true);
    expect(worktreeButton.title).toBe('Tasks are only available for local projects.');
  });

  it('opens a new active tab and toasts after creation', async () => {
    mocks.create.mockResolvedValue(TASK);
    const onSessionStatusRefresh = vi.fn();
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    await waitFor(() => expect(onSessionStatusRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task title' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ project: 'Demo', title: 'new' }));
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

  it('disables the button for remote projects and blocked runtimes', async () => {
    const { rerender } = render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo', host: 'other' }} sessionStatus={[]} />);
    expect(screen.getByRole('button', { name: 'New task' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'New task' }).style.color).toBe('rgba(138, 146, 166, 0.45)');
    global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: false } : [] }));
    rerender(<TerminalArea project={{ name: 'Other', path: '/tmp/other' }} sessionStatus={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'New task' }).disabled).toBe(true));
  });
});
