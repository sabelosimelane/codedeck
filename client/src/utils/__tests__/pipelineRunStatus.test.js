import { describe, expect, it } from 'vitest';
import { describeRunStatus, describeStepState, describeStepProgress } from '../pipelineRunStatus';

describe('describeRunStatus', () => {
  it('shows a no-progress stop as waiting for the owner', () => {
    expect(describeRunStatus({ status: 'stopped', stopReason: 'no_progress', actions: { resume: true } }))
      .toEqual({ label: 'Stopped: no progress', tone: 'waiting', primaryAction: 'resume', needsOwner: true });
  });
  it('says when a run stopped because its terminal was closed, and counts it as needing the owner', () => {
    expect(describeRunStatus({ status: 'stopped', stopReason: 'terminal', actions: { resume: true } }))
      .toEqual({ label: 'Stopped: terminal closed', tone: 'waiting', primaryAction: 'resume', needsOwner: true });
  });
  it('highlights nothing on a run that finished in a task or in Main: what comes next is landing the task', () => {
    expect(describeRunStatus({ status: 'complete', actions: { cleanup: true }, worktree: { state: 'external' } }))
      .toEqual({ label: 'Complete', tone: 'done', primaryAction: null, needsOwner: false });
    expect(describeRunStatus({ status: 'complete', actions: { cleanup: true }, worktree: { state: 'removal_blocked' } }).primaryAction).toBe('cleanup');
  });
  it.each([
    ['pending', 'Starting', 'neutral', null, false], ['running', 'Running', 'active', null, false],
    ['needs_input', 'Needs your input', 'waiting', 'answer', true],
    ['limit_paused', 'Paused at its limit', 'waiting', 'continue', true],
    ['awaiting_approval', 'Waiting for your approval', 'waiting', 'approve', true],
    ['interrupted', 'Interrupted', 'waiting', 'resume', true],
    ['stopped', 'Stopped', 'neutral', 'resume', false], ['error', 'Failed', 'danger', 'resume', true],
    ['complete', 'Complete', 'done', 'cleanup', false],
  ])('%s description, offered action and whether it needs the owner', (status, label, tone, action, needsOwner) => {
    expect(describeRunStatus({ status, actions: action ? { [action]: true } : {} }))
      .toEqual({ label, tone, primaryAction: action, needsOwner });
    if (action) expect(describeRunStatus({ status, actions: {} }).primaryAction).toBeNull();
  });
  it('rejects unknown and malformed statuses', () => {
    expect(() => describeRunStatus({ status: 'mystery', actions: {} })).toThrow(/status/);
    expect(() => describeRunStatus(null)).toThrow(/run/);
  });
});

describe('describeStepState', () => {
  it.each([
    ['complete', false, 'done'], ['limit_accepted', false, 'done'], ['limit_accepted', true, 'done'], ['failed', true, 'failed'], ['stopped', true, 'stopped'],
    ['running', true, 'current'], ['launching', true, 'current'],
    ['needs_input', true, 'current'], ['awaiting_approval', true, 'current'],
    ['limit_reached', true, 'current'], ['interrupted', true, 'current'],
    ['running', false, 'pending'], ['pending', true, 'pending'],
  ])('%s, current=%s yields %s', (status, isCurrent, state) => {
    expect(describeStepState({ status }, { isCurrent })).toEqual({ state });
  });
  it('rejects malformed inputs', () => {
    expect(() => describeStepState(null, { isCurrent: true })).toThrow(/step/);
    expect(() => describeStepState({ status: 'running' }, {})).toThrow(/isCurrent/);
  });
});

describe('describeStepProgress', () => {
  const once = { mode: 'once' };
  const passes = { mode: 'until_complete', max: 5 };
  const loop = { mode: 'loop_back', max: 12, toStepIndex: 1 };
  it.each([
    [{ status: 'pending', repeat: once, iteration: 0, roundsCompleted: 0 }, 'Not started', null],
    [{ status: 'launching', repeat: once, iteration: 0, roundsCompleted: 0 }, 'Starting', null],
    [{ status: 'running', repeat: once, iteration: 1, roundsCompleted: 0 }, 'Running', null],
    [{ status: 'needs_input', repeat: once, iteration: 1, roundsCompleted: 0 }, 'Needs your input', null],
    [{ status: 'awaiting_approval', repeat: once, iteration: 1, roundsCompleted: 0 }, 'Waiting for your approval', null],
    [{ status: 'complete', repeat: once, iteration: 1, roundsCompleted: 0 }, 'Done', null],
    [{ status: 'failed', repeat: once, iteration: 1, roundsCompleted: 0 }, 'Failed', null],
    [{ status: 'stopped', repeat: once, iteration: 1, roundsCompleted: 0 }, 'Stopped', null],
    [{ status: 'interrupted', repeat: once, iteration: 1, roundsCompleted: 0 }, 'Interrupted', null],
    [{ status: 'pending', repeat: passes, iteration: 0, roundsCompleted: 0 }, 'Not started', 'up to 5 passes'],
    [{ status: 'running', repeat: passes, iteration: 2, roundsCompleted: 0 }, 'Running', 'pass 2 of 5'],
    [{ status: 'complete', repeat: passes, iteration: 1, roundsCompleted: 0 }, 'Done', '1 pass'],
    [{ status: 'complete', repeat: passes, iteration: 3, roundsCompleted: 0 }, 'Done', '3 passes'],
    [{ status: 'limit_reached', repeat: passes, iteration: 5, roundsCompleted: 0 }, 'Paused at its limit', 'pass 5 of 5'],
    [{ status: 'limit_accepted', repeat: passes, iteration: 5, roundsCompleted: 0 }, 'Stopped at its limit; you continued', '5 passes'],
    [{ status: 'running', repeat: loop, iteration: 1, roundsCompleted: 3 }, 'Running', 'round 4 of 12'],
    [{ status: 'complete', repeat: loop, iteration: 1, roundsCompleted: 0 }, 'Done', '1 round'],
    [{ status: 'limit_reached', repeat: loop, iteration: 1, roundsCompleted: 11 }, 'Paused at its limit', 'round 12 of 12'],
    [{ status: 'limit_accepted', repeat: loop, iteration: 1, roundsCompleted: 11 }, 'Stopped at its limit; you continued', '12 rounds'],
  ])('%j reads %s (%s)', (step, label, detail) => {
    expect(describeStepProgress(step)).toEqual({ label, detail });
  });
  it('rejects a status it has no words for, and malformed steps', () => {
    expect(() => describeStepProgress({ status: 'mystery', repeat: once, iteration: 0, roundsCompleted: 0 })).toThrow(/status mystery/);
    expect(() => describeStepProgress(null)).toThrow(/step/);
    expect(() => describeStepProgress({ status: 'running', iteration: 0, roundsCompleted: 0 })).toThrow(/repeat/);
    expect(() => describeStepProgress({ status: 'running', repeat: passes, iteration: -1, roundsCompleted: 0 })).toThrow(/iteration/);
    expect(() => describeStepProgress({ status: 'running', repeat: loop, iteration: 1, roundsCompleted: 'x' })).toThrow(/roundsCompleted/);
  });
});
