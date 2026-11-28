import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TaskScreen from '../TaskScreen';
import { buildNowView } from '../nowView';
import { run, askingRun, approvalRun, completeRun, task, RUN_ID } from './runFixtures';

const NOW = Date.parse('2026-11-10T18:00:00.000Z');
const projects = [{ id: 'p', name: 'p', state: 'active' }];
const session = id => ({ id, incarnationId: `inc-${id}`, projectId: 'p', title: id, status: 'idle', live: true, cwd: '/work', host: 'local', runtimeType: 'tmux', finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: NOW });
const rowOf = (record, sessions = [session('p-1'), session('p-2')]) => buildNowView({ sessions, projects, now: NOW, scope: 'all', query: '', runs: [record], tasks: [task()] }).tasks[0];
const NOTE = { id: 7, stepIndex: 1, stepName: 'Fix', status: 'written', summary: 'The call now uses the first name', attempt: 1, pass: 1, createdAt: '2026-11-10T17:50:00.000Z', content: '# Fix\n\nThe greeting reads the first name.' };

function show(record, overrides = {}, sessions) {
  const handlers = {
    onBack: vi.fn(), onOpenSession: vi.fn(), onAnswer: vi.fn(async () => record), onApprove: vi.fn(async () => record),
    onSendBack: vi.fn(async () => record), onLoadNotes: vi.fn(async () => ({ notes: [NOTE], hasNextPage: false, total: 1 })), onAction: vi.fn(async () => record), ...overrides,
  };
  render(<TaskScreen row={rowOf(record, sessions)} busy={false} {...handlers} />);
  return handlers;
}
const steps = () => within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem');
afterEach(cleanup);

describe('a task on the phone', () => {
  it('lists the repositories of a task with several and where the run works', () => {
    const handlers = { onBack: vi.fn(), onOpenSession: vi.fn(), onAnswer: vi.fn(), onApprove: vi.fn(), onSendBack: vi.fn(), onLoadNotes: vi.fn(), onAction: vi.fn() };
    const row = { ...rowOf(run()), repositories: [{ name: 'mobile-app', state: 'active', current: true }, { name: 'backend', state: 'active', current: false }, { name: 'frontend', state: 'merged', current: false }] };
    render(<TaskScreen row={row} busy={false} {...handlers} />);
    const items = within(screen.getByRole('list', { name: 'Repositories' })).getAllByRole('listitem').map(item => item.textContent);
    expect(items).toEqual(['mobile-app · the run works here', 'backend', 'frontend · merged']);
    cleanup();
    render(<TaskScreen row={rowOf(run())} busy={false} {...handlers} />);
    expect(screen.queryByRole('list', { name: 'Repositories' })).toBeNull();
  });

  it('names the task and says how its run stands', () => {
    show(run());
    expect(screen.getByRole('heading', { level: 1, name: 'First name only on the call' })).toBeTruthy();
    expect(screen.getByText('Running', { selector: '.m-state' })).toBeTruthy();
    expect(screen.getByText(/Bug fix · p/)).toBeTruthy();
  });
  it('lists the steps with their state in words and marks the one the run is in', () => {
    show(run());
    expect(steps().map(item => item.querySelector('.m-step-name').textContent)).toEqual(['Clarify', 'Fix', 'Verify']);
    expect(steps().map(item => item.querySelector('.m-step-meta').textContent)).toEqual(['Done · Fable Medium', 'Running · Fable Medium', 'Not started · Fable Medium']);
    expect(steps().map(item => item.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(steps().map(item => item.className)).toEqual(['m-step is-done', 'm-step is-current', 'm-step is-pending']);
  });
  it('opens the terminal of a step that has one', () => {
    const { onOpenSession } = show(run());
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal of Fix' }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-2' }));
    expect(screen.queryByRole('button', { name: 'Open terminal of Verify' })).toBeNull();
  });
  it('offers no terminal for a step whose terminal is not open', () => {
    show(run(), {}, [session('p-1')]);
    expect(screen.queryByRole('button', { name: 'Open terminal of Fix' })).toBeNull();
  });
  it('goes back', () => {
    const { onBack } = show(run());
    fireEvent.click(screen.getByRole('button', { name: 'Back to sessions' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
  it('shows a historical accepted limit with the verified count and preserves the step note', async () => {
    const record = completeRun();
    record.steps[1] = { ...record.steps[1], status: 'limit_accepted', note: NOTE };
    const { onLoadNotes } = show(record);
    expect(screen.getByText('Ended at limit', { selector: '.m-state' })).toBeTruthy();
    expect(screen.getByText('2/3 steps done')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read full note' }));
    await waitFor(() => expect(screen.getByText(/The greeting reads the first name/)).toBeTruthy());
    expect(onLoadNotes).toHaveBeenCalledWith(RUN_ID, 0, 1);
  });

  it('shows the phase the run is in', () => {
    show(run({ progress: { file: 'docs/todos/fix.md', status: 'in_progress', phaseCount: 3, phase: { number: 2, position: 2, title: 'Greeting', tasksTotal: 5, tasksDone: 2 } } }));
    expect(screen.getByText('Phase 2 of 3: Greeting · 2 of 5 tasks done')).toBeTruthy();
  });
});

describe('answering on the phone', () => {
  it('shows each question on the waiting step and sends the answers', async () => {
    const { onAnswer } = show(askingRun());
    const waiting = within(steps()[1]);
    expect(waiting.getByRole('group', { name: 'Question 1' })).toBeTruthy();
    expect(waiting.getByText('Which name should the call use?')).toBeTruthy();
    fireEvent.change(waiting.getByLabelText('Your answer to question 2'), { target: { value: 'Yes, the text too' } });
    fireEvent.click(waiting.getByRole('button', { name: 'Send answers' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(RUN_ID, '1. As you recommend: The first name only\n2. Yes, the text too'));
  });
  it('sends the answer once however fast it is tapped', async () => {
    let finish;
    const { onAnswer } = show(askingRun(), { onAnswer: vi.fn(() => new Promise(resolve => { finish = resolve; })) });
    fireEvent.change(screen.getByLabelText('Your answer to question 2'), { target: { value: 'Yes' } });
    const send = screen.getByRole('button', { name: 'Send answers' });
    fireEvent.click(send); fireEvent.click(send);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    finish(null);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send answers' }).disabled).toBe(false));
  });
  it('says to answer in the terminal when the agent shows a dialog', () => {
    show(askingRun({ inputRequest: null, actions: { ...askingRun().actions, answer: false } }));
    expect(screen.getByText('The agent is showing a dialog in its terminal. Answer it there.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open terminal of Fix' })).toBeTruthy();
  });
});

describe('approving on the phone', () => {
  it('shows what the step concluded and its note, and approves', async () => {
    const { onApprove, onLoadNotes } = show(approvalRun());
    const waiting = within(steps()[1]);
    expect(waiting.getByText('The call now uses the first name')).toBeTruthy();
    await waitFor(() => expect(waiting.getByText('The greeting reads the first name.')).toBeTruthy());
    expect(onLoadNotes).toHaveBeenCalledWith(RUN_ID, 0, 1);
    fireEvent.click(waiting.getByRole('button', { name: 'Approve and continue' }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(RUN_ID));
  });
  it('sends the step back with what to change', async () => {
    const { onSendBack } = show(approvalRun());
    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }));
    expect(screen.getByRole('button', { name: 'Send back' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('What should change'), { target: { value: ' Keep the surname in the text. ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }));
    await waitFor(() => expect(onSendBack).toHaveBeenCalledWith(RUN_ID, 'Keep the surname in the text.'));
  });
});

describe('a run that cannot go on by itself', () => {
  const interrupted = run({ status: 'interrupted', actions: { ...run().actions, stop: false, resume: true }, steps: [run().steps[0], { ...run().steps[1], status: 'interrupted' }, run().steps[2]] });
  it('offers Resume for an interrupted run', async () => {
    const { onAction } = show(interrupted);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('resume', RUN_ID));
  });
  it('offers one more pass at a capped limit', () => {
    const { onAction } = show(run({ status: 'limit_paused', actions: { ...run().actions, continue: true }, steps: [run().steps[0], { ...run().steps[1], status: 'limit_reached', repeat: { mode: 'until_complete', max: 3 }, iteration: 3 }, run().steps[2]] }));
    fireEvent.click(screen.getByRole('button', { name: 'Run one more pass' }));
    expect(onAction).toHaveBeenCalledWith('continue', RUN_ID, { stepIndex: 1, roundsCompleted: 0, extraRounds: 0 });
    expect(steps()[1].querySelector('.m-step-meta').textContent).toBe('Paused at its limit · pass 3 of 3 · Fable Medium');
  });
  it('disables the action while another is being sent', () => {
    render(<TaskScreen row={rowOf(interrupted)} busy onBack={vi.fn()} onOpenSession={vi.fn()} onAnswer={vi.fn()} onApprove={vi.fn()} onSendBack={vi.fn()} onLoadNotes={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Resume' }).disabled).toBe(true);
  });
  it('says why a run failed', () => {
    show(run({ status: 'error', error: 'The agent exited before it finished', finishedAt: run().createdAt, actions: { ...run().actions, stop: false, resume: true }, steps: [run().steps[0], { ...run().steps[1], status: 'failed' }, run().steps[2]] }));
    expect(screen.getByRole('alert').textContent).toBe('The agent exited before it finished');
    expect(steps()[1].className).toBe('m-step is-failed');
  });
  it('offers nothing to do for a complete run', () => {
    show(completeRun());
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(steps().every(item => item.className === 'm-step is-done')).toBe(true);
  });
});

describe('what the task screen requires', () => {
  it.each(['onBack', 'onOpenSession', 'onAnswer', 'onApprove', 'onSendBack', 'onLoadNotes', 'onAction'])('requires %s', name => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handlers = { onBack: vi.fn(), onOpenSession: vi.fn(), onAnswer: vi.fn(), onApprove: vi.fn(), onSendBack: vi.fn(), onLoadNotes: vi.fn(), onAction: vi.fn(), [name]: undefined };
    expect(() => render(<TaskScreen row={rowOf(run())} busy={false} {...handlers} />)).toThrow(`task screen: ${name} must be a function`);
    quiet.mockRestore();
  });
  it('requires a task row', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TaskScreen row={null} busy={false} onBack={vi.fn()} onOpenSession={vi.fn()} onAnswer={vi.fn()} onApprove={vi.fn()} onSendBack={vi.fn()} onLoadNotes={vi.fn()} onAction={vi.fn()} />)).toThrow('task screen: row is required');
    quiet.mockRestore();
  });
});

describe('limit recovery on the phone', () => {
  const capped = run({ status: 'limit_paused', currentStepIndex: 1,
    progress: { file: 'docs/todos/fix.md', status: 'in_progress', phaseCount: 6, phase: { number: 8, position: 5, title: 'Relay', tasksTotal: 4, tasksDone: 2 } },
    actions: { ...run().actions, stop: true, continue: true },
    steps: [
      run().steps[0],
      { ...run().steps[1], status: 'limit_reached', repeat: { mode: 'loop_back', toStepIndex: 0, max: 8 }, roundsCompleted: 7, extraRounds: 0,
        note: { status: 'written', summary: 'The queue stalled on a batch of one', attempt: 8, pass: 1, createdAt: '2026-11-10T17:50:00.000Z' } },
      run().steps[2],
    ] });
  it('runs one more round or stops with the findings visible', () => {
    const { onAction } = show(capped);
    expect(screen.getByRole('button', { name: 'Run one more round' })).toBeTruthy();
    expect(screen.getByText(/8 rounds/)).toBeTruthy();
    expect(screen.getByText(/2 of 4 tasks done/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run one more round' }));
    expect(onAction).toHaveBeenCalledWith('continue', RUN_ID, { stepIndex: 1, roundsCompleted: 7, extraRounds: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Stop with work remaining' }));
    expect(onAction).toHaveBeenCalledWith('stop', RUN_ID);
  });
  it('names the pass for an until_complete pause', () => {
    show(run({ status: 'limit_paused', actions: { ...run().actions, continue: true },
      steps: [run().steps[0], { ...run().steps[1], status: 'limit_reached', repeat: { mode: 'until_complete', max: 3 }, iteration: 3, extraRounds: 0 }, run().steps[2]] }));
    expect(screen.getByRole('button', { name: 'Run one more pass' })).toBeTruthy();
  });
  it('counts a granted round in the used rounds on the second pause', () => {
    show(run({ status: 'limit_paused', currentStepIndex: 1,
      actions: { ...run().actions, stop: true, continue: true },
      steps: [run().steps[0],
        { ...run().steps[1], status: 'limit_reached', repeat: { mode: 'loop_back', toStepIndex: 0, max: 8 }, roundsCompleted: 8, extraRounds: 1,
          note: { status: 'written', summary: 'The queue still stalls', attempt: 9, pass: 1, createdAt: '2026-11-10T17:50:00.000Z' } },
        run().steps[2]] }));
    expect(screen.getByText('Fix paused at its limit: 9 rounds used of 8 allowed + 1 granted.')).toBeTruthy();
  });
  it('opens the full capped note from the pause', async () => {
    const { onLoadNotes } = show(capped);
    fireEvent.click(screen.getByRole('button', { name: 'Read full note' }));
    await waitFor(() => expect(onLoadNotes).toHaveBeenCalledWith(RUN_ID, 0, 1));
    await waitFor(() => expect(screen.getByText(/The greeting reads the first name/)).toBeTruthy());
  });
  it('says the capped note could not be loaded when the load fails, not that there is none', async () => {
    // The app's loader toasts the failure and resolves null.
    show(capped, { onLoadNotes: vi.fn(async () => null) });
    fireEvent.click(screen.getByRole('button', { name: 'Read full note' }));
    await waitFor(() => expect(screen.getByText('The step note could not be loaded.')).toBeTruthy());
    expect(screen.queryByText('This step left no note.')).toBeNull();
  });
  it('says passes for an until_complete pause with multiple passes', () => {
    show(run({ status: 'limit_paused', actions: { ...run().actions, continue: true },
      steps: [run().steps[0],
        { ...run().steps[1], status: 'limit_reached', repeat: { mode: 'until_complete', max: 3 }, iteration: 4, extraRounds: 1 },
        run().steps[2]] }));
    expect(screen.getByText('Fix paused at its limit: 4 passes used of 3 allowed + 1 granted.')).toBeTruthy();
  });
  it('does not keep showing the previous pause full note after a direct pause-to-pause refresh', async () => {
    const round8 = { ...NOTE, attempt: 8, summary: 'Round 8 still stalls', content: '# Round 8 Test note REPAIR 8 PH1', createdAt: '2026-11-10T17:50:00.000Z' };
    const round9 = { ...NOTE, attempt: 9, summary: 'Round 9 probe still fails', content: '# Round 9 Test note REPAIR 9 PH1', createdAt: '2026-11-10T17:55:00.000Z' };
    const pause1 = run({ status: 'limit_paused', currentStepIndex: 1,
      actions: { ...run().actions, stop: true, continue: true },
      steps: [run().steps[0],
        { ...run().steps[1], status: 'limit_reached', repeat: { mode: 'loop_back', toStepIndex: 0, max: 8 }, roundsCompleted: 7, extraRounds: 0, note: round8 },
        run().steps[2]] });
    const pause2 = run({ status: 'limit_paused', currentStepIndex: 1,
      actions: { ...run().actions, stop: true, continue: true },
      steps: [run().steps[0],
        { ...run().steps[1], status: 'limit_reached', repeat: { mode: 'loop_back', toStepIndex: 0, max: 8 }, roundsCompleted: 8, extraRounds: 1, note: round9 },
        run().steps[2]] });
    let latest = [round8];
    const handlers = {
      onBack: vi.fn(), onOpenSession: vi.fn(), onAnswer: vi.fn(), onApprove: vi.fn(), onSendBack: vi.fn(),
      onLoadNotes: vi.fn(async () => ({ notes: latest, hasNextPage: false, total: 1 })), onAction: vi.fn(),
    };
    const { rerender } = render(<TaskScreen row={rowOf(pause1)} busy={false} {...handlers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read full note' }));
    await waitFor(() => expect(screen.getByText(/# Round 8 Test note REPAIR 8 PH1/)).toBeTruthy());
    latest = [round9];
    rerender(<TaskScreen row={rowOf(pause2)} busy={false} {...handlers} />);
    expect(screen.queryByText(/# Round 8 Test note REPAIR 8 PH1/)).toBeNull();
  });
});
