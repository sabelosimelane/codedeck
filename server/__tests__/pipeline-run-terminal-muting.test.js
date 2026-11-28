import { describe, expect, it } from 'vitest';
import { isLiveRunStepSession, planRunTerminalMuting } from '../pipelines/run-terminal-muting.js';
import { setObservedTerminalMuted } from '../pipelines/terminal-muting-adapter.js';

const run = (patch = {}) => ({
  status: 'running', currentStepIndex: 0, worktreeState: 'present',
  steps: [{ sessionId: 'one', priorSessionIds: ['old'] }, { sessionId: 'two' }, { sessionId: 'one' }],
  ...patch,
});

describe('planRunTerminalMuting', () => {
  it.each(['pending', 'running', 'needs_input', 'awaiting_approval', 'limit_paused'])(
    'keeps the current terminal live during %s', status => {
      expect([...planRunTerminalMuting(run({ status })).entries()]).toEqual([['one', false], ['two', true]]);
      expect([...planRunTerminalMuting(run({ status, currentStepIndex: 1 })).entries()]).toEqual([['one', true], ['two', false]]);
    },
  );
  it.each(['interrupted', 'stopped', 'error', 'complete'])(
    'mutes every terminal during %s', status => {
      expect([...planRunTerminalMuting(run({ status })).entries()]).toEqual([['one', true], ['two', true]]);
    },
  );
  it('mutes known terminals while the current step has no session', () => {
    expect([...planRunTerminalMuting(run({ currentStepIndex: 1, steps: [{ sessionId: 'one' }, { sessionId: null }, { sessionId: 'two' }] })).entries()]).toEqual([['one', true], ['two', true]]);
  });
  it.each(['removed', 'released'])('unmutes every terminal after %s', worktreeState => {
    expect([...planRunTerminalMuting(run({ worktreeState, status: 'complete' })).entries()]).toEqual([['one', false], ['two', false]]);
  });
  it.each([
    [null, 'run'],
    [{ status: 'bogus' }, 'status'],
    [{ currentStepIndex: -1 }, 'currentStepIndex'],
    [{ currentStepIndex: 3 }, 'currentStepIndex'],
    [{ steps: null }, 'steps'],
    [{ steps: [] }, 'steps'],
    [{ steps: [null] }, 'step'],
    [{ steps: [{ sessionId: '' }] }, 'sessionId'],
    [{ steps: [{ sessionId: 1 }] }, 'sessionId'],
    [{ worktreeState: 'bogus' }, 'worktreeState'],
  ])('rejects invalid edge input %j', (patch, message) => {
    expect(() => planRunTerminalMuting(patch === null ? null : run(patch))).toThrow(message);
  });
});

describe('setObservedTerminalMuted', () => {
  it('does not write an unobserved session and reports a retry', () => {
    const attention = { knows: () => false, setMuted: () => { throw new Error('should not write'); } };
    expect(setObservedTerminalMuted(attention, 'one', true)).toBe(false);
  });
  it('writes a known session and returns true', () => {
    const writes = [];
    const attention = { knows: () => true, setMuted: (...args) => writes.push(args) };
    expect(setObservedTerminalMuted(attention, 'one', false)).toBe(true);
    expect(writes).toEqual([['one', false]]);
  });
  it.each([
    [null, 'attention'],
    [{ knows() {} }, 'attention'],
    [{ knows() {}, setMuted() {} }, 'sessionId', ''],
    [{ knows() {}, setMuted() {} }, 'muted', 'one', null],
  ])('rejects an invalid adapter argument', (attention, message, sessionId = 'one', muted = true) => {
    expect(() => setObservedTerminalMuted(attention, sessionId, muted)).toThrow(message);
  });
});

describe('isLiveRunStepSession', () => {
  it.each(['pending', 'running'])('holds the current step terminal of a %s run', status => {
    expect(isLiveRunStepSession([run({ status })], 'one')).toBe(true);
    expect(isLiveRunStepSession([run({ status, currentStepIndex: 1 })], 'two')).toBe(true);
  });
  it('does not hold a terminal of a step the run has moved past', () => {
    expect(isLiveRunStepSession([run({ currentStepIndex: 1 })], 'one')).toBe(false);
  });
  // A run that is waiting on the owner hands the attention signal back to its terminal.
  it.each(['needs_input', 'awaiting_approval', 'limit_paused', 'interrupted', 'stopped', 'error', 'complete'])(
    'does not hold the current terminal of a %s run', status => {
      expect(isLiveRunStepSession([run({ status })], 'one')).toBe(false);
    },
  );
  it.each(['removed', 'released'])('does not hold terminals after the worktree is %s', worktreeState => {
    expect(isLiveRunStepSession([run({ worktreeState })], 'one')).toBe(false);
  });
  it('does not hold terminals no run uses', () => {
    expect(isLiveRunStepSession([], 'one')).toBe(false);
    expect(isLiveRunStepSession([run()], 'stranger')).toBe(false);
  });
  it('rejects a runs value that is not a list', () => {
    expect(() => isLiveRunStepSession(null, 'one')).toThrow(/runs must be an array/);
  });
  it.each([undefined, '', '  ', 7])('rejects sessionId %p', sessionId => {
    expect(() => isLiveRunStepSession([run()], sessionId)).toThrow(/sessionId must be nonempty text/);
  });
  it('rejects an invalid run rather than guessing', () => {
    expect(() => isLiveRunStepSession([run({ status: 'bogus' })], 'one')).toThrow(/status is invalid/);
  });
});
