import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TaskScreen from '../TaskScreen';
import { buildNowView } from '../nowView';
import { run, askingRun, approvalRun, completeRun, task, RUN_ID, TASK_ID, WORKTREE_ID, landing, committedLanding } from './runFixtures';

const NOW = Date.parse('2026-11-10T18:00:00.000Z');
const projects = [{ id: 'p', name: 'p', state: 'active' }];
const session = id => ({ id, incarnationId: `inc-${id}`, projectId: 'p', title: id, status: 'idle', live: true, cwd: '/work', host: 'local', runtimeType: 'tmux', finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: NOW });
const rowOf = (record, sessions = [session('p-1'), session('p-2')]) => buildNowView({ sessions, projects, now: NOW, scope: 'all', query: '', runs: [record], tasks: [task()] }).tasks[0];
const NOTE = { id: 7, stepIndex: 1, stepName: 'Fix', status: 'written', summary: 'The call now uses the first name', attempt: 1, pass: 1, createdAt: '2026-11-10T17:50:00.000Z', content: '# Fix\n\nThe greeting reads the first name.' };

function show(record, overrides = {}, sessions) {
  const handlers = {
    onBack: vi.fn(), onOpenSession: vi.fn(), onAnswer: vi.fn(async () => record), onApprove: vi.fn(async () => record),
    onSendBack: vi.fn(async () => record), onLoadNotes: vi.fn(async () => ({ notes: [NOTE], hasNextPage: false, total: 1 })), onAction: vi.fn(async () => record),
    onLoadRecords: vi.fn(async () => ({ items: [], total: 0 })), onLoadLanding: vi.fn(async () => [landing()]), onLand: vi.fn(async () => ({})), ...overrides,
  };
  render(<TaskScreen row={rowOf(record, sessions)} busy={false} {...handlers} />);
  return handlers;
}
const steps = () => within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem');
afterEach(cleanup);

describe('a task on the phone', () => {
  it('lists the repositories of a task with several and where the run works', () => {
    const handlers = { onBack: vi.fn(), onOpenSession: vi.fn(), onAnswer: vi.fn(), onApprove: vi.fn(), onSendBack: vi.fn(), onLoadNotes: vi.fn(), onAction: vi.fn(), onLoadRecords: vi.fn(), onLoadLanding: vi.fn(async () => []), onLand: vi.fn() };
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
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Confirm' })).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('resume', RUN_ID));
  });
  it('offers one more pass at a capped limit', () => {
    const { onAction } = show(run({ status: 'limit_paused', actions: { ...run().actions, continue: true }, steps: [run().steps[0], { ...run().steps[1], status: 'limit_reached', repeat: { mode: 'until_complete', max: 3 }, iteration: 3 }, run().steps[2]] }));
    fireEvent.click(screen.getByRole('button', { name: 'Run one more pass' }));
    expect(onAction).toHaveBeenCalledWith('continue', RUN_ID, { stepIndex: 1, roundsCompleted: 0, extraRounds: 0 });
    expect(steps()[1].querySelector('.m-step-meta').textContent).toBe('Paused at its limit · pass 3 of 3 · Fable Medium');
  });
  it('disables the action while another is being sent', () => {
    render(<TaskScreen row={rowOf(interrupted)} busy onBack={vi.fn()} onOpenSession={vi.fn()} onAnswer={vi.fn()} onApprove={vi.fn()} onSendBack={vi.fn()} onLoadNotes={vi.fn()} onAction={vi.fn()} onLoadRecords={vi.fn()} onLoadLanding={vi.fn(async () => [])} onLand={vi.fn()} />);
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
  it.each(['onBack', 'onOpenSession', 'onAnswer', 'onApprove', 'onSendBack', 'onLoadNotes', 'onAction', 'onLoadRecords', 'onLoadLanding', 'onLand'])('requires %s', name => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handlers = { onBack: vi.fn(), onOpenSession: vi.fn(), onAnswer: vi.fn(), onApprove: vi.fn(), onSendBack: vi.fn(), onLoadNotes: vi.fn(), onAction: vi.fn(), onLoadRecords: vi.fn(), onLoadLanding: vi.fn(async () => []), onLand: vi.fn(), [name]: undefined };
    expect(() => render(<TaskScreen row={rowOf(run())} busy={false} {...handlers} />)).toThrow(`task screen: ${name} must be a function`);
    quiet.mockRestore();
  });
  it('requires a task row', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TaskScreen row={null} busy={false} onBack={vi.fn()} onOpenSession={vi.fn()} onAnswer={vi.fn()} onApprove={vi.fn()} onSendBack={vi.fn()} onLoadNotes={vi.fn()} onAction={vi.fn()} onLoadRecords={vi.fn()} onLoadLanding={vi.fn(async () => [])} onLand={vi.fn()} />)).toThrow('task screen: row is required');
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
      onLoadNotes: vi.fn(async () => ({ notes: latest, hasNextPage: false, total: 1 })), onAction: vi.fn(), onLoadRecords: vi.fn(), onLoadLanding: vi.fn(async () => []), onLand: vi.fn(),
    };
    const { rerender } = render(<TaskScreen row={rowOf(pause1)} busy={false} {...handlers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read full note' }));
    await waitFor(() => expect(screen.getByText(/# Round 8 Test note REPAIR 8 PH1/)).toBeTruthy());
    latest = [round9];
    rerender(<TaskScreen row={rowOf(pause2)} busy={false} {...handlers} />);
    expect(screen.queryByText(/# Round 8 Test note REPAIR 8 PH1/)).toBeNull();
  });
});

describe('run controls on the phone', () => {
  const dock = () => within(screen.getByRole('toolbar', { name: 'Run controls' }));
  const confirmation = () => within(screen.getByRole('dialog', { name: 'Confirm' }));
  const interrupted = run({ status: 'interrupted', actions: { ...run().actions, stop: false, resume: true }, steps: [run().steps[0], { ...run().steps[1], status: 'interrupted' }, run().steps[2]] });

  it('offers Stop while the run works, and stops only once the owner confirms', async () => {
    const { onAction } = show(run());
    fireEvent.click(dock().getByRole('button', { name: 'Stop' }));
    expect(onAction).not.toHaveBeenCalled();
    expect(confirmation().getByText('Stop Bug fix? Automation stops; the agent in its terminal may still be working.')).toBeTruthy();
    fireEvent.click(confirmation().getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('stop', RUN_ID));
    expect(screen.queryByRole('dialog', { name: 'Confirm' })).toBeNull();
  });
  it('does nothing when the owner cancels', () => {
    const { onAction } = show(run());
    fireEvent.click(dock().getByRole('button', { name: 'Stop' }));
    fireEvent.click(confirmation().getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Confirm' })).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });
  it('offers Stop while the run waits for an answer or an approval', () => {
    show(askingRun());
    expect(dock().getByRole('button', { name: 'Stop' })).toBeTruthy();
    cleanup();
    show(approvalRun());
    expect(dock().getByRole('button', { name: 'Stop' })).toBeTruthy();
  });
  it('offers no Stop for a run that is not working', () => {
    show(interrupted);
    expect(dock().queryByRole('button', { name: 'Stop' })).toBeNull();
  });
  it('asks before Resume, in the words of the desktop', async () => {
    const { onAction } = show(interrupted);
    fireEvent.click(dock().getByRole('button', { name: 'Resume' }));
    expect(confirmation().getByText(/^Resume Bug fix\? The agent in p-2 is cleared and Fix starts again there\./)).toBeTruthy();
    fireEvent.click(confirmation().getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('resume', RUN_ID));
  });
  it('highlights the next action', () => {
    show(interrupted);
    expect(dock().getByRole('button', { name: 'Resume' }).className).toContain('m-primary');
  });
  it('offers Close run for a finished run in a task, not highlighted, and asks first', async () => {
    const { onAction } = show(completeRun());
    const close = dock().getByRole('button', { name: 'Close run' });
    expect(close.className).not.toContain('m-primary');
    fireEvent.click(close);
    expect(confirmation().getByText('Close Bug fix? Its terminals are closed and the run leaves the screen. The task and its files remain available.')).toBeTruthy();
    fireEvent.click(confirmation().getByRole('button', { name: 'Close run' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('cleanup', RUN_ID));
  });
  it('offers Close run for a stopped run', () => {
    show(run({ status: 'stopped', stopReason: 'user', actions: { ...run().actions, stop: false, resume: true, cleanup: true }, steps: [run().steps[0], { ...run().steps[1], status: 'stopped' }, run().steps[2]] }));
    expect(dock().getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(dock().getByRole('button', { name: 'Close run' })).toBeTruthy();
  });
  it('opens the terminal of the step the run is in', () => {
    const { onOpenSession } = show(run());
    fireEvent.click(dock().getByRole('button', { name: 'Open terminal' }));
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-2' }));
  });
  it('leaves the controls of a capped pause to its panel', () => {
    show(run({ status: 'limit_paused', actions: { ...run().actions, continue: true, stop: true },
      steps: [run().steps[0], { ...run().steps[1], status: 'limit_reached', repeat: { mode: 'until_complete', max: 3 }, iteration: 3 }, run().steps[2]] }));
    expect(dock().queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(dock().queryByRole('button', { name: /Continue/ })).toBeNull();
  });
  it('disables the controls while an action is being sent', () => {
    render(<TaskScreen row={rowOf(run())} busy onBack={vi.fn()} onOpenSession={vi.fn()} onAnswer={vi.fn()} onApprove={vi.fn()} onSendBack={vi.fn()} onLoadNotes={vi.fn()} onAction={vi.fn()} onLoadRecords={vi.fn()} onLoadLanding={vi.fn(async () => [])} onLand={vi.fn()} />);
    expect(dock().getByRole('button', { name: 'Stop' }).disabled).toBe(true);
  });
  it('shows how long the run has taken', () => {
    show(run());
    expect(screen.getByLabelText(/^Run time so far: /)).toBeTruthy();
    cleanup();
    show(completeRun());
    expect(screen.getByLabelText('Run time: under 1s').textContent).toBe('took under 1s');
  });
  it('says what to do when a loop stopped for lack of progress', () => {
    show(run({ status: 'stopped', stopReason: 'no_progress', actions: { ...run().actions, stop: false, resume: true }, steps: [run().steps[0], { ...run().steps[1], status: 'stopped' }, run().steps[2]] }));
    expect(screen.getByText('This loop ran 2 rounds without finishing. Check what the steps reported, then Resume to try again.')).toBeTruthy();
  });
});

describe('steps that open on the phone', () => {
  const toggle = name => screen.getByRole('button', { name: `Step ${name}` });
  const DECISION = { id: 3, stepIndex: 1, stepName: 'Fix', pass: 1, questions: '1. Keep the surname?', truncated: false, answer: 'Proceed with your recommendations.', createdAt: '2026-11-10T17:50:00.000Z' };
  it('opens the step the run is in, and opens another when tapped', () => {
    show(run());
    expect(toggle('Fix').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Clarify').getAttribute('aria-expanded')).toBe('false');
    expect(within(steps()[0]).queryByRole('button', { name: 'Notes' })).toBeNull();
    fireEvent.click(toggle('Clarify'));
    expect(toggle('Clarify').getAttribute('aria-expanded')).toBe('true');
    expect(within(steps()[0]).getByRole('button', { name: 'Notes' })).toBeTruthy();
    fireEvent.click(toggle('Clarify'));
    expect(toggle('Clarify').getAttribute('aria-expanded')).toBe('false');
  });
  it('offers nothing to read on a step that has not started', () => {
    show(run());
    fireEvent.click(toggle('Verify'));
    expect(within(steps()[2]).queryByRole('button', { name: 'Notes' })).toBeNull();
    expect(within(steps()[2]).getByText('Nothing to read until this step starts.')).toBeTruthy();
  });
  it('reads the notes of a step when asked', async () => {
    const { onLoadNotes } = show(run());
    fireEvent.click(within(steps()[1]).getByRole('button', { name: 'Notes' }));
    await waitFor(() => expect(within(steps()[1]).getByText('The greeting reads the first name.')).toBeTruthy());
    expect(within(steps()[1]).getByText('Pass 1 · The call now uses the first name')).toBeTruthy();
    expect(onLoadNotes).toHaveBeenCalledWith(RUN_ID, 0, 1);
    expect(within(steps()[1]).getByRole('button', { name: 'Notes' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('says when a step wrote no notes, and when they could not be read', async () => {
    show(run(), { onLoadNotes: vi.fn(async () => ({ notes: [], hasNextPage: false, total: 0 })) });
    fireEvent.click(within(steps()[1]).getByRole('button', { name: 'Notes' }));
    expect(await within(steps()[1]).findByText('No notes yet.')).toBeTruthy();
    cleanup();
    show(run(), { onLoadNotes: vi.fn(async () => null) });
    fireEvent.click(within(steps()[1]).getByRole('button', { name: 'Notes' }));
    expect(await within(steps()[1]).findByText('These could not be loaded.')).toBeTruthy();
  });
  it('reads the decisions agents made, in a run that lets them decide', async () => {
    const { onLoadRecords } = show(run({ agentsDecide: true, decisionCount: 1 }), { onLoadRecords: vi.fn(async () => ({ items: [DECISION], total: 1 })) });
    fireEvent.click(within(steps()[1]).getByRole('button', { name: 'Decisions' }));
    expect(await within(steps()[1]).findByText('1. Keep the surname?')).toBeTruthy();
    expect(within(steps()[1]).getByText('Proceed with your recommendations.')).toBeTruthy();
    expect(onLoadRecords).toHaveBeenCalledWith('decisions', RUN_ID, 1);
    cleanup();
    show(run());
    expect(within(steps()[1]).queryByRole('button', { name: 'Decisions' })).toBeNull();
  });
  it('reads what the owner answered on a step', async () => {
    show(run(), { onLoadRecords: vi.fn(async () => ({ items: [{ id: 1, stepIndex: 1, stepName: 'Fix', pass: 1, questions: null, answer: 'Use the first name', createdAt: DECISION.createdAt }], total: 1 })) });
    fireEvent.click(within(steps()[1]).getByRole('button', { name: 'Your answers' }));
    expect(await within(steps()[1]).findByText('Use the first name')).toBeTruthy();
  });
  it('reads the reviews of a step that waits for approval', async () => {
    const { onLoadRecords } = show(approvalRun(), { onLoadRecords: vi.fn(async () => ({ items: [
      { id: 1, stepIndex: 1, stepName: 'Fix', attempt: 1, verdict: 'sent_back', comment: 'Keep the surname.', createdAt: DECISION.createdAt },
      { id: 2, stepIndex: 1, stepName: 'Fix', attempt: 2, verdict: 'approved', comment: null, createdAt: DECISION.createdAt }], total: 2 })) });
    fireEvent.click(within(steps()[1]).getByRole('button', { name: 'Your reviews' }));
    expect(await within(steps()[1]).findByText('Attempt 1 · Sent back: Keep the surname.')).toBeTruthy();
    expect(within(steps()[1]).getByText('Attempt 2 · Approved')).toBeTruthy();
    expect(onLoadRecords).toHaveBeenCalledWith('reviews', RUN_ID, 1);
  });
});

describe('landing a task on the phone', () => {
  const git = () => within(screen.getByRole('region', { name: 'In Git' }));
  const confirmation = () => within(screen.getByRole('dialog', { name: 'Confirm' }));
  const NO = { commit: [], merge: [], pullRequest: [], close: [] };
  it('says how the task stands in Git and highlights its next step', async () => {
    const { onLoadLanding } = show(completeRun());
    expect(await git().findByText('2 uncommitted files')).toBeTruthy();
    expect(onLoadLanding).toHaveBeenCalledWith(TASK_ID);
    expect(git().getByRole('button', { name: 'Commit changes' }).className).toContain('m-primary');
    expect(git().queryByRole('button', { name: 'Merge into main' })).toBeNull();
  });
  it('commits with the message the owner gives, starting from the task title', async () => {
    const { onLand, onLoadLanding } = show(completeRun(), { onLand: vi.fn(async () => committedLanding()) });
    fireEvent.click(await git().findByRole('button', { name: 'Commit changes' }));
    const form = within(screen.getByRole('dialog', { name: 'Commit changes' }));
    expect(form.getByLabelText('Commit message').value).toBe('First name only on the call');
    fireEvent.change(form.getByLabelText('Commit message'), { target: { value: 'Use the first name' } });
    fireEvent.click(form.getByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(onLand).toHaveBeenCalledWith('commit', TASK_ID, WORKTREE_ID, { message: 'Use the first name' }));
    await waitFor(() => expect(onLoadLanding).toHaveBeenCalledTimes(2));
  });
  it('does not commit without a message', async () => {
    const { onLand } = show(completeRun());
    fireEvent.click(await git().findByRole('button', { name: 'Commit changes' }));
    const form = within(screen.getByRole('dialog', { name: 'Commit changes' }));
    fireEvent.change(form.getByLabelText('Commit message'), { target: { value: '   ' } });
    expect(form.getByRole('button', { name: 'Commit' }).disabled).toBe(true);
    expect(onLand).not.toHaveBeenCalled();
  });
  it('merges committed work once the owner confirms', async () => {
    const { onLand } = show(completeRun(), { onLoadLanding: vi.fn(async () => [committedLanding()]) });
    expect(await git().findByText('3 commits ready for main')).toBeTruthy();
    fireEvent.click(git().getByRole('button', { name: 'Merge into main' }));
    expect(confirmation().getByText('The task is merged into main in Main. Its copy is removed afterwards, its terminals are closed and the task is finished.')).toBeTruthy();
    fireEvent.click(confirmation().getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(onLand).toHaveBeenCalledWith('merge', TASK_ID, WORKTREE_ID, {}));
  });
  it('says what keeps committed work from merging', async () => {
    show(completeRun(), { onLoadLanding: vi.fn(async () => [committedLanding({ blockers: { ...NO, commit: [{ code: 'nothing_to_commit', message: 'Nothing to commit' }], merge: [{ code: 'main_dirty', message: 'Main has uncommitted changes' }] } })]) });
    expect(await git().findByText('Main has uncommitted changes')).toBeTruthy();
    expect(git().queryByRole('button', { name: 'Merge into main' })).toBeNull();
  });
  it('opens a pull request on the remote the owner picks, saying it publishes the branch', async () => {
    const remotes = [{ name: 'origin', host: 'github.com', tool: 'gh' }, { name: 'lab', host: 'gitlab.com', tool: 'glab' }];
    const { onLand } = show(completeRun(), { onLoadLanding: vi.fn(async () => [committedLanding({ remotes })]) });
    fireEvent.click(await git().findByRole('button', { name: 'Open a pull request' }));
    expect(confirmation().getByText(/Pushing publishes the branch\./)).toBeTruthy();
    fireEvent.change(confirmation().getByLabelText('Remote'), { target: { value: 'lab' } });
    fireEvent.click(confirmation().getByRole('button', { name: 'Push and open' }));
    await waitFor(() => expect(onLand).toHaveBeenCalledWith('pullRequest', TASK_ID, WORKTREE_ID, { remote: 'lab' }));
  });
  it('closes a task whose work is already in its base', async () => {
    const done = landing({ uncommitted: [], uncommittedCount: 0, commitsAhead: 0, alreadyInBase: true, blockers: { ...NO, commit: [{ code: 'nothing_to_commit', message: 'Nothing to commit' }], merge: [{ code: 'already_in_base', message: 'Already in main' }] } });
    const { onLand } = show(completeRun(), { onLoadLanding: vi.fn(async () => [done]) });
    const close = await git().findByRole('button', { name: 'Close task' });
    expect(close.className).toContain('m-primary');
    fireEvent.click(close);
    expect(confirmation().getByText('The task is closed: its copy is removed and its terminals are closed.')).toBeTruthy();
    fireEvent.click(confirmation().getByRole('button', { name: 'Close task' }));
    await waitFor(() => expect(onLand).toHaveBeenCalledWith('close', TASK_ID, WORKTREE_ID, {}));
  });
  it('leaves a close that would delete ignored files to the desktop', async () => {
    show(completeRun(), { onLoadLanding: vi.fn(async () => [landing({ uncommitted: [], uncommittedCount: 0, alreadyInBase: true, ignoredAtRisk: ['.env.local'], ignoredAtRiskCount: 1,
      blockers: { ...NO, close: [{ code: 'ignored_files', message: 'Ignored files exist only here' }] } })]) });
    expect(await git().findByText('1 ignored file exists only in this copy (.env.local). Close it on the desktop.')).toBeTruthy();
    expect(git().queryByRole('button', { name: 'Close task' })).toBeNull();
  });
  it('names the repository on each action of a task with several', async () => {
    const backend = committedLanding({ worktreeId: '7b000000-0000-4000-8000-000000000002', repository: 'backend', own: false, first: false, worktreePath: '/work/t/backend' });
    show(completeRun(), { onLoadLanding: vi.fn(async () => [landing(), backend]) });
    expect(await git().findByRole('button', { name: 'Commit changes in p' })).toBeTruthy();
    expect(git().getByRole('button', { name: 'Merge backend into main' })).toBeTruthy();
    expect(git().getByRole('button', { name: 'Close backend' })).toBeTruthy();
    fireEvent.click(git().getByRole('button', { name: 'Merge backend into main' }));
    expect(confirmation().getByText('backend is merged into main in its own checkout. Its copy in this task is removed afterwards and the terminals in it are closed. The task stays open for its other repositories.')).toBeTruthy();
  });
  it('says when Git could not be read, and reads it again', async () => {
    const onLoadLanding = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce([landing()]);
    show(completeRun(), { onLoadLanding });
    expect(await git().findByText('How the task stands in Git could not be read.')).toBeTruthy();
    fireEvent.click(git().getByRole('button', { name: 'Refresh' }));
    expect(await git().findByText('2 uncommitted files')).toBeTruthy();
  });
  it('offers no landing while the run works, and none for a run in Main', async () => {
    show(run(), { onLoadLanding: vi.fn(async () => [landing({ runActive: true, blockers: { ...NO, commit: [{ code: 'run_active', message: 'A run is working' }], merge: [{ code: 'run_active', message: 'A run is working' }], pullRequest: [{ code: 'run_active', message: 'A run is working' }], close: [{ code: 'run_active', message: 'A run is working' }] } })]) });
    expect(await git().findByText('2 uncommitted files')).toBeTruthy();
    expect(git().queryAllByRole('button').map(button => button.textContent)).toEqual(['Refresh']);
    cleanup();
    const { onLoadLanding } = show(completeRun({ taskId: null }));
    expect(screen.queryByRole('region', { name: 'In Git' })).toBeNull();
    expect(onLoadLanding).not.toHaveBeenCalled();
  });
});
