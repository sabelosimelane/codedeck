import { describe, expect, it } from 'vitest';
import { applyEvent, computeActions } from '../pipelines/run-machine.js';

const AT = '2026-11-13T12:00:00.000Z';

function step(overrides = {}) {
  return {
    status: 'pending',
    sessionId: null,
    priorSessionIds: [],
    attempt: 0,
    iteration: 0,
    detail: null,
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    status: 'pending',
    stopReason: null,
    error: null,
    currentStepIndex: 0,
    finishedAt: null,
    worktreeState: 'not_created',
    inputRequest: null,
    steps: [step()],
    ...overrides,
  };
}

describe('applyEvent — single-step run (Spec §5)', () => {
  it('keeps no_progress on Stop and clears it on Resume', () => {
    const running = run({ status: 'running', worktreeState: 'present', steps: [step({ status: 'running', sessionId: 'terminal-1', startedAt: AT })] });
    const stopped = applyEvent(running, { type: 'stop', reason: 'no_progress', at: AT });
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'no_progress' });
    expect(computeActions(stopped)).toMatchObject({ resume: true, cleanup: true });
    expect(applyEvent(stopped, { type: 'resume', newTerminal: false, at: AT }).stopReason).toBeNull();
    expect(() => applyEvent(running, { type: 'stop', reason: 'mystery', at: AT })).toThrow(/reason/);
  });
  it.each(['pending', 'running', 'needs_input', 'limit_paused', 'awaiting_approval', 'interrupted', 'stopped', 'error', 'complete'])
    ('accepts approval events only from their legal status: %s', status => {
      const state = run({ status, steps: [step({ status: status === 'awaiting_approval' ? 'awaiting_approval' : 'running', attempt: 1, sessionId: 'terminal-1', startedAt: AT })] });
      for (const [type, legal] of [['approval_requested', status === 'running'], ['approve', status === 'awaiting_approval'], ['send_back', status === 'awaiting_approval']]) {
        const event = { type, at: AT, newTerminal: false };
        if (legal) expect(() => applyEvent(state, event)).not.toThrow();
        else expect(() => applyEvent(state, event)).toThrow(/illegal transition/);
      }
    });
  it('requires a new terminal when sending back a step without a session', () => {
    const waiting = run({ status: 'awaiting_approval', steps: [step({ status: 'awaiting_approval', attempt: 1 })] });
    expect(() => applyEvent(waiting, { type: 'send_back', newTerminal: false, at: AT })).toThrow(/new one/);
    expect(applyEvent(waiting, { type: 'send_back', newTerminal: true, at: AT }).steps[0].attempt).toBe(2);
  });
  it('stops an approval wait and offers only approval, send-back and stop while waiting', () => {
    const waiting = run({ status: 'awaiting_approval', worktreeState: 'present', steps: [step({ status: 'awaiting_approval', attempt: 1 })] });
    expect(computeActions(waiting)).toMatchObject({ approve: true, sendBack: true, stop: true, resume: false, continue: false, answer: false });
    const stopped = applyEvent(waiting, { type: 'stop', at: AT });
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'user' });
  });
  it('pauses for approval, sends back a new attempt, and approves exactly once', () => {
    const running = applyEvent(applyEvent(run(), { type: 'start', at: AT }), { type: 'step_running' });
    const waiting = applyEvent(running, { type: 'approval_requested', at: AT });
    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.steps[0].status).toBe('awaiting_approval');
    expect(computeActions(waiting)).toMatchObject({ approve: true, sendBack: true, stop: true });
    expect(applyEvent(waiting, { type: 'approve', at: AT }).status).toBe('complete');
    expect(() => applyEvent(running, { type: 'approve' })).toThrow(/illegal transition/);
    expect(() => applyEvent(waiting, { type: 'approval_requested' })).toThrow(/illegal transition/);
    const back = applyEvent(waiting, { type: 'send_back', newTerminal: true, at: AT });
    expect(back.status).toBe('running');
    expect(back.steps[0]).toMatchObject({ status: 'launching', attempt: 2 });
  });
  it('does not mutate the input state', () => {
    const state = run();
    const frozen = structuredClone(state);
    applyEvent(state, { type: 'start', at: AT });
    expect(state).toEqual(frozen);
  });

  it('pending → running on start; current step pending → launching', () => {
    const next = applyEvent(run(), { type: 'start', at: AT });
    expect(next.status).toBe('running');
    expect(next.steps[0].status).toBe('launching');
    expect(next.steps[0].attempt).toBe(1);
    expect(next.steps[0].startedAt).toBe(AT);
    expect(next.finishedAt).toBeNull();
    expect(next.error).toBeNull();
  });

  it('step launching → running on step_running', () => {
    const started = applyEvent(run(), { type: 'start', at: AT });
    const next = applyEvent(started, { type: 'step_running' });
    expect(next.status).toBe('running');
    expect(next.steps[0].status).toBe('running');
  });

  it('running → complete when the only step completes', () => {
    let state = applyEvent(run(), { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    const next = applyEvent(state, { type: 'step_complete', at: AT });
    expect(next.status).toBe('complete');
    expect(next.steps[0].status).toBe('complete');
    expect(next.steps[0].finishedAt).toBe(AT);
    expect(next.finishedAt).toBe(AT);
  });

  it('pending → error on error (e.g. worktree create failed)', () => {
    const next = applyEvent(run(), { type: 'error', error: 'git worktree add failed', at: AT });
    expect(next.status).toBe('error');
    expect(next.error).toBe('git worktree add failed');
    expect(next.finishedAt).toBe(AT);
    expect(next.steps[0].status).toBe('pending');
  });

  it('running → error on error; current step → failed', () => {
    let state = applyEvent(run(), { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    const next = applyEvent(state, {
      type: 'error',
      error: 'The launch command for agent codex exited.',
      at: AT,
    });
    expect(next.status).toBe('error');
    expect(next.error).toBe('The launch command for agent codex exited.');
    expect(next.steps[0].status).toBe('failed');
    expect(next.steps[0].finishedAt).toBe(AT);
    expect(next.finishedAt).toBe(AT);
  });

  it('running → needs_input → running round trip', () => {
    let state = applyEvent(run(), { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    state = applyEvent(state, { type: 'needs_input', inputRequest: null });
    expect(state.status).toBe('needs_input');
    expect(state.steps[0].status).toBe('needs_input');

    state = applyEvent(state, { type: 'input_received' });
    expect(state.status).toBe('running');
    expect(state.steps[0].status).toBe('running');
  });

  it('needs_input → error', () => {
    let state = applyEvent(run(), { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    state = applyEvent(state, { type: 'needs_input', inputRequest: null });
    const next = applyEvent(state, { type: 'error', error: 'terminal closed', at: AT });
    expect(next.status).toBe('error');
    expect(next.error).toBe('terminal closed');
    expect(next.steps[0].status).toBe('failed');
    expect(next.finishedAt).toBe(AT);
  });

  it('limit_paused → error (e.g. Setup dirty on Continue)', () => {
    let state = applyEvent(run(), { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    state = applyEvent(state, { type: 'limit_reached', at: AT });
    const next = applyEvent(state, {
      type: 'error',
      error: 'Setup left uncommitted changes in the worktree\ntmp.out',
      at: AT,
    });
    expect(next.status).toBe('error');
    expect(next.steps[0].status).toBe('failed');
    expect(next.finishedAt).toBe(AT);
  });

  it('running → limit_paused when the step hits its pass limit', () => {
    let state = applyEvent(run(), { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    const next = applyEvent(state, { type: 'limit_reached', at: AT });
    expect(next.status).toBe('limit_paused');
    expect(next.steps[0].status).toBe('limit_reached');
    expect(next.steps[0].finishedAt).toBe(AT);
    expect(next.finishedAt).toBeNull();
  });

  it('rejects unknown events', () => {
    expect(() => applyEvent(run(), { type: 'nope' })).toThrow(/unknown event/i);
  });

  it('rejects illegal transitions', () => {
    expect(() => applyEvent(run(), { type: 'step_complete' })).toThrow(/illegal/i);
    expect(() => applyEvent(run({ status: 'complete', finishedAt: AT, steps: [step({ status: 'complete' })] }), { type: 'start' }))
      .toThrow(/illegal/i);
  });
});

describe('computeActions (Spec §8.8)', () => {
  it.each([
    ['pending', { stop: true, resume: false, continue: false, cleanup: false, answer: false }],
    ['running', { stop: true, resume: false, continue: false, cleanup: false, answer: false }],
    ['needs_input', { stop: true, resume: false, continue: false, cleanup: false, answer: false }],
    ['limit_paused', { stop: true, resume: false, continue: true, cleanup: false, answer: false }],
    ['interrupted', { stop: true, resume: true, continue: false, cleanup: true, answer: false }],
    ['stopped', { stop: false, resume: true, continue: false, cleanup: true, answer: false }],
    ['error', { stop: false, resume: true, continue: false, cleanup: true, answer: false }],
    ['complete', { stop: false, resume: false, continue: false, cleanup: true, answer: false }],
  ])('status %s → %j when worktree is present', (status, expected) => {
    expect(computeActions(run({
      status,
      worktreeState: 'present',
      stopReason: status === 'stopped' ? 'user' : null,
      error: status === 'error' ? 'boom' : null,
      finishedAt: ['complete', 'stopped', 'error'].includes(status) ? AT : null,
      steps: [step({
        status: status === 'limit_paused' ? 'limit_reached'
          : status === 'needs_input' ? 'needs_input'
          : status === 'complete' ? 'complete'
          : status === 'error' ? 'failed'
          : status === 'interrupted' ? 'interrupted'
          : status === 'stopped' ? 'stopped'
          : status === 'running' ? 'running'
          : 'pending',
      })],
    }))).toMatchObject(expected);
  });

  it('resume requires worktree_state not_created or present', () => {
    expect(computeActions(run({ status: 'interrupted', worktreeState: 'removed' })).resume).toBe(false);
    expect(computeActions(run({ status: 'error', error: 'x', worktreeState: 'removal_blocked', finishedAt: AT })).resume).toBe(false);
    expect(computeActions(run({ status: 'stopped', stopReason: 'user', worktreeState: 'not_created', finishedAt: AT })).resume).toBe(true);
  });

  it('an existing worktree the owner chose can be resumed, and the run released, but is never removable state', () => {
    expect(computeActions(run({ status: 'running', worktreeState: 'external' }))).toMatchObject({ stop: true, resume: false, continue: false, cleanup: false, answer: false });
    expect(computeActions(run({ status: 'stopped', stopReason: 'user', worktreeState: 'external', finishedAt: AT }))).toMatchObject({ stop: false, resume: true, continue: false, cleanup: true, answer: false });
    expect(computeActions(run({ status: 'error', error: 'x', worktreeState: 'external', finishedAt: AT }))).toMatchObject({ stop: false, resume: true, continue: false, cleanup: true, answer: false });
    expect(computeActions(run({ status: 'interrupted', worktreeState: 'external' }))).toMatchObject({ stop: true, resume: true, continue: false, cleanup: true, answer: false });
  });

  it('a released run offers neither resume nor cleanup', () => {
    expect(computeActions(run({ status: 'stopped', stopReason: 'user', worktreeState: 'released', finishedAt: AT }))).toMatchObject({ stop: false, resume: false, continue: false, cleanup: false, answer: false });
    expect(computeActions(run({ status: 'complete', worktreeState: 'released', finishedAt: AT }))).toMatchObject({ stop: false, resume: false, continue: false, cleanup: false, answer: false });
  });

  it('allows Resume for a released run only after its task worktree was checked for reclaim', () => {
    expect(computeActions(run({ status: 'interrupted', worktreeState: 'released', taskId: 'task-1' })).resume).toBe(false);
    expect(computeActions(run({ status: 'interrupted', worktreeState: 'released', taskId: 'task-1', reclaimableTaskWorktree: true })).resume).toBe(true);
    expect(computeActions(run({ status: 'complete', worktreeState: 'released', taskId: 'task-1', reclaimableTaskWorktree: true })).resume).toBe(false);
  });

  it('resumes a stopped run in an existing worktree', () => {
    const stopped = run({
      status: 'stopped', stopReason: 'user', worktreeState: 'external', finishedAt: AT,
      steps: [{ ...run().steps[0], status: 'stopped', sessionId: 'Demo-1', attempt: 1, startedAt: AT, finishedAt: AT }],
    });
    expect(applyEvent(stopped, { type: 'resume', newTerminal: false, at: AT }).status).toBe('running');
  });

  it('cleanup allowed for terminal/interrupted statuses with removable worktree states', () => {
    expect(computeActions(run({ status: 'complete', worktreeState: 'not_created', finishedAt: AT })).cleanup).toBe(true);
    expect(computeActions(run({ status: 'complete', worktreeState: 'present', finishedAt: AT })).cleanup).toBe(true);
    expect(computeActions(run({ status: 'complete', worktreeState: 'removal_blocked', finishedAt: AT })).cleanup).toBe(true);
    expect(computeActions(run({ status: 'complete', worktreeState: 'removed', finishedAt: AT })).cleanup).toBe(false);
    expect(computeActions(run({ status: 'running', worktreeState: 'present' })).cleanup).toBe(false);
  });
});

describe('applyEvent — multi-step, stop, resume, continue, terminal (Spec §5, §8.6–§8.8)', () => {
  function twoStepRunning() {
    let state = run({
      worktreeState: 'present',
      steps: [step(), step()],
    });
    state = applyEvent(state, { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    return state;
  }

  it('step_complete advances to the next pending step when more steps remain', () => {
    const next = applyEvent(twoStepRunning(), { type: 'step_complete', at: AT });
    expect(next.status).toBe('running');
    expect(next.currentStepIndex).toBe(1);
    expect(next.steps[0].status).toBe('complete');
    expect(next.steps[0].finishedAt).toBe(AT);
    expect(next.steps[1].status).toBe('pending');
    expect(next.finishedAt).toBeNull();
  });

  it('start launches the next pending step while the run is already running', () => {
    let state = applyEvent(twoStepRunning(), { type: 'step_complete', at: AT });
    state = applyEvent(state, { type: 'start', at: AT });
    expect(state.status).toBe('running');
    expect(state.currentStepIndex).toBe(1);
    expect(state.steps[1].status).toBe('launching');
    expect(state.steps[1].attempt).toBe(1);
    expect(state.steps[1].startedAt).toBe(AT);
  });

  it('stop from running → stopped with stop_reason=user; current step → stopped', () => {
    const next = applyEvent(twoStepRunning(), { type: 'stop', reason: 'user', at: AT });
    expect(next.status).toBe('stopped');
    expect(next.stopReason).toBe('user');
    expect(next.finishedAt).toBe(AT);
    expect(next.error).toBeNull();
    expect(next.steps[0].status).toBe('stopped');
    expect(next.steps[0].finishedAt).toBe(AT);
  });

  it('stop from pending marks the current pending step stopped', () => {
    const next = applyEvent(run({ worktreeState: 'not_created' }), { type: 'stop', reason: 'user', at: AT });
    expect(next.status).toBe('stopped');
    expect(next.steps[0].status).toBe('stopped');
    expect(next.steps[0].finishedAt).toBe(AT);
  });

  it.each(['pending', 'needs_input', 'limit_paused', 'interrupted'])(
    'stop from %s → stopped with stop_reason=user',
    (status) => {
      const stepStatus = status === 'limit_paused' ? 'limit_reached'
        : status === 'needs_input' ? 'needs_input'
          : status === 'interrupted' ? 'interrupted'
            : status === 'pending' ? 'pending'
              : 'running';
      const next = applyEvent(run({
        status,
        worktreeState: 'present',
        stopReason: null,
        steps: [step({ status: stepStatus, startedAt: AT })],
      }), { type: 'stop', reason: 'user', at: AT });
      expect(next.status).toBe('stopped');
      expect(next.stopReason).toBe('user');
      expect(next.finishedAt).toBe(AT);
    },
  );

  it('stop is refused from complete and error', () => {
    expect(() => applyEvent(run({
      status: 'complete',
      finishedAt: AT,
      steps: [step({ status: 'complete' })],
    }), { type: 'stop', reason: 'user' })).toThrow(/illegal/i);
    expect(() => applyEvent(run({
      status: 'error',
      error: 'boom',
      finishedAt: AT,
      steps: [step({ status: 'failed' })],
    }), { type: 'stop', reason: 'user' })).toThrow(/illegal/i);
  });

  it('terminal stop from running → stopped with stop_reason=terminal', () => {
    const next = applyEvent(twoStepRunning(), { type: 'stop', reason: 'terminal', at: AT });
    expect(next.status).toBe('stopped');
    expect(next.stopReason).toBe('terminal');
    expect(next.steps[0].status).toBe('stopped');
    expect(next.finishedAt).toBe(AT);
  });

  it('continue from limit_paused advances to the next step when more remain', () => {
    let state = twoStepRunning();
    state = applyEvent(state, { type: 'limit_reached', at: AT });
    expect(state.status).toBe('limit_paused');
    const next = applyEvent(state, { type: 'continue', at: AT });
    expect(next.status).toBe('running');
    expect(next.currentStepIndex).toBe(1);
    // The owner accepted the limit: the step is over, and says how it ended.
    expect(next.steps[0].status).toBe('limit_accepted');
    expect(next.steps[1].status).toBe('pending');
    expect(next.finishedAt).toBeNull();
  });

  it('continue from limit_paused on the last step completes the run', () => {
    let state = applyEvent(run({ worktreeState: 'present' }), { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    state = applyEvent(state, { type: 'limit_reached', at: AT });
    const next = applyEvent(state, { type: 'continue', at: AT });
    expect(next.status).toBe('complete');
    expect(next.currentStepIndex).toBe(0);
    expect(next.steps[0].status).toBe('limit_accepted');
    expect(next.finishedAt).toBe(AT);
  });

  it('continue is refused outside limit_paused', () => {
    expect(() => applyEvent(twoStepRunning(), { type: 'continue' })).toThrow(/illegal/i);
  });

  it('resume keeps the step in its terminal when that terminal can still be used', () => {
    const next = applyEvent(run({
      status: 'stopped',
      stopReason: 'user',
      finishedAt: AT,
      worktreeState: 'present',
      steps: [step({
        status: 'stopped',
        sessionId: 'Demo-2',
        priorSessionIds: ['Demo-1'],
        attempt: 1,
        iteration: 3,
        finishedAt: AT,
      })],
    }), { type: 'resume', newTerminal: false, at: AT });
    expect(next.status).toBe('running');
    expect(next.stopReason).toBeNull();
    expect(next.finishedAt).toBeNull();
    expect(next.steps[0]).toMatchObject({
      status: 'launching',
      sessionId: 'Demo-2',
      priorSessionIds: ['Demo-1'],
      attempt: 2,
      iteration: 0,
      startedAt: AT,
      finishedAt: null,
    });
  });

  it('resume refuses to keep a terminal the step never had', () => {
    expect(() => applyEvent(run({
      status: 'interrupted',
      worktreeState: 'present',
      steps: [step({ status: 'interrupted', sessionId: null, attempt: 1 })],
    }), { type: 'resume', newTerminal: false, at: AT })).toThrow('resume event: a step without a terminal needs a new one');
  });

  it.each([undefined, null, 'yes', 1])('resume requires newTerminal to be a boolean (%s)', (newTerminal) => {
    expect(() => applyEvent(run({
      status: 'interrupted',
      worktreeState: 'present',
      steps: [step({ status: 'interrupted', sessionId: 'Demo-1', attempt: 1 })],
    }), { type: 'resume', newTerminal, at: AT })).toThrow('resume event: newTerminal must be true or false');
  });

  it('resume into a new terminal moves sessionId to priorSessionIds and relaunches the step', () => {
    const next = applyEvent(run({
      status: 'interrupted',
      worktreeState: 'present',
      steps: [step({
        status: 'interrupted',
        sessionId: 'Demo-1',
        priorSessionIds: [],
        attempt: 1,
        iteration: 4,
      })],
    }), { type: 'resume', newTerminal: true, at: AT });
    expect(next.status).toBe('running');
    expect(next.stopReason).toBeNull();
    expect(next.error).toBeNull();
    expect(next.finishedAt).toBeNull();
    expect(next.steps[0].status).toBe('launching');
    expect(next.steps[0].attempt).toBe(2);
    expect(next.steps[0].iteration).toBe(0);
    expect(next.steps[0].sessionId).toBeNull();
    expect(next.steps[0].priorSessionIds).toEqual(['Demo-1']);
    expect(next.steps[0].startedAt).toBe(AT);
    expect(next.steps[0].finishedAt).toBeNull();
  });

  it.each(['stopped', 'error'])('resume from %s into a new terminal relaunches the current step', (status) => {
    const next = applyEvent(run({
      status,
      stopReason: status === 'stopped' ? 'user' : null,
      error: status === 'error' ? 'boom' : null,
      finishedAt: AT,
      worktreeState: 'present',
      steps: [step({
        status: status === 'stopped' ? 'stopped' : 'failed',
        sessionId: 'Demo-2',
        priorSessionIds: ['Demo-1'],
        attempt: 1,
        finishedAt: AT,
      })],
    }), { type: 'resume', newTerminal: true, at: AT });
    expect(next.status).toBe('running');
    expect(next.steps[0].status).toBe('launching');
    expect(next.steps[0].attempt).toBe(2);
    expect(next.steps[0].priorSessionIds).toEqual(['Demo-1', 'Demo-2']);
    expect(next.steps[0].sessionId).toBeNull();
    expect(next.finishedAt).toBeNull();
    expect(next.error).toBeNull();
    expect(next.stopReason).toBeNull();
  });

  it('resume is refused when worktree is removed or removal_blocked', () => {
    expect(() => applyEvent(run({
      status: 'interrupted',
      worktreeState: 'removed',
      steps: [step({ status: 'interrupted' })],
    }), { type: 'resume' })).toThrow(/illegal/i);
    expect(() => applyEvent(run({
      status: 'error',
      error: 'x',
      finishedAt: AT,
      worktreeState: 'removal_blocked',
      steps: [step({ status: 'failed' })],
    }), { type: 'resume' })).toThrow(/illegal/i);
  });

  it('resume is refused from running and limit_paused', () => {
    expect(() => applyEvent(twoStepRunning(), { type: 'resume' })).toThrow(/illegal/i);
    expect(() => applyEvent(run({
      status: 'limit_paused',
      worktreeState: 'present',
      steps: [step({ status: 'limit_reached' })],
    }), { type: 'resume' })).toThrow(/illegal/i);
  });

  it('stop from limit_paused keeps the step as limit_reached', () => {
    let state = applyEvent(run({ worktreeState: 'present' }), { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    state = applyEvent(state, { type: 'limit_reached', at: AT });
    const next = applyEvent(state, { type: 'stop', reason: 'user', at: AT });
    expect(next.status).toBe('stopped');
    expect(next.stopReason).toBe('user');
    expect(next.steps[0].status).toBe('limit_reached');
  });
});

describe('input request (what the agent is waiting for)', () => {
  const running = () => run({ status: 'running', steps: [step({ status: 'running', attempt: 1, startedAt: AT })] });
  const asked = { questions: '1. Which schema?\nRecommended: the existing one.', truncated: false };

  it('keeps the request of a needs_input event on the run', () => {
    const next = applyEvent(running(), { type: 'needs_input', inputRequest: asked });
    expect(next.status).toBe('needs_input');
    expect(next.inputRequest).toEqual(asked);
  });

  it('keeps a null request for a dialog the agent shows while launching', () => {
    const launching = run({ status: 'running', steps: [step({ status: 'launching', attempt: 1 })] });
    expect(applyEvent(launching, { type: 'needs_input', inputRequest: null }).inputRequest).toBeNull();
  });

  it('refuses a needs_input event that does not say whether the agent asked', () => {
    expect(() => applyEvent(running(), { type: 'needs_input' })).toThrow('needs_input event: inputRequest is required');
  });

  it.each([
    ['input_received', { type: 'input_received' }],
    ['stop', { type: 'stop', reason: 'user', at: AT }],
    ['error', { type: 'error', error: 'boom', at: AT }],
  ])('drops the request on %s', (_label, event) => {
    const waiting = applyEvent(running(), { type: 'needs_input', inputRequest: asked });
    expect(applyEvent(waiting, event).inputRequest).toBeNull();
  });

  it('allows an answer only while the run waits on a request the agent signalled', () => {
    const waiting = applyEvent(running(), { type: 'needs_input', inputRequest: asked });
    expect(computeActions(waiting).answer).toBe(true);
    expect(computeActions(applyEvent(running(), { type: 'needs_input', inputRequest: { questions: null, truncated: false } })).answer).toBe(true);
    expect(computeActions(applyEvent(running(), { type: 'needs_input', inputRequest: null })).answer).toBe(false);
    expect(computeActions(running()).answer).toBe(false);
    expect(computeActions(run({ status: 'limit_paused', steps: [step({ status: 'limit_reached' })] })).answer).toBe(false);
  });
});

describe('loop back (a step sends the run back to an earlier step)', () => {
  const done = (overrides = {}) => step({ status: 'complete', sessionId: 'Demo-1', attempt: 1, iteration: 1, startedAt: AT, finishedAt: AT, roundsCompleted: 0, ...overrides });
  // Setup, Develop, Test (loops back to Develop), Review — Test has just finished a pass.
  const looping = (overrides = {}) => run({
    status: 'running',
    currentStepIndex: 2,
    steps: [
      done({ sessionId: 'Demo-1' }),
      done({ sessionId: 'Demo-2', priorSessionIds: ['Demo-9'] }),
      step({ status: 'running', sessionId: 'Demo-3', attempt: 1, iteration: 1, startedAt: AT, roundsCompleted: 0 }),
      step({ roundsCompleted: 0 }),
    ],
    ...overrides,
  });
  const LATER = '2026-11-13T12:30:00.000Z';

  it('makes the steps of the loop pending again and continues at its first step', () => {
    const next = applyEvent(looping(), { type: 'loop_back', toStepIndex: 1, at: LATER });
    expect(next.status).toBe('running');
    expect(next.currentStepIndex).toBe(1);
    expect(next.steps.map(s => s.status)).toEqual(['complete', 'pending', 'pending', 'pending']);
    expect(next.finishedAt).toBeNull();
  });

  it('counts the finished round on the step that loops back, and only there', () => {
    const next = applyEvent(looping(), { type: 'loop_back', toStepIndex: 1, at: LATER });
    expect(next.steps.map(s => s.roundsCompleted)).toEqual([0, 0, 1, 0]);
    const again = applyEvent(
      { ...next, currentStepIndex: 2, steps: next.steps.map((s, i) => (i === 2 ? { ...s, status: 'running' } : i === 1 ? { ...s, status: 'complete' } : s)) },
      { type: 'loop_back', toStepIndex: 1, at: LATER },
    );
    expect(again.steps[2].roundsCompleted).toBe(2);
  });

  it('keeps each step in its terminal: sessions, earlier sessions and attempts stay, passes start over', () => {
    const next = applyEvent(looping(), { type: 'loop_back', toStepIndex: 1, at: LATER });
    expect(next.steps[1]).toMatchObject({ sessionId: 'Demo-2', priorSessionIds: ['Demo-9'], attempt: 1, iteration: 0, finishedAt: null });
    expect(next.steps[2]).toMatchObject({ sessionId: 'Demo-3', attempt: 1, iteration: 0, finishedAt: null });
    // A step before the loop is not touched.
    expect(next.steps[0]).toEqual(looping().steps[0]);
  });

  it('lets the first step of the loop start again', () => {
    const back = applyEvent(looping(), { type: 'loop_back', toStepIndex: 1, at: LATER });
    const started = applyEvent(back, { type: 'start', at: LATER });
    expect(started.steps[1]).toMatchObject({ status: 'launching', attempt: 2, sessionId: 'Demo-2', startedAt: LATER });
  });

  it('does not mutate the input state', () => {
    const state = looping();
    const frozen = structuredClone(state);
    applyEvent(state, { type: 'loop_back', toStepIndex: 1, at: LATER });
    expect(state).toEqual(frozen);
  });

  it.each([
    ['its own index', 2],
    ['a later index', 3],
    ['a negative index', -1],
    ['a fractional index', 0.5],
    ['no index', undefined],
    ['a string', '1'],
  ])('throws on %s', (_label, toStepIndex) => {
    expect(() => applyEvent(looping(), { type: 'loop_back', toStepIndex })).toThrow('loop_back event: toStepIndex must be the index of an earlier step');
  });

  it.each(['pending', 'needs_input', 'limit_paused', 'interrupted', 'stopped', 'error', 'complete'])('is illegal while the run is %s', (status) => {
    expect(() => applyEvent(looping({ status }), { type: 'loop_back', toStepIndex: 1 })).toThrow(`illegal transition: ${status} + loop_back`);
  });

  it.each(['pending', 'launching', 'needs_input', 'complete', 'limit_reached'])('is illegal while the current step is %s', (status) => {
    const state = looping();
    state.steps[2] = { ...state.steps[2], status };
    expect(() => applyEvent(state, { type: 'loop_back', toStepIndex: 1 })).toThrow(`illegal transition: step:${status} + loop_back`);
  });

  it('keeps the completed rounds when the run is resumed', () => {
    const state = looping({ status: 'interrupted', worktreeState: 'present' });
    state.steps[2] = { ...state.steps[2], status: 'interrupted', roundsCompleted: 4 };
    const resumed = applyEvent(state, { type: 'resume', newTerminal: true, at: LATER });
    expect(resumed.steps[2]).toMatchObject({ status: 'launching', roundsCompleted: 4, iteration: 0, sessionId: null });
  });
});

describe('applyEvent — the time a step has worked', () => {
  const at = seconds => new Date(Date.UTC(2026, 10, 19, 10, 0, 0) + seconds * 1000).toISOString();
  const working = (overrides = {}) => step({ status: 'running', sessionId: 'Demo-1', attempt: 1, iteration: 1, startedAt: at(0), roundsCompleted: 0, ...overrides });
  const one = (stepOverrides, runOverrides = {}) => run({ status: 'running', worktreeState: 'present', steps: [working(stepOverrides)], ...runOverrides });

  it('adds the time from a step\'s start to its end when it completes', () => {
    const next = applyEvent(one(), { type: 'step_complete', at: at(252) });
    expect(next.steps[0]).toMatchObject({ status: 'complete', elapsedMs: 252000, finishedAt: at(252) });
  });

  it('keeps what earlier starts took and adds the new one', () => {
    const next = applyEvent(one({ elapsedMs: 60000, startedAt: at(100) }), { type: 'step_complete', at: at(130) });
    expect(next.steps[0].elapsedMs).toBe(90000);
  });

  it('counts the wait for an answer, and not the wait for an approval', () => {
    const asked = applyEvent(one(), { type: 'needs_input', inputRequest: null, at: at(10) });
    const answered = applyEvent(asked, { type: 'input_received', at: at(70) });
    const requested = applyEvent(answered, { type: 'approval_requested', at: at(100) });
    expect(requested.steps[0].elapsedMs).toBe(100000);
    const approved = applyEvent(requested, { type: 'approve', at: at(5000) });
    expect(approved.steps[0]).toMatchObject({ status: 'complete', elapsedMs: 100000 });
  });

  it('adds the new attempt after the owner sends a step back', () => {
    const requested = applyEvent(one(), { type: 'approval_requested', at: at(100) });
    const sentBack = applyEvent(requested, { type: 'send_back', newTerminal: false, at: at(900) });
    expect(sentBack.steps[0]).toMatchObject({ status: 'launching', elapsedMs: 100000, startedAt: at(900), finishedAt: null });
    const running = applyEvent(sentBack, { type: 'step_running', at: at(905) });
    expect(applyEvent(running, { type: 'approval_requested', at: at(950) }).steps[0].elapsedMs).toBe(150000);
  });

  it('adds every round of a loop, for the step that closes it and the steps inside it', () => {
    const loop = run({ status: 'running', worktreeState: 'present', currentStepIndex: 1, steps: [
      step({ status: 'complete', sessionId: 'Demo-1', attempt: 1, iteration: 1, startedAt: at(0), finishedAt: at(40), elapsedMs: 40000, roundsCompleted: 0 }),
      working({ sessionId: 'Demo-2', startedAt: at(40) }),
    ] });
    const back = applyEvent(loop, { type: 'loop_back', toStepIndex: 0, at: at(100) });
    expect(back.steps.map(s => [s.status, s.elapsedMs, s.finishedAt])).toEqual([['pending', 40000, null], ['pending', 60000, null]]);
    // Stopping a run whose step waits for its next round adds nothing: nothing was working in it.
    expect(applyEvent(back, { type: 'stop', at: at(9000) }).steps[0].elapsedMs).toBe(40000);
    const second = applyEvent(applyEvent(back, { type: 'start', at: at(100) }), { type: 'step_running', at: at(101) });
    const done = applyEvent(second, { type: 'step_complete', at: at(130) });
    expect(done.steps[0].elapsedMs).toBe(70000);
  });

  it('adds the time up to a limit, a failure and a stop, once', () => {
    const limited = applyEvent(one(), { type: 'limit_reached', at: at(30) });
    expect(limited.steps[0].elapsedMs).toBe(30000);
    expect(applyEvent(limited, { type: 'continue', at: at(999) }).steps[0]).toMatchObject({ status: 'limit_accepted', elapsedMs: 30000 });
    expect(applyEvent(limited, { type: 'stop', at: at(999) }).steps[0].elapsedMs).toBe(30000);
    expect(applyEvent(limited, { type: 'error', error: 'x', at: at(999) }).steps[0]).toMatchObject({ status: 'failed', elapsedMs: 30000 });
    expect(applyEvent(one(), { type: 'error', error: 'x', at: at(20) }).steps[0]).toMatchObject({ status: 'failed', elapsedMs: 20000 });
    const stopped = applyEvent(one(), { type: 'stop', at: at(45) });
    expect(stopped.steps[0]).toMatchObject({ status: 'stopped', elapsedMs: 45000 });
    const resumed = applyEvent(stopped, { type: 'resume', newTerminal: false, at: at(500) });
    expect(resumed.steps[0]).toMatchObject({ status: 'launching', elapsedMs: 45000, startedAt: at(500) });
  });

  it('does not count the time a step lay interrupted', () => {
    const interrupted = one({ status: 'interrupted' }, { status: 'interrupted' });
    expect(applyEvent(interrupted, { type: 'stop', at: at(9000) }).steps[0].elapsedMs).toBe(0);
    const resumed = applyEvent(interrupted, { type: 'resume', newTerminal: false, at: at(9000) });
    const done = applyEvent(applyEvent(resumed, { type: 'step_running', at: at(9001) }), { type: 'step_complete', at: at(9030) });
    expect(done.steps[0].elapsedMs).toBe(30000);
  });

  it('fails loudly on a step without a usable count, a start or an end time', () => {
    expect(() => applyEvent(one({ elapsedMs: undefined }), { type: 'step_complete', at: at(5) })).toThrow('step time: elapsedMs must be an integer ≥ 0');
    expect(() => applyEvent(one({ elapsedMs: -1 }), { type: 'step_complete', at: at(5) })).toThrow('step time: elapsedMs must be an integer ≥ 0');
    expect(() => applyEvent(one({ startedAt: null }), { type: 'step_complete', at: at(5) })).toThrow('step time: a working step must have a start time');
    expect(() => applyEvent(one(), { type: 'step_complete' })).toThrow('step time: the event must say when it happened');
    expect(() => applyEvent(one(), { type: 'step_complete', at: at(-5) })).toThrow('step time: the step ends before it started');
  });
});

it('switches a completed step to its queued agent only when another loop round begins', () => {
  const agent = { id: 'old', launchCommand: 'old' };
  const nextAgent = { id: 'new', launchCommand: 'new' };
  const state = run({ status: 'running', currentStepIndex: 1,
    definition: { steps: [{ agent, nextAgent }, { agent }] },
    steps: [step({ status: 'complete', sessionId: 'Demo-1' }), step({ status: 'running', startedAt: AT, roundsCompleted: 0 })] });
  const next = applyEvent(state, { type: 'loop_back', toStepIndex: 0, at: AT });
  expect(next.definition.steps[0]).toEqual({ agent: nextAgent });
  expect(next.steps[0]).toMatchObject({ sessionId: null, priorSessionIds: ['Demo-1'] });
  expect(state.definition.steps[0].agent).toBe(agent);
});

describe('agent_restarted (the agent of a running step is started again in its terminal)', () => {
  const working = () => run({ status: 'running', worktreeState: 'present', steps: [step({ status: 'running', sessionId: 'terminal-1', attempt: 3, iteration: 1, startedAt: AT, elapsedMs: 5000 })] });

  it('relaunches the step in its terminal as a new attempt, its clock still running', () => {
    const next = applyEvent(working(), { type: 'agent_restarted' });
    expect(next.status).toBe('running');
    expect(next.steps[0]).toMatchObject({ status: 'launching', sessionId: 'terminal-1', attempt: 4, iteration: 0, startedAt: AT, elapsedMs: 5000, finishedAt: null });
  });

  it.each(['pending', 'needs_input', 'limit_paused', 'awaiting_approval', 'interrupted', 'stopped', 'error', 'complete'])
    ('is illegal while the run is %s', status => {
      expect(() => applyEvent(run({ status, steps: [step({ status: 'running', sessionId: 'terminal-1', startedAt: AT })] }), { type: 'agent_restarted' }))
        .toThrow(/illegal transition/);
    });

  it('is illegal for a step that is not running in a terminal', () => {
    expect(() => applyEvent(run({ status: 'running', steps: [step({ status: 'launching', sessionId: 'terminal-1', startedAt: AT })] }), { type: 'agent_restarted' }))
      .toThrow(/illegal transition/);
    expect(() => applyEvent(run({ status: 'running', steps: [step({ status: 'running', sessionId: null, startedAt: AT })] }), { type: 'agent_restarted' }))
      .toThrow('agent_restarted event: the step has no terminal to restart its agent in');
  });
});
