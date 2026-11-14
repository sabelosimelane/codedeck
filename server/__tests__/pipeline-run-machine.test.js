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
    }))).toEqual(expected);
  });

  it('resume requires worktree_state not_created or present', () => {
    expect(computeActions(run({ status: 'interrupted', worktreeState: 'removed' })).resume).toBe(false);
    expect(computeActions(run({ status: 'error', error: 'x', worktreeState: 'removal_blocked', finishedAt: AT })).resume).toBe(false);
    expect(computeActions(run({ status: 'stopped', stopReason: 'user', worktreeState: 'not_created', finishedAt: AT })).resume).toBe(true);
  });

  it('an existing worktree the owner chose can be resumed, and the run released, but is never removable state', () => {
    expect(computeActions(run({ status: 'running', worktreeState: 'external' }))).toEqual({ stop: true, resume: false, continue: false, cleanup: false, answer: false });
    expect(computeActions(run({ status: 'stopped', stopReason: 'user', worktreeState: 'external', finishedAt: AT }))).toEqual({ stop: false, resume: true, continue: false, cleanup: true, answer: false });
    expect(computeActions(run({ status: 'error', error: 'x', worktreeState: 'external', finishedAt: AT }))).toEqual({ stop: false, resume: true, continue: false, cleanup: true, answer: false });
    expect(computeActions(run({ status: 'interrupted', worktreeState: 'external' }))).toEqual({ stop: true, resume: true, continue: false, cleanup: true, answer: false });
  });

  it('a released run offers neither resume nor cleanup', () => {
    expect(computeActions(run({ status: 'stopped', stopReason: 'user', worktreeState: 'released', finishedAt: AT }))).toEqual({ stop: false, resume: false, continue: false, cleanup: false, answer: false });
    expect(computeActions(run({ status: 'complete', worktreeState: 'released', finishedAt: AT }))).toEqual({ stop: false, resume: false, continue: false, cleanup: false, answer: false });
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
        steps: [step({ status: stepStatus })],
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
    expect(next.steps[0].status).toBe('limit_reached');
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
    expect(next.steps[0].status).toBe('limit_reached');
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
  const running = () => run({ status: 'running', steps: [step({ status: 'running', attempt: 1 })] });
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
