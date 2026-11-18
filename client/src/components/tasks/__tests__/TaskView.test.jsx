import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

vi.mock('../../ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
import TaskView from '../TaskView.jsx';

const step = (index, name, overrides = {}) => ({
  index, kind: 'node', name, readOnly: false, approval: false, agentName: 'codex', notePath: null, note: null,
  repeat: { mode: 'once' }, status: 'pending', sessionId: null, priorSessionIds: [], attempt: 0, iteration: 0, roundsCompleted: 0, ...overrides,
});
const run = (overrides = {}) => ({
  id: 'run-1', workflowName: 'Feature build', status: 'running', stopReason: null, error: null, agentsDecide: false, decisionCount: 0,
  notesDir: '.codedeck/runs/abcd1234', progress: null, currentStepIndex: 1, inputRequest: null, approvalRequest: null,
  worktree: { path: '/tmp/wt', branch: 'task/x', state: 'external', detail: null },
  actions: { stop: true, resume: false, continue: false, cleanup: false, answer: false, approve: false, sendBack: false },
  steps: [
    step(0, 'Plan', { status: 'complete', sessionId: 'Demo-1', attempt: 1, iteration: 1, approval: true, readOnly: true }),
    step(1, 'Develop', { status: 'running', sessionId: 'Demo-2', attempt: 1, iteration: 1 }),
    step(2, 'Test', { repeat: { mode: 'loop_back', toStepIndex: 1, max: 12 } }),
  ],
  ...overrides,
});
const handlers = () => ({
  onActivateStep: vi.fn(), onOpenTerminal: vi.fn(), onStop: vi.fn(), onResume: vi.fn(), onContinue: vi.fn(), onCleanup: vi.fn(),
  onAnswer: vi.fn(async () => ({})), onApprove: vi.fn(async () => ({})), onSendBack: vi.fn(async () => ({})),
  onLoadNotes: vi.fn(async () => ({ notes: [{ id: 1, pass: 1, attempt: 1, summary: 'Planned three phases', content: 'Full plan text' }] })),
  onLoadDecisions: vi.fn(async () => ({ decisions: [{ id: 4, pass: 1, questions: '1. Use Redis?', answer: 'Proceed with your recommendations.' }] })),
  onLoadAnswers: vi.fn(async () => ({ answers: [{ id: 3, pass: 1, questions: '1. Which page?', answer: 'The login page' }, { id: 5, pass: 2, questions: null, answer: 'Yes' }] })),
  onLoadReviews: vi.fn(async () => ({ reviews: [{ id: 7, verdict: 'sent_back', comment: 'Cover the empty case' }, { id: 8, verdict: 'approved', comment: null }] })),
});
const view = (props = {}) => {
  const h = handlers();
  const result = render(<TaskView title="WhatsApp replies" tooltip="demo-wt\ntask/x\n/tmp/wt" run={run()} openSessionIds={new Set(['Demo-1', 'Demo-2'])} {...h} {...props}><div data-testid="terminals" /></TaskView>);
  return { ...result, h };
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('TaskView', () => {
  it('names the task and its workflow, shows the status in words and keeps the terminals inside', () => {
    view();
    expect(screen.getByText('WhatsApp replies · Feature build').getAttribute('title')).toContain('task/x');
    expect(screen.getByLabelText('Run status: Running')).toBeTruthy();
    expect(within(screen.getByTestId('task-view')).getByTestId('terminals')).toBeTruthy();
  });

  it('lists every step in plain words and never a raw state name', () => {
    view({ run: run({ status: 'complete', currentStepIndex: 2, steps: [
      step(0, 'Plan', { status: 'complete', sessionId: 'Demo-1', attempt: 1, iteration: 1 }),
      step(1, 'Develop', { status: 'complete', sessionId: 'Demo-2', attempt: 1, iteration: 1 }),
      step(2, 'Test', { status: 'limit_accepted', sessionId: 'Demo-2', attempt: 1, iteration: 1, roundsCompleted: 11, repeat: { mode: 'loop_back', toStepIndex: 1, max: 12 } }),
    ] }) });
    const rail = screen.getByRole('navigation', { name: 'Steps' });
    expect(within(rail).getByRole('button', { name: 'Test: Stopped at its limit; you continued, 12 rounds' })).toBeTruthy();
    expect(within(rail).getByRole('button', { name: 'Plan: Done' })).toBeTruthy();
    expect(screen.getByTestId('task-view').textContent).not.toMatch(/limit_|needs_input|awaiting_/);
  });

  it('shows the current step first, and a picked step until the run moves on', () => {
    const { rerender, h } = view();
    expect(screen.getByRole('region', { name: 'Step Develop' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Plan: Done' }));
    expect(screen.getByRole('region', { name: 'Step Plan' })).toBeTruthy();
    expect(h.onActivateStep).toHaveBeenCalledWith('Demo-1');
    expect(screen.getByRole('button', { name: 'Plan: Done' }).getAttribute('aria-current')).toBe('step');
    rerender(<TaskView title="WhatsApp replies" run={run({ currentStepIndex: 2, steps: run().steps.map(item => (item.index === 2 ? { ...item, status: 'running', sessionId: 'Demo-2', attempt: 1, iteration: 1 } : item.index === 1 ? { ...item, status: 'complete' } : item)) })} openSessionIds={new Set(['Demo-1', 'Demo-2'])} {...h} />);
    expect(screen.getByRole('region', { name: 'Step Test' })).toBeTruthy();
    expect(screen.getByText('loops back to Develop')).toBeTruthy();
  });

  it('shows the terminal of the step the run is working on, and follows the run to the next one', () => {
    const moved = (overrides = {}) => run({ currentStepIndex: 2, steps: run().steps.map(item => (item.index === 2 ? { ...item, status: 'running', sessionId: 'Demo-3', attempt: 1, iteration: 1 } : item.index === 1 ? { ...item, status: 'complete' } : item)), ...overrides });
    const props = { title: 'WhatsApp replies' };
    const { rerender, h } = view();
    expect(h.onActivateStep.mock.calls).toEqual([['Demo-2']]);

    // The same step again (a poll) does not pull the owner back from a tab they chose.
    rerender(<TaskView {...props} run={run()} openSessionIds={new Set(['Demo-1', 'Demo-2'])} {...h} />);
    expect(h.onActivateStep).toHaveBeenCalledTimes(1);

    // A new callback on every render (the terminal area makes one whenever sessions are polled) is
    // not a move: otherwise the owner is pulled back to the run every two seconds and cannot leave.
    const again = vi.fn();
    rerender(<TaskView {...props} run={run()} openSessionIds={new Set(['Demo-1', 'Demo-2'])} {...h} onActivateStep={again} />);
    expect(again).not.toHaveBeenCalled();

    // The run moved on, but the next step's terminal is not open in this browser yet.
    rerender(<TaskView {...props} run={moved()} openSessionIds={new Set(['Demo-1', 'Demo-2'])} {...h} />);
    expect(h.onActivateStep).toHaveBeenCalledTimes(1);
    rerender(<TaskView {...props} run={moved()} openSessionIds={new Set(['Demo-1', 'Demo-2', 'Demo-3'])} {...h} />);
    expect(h.onActivateStep.mock.calls).toEqual([['Demo-2'], ['Demo-3']]);
  });

  it.each(['complete', 'stopped', 'error', 'interrupted'])('leaves the owner where they are when the run is %s', status => {
    const { h } = view({ run: run({ status }) });
    expect(h.onActivateStep).not.toHaveBeenCalled();
  });

  it('says when a step has no terminal yet or its terminal was closed, and offers one', () => {
    const { h } = view({ openSessionIds: new Set(['Demo-2']) });
    h.onActivateStep.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Test: Not started, round 1 of 12' }));
    expect(screen.getByText('This step has not started, so it has no terminal yet.')).toBeTruthy();
    expect(h.onActivateStep).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Plan: Done' }));
    expect(screen.getByText(/This step's terminal is closed/)).toBeTruthy();
    expect(h.onActivateStep).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open a terminal here' }));
    expect(h.onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it('loads a step’s notes and reviews only for that step, when opened', async () => {
    const { h } = view();
    fireEvent.click(screen.getByRole('button', { name: 'Plan: Done' }));
    expect(h.onLoadNotes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    await waitFor(() => expect(screen.getByText('Full plan text')).toBeTruthy());
    expect(h.onLoadNotes).toHaveBeenCalledWith('run-1', 0, 0);
    fireEvent.click(screen.getByRole('button', { name: 'Your reviews' }));
    await waitFor(() => expect(screen.getByText('Cover the empty case')).toBeTruthy());
    expect(h.onLoadReviews).toHaveBeenCalledWith('run-1', 0);
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Decisions' })).toBeNull();
  });

  it('shows what the step asked the owner and what was answered, and marks a step that always asks', async () => {
    const { h } = view({ run: run({ steps: run().steps.map(item => (item.index === 1 ? { ...item, askOwner: true } : item)) }) });
    expect(screen.getByText('always asks you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Your answers' }));
    await waitFor(() => expect(screen.getByText('You answered: The login page')).toBeTruthy());
    expect(h.onLoadAnswers).toHaveBeenCalledWith('run-1', 1);
    expect(screen.getByText('1. Which page?')).toBeTruthy();
    expect(screen.getByText('The agent asked without listing its questions.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Plan: Done' }));
    expect(screen.queryByText('always asks you')).toBeNull();
  });

  it('offers decisions only when agents decide, and reviews only on a step that waits for approval', async () => {
    const { h } = view({ run: run({ agentsDecide: true, decisionCount: 2 }) });
    expect(screen.getByText('agents decide · 2 so far')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Your reviews' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Decisions' }));
    await waitFor(() => expect(screen.getByText('1. Use Redis?')).toBeTruthy());
    expect(h.onLoadDecisions).toHaveBeenCalledWith('run-1', 0, 1);
  });

  it('reports records that could not be loaded and an empty list', async () => {
    view({ onLoadNotes: vi.fn(async () => null) });
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    await waitFor(() => expect(screen.getByText('Notes could not be loaded.')).toBeTruthy());
    cleanup();
    view({ onLoadNotes: vi.fn(async () => ({ notes: [] })) });
    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    await waitFor(() => expect(screen.getByText('This step has left no note yet.')).toBeTruthy());
  });

  it('puts the question panel on the step that needs input, and nowhere else', () => {
    const waiting = run({ status: 'needs_input', inputRequest: { questions: '1. Which port?', truncated: false },
      actions: { ...run().actions, answer: true },
      steps: run().steps.map(item => (item.index === 1 ? { ...item, status: 'needs_input' } : item)) });
    view({ run: waiting });
    expect(screen.getByRole('group', { name: 'Feature build needs your input' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Plan: Done' }));
    expect(screen.queryByRole('group', { name: 'Feature build needs your input' })).toBeNull();
  });

  it('offers the run actions the backend allows, with the next one highlighted', () => {
    const { h } = view({ run: run({ status: 'limit_paused', actions: { ...run().actions, continue: true },
      steps: run().steps.map(item => (item.index === 1 ? { ...item, status: 'limit_reached' } : item)) }) });
    expect(screen.getByRole('button', { name: 'Continue' }).className).toContain('pipeline-run-primary');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(h.onContinue).toHaveBeenCalledWith('run-1');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(h.onStop).toHaveBeenCalledWith('run-1');
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('asks before Resume and closes a finished run without removing the task', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { h } = view({ run: run({ status: 'stopped', stopReason: 'no_progress', actions: { ...run().actions, stop: false, resume: true, cleanup: true },
      steps: run().steps.map(item => (item.index === 1 ? { ...item, status: 'stopped' } : item)) }) });
    expect(screen.getByText(/No task was ticked in the last/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(h.onResume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(h.onResume).toHaveBeenCalledWith('run-1');
    expect(confirm.mock.calls[0][0]).toContain('Develop starts again there');
    fireEvent.click(screen.getByRole('button', { name: 'Close run' }));
    expect(h.onCleanup).toHaveBeenCalledWith('run-1');
  });

  it('shows progress, a failure message, and opens a terminal from the rail', () => {
    const { h } = view({ run: run({ status: 'error', error: 'Setup left uncommitted files', actions: { ...run().actions, stop: false, resume: true },
      progress: { file: 'plan.md', status: 'in_progress', phaseCount: 6, phase: { number: 4, title: 'Answers', tasksDone: 3, tasksTotal: 7 } },
      steps: run().steps.map(item => (item.index === 1 ? { ...item, status: 'failed' } : item)) }) });
    expect(screen.getByText('Phase 4 of 6: Answers')).toBeTruthy();
    expect(screen.getByText(/3\/7 tasks in this phase/)).toBeTruthy();
    expect(screen.getByText('Setup left uncommitted files')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(h.onOpenTerminal).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed input', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TaskView title="x" run={null} openSessionIds={new Set()} />)).toThrow(/run is required/);
    expect(() => render(<TaskView title="x" run={run({ steps: [] })} openSessionIds={new Set()} />)).toThrow(/steps/);
    expect(() => render(<TaskView title="x" run={run()} openSessionIds={[]} />)).toThrow(/openSessionIds/);
    quiet.mockRestore();
  });
});
