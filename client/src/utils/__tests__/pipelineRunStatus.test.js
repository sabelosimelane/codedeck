import { describe, expect, it } from 'vitest';
import { describeRunStatus, describeStepState } from '../pipelineRunStatus';

describe('describeRunStatus', () => {
  it('shows a no-progress stop as waiting for the owner', () => {
    expect(describeRunStatus({ status: 'stopped', stopReason: 'no_progress', actions: { resume: true } }))
      .toEqual({ label: 'Stopped: no progress', tone: 'waiting', primaryAction: 'resume' });
  });
  it.each([
    ['pending', 'Starting', 'neutral', null], ['running', 'Running', 'active', null],
    ['needs_input', 'Needs your input', 'waiting', 'answer'],
    ['limit_paused', 'Paused at its limit', 'waiting', 'continue'],
    ['awaiting_approval', 'Waiting for your approval', 'waiting', 'approve'],
    ['interrupted', 'Interrupted', 'waiting', 'resume'],
    ['stopped', 'Stopped', 'neutral', 'resume'], ['error', 'Failed', 'danger', 'resume'],
    ['complete', 'Complete', 'done', 'cleanup'],
  ])('%s description and offered action', (status, label, tone, action) => {
    expect(describeRunStatus({ status, actions: action ? { [action]: true } : {} }))
      .toEqual({ label, tone, primaryAction: action });
    if (action) expect(describeRunStatus({ status, actions: {} }).primaryAction).toBeNull();
  });
  it('rejects unknown and malformed statuses', () => {
    expect(() => describeRunStatus({ status: 'mystery', actions: {} })).toThrow(/status/);
    expect(() => describeRunStatus(null)).toThrow(/run/);
  });
});

describe('describeStepState', () => {
  it.each([
    ['complete', false, 'done'], ['failed', true, 'failed'], ['stopped', true, 'stopped'],
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
