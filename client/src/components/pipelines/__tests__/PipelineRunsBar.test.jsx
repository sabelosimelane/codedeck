import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import PipelineRunsBar from '../PipelineRunsBar';

function runView(overrides = {}) {
  return {
    id: 'r1',
    workflowName: 'Feature',
    status: 'running',
    error: null,
    steps: [
      {
        index: 0,
        name: 'Setup',
        status: 'complete',
        sessionId: 'Demo-1',
        iteration: 1,
        repeat: { mode: 'until_complete', max: 3 },
      },
      {
        index: 1,
        name: 'Implement',
        status: 'running',
        sessionId: 'Demo-2',
        iteration: 2,
        repeat: { mode: 'until_complete', max: 5 },
      },
    ],
    worktree: {
      branch: 'workflow/feature-abcd',
      state: 'present',
      detail: null,
    },
    actions: { stop: true, resume: false, continue: false, cleanup: false },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PipelineRunsBar', () => {
  it('renders step chips with pass counts and action buttons from actions', () => {
    const onStop = vi.fn();
    const onActivateStep = vi.fn();
    render(
      <PipelineRunsBar
        runs={[runView()]}
        onStop={onStop}
        onResume={vi.fn()}
        onContinue={vi.fn()}
        onCleanup={vi.fn()}
        onActivateStep={onActivateStep}
      />,
    );

    expect(screen.getByText('Feature')).toBeTruthy();
    expect(screen.getByText('workflow/feature-abcd')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Setup complete 1\/3/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Implement running 2\/5/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledWith('r1');
    fireEvent.click(screen.getByRole('button', { name: /Implement running 2\/5/i }));
    expect(onActivateStep).toHaveBeenCalledWith('Demo-2');
  });

  it('confirms Resume and names the current step terminal that may still be working', () => {
    const onResume = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <PipelineRunsBar
        runs={[runView({
          status: 'interrupted',
          actions: { stop: false, resume: true, continue: false, cleanup: true },
          steps: [{
            index: 1,
            name: 'Implement',
            status: 'interrupted',
            sessionId: 'Demo-2',
            priorSessionIds: ['Demo-9'],
            iteration: 1,
            repeat: { mode: 'once' },
          }],
        })]}
        onStop={vi.fn()}
        onResume={onResume}
        onContinue={vi.fn()}
        onCleanup={vi.fn()}
        onActivateStep={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Demo-2'));
    expect(confirmSpy.mock.calls[0][0]).not.toMatch(/Demo-9/);
    expect(onResume).toHaveBeenCalledWith('r1');
  });

  it('shows error and blocked-cleanup detail', () => {
    render(
      <PipelineRunsBar
        runs={[runView({
          status: 'complete',
          error: null,
          actions: { stop: false, resume: false, continue: false, cleanup: true },
          worktree: {
            branch: 'workflow/feature-abcd',
            state: 'removal_blocked',
            detail: 'contains modified or untracked files: notes.txt',
          },
        })]}
        onStop={vi.fn()}
        onResume={vi.fn()}
        onContinue={vi.fn()}
        onCleanup={vi.fn()}
        onActivateStep={vi.fn()}
      />,
    );

    expect(screen.getByText(/contains modified or untracked files/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clean up worktree' })).toBeTruthy();
  });

  it('hides actions the backend does not allow', () => {
    render(
      <PipelineRunsBar
        runs={[runView({ actions: { stop: false, resume: false, continue: true, cleanup: false } })]}
        onStop={vi.fn()}
        onResume={vi.fn()}
        onContinue={vi.fn()}
        onCleanup={vi.fn()}
        onActivateStep={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });
});
