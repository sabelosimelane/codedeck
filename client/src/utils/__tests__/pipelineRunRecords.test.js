import { expect, it } from 'vitest';
import { parseDecision, parseDecisionPage, parseInputRequest, parseRun, parseRunAutonomy } from '../pipelineRunRecords';
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

// A run without Setup: Develop, then Test which loops back to Develop.
const looping = (repeat = { mode: 'loop_back', toStepIndex: 0, max: 5 }, roundsCompleted = 2) => {
  const row = validRun();
  const develop = { ...row.steps[0], kind: 'node', name: 'Develop', repeat: { mode: 'once' }, status: 'complete', finishedAt: '2026-11-13T12:05:00.000Z' };
  const test = { ...row.steps[0], index: 1, kind: 'node', name: 'Test', repeat, sessionId: 'Alpha-2', roundsCompleted };
  return { ...row, currentStepIndex: 1, agentsDecide: true, decisionCount: 3, steps: [develop, test] };
};
it('accepts a step that loops back, the rounds it completed, and a run whose agents decide', () => {
  expect(parseRun(looping())).toEqual(looping());
  expect(parseRun(looping({ mode: 'loop_back', toStepIndex: 0, max: 1 }, 0)).steps[1].roundsCompleted).toBe(0);
  expect(parseRun(looping({ mode: 'loop_back', toStepIndex: 0, max: 100 }, 99)).steps[1].roundsCompleted).toBe(99);
});
it.each([
  ['steps[1].repeat.toStepIndex', { mode: 'loop_back', toStepIndex: 1, max: 5 }],
  ['steps[1].repeat.toStepIndex', { mode: 'loop_back', toStepIndex: 2, max: 5 }],
  ['steps[1].repeat.toStepIndex', { mode: 'loop_back', toStepIndex: -1, max: 5 }],
  ['steps[1].repeat.toStepIndex', { mode: 'loop_back', toStepIndex: 0.5, max: 5 }],
  ['steps[1].repeat.toStepIndex', { mode: 'loop_back', max: 5 }],
  ['steps[1].repeat.toStepIndex', { mode: 'once', toStepIndex: 0 }],
  ['steps[1].repeat.toStepIndex', { mode: 'until_complete', max: 5, toStepIndex: 0 }],
  ['steps[1].repeat.max', { mode: 'loop_back', toStepIndex: 0 }],
  ['steps[1].repeat.max', { mode: 'loop_back', toStepIndex: 0, max: 0 }],
  ['steps[1].repeat.max', { mode: 'loop_back', toStepIndex: 0, max: 101 }],
  ['steps[1].repeat.mode', { mode: 'forever' }],
])('rejects a malformed %s', (field, repeat) => {
  expect(() => parseRun(looping(repeat, 0))).toThrow(field);
});
it.each([
  ['at its maximum', { mode: 'loop_back', toStepIndex: 0, max: 5 }, 5],
  ['negative', { mode: 'loop_back', toStepIndex: 0, max: 5 }, -1],
  ['fractional', { mode: 'loop_back', toStepIndex: 0, max: 5 }, 1.5],
  ['on a step that does not loop back', { mode: 'until_complete', max: 5 }, 1],
])('rejects completed rounds %s', (_label, repeat, roundsCompleted) => {
  expect(() => parseRun(looping(repeat, roundsCompleted))).toThrow('steps[1].roundsCompleted');
});
it.each([
  ['agentsDecide', 'yes'], ['agentsDecide', null], ['decisionCount', -1], ['decisionCount', 1.5], ['decisionCount', '3'],
])('rejects a malformed %s', (field, value) => {
  expect(() => parseRun({ ...validRun(), [field]: value })).toThrow(field);
});

const decision = (patch = {}) => ({
  id: 4, stepIndex: 1, stepName: 'Test', pass: 2, questions: '1. Run the slow suite?\nRecommended: yes',
  truncated: false, answer: 'Proceed with your recommendations.', createdAt: '2026-11-14T10:00:00.000Z', ...patch,
});
const decisionPage = (data = [decision()], page = {}) => ({
  data, page: { currentPage: 0, size: 50, totalElements: data.length, totalPages: data.length ? 1 : 0, hasNextPage: false, ...page },
});
it('returns every field of a decision and nothing else', () => {
  expect(parseDecision({ ...decision(), extra: 1 })).toEqual(decision());
  expect(parseDecision(decision({ truncated: true, pass: 100, stepIndex: 32 }))).toEqual(decision({ truncated: true, pass: 100, stepIndex: 32 }));
});
it.each([
  ['decision', null], ['decision', []],
  ['id', decision({ id: 0 })], ['id', decision({ id: '4' })], ['id', decision({ id: undefined })],
  ['stepIndex', decision({ stepIndex: -1 })], ['stepIndex', decision({ stepIndex: 33 })],
  ['stepName', decision({ stepName: '' })], ['stepName', decision({ stepName: 'x'.repeat(65) })],
  ['pass', decision({ pass: 0 })], ['pass', decision({ pass: 101 })],
  ['questions', decision({ questions: '' })], ['questions', decision({ questions: 'q'.repeat(4001) })], ['questions', decision({ questions: null })],
  ['truncated', decision({ truncated: 'no' })], ['truncated', decision({ truncated: undefined })],
  ['answer', decision({ answer: '  ' })], ['answer', decision({ answer: 'a'.repeat(4001) })],
  ['createdAt', decision({ createdAt: 'today' })], ['createdAt', decision({ createdAt: undefined })],
])('rejects a decision with a bad %s', (field, record) => {
  expect(() => parseDecision(record)).toThrow(`Invalid decision`);
  expect(() => parseDecision(record)).toThrow(field);
});
it('never repeats what was asked or answered in a failure', () => {
  let failure;
  try { parseDecision(decision({ pass: 0, questions: 'the secret plan?', answer: 'use the secret' })); } catch (error) { failure = error; }
  expect(failure.message).not.toContain('secret');
  expect(failure.message).toContain('4');
});
it('accepts a page of decisions and an empty page', () => {
  expect(parseDecisionPage(decisionPage([decision(), decision({ id: 5 })], { hasNextPage: true, totalElements: 60, totalPages: 2 }))).toEqual({
    decisions: [decision(), decision({ id: 5 })], hasNextPage: true, total: 60,
  });
  expect(parseDecisionPage(decisionPage([]))).toEqual({ decisions: [], hasNextPage: false, total: 0 });
});
it.each([
  ['body', null],
  ['data', { page: decisionPage().page }],
  ['data', { data: 'none', page: decisionPage().page }],
  ['page', { data: [] }],
  ['page.hasNextPage', decisionPage([], { hasNextPage: 'no' })],
  ['page.totalElements', decisionPage([], { totalElements: -1 })],
  ['page.totalElements', decisionPage([], { totalElements: undefined })],
  ['page.currentPage', decisionPage([], { currentPage: -1 })],
  ['page.size', decisionPage([], { size: 0 })],
  ['page.totalPages', decisionPage([], { totalPages: 1.5 })],
  ['pass', decisionPage([decision({ pass: 0 })])],
])('rejects a decisions page with a bad %s', (field, body) => {
  expect(() => parseDecisionPage(body)).toThrow(field);
});

it('checks the fields the runs bar reads about loops and decisions', () => {
  expect(parseRunAutonomy(looping())).toBeUndefined();
  expect(parseRunAutonomy(validRun())).toBeUndefined();
});
it.each([
  ['run', () => null],
  ['agentsDecide', () => ({ ...validRun(), agentsDecide: undefined })],
  ['decisionCount', () => ({ ...validRun(), decisionCount: 2.5 })],
  ['steps', () => ({ ...validRun(), steps: 'none' })],
  ['steps[0]', () => ({ ...validRun(), steps: [null] })],
  ['steps[1].repeat', () => { const row = looping(); row.steps[1].repeat = null; return row; }],
  ['steps[1].repeat.max', () => looping({ mode: 'loop_back', toStepIndex: 0, max: 101 }, 0)],
  ['steps[1].roundsCompleted', () => looping({ mode: 'loop_back', toStepIndex: 0, max: 5 }, 5)],
  ['steps[1].roundsCompleted', () => looping({ mode: 'loop_back', toStepIndex: 0, max: 5 }, null)],
])('parseRunAutonomy rejects a malformed %s', (field, build) => {
  expect(() => parseRunAutonomy(build())).toThrow(field);
});
