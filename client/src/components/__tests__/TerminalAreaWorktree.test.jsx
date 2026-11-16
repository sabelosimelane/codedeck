import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import TerminalArea from '../TerminalArea.jsx';

const mocks = vi.hoisted(() => ({ showToast: vi.fn(), create: vi.fn() }));
vi.mock('../Terminal', () => ({ default: () => null }));
vi.mock('../PaneDivider', () => ({ default: () => null }));
vi.mock('../TerminalInspector', () => ({ default: () => null }));
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock('../../utils/terminalWorktreesApi.js', () => ({ createWorktreeTerminal: mocks.create }));

const originalFetch = global.fetch;
beforeEach(() => {
  localStorage.clear();
  mocks.showToast.mockReset();
  mocks.create.mockReset();
  global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: true } : [] }));
});
afterEach(() => { cleanup(); global.fetch = originalFetch; });

describe('TerminalArea worktree terminal', () => {
  it('opens a new active tab and toasts after creation', async () => {
    mocks.create.mockResolvedValue({ sessionId: 'Demo-1', project: 'Demo', branch: 'new', worktreePath: '/tmp/worktrees/demo-new', baseCommit: 'a'.repeat(40) });
    const onSessionStatusRefresh = vi.fn();
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    await waitFor(() => expect(onSessionStatusRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'New terminal in a new worktree' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({ project: 'Demo', branch: 'new' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New terminal in a new worktree' })).toBeNull());
    expect(screen.getByTestId('terminal-tab').getAttribute('data-active')).toBe('true');
    expect(screen.getByText('cwd: /tmp/worktrees/demo-new')).toBeTruthy();
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'success', message: 'Opened Demo-1 in /tmp/worktrees/demo-new' });
  });

  it('forgets a closed worktree session path when an ordinary terminal reuses its id', async () => {
    mocks.create.mockResolvedValue({ sessionId: 'Demo-1', project: 'Demo', branch: 'new', worktreePath: '/tmp/worktrees/demo-new', baseCommit: 'a'.repeat(40) });
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
    fireEvent.click(screen.getByRole('button', { name: 'New terminal in a new worktree' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
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
    mocks.create.mockResolvedValue({ sessionId: 'Demo-1', project: 'Demo', branch: 'new', worktreePath: '/tmp/worktrees/demo-new', baseCommit: 'a'.repeat(40) });
    const onSessionStatusRefresh = vi.fn();
    const project = { name: 'Demo', path: '/tmp/demo' };
    const { rerender } = render(<TerminalArea project={project} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    await waitFor(() => expect(onSessionStatusRefresh).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'New terminal in a new worktree' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
    await waitFor(() => expect(screen.getByText('cwd: /tmp/worktrees/demo-new')).toBeTruthy());

    rerender(<TerminalArea project={project} sessionStatus={[{ sessionId: 'Demo-1', cwd: '/tmp/worktrees/demo-new' }]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    expect(screen.getByText('cwd: /tmp/worktrees/demo-new')).toBeTruthy();
    rerender(<TerminalArea project={project} sessionStatus={[]} onSessionStatusRefresh={onSessionStatusRefresh} />);
    expect(screen.getByText('cwd: /tmp/demo')).toBeTruthy();
  });

  it('forgets a worktree session path after its tab is closed', async () => {
    mocks.create.mockResolvedValue({ sessionId: 'Demo-1', project: 'Demo', branch: 'new', worktreePath: '/tmp/worktrees/demo-new', baseCommit: 'a'.repeat(40) });
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
    fireEvent.click(screen.getByRole('button', { name: 'New terminal in a new worktree' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
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
    mocks.create.mockRejectedValue(new Error('Branch exists'));
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'New terminal in a new worktree' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Branch exists'));
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Branch exists' });
    expect(screen.queryByTestId('terminal-tab')).toBeNull();
  });

  it('shows a network failure in the dialog and toast', async () => {
    mocks.create.mockRejectedValue(new Error('Server unreachable'));
    render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo' }} sessionStatus={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'New terminal in a new worktree' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Server unreachable'));
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' });
  });

  it('disables the button for remote projects and blocked runtimes', async () => {
    const { rerender } = render(<TerminalArea project={{ name: 'Demo', path: '/tmp/demo', host: 'other' }} sessionStatus={[]} />);
    expect(screen.getByRole('button', { name: 'New terminal in a new worktree' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'New terminal in a new worktree' }).style.color).toBe('rgba(138, 146, 166, 0.45)');
    global.fetch = vi.fn(async url => ({ ok: true, json: async () => url === '/api/health' ? { terminalCreationAllowed: false } : [] }));
    rerender(<TerminalArea project={{ name: 'Other', path: '/tmp/other' }} sessionStatus={[]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'New terminal in a new worktree' }).disabled).toBe(true));
  });
});
