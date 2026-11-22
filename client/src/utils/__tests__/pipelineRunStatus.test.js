import { describe, expect, it } from 'vitest';
import { describeRunStatus, describeStepState, describeStepProgress, describeStepDuration, describeRunDuration } from '../pipelineRunStatus';

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

describe('describeStepDuration', () => {
  const at = seconds => new Date(Date.UTC(2026, 10, 19, 10, 0, 0) + seconds * 1000).toISOString();
  const now = seconds => Date.UTC(2026, 10, 19, 10, 0, 0) + seconds * 1000;
  const step = (overrides = {}) => ({ status: 'complete', elapsedMs: 252000, startedAt: null, ...overrides });

  it.each([
    [400, 'under 1s'], [1000, '1s'], [59900, '59s'], [60000, '1m 0s'], [252000, '4m 12s'], [3599000, '59m 59s'], [3600000, '1h 0m'], [3900000, '1h 5m'], [90000000, '25h 0m'],
  ])('says a finished step that worked %s milliseconds took %s', (elapsedMs, words) => {
    expect(describeStepDuration(step({ elapsedMs }), now(0))).toEqual({ words, live: false });
  });

  it('says nothing for a non-working step with no time kept', () => {
    expect(describeStepDuration(step({ elapsedMs: 0 }), now(0))).toBeNull();
    expect(describeStepDuration(step({ status: 'pending', elapsedMs: 0 }), now(0))).toBeNull();
  });

  it.each(['complete', 'limit_accepted', 'pending', 'needs_input', 'awaiting_approval', 'limit_reached', 'failed', 'stopped', 'interrupted'])(
    'shows the accumulated working time for a %s step that has worked before',
    (status) => {
      expect(describeStepDuration(step({ status }), now(99999))).toEqual({ words: '4m 12s', live: false });
    },
  );

  it.each(['launching', 'running'])(
    'counts live from startedAt on top of accumulated elapsedMs while a step is %s',
    (status) => {
      expect(describeStepDuration(step({ status, elapsedMs: 60000, startedAt: at(10) }), now(75))).toEqual({ words: '2m 5s', live: true });
    },
  );

  it('never counts backwards when this device\'s clock is behind the backend\'s', () => {
    expect(describeStepDuration(step({ status: 'running', elapsedMs: 0, startedAt: at(10) }), now(5))).toEqual({ words: 'under 1s', live: true });
    expect(describeStepDuration(step({ status: 'running', elapsedMs: 60000, startedAt: at(10) }), now(5))).toEqual({ words: '1m 0s', live: true });
  });

  it('falls back to settled elapsedMs (or null) when a working step has no startedAt', () => {
    expect(describeStepDuration(step({ status: 'running', elapsedMs: 9000, startedAt: null }), now(100))).toEqual({ words: '9s', live: false });
    expect(describeStepDuration(step({ status: 'running', elapsedMs: 0, startedAt: null }), now(100))).toBeNull();
  });

  it.each([
    ['a step that is not an object', null, 0, 'step duration: step must be an object'],
    ['an unknown status', step({ status: 'weird' }), 0, 'step duration: status weird is unknown'],
    ['a missing time', step({ elapsedMs: undefined }), 0, 'step duration: elapsedMs must be an integer ≥ 0'],
    ['a time that is null', step({ elapsedMs: null }), 0, 'step duration: elapsedMs must be an integer ≥ 0'],
    ['a negative time', step({ elapsedMs: -1 }), 0, 'step duration: elapsedMs must be an integer ≥ 0'],
    ['a time that is not whole', step({ elapsedMs: 1.5 }), 0, 'step duration: elapsedMs must be an integer ≥ 0'],
    ['a time as text', step({ elapsedMs: '252000' }), 0, 'step duration: elapsedMs must be an integer ≥ 0'],
    ['a malformed startedAt', step({ startedAt: 'yesterday' }), 0, 'step duration: startedAt must be a timestamp or null'],
    ['a time now that is not a number', step(), 'now', 'step duration: now must be a time in milliseconds'],
  ])('throws on %s', (_label, value, time, message) => {
    expect(() => describeStepDuration(value, time)).toThrow(message);
  });
});

describe('describeRunDuration', () => {
  const at = seconds => new Date(Date.UTC(2026, 10, 19, 10, 0, 0) + seconds * 1000).toISOString();
  const now = seconds => Date.UTC(2026, 10, 19, 10, 0, 0) + seconds * 1000;
  const run = (overrides = {}) => ({ status: 'running', createdAt: at(0), updatedAt: at(30), finishedAt: null, ...overrides });

  it('counts a run that is not over from its start to now, and says it is still counting', () => {
    expect(describeRunDuration(run(), now(725))).toEqual({ words: '12m 5s', live: true });
    expect(describeRunDuration(run({ status: 'needs_input' }), now(3900))).toEqual({ words: '1h 5m', live: true });
  });

  it('gives a finished run the time from its start to its end, whatever the time is now', () => {
    for (const status of ['complete', 'stopped', 'error']) {
      expect(describeRunDuration(run({ status, finishedAt: at(252) }), now(99999))).toEqual({ words: '4m 12s', live: false });
    }
  });

  it('stops counting an interrupted run at its last change: nothing is working in it', () => {
    expect(describeRunDuration(run({ status: 'interrupted', updatedAt: at(90) }), now(99999))).toEqual({ words: '1m 30s', live: false });
  });

  it('shows nothing negative when this device\'s clock is behind the backend\'s', () => {
    expect(describeRunDuration(run(), now(-3))).toEqual({ words: 'under 1s', live: true });
  });

  it.each([
    ['a run that is not an object', null, 0, 'run duration: run must be an object'],
    ['a status that is not a name', run({ status: '' }), 0, 'run duration: status must be a nonempty string'],
    ['a missing start', run({ createdAt: null }), 0, 'run duration: createdAt must be a timestamp'],
    ['a last change that is not a time', run({ updatedAt: 'yesterday' }), 0, 'run duration: updatedAt must be a timestamp'],
    ['a missing end field', run({ finishedAt: undefined }), 0, 'run duration: finishedAt must be a timestamp or null'],
    ['an end before the start', run({ status: 'complete', finishedAt: at(-1) }), 0, 'run duration: the run ends before it starts'],
    ['a last change before the start', run({ status: 'interrupted', updatedAt: at(-1) }), 0, 'run duration: the run ends before it starts'],
    ['a time now that is not a number', run(), 'now', 'run duration: now must be a time in milliseconds'],
  ])('throws on %s', (_label, value, time, message) => {
    expect(() => describeRunDuration(value, time)).toThrow(message);
  });
});
