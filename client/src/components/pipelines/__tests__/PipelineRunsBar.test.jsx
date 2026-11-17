import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import PipelineRunsBar from '../PipelineRunsBar';

function runView(overrides = {}) {
  return {
    id: 'r1',
    workflowName: 'Feature',
    agentsDecide: false,
    decisionCount: 0,
    status: 'running',
    error: null,
    steps: [
      {
        index: 0,
        name: 'Setup',
        status: 'complete',
        sessionId: 'Demo-1',
        iteration: 1,
        roundsCompleted: 0,
        repeat: { mode: 'until_complete', max: 3 },
      },
      {
        index: 1,
        name: 'Implement',
        status: 'running',
        sessionId: 'Demo-2',
        iteration: 2,
        roundsCompleted: 0,
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
    expect(screen.getByRole('button', { name: 'Setup complete · 1 pass' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Implement running · pass 2 (max 5)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledWith('r1');
    fireEvent.click(screen.getByRole('button', { name: 'Implement running · pass 2 (max 5)' }));
    expect(onActivateStep).toHaveBeenCalledWith('Demo-2');
  });

  it('confirms Resume and says the step starts again in its own terminal after its agent is cleared', () => {
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
    expect(confirmSpy).toHaveBeenCalledWith(
      'Resume Feature? The agent in Demo-2 is cleared and Implement starts again there. '
      + 'If its agent has exited, it is started again there. A new terminal is opened only if that one was closed.',
    );
    expect(onResume).toHaveBeenCalledWith('r1');
  });

  it('confirms Resume of a step that has no terminal yet', () => {
    const onResume = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <PipelineRunsBar
        runs={[runView({
          status: 'interrupted',
          actions: { stop: false, resume: true, continue: false, cleanup: true },
          steps: [{
            index: 1,
            name: 'Implement',
            status: 'interrupted',
            sessionId: null,
            priorSessionIds: ['Demo-9'],
            iteration: 0,
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
    expect(confirmSpy).toHaveBeenCalledWith('Resume Feature? Implement starts in a new terminal.');
    expect(onResume).not.toHaveBeenCalled();
  });

  it('shows a plain blocked-cleanup summary with dirty files collapsed', () => {
    render(
      <PipelineRunsBar
        runs={[runView({
          status: 'complete',
          error: null,
          actions: { stop: false, resume: false, continue: false, cleanup: true },
          worktree: {
            branch: 'workflow/feature-abcd',
            state: 'removal_blocked',
            detail: "fatal: '/tmp/worktree' contains modified or untracked files, use --force to delete it\nnotes.txt\ntmp.out",
          },
        })]}
        onStop={vi.fn()}
        onResume={vi.fn()}
        onContinue={vi.fn()}
        onCleanup={vi.fn()}
        onActivateStep={vi.fn()}
      />,
    );

    expect(screen.getByText('Worktree kept: it has uncommitted work. Commit or discard the files, then choose Clean up worktree.')).toBeTruthy();
    const disclosure = screen.getByText('Show files').closest('details');
    expect(disclosure).toBeTruthy();
    expect(disclosure.open).toBe(false);
    expect(within(disclosure).getByText('notes.txt')).toBeTruthy();
    expect(within(disclosure).getByText('tmp.out')).toBeTruthy();
    expect(screen.queryByText(/fatal:/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Clean up worktree' })).toBeTruthy();
  });

  it('shows a single-line blocked-cleanup detail without a file disclosure', () => {
    render(
      <PipelineRunsBar
        runs={[runView({
          worktree: { branch: 'workflow/feature-abcd', state: 'removal_blocked', detail: 'fatal: worktree is locked' },
        })]}
        onStop={vi.fn()}
        onResume={vi.fn()}
        onContinue={vi.fn()}
        onCleanup={vi.fn()}
        onActivateStep={vi.fn()}
      />,
    );

    expect(screen.getByText('fatal: worktree is locked')).toBeTruthy();
    expect(screen.queryByText('Show files')).toBeNull();
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

describe('PipelineRunsBar — loops and decisions agents made', () => {
  const decision = (id, patch = {}) => ({
    id, stepIndex: 1, stepName: 'Test', pass: 1, questions: `1. Question ${id}?\nRecommended: yes`,
    truncated: false, answer: 'Proceed with your recommendations.', createdAt: '2026-11-14T10:00:00.000Z', ...patch,
  });
  const loopRun = (overrides = {}) => runView({
    agentsDecide: true,
    steps: [
      { index: 0, name: 'Develop', status: 'complete', sessionId: 'Demo-1', iteration: 1, roundsCompleted: 0, repeat: { mode: 'once' } },
      { index: 1, name: 'Test', status: 'running', sessionId: 'Demo-2', iteration: 1, roundsCompleted: 2, repeat: { mode: 'loop_back', toStepIndex: 0, max: 20 } },
    ],
    ...overrides,
  });

  function renderBar(run, onLoadDecisions = vi.fn(async () => ({ decisions: [decision(1), decision(2)], hasNextPage: false, total: 2 }))) {
    const props = { onStop: vi.fn(), onResume: vi.fn(), onContinue: vi.fn(), onCleanup: vi.fn(), onAnswer: vi.fn(), onActivateStep: vi.fn(), onLoadDecisions };
    const view = render(<PipelineRunsBar runs={[run]} {...props} />);
    return { onLoadDecisions, rerender: next => view.rerender(<PipelineRunsBar runs={[next]} {...props} />) };
  }
  const toggle = count => screen.getByRole('button', { name: `${count} ${count === 1 ? 'decision' : 'decisions'} made by agents` });
  const list = () => screen.getByRole('list', { name: 'Decisions agents made in Feature' });
  const open = async (count) => { await act(async () => { fireEvent.click(toggle(count)); }); };

  it('shows which round a loop is on, on the step that loops back', () => {
    renderBar(loopRun());
    expect(screen.getByRole('button', { name: 'Test running · round 3 (max 20)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Develop complete' })).toBeTruthy();
  });

  it('shows round 1 before the loop has gone round', () => {
    const run = loopRun();
    run.steps[1] = { ...run.steps[1], status: 'pending', roundsCompleted: 0 };
    renderBar(run);
    expect(screen.getByRole('button', { name: 'Test pending · round 1 (max 20)' })).toBeTruthy();
  });

  it('shows completed loop counts with the right singular or plural noun', () => {
    const run = loopRun();
    run.steps[1] = { ...run.steps[1], status: 'complete', roundsCompleted: 5, repeat: { ...run.steps[1].repeat, max: 12 } };
    const { rerender } = renderBar(run);
    expect(screen.getByRole('button', { name: 'Test complete · 6 rounds' })).toBeTruthy();

    rerender(loopRun({ steps: [{ ...run.steps[1], roundsCompleted: 0 }] }));
    expect(screen.getByRole('button', { name: 'Test complete · 1 round' })).toBeTruthy();
  });

  it('shows completed passes and pending pass limits', () => {
    const run = runView();
    run.steps[0] = { ...run.steps[0], iteration: 2 };
    run.steps[1] = { ...run.steps[1], status: 'pending', iteration: 0, repeat: { mode: 'until_complete', max: 3 } };
    renderBar(run);
    expect(screen.getByRole('button', { name: 'Setup complete · 2 passes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Implement pending · max 3 passes' })).toBeTruthy();
  });

  it('shows a tick only on complete chips and keeps labels free of progress fractions', () => {
    const run = loopRun({ steps: [
      runView().steps[0],
      runView().steps[1],
      { ...loopRun().steps[1], index: 2 },
      { ...loopRun().steps[0], index: 3 },
    ] });
    renderBar(run);
    const complete = screen.getByRole('button', { name: 'Setup complete · 1 pass' });
    const running = screen.getByRole('button', { name: 'Implement running · pass 2 (max 5)' });
    expect(complete.querySelector('svg')).toBeTruthy();
    expect(complete.querySelector('svg').getAttribute('aria-hidden')).toBe('true');
    expect(running.querySelector('svg')).toBeNull();
    expect(complete.getAttribute('title')).toBe(complete.getAttribute('aria-label'));
    expect(running.getAttribute('title')).toBe(running.getAttribute('aria-label'));
    expect([...screen.getByTestId('pipeline-runs-bar').querySelectorAll('button[aria-label]')]
      .map(chip => chip.textContent).join(' ')).not.toMatch(/\d+\/\d+/);
  });

  it('marks a run whose agents decide, and only such a run', () => {
    renderBar(loopRun());
    expect(screen.getByText('agents decide')).toBeTruthy();
    cleanup();
    renderBar(loopRun({ agentsDecide: false }));
    expect(screen.queryByText('agents decide')).toBeNull();
  });

  it('offers no decisions for a run whose agents decided nothing', () => {
    const { onLoadDecisions } = renderBar(loopRun({ decisionCount: 0 }));
    expect(screen.queryByRole('button', { name: /made by agents/ })).toBeNull();
    expect(onLoadDecisions).not.toHaveBeenCalled();
  });

  it('counts one decision in the singular', () => {
    renderBar(loopRun({ decisionCount: 1 }));
    expect(toggle(1)).toBeTruthy();
  });

  it('loads and lists the decisions when asked, then hides them again', async () => {
    const { onLoadDecisions } = renderBar(loopRun({ decisionCount: 2 }));
    expect(onLoadDecisions).not.toHaveBeenCalled();
    await open(2);
    expect(onLoadDecisions).toHaveBeenCalledWith('r1', 0);
    const items = within(list()).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Test, pass 1')).toBeTruthy();
    expect(within(items[0]).getByText(/1\. Question 1\?/)).toBeTruthy();
    expect(within(items[0]).getByText(/Recommended: yes/)).toBeTruthy();
    expect(within(items[0]).getByText('Answered: Proceed with your recommendations.')).toBeTruthy();
    expect(toggle(2).getAttribute('aria-expanded')).toBe('true');

    await open(2);
    expect(screen.queryByRole('list', { name: 'Decisions agents made in Feature' })).toBeNull();
    expect(toggle(2).getAttribute('aria-expanded')).toBe('false');
  });

  it('notes a list of questions that was cut', async () => {
    renderBar(loopRun({ decisionCount: 1 }), vi.fn(async () => ({ decisions: [decision(1, { truncated: true })], hasNextPage: false, total: 1 })));
    await open(1);
    expect(within(list()).getByText('The list was cut here.')).toBeTruthy();
  });

  it('loads further pages on request and appends them', async () => {
    const onLoadDecisions = vi.fn()
      .mockResolvedValueOnce({ decisions: [decision(1), decision(2)], hasNextPage: true, total: 3 })
      .mockResolvedValueOnce({ decisions: [decision(3)], hasNextPage: false, total: 3 });
    renderBar(loopRun({ decisionCount: 3 }), onLoadDecisions);
    await open(3);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show more decisions' })); });
    expect(onLoadDecisions).toHaveBeenLastCalledWith('r1', 1);
    expect(within(list()).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Show more decisions' })).toBeNull();
  });

  it('says so when the decisions could not be loaded, and loads them on Try again', async () => {
    const onLoadDecisions = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ decisions: [decision(1)], hasNextPage: false, total: 1 });
    renderBar(loopRun({ decisionCount: 1 }), onLoadDecisions);
    await open(1);
    expect(screen.getByText('The decisions could not be loaded.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Decisions agents made in Feature' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText('The decisions could not be loaded.')).toBeNull();
  });

  it('loads the list again when another decision is made while it is open', async () => {
    const onLoadDecisions = vi.fn()
      .mockResolvedValueOnce({ decisions: [decision(1)], hasNextPage: false, total: 1 })
      .mockResolvedValueOnce({ decisions: [decision(1), decision(2)], hasNextPage: false, total: 2 });
    const { rerender } = renderBar(loopRun({ decisionCount: 1 }), onLoadDecisions);
    await open(1);
    await act(async () => { rerender(loopRun({ decisionCount: 2 })); });
    expect(onLoadDecisions).toHaveBeenCalledTimes(2);
    expect(onLoadDecisions).toHaveBeenLastCalledWith('r1', 0);
    expect(within(list()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('does not load again for a poll that changes nothing', async () => {
    const { onLoadDecisions, rerender } = renderBar(loopRun({ decisionCount: 2 }));
    await open(2);
    await act(async () => { rerender(loopRun({ decisionCount: 2, status: 'running' })); });
    expect(onLoadDecisions).toHaveBeenCalledTimes(1);
  });

  it('ignores a page that arrives after the list was closed', async () => {
    let release;
    const onLoadDecisions = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    renderBar(loopRun({ decisionCount: 1 }), onLoadDecisions);
    await open(1);
    await open(1);
    await act(async () => { release({ decisions: [decision(1)], hasNextPage: false, total: 1 }); });
    expect(screen.queryByRole('list', { name: 'Decisions agents made in Feature' })).toBeNull();
  });
});
