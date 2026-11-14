import { expect, it } from 'vitest';
import { parseInputRequest, parseRun } from '../pipelineRunRecords';
import { validRun } from './pipelineRunFixture';
it('accepts the complete run response', () => { expect(parseRun(validRun())).toEqual(validRun()); });
const paths = [
 ...Object.keys(validRun()),
 ...Object.keys(validRun().steps[0]).map(k => `steps.0.${k}`),
 'steps.0.repeat.mode', 'steps.0.repeat.max',
 ...Object.keys(validRun().worktree).map(k => `worktree.${k}`),
 ...Object.keys(validRun().actions).map(k => `actions.${k}`),
];
it.each(paths)('rejects missing field %s', path => {
  const row = validRun(); const keys = path.split('.'); const field = keys.pop();
  let target = row; for (const key of keys) target = target[key]; delete target[field];
  expect(() => parseRun(row)).toThrow(field);
});
it.each([
 ['id', 'bad'], ['project', ''], ['status', 'unknown'], ['currentStepIndex', 1],
 ['createdAt', 'bad'], ['steps.0.sessionId', 'Other-1'], ['steps.0.priorSessionIds', [null]],
 ['steps.0.repeat.max', 101], ['steps.0.attempt', -1], ['worktree.path', 'relative'],
 ['worktree.baseCommit', 'bad'], ['actions.stop', 'true'], ['stopReason', 'user'],
])('rejects malformed %s', (path, value) => {
 const row = validRun(); const keys = path.split('.'); const field = keys.pop();
 let target = row; for (const key of keys) target = target[key]; target[field] = value;
 expect(() => parseRun(row)).toThrow(field);
});
it.each(['not_created', 'present', 'removed', 'removal_blocked', 'external', 'released'])('accepts worktree state %s', state => {
 const row = validRun(); row.worktree.state = state;
 expect(parseRun(row).worktree.state).toBe(state);
});
it('rejects an unknown worktree state', () => {
 const row = validRun(); row.worktree.state = 'borrowed';
 expect(() => parseRun(row)).toThrow('state');
});
it('requires error details and terminal timestamps', () => {
 expect(() => parseRun({ ...validRun(), status: 'error' })).toThrow('error');
 expect(() => parseRun({ ...validRun(), status: 'complete' })).toThrow('finishedAt');
});
it('supports once steps and nullable pending metadata', () => {
 const row = validRun(); row.steps[0] = { ...row.steps[0], repeat: { mode: 'once' }, sessionId: null, startedAt: null };
 row.worktree.baseCommit = null;
 expect(parseRun(row)).toEqual(row);
 row.steps[0].repeat.max = 1;
 expect(() => parseRun(row)).toThrow('max');
});

const waiting = (inputRequest, answer = inputRequest !== null) => {
  const row = validRun();
  row.status = 'needs_input'; row.steps[0].status = 'needs_input';
  row.inputRequest = inputRequest; row.actions.answer = answer;
  return row;
};
const ASKED = { questions: '1. Which schema?\nRecommended: the existing one.', truncated: false };
it.each([
  ['questions the agent stated', ASKED],
  ['a request without stated questions', { questions: null, truncated: false }],
  ['questions that were cut', { questions: 'q'.repeat(4000), truncated: true }],
  ['a dialog in the terminal', null],
])('accepts a waiting run with %s', (_label, inputRequest) => {
  expect(parseRun(waiting(inputRequest)).inputRequest).toEqual(inputRequest);
  expect(parseInputRequest(waiting(inputRequest))).toEqual(inputRequest);
});
it.each([
  ['inputRequest', 'text'],
  ['inputRequest', []],
  ['inputRequest.questions', { truncated: false }],
  ['inputRequest.questions', { questions: '', truncated: false }],
  ['inputRequest.questions', { questions: 7, truncated: false }],
  ['inputRequest.questions', { questions: 'q'.repeat(4001), truncated: false }],
  ['inputRequest.truncated', { questions: 'One?' }],
  ['inputRequest.truncated', { questions: 'One?', truncated: 'yes' }],
  ['inputRequest.truncated', { questions: null, truncated: true }],
])('rejects a malformed %s', (field, inputRequest) => {
  expect(() => parseRun(waiting(inputRequest))).toThrow(field);
  expect(() => parseInputRequest(waiting(inputRequest))).toThrow(field);
});
it('rejects a request on a run that is not waiting, and a missing one', () => {
  const running = validRun(); running.inputRequest = ASKED;
  expect(() => parseRun(running)).toThrow('inputRequest');
  expect(() => parseInputRequest(running)).toThrow('inputRequest');
  const missing = validRun(); delete missing.inputRequest;
  expect(() => parseInputRequest(missing)).toThrow('inputRequest');
  expect(() => parseInputRequest(null)).toThrow('run');
});
it('requires the answer action to match whether the agent signalled a request', () => {
  expect(() => parseRun(waiting(ASKED, false))).toThrow('actions.answer');
  expect(() => parseRun(waiting(null, true))).toThrow('actions.answer');
  const running = validRun(); running.actions.answer = true;
  expect(() => parseRun(running)).toThrow('actions.answer');
});
