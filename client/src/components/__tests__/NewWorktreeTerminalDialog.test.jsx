import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import NewWorktreeTerminalDialog from '../NewWorktreeTerminalDialog.jsx';

afterEach(cleanup);
describe('NewWorktreeTerminalDialog', () => {
  it('styles both actions and gives the disabled submit a muted look', () => {
    render(<NewWorktreeTerminalDialog projectName="Demo" onCreate={vi.fn()} onClose={vi.fn()} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const create = screen.getByRole('button', { name: 'Create worktree' });
    expect(cancel.style.padding).toBe('8px 12px');
    expect(cancel.style.borderRadius).toBe('6px');
    expect(cancel.style.cursor).toBe('pointer');
    expect(create.style.padding).toBe('8px 12px');
    expect(create.style.color).toBe('var(--text-muted)');
    expect(create.style.cursor).toBe('not-allowed');
  });
  it('submits the typed branch and closes on success', async () => {
    const onCreate = vi.fn(async () => ({ sessionId: 'Demo-1' }));
    const onClose = vi.fn();
    render(<NewWorktreeTerminalDialog projectName="Demo" onCreate={onCreate} onClose={onClose} />);
    expect(screen.getByRole('button', { name: 'Create worktree' }).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ project: 'Demo', branch: 'new' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
  it('keeps the dialog open and displays an API error', async () => {
    const onClose = vi.fn();
    render(<NewWorktreeTerminalDialog projectName="Demo" onCreate={async () => { throw new Error('Branch exists'); }} onClose={onClose} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Branch name' }), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Branch exists'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
