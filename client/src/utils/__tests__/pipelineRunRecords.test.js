import { expect, it } from 'vitest';
import { parseRun } from '../pipelineRunRecords';
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
