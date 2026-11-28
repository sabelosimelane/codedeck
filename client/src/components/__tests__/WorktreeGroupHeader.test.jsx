import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import WorktreeGroupHeader from '../WorktreeGroupHeader';

afterEach(cleanup);
const base = { key: '/repo/feature', path: '/repo/feature', label: 'feature', branch: 'feat/fix', isMain: false, sessionIds: [], run: null };
const run = status => ({ id: '57f488b5-1234', workflowName: 'Medium Feature Build', status, progress: null, steps: [{ status: 'running', name: 'Implement', note: null }] });

describe('WorktreeGroupHeader', () => {
  it.each([
    ['pending', 'starting'], ['running', 'running'], ['needs_input', 'needs your input'], ['limit_paused', 'paused at its limit'],
    ['awaiting_approval', 'waiting for your approval'], ['interrupted', 'interrupted'], ['stopped', 'stopped'], ['error', 'failed'], ['complete', 'complete'],
  ])('shows a human status for %s', (status, label) => {
    const view = render(<WorktreeGroupHeader group={{ ...base, run: run(status) }} selected={false} onClick={vi.fn()} />);
    expect(view.getByText(label)).toBeTruthy();
    expect(view.getByText('Medium Feature Build · 57f488b5')).toBeTruthy();
    expect(view.getByTestId('worktree-group-header').getAttribute('title')).toBe('feature\nfeat/fix\n/repo/feature');
    expect(view.getByTestId('worktree-group-header').textContent).not.toContain('feat/fix');
  });

  it('prefers phase, then latest note, then current step name', () => {
    const onClick = vi.fn();
    const withNote = { ...run('running'), steps: [{ status: 'complete', name: 'Setup', note: { summary: 'Ready' } }, { status: 'running', name: 'Implement', note: null }] };
    const view = render(<WorktreeGroupHeader group={{ ...base, run: { ...withNote, progress: { phase: { number: 2, position: 2 }, phaseCount: 3 } } }} selected onClick={onClick} />);
    expect(view.getByText('Phase 2 of 3')).toBeTruthy();
    expect(view.getByTestId('worktree-group-header').getAttribute('data-selected')).toBe('true');
    expect(view.getByRole('button').getAttribute('aria-label')).toBe('Select Medium Feature Build · 57f488b5 worktree');
    fireEvent.click(view.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
    view.rerender(<WorktreeGroupHeader group={{ ...base, run: withNote }} selected onClick={onClick} />);
    expect(view.getByText('Ready')).toBeTruthy();
    view.rerender(<WorktreeGroupHeader group={{ ...base, run: run('running') }} selected onClick={onClick} />);
    expect(view.getByText('Implement')).toBeTruthy();
  });
  it('says where a phase sits when the todo numbers its phases on from an earlier one', () => {
    const view = render(<WorktreeGroupHeader group={{ ...base, run: { ...run('running'), progress: { phase: { number: 17, position: 2 }, phaseCount: 4 } } }} selected={false} onClick={vi.fn()} />);
    expect(view.getByText('Phase 17 · 2 of 4')).toBeTruthy();
  });
  it('names main and plain worktrees', () => {
    const view = render(<WorktreeGroupHeader group={{ ...base, key: 'main', path: '/repo/main', isMain: true, branch: null }} selected={false} onClick={vi.fn()} />);
    expect(view.getByText('Main')).toBeTruthy();
    view.rerender(<WorktreeGroupHeader group={base} selected={false} onClick={vi.fn()} />);
    expect(view.getByText('feature')).toBeTruthy();
  });
});
