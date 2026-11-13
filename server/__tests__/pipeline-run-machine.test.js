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
    state = applyEvent(state, { type: 'needs_input' });
    expect(state.status).toBe('needs_input');
    expect(state.steps[0].status).toBe('needs_input');

    state = applyEvent(state, { type: 'input_received' });
    expect(state.status).toBe('running');
    expect(state.steps[0].status).toBe('running');
  });

  it('needs_input → error', () => {
    let state = applyEvent(run(), { type: 'start', at: AT });
    state = applyEvent(state, { type: 'step_running' });
    state = applyEvent(state, { type: 'needs_input' });
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
    ['pending', { stop: true, resume: false, continue: false, cleanup: false }],
    ['running', { stop: true, resume: false, continue: false, cleanup: false }],
    ['needs_input', { stop: true, resume: false, continue: false, cleanup: false }],
    ['limit_paused', { stop: true, resume: false, continue: true, cleanup: false }],
    ['interrupted', { stop: true, resume: true, continue: false, cleanup: true }],
    ['stopped', { stop: false, resume: true, continue: false, cleanup: true }],
    ['error', { stop: false, resume: true, continue: false, cleanup: true }],
    ['complete', { stop: false, resume: false, continue: false, cleanup: true }],
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

  it('resume from interrupted moves sessionId to priorSessionIds and relaunches the step', () => {
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
    }), { type: 'resume', at: AT });
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

  it.each(['stopped', 'error'])('resume from %s relaunches the current step', (status) => {
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
    }), { type: 'resume', at: AT });
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
