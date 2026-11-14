import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('offers Dismiss run, not worktree cleanup, for a run in an existing worktree', () => {
    const onCleanup = vi.fn();
    render(
      <PipelineRunsBar
        runs={[runView({
          status: 'stopped',
          actions: { stop: false, resume: true, continue: false, cleanup: true },
          worktree: { branch: 'feature/x', state: 'external', detail: null },
        })]}
        onStop={vi.fn()}
        onResume={vi.fn()}
        onContinue={vi.fn()}
        onCleanup={onCleanup}
        onActivateStep={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Clean up worktree' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss run' }));
    expect(onCleanup).toHaveBeenCalledWith('r1');
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

describe('PipelineRunsBar — what the agent needs', () => {
  const QUESTIONS = '1. Which schema should the migration target?\nRecommended: the existing guardian schema.';
  const waitingRun = (overrides = {}) => runView({
    status: 'needs_input',
    inputRequest: { questions: QUESTIONS, truncated: false },
    actions: { stop: true, resume: false, continue: false, cleanup: false, answer: true },
    ...overrides,
  });

  function renderBar(run, onAnswer = vi.fn(async () => ({ id: 'r1' }))) {
    render(
      <PipelineRunsBar
        runs={[run]}
        onStop={vi.fn()}
        onResume={vi.fn()}
        onContinue={vi.fn()}
        onCleanup={vi.fn()}
        onAnswer={onAnswer}
        onActivateStep={vi.fn()}
      />,
    );
    return onAnswer;
  }
  const panel = () => screen.getByRole('group', { name: 'Feature needs your input' });
  const reply = () => screen.getByLabelText('Answer for Feature');

  it('shows the questions the agent asked, line by line, with a reply box', () => {
    renderBar(waitingRun());
    expect(within(panel()).getByText(/1\. Which schema should the migration target\?/)).toBeTruthy();
    expect(within(panel()).getByText(/Recommended: the existing guardian schema\./)).toBeTruthy();
    expect(reply().value).toBe('');
    expect(screen.getByRole('button', { name: 'Send answer' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Accept recommendations' }).disabled).toBe(false);
  });

  it('shows no panel for a run that is not waiting', () => {
    renderBar(runView({ inputRequest: null }));
    expect(screen.queryByRole('group', { name: 'Feature needs your input' })).toBeNull();
    expect(screen.queryByLabelText('Answer for Feature')).toBeNull();
  });

  it('sends the typed answer and clears the box once the backend has taken it', async () => {
    const onAnswer = renderBar(waitingRun());
    fireEvent.change(reply(), { target: { value: 'Use the existing schema.' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send answer' })); });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer).toHaveBeenCalledWith('r1', 'Use the existing schema.');
    await waitFor(() => expect(reply().value).toBe(''));
  });

  it('keeps the typed answer when sending it failed', async () => {
    const onAnswer = renderBar(waitingRun(), vi.fn(async () => null));
    fireEvent.change(reply(), { target: { value: 'Use the existing schema.' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send answer' })); });
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(reply().value).toBe('Use the existing schema.');
    expect(screen.getByRole('button', { name: 'Send answer' }).disabled).toBe(false);
  });

  it('accepts the recommendations with one click', async () => {
    const onAnswer = renderBar(waitingRun());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Accept recommendations' })); });
    expect(onAnswer).toHaveBeenCalledWith('r1', 'Proceed with your recommendations.');
  });

  it('does not send twice while an answer is on its way', async () => {
    let release;
    const onAnswer = renderBar(waitingRun(), vi.fn(() => new Promise((resolve) => { release = resolve; })));
    fireEvent.change(reply(), { target: { value: 'yes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send answer' }).disabled).toBe(true));
    expect(screen.getByRole('button', { name: 'Accept recommendations' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    await act(async () => { release({ id: 'r1' }); });
  });

  it('says so when the agent stated no questions, and offers only a typed answer', () => {
    renderBar(waitingRun({ inputRequest: { questions: null, truncated: false } }));
    expect(within(panel()).getByText('The agent did not say what it needs. Read its terminal, then answer here or there.')).toBeTruthy();
    expect(reply()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept recommendations' })).toBeNull();
  });

  it('notes when the list of questions was cut', () => {
    renderBar(waitingRun({ inputRequest: { questions: QUESTIONS, truncated: true } }));
    expect(within(panel()).getByText("The list was cut here. Read the rest in the agent's terminal.")).toBeTruthy();
  });

  it('points to the terminal for a dialog the agent shows there, without a reply box', () => {
    renderBar(waitingRun({ inputRequest: null, actions: { stop: true, resume: false, continue: false, cleanup: false, answer: false } }));
    expect(within(panel()).getByText('The agent is showing a dialog in its terminal. Answer it there.')).toBeTruthy();
    expect(screen.queryByLabelText('Answer for Feature')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
  });
});
