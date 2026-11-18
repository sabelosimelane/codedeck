import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createAnswerStore } from '../pipelines/answer-store.js';

const RUN = '8a000000-0000-4000-8000-000000000001';
const OTHER = '8a000000-0000-4000-8000-000000000002';
const databases = [];
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  let tick = 0;
  return { db, store: createAnswerStore(db, { now: () => new Date(Date.UTC(2026, 10, 18, 10, 0, tick++)).toISOString() }) };
}
afterEach(() => databases.splice(0).forEach(db => db.close()));
const answer = (extra = {}) => ({ runId: RUN, stepIndex: 0, stepName: 'Clarify', pass: 1, questions: '1. Which page?\nRecommended: login', answer: 'The login page\non mobile', ...extra });

describe('owner answer store', () => {
  it('keeps what was asked and answered, in order, per run and per step', () => {
    const { store } = setup();
    const first = store.add(answer());
    store.add(answer({ runId: OTHER }));
    const second = store.add(answer({ stepIndex: 2, stepName: 'Fix', pass: 3, questions: null, answer: 'Yes' }));
    expect(first).toEqual({ id: 1, ...answer(), createdAt: '2026-11-18T10:00:00.000Z' });
    expect(store.list(RUN)).toEqual([first, second]);
    expect(store.list(RUN, { stepIndex: 2 })).toEqual([second]);
    expect(store.list(RUN, { stepIndex: 5 })).toEqual([]);
    expect(second.questions).toBeNull();
  });

  it.each([
    [{ runId: 'nope' }, 'runId'], [{ stepIndex: -1 }, 'stepIndex'], [{ stepIndex: 33 }, 'stepIndex'], [{ stepIndex: '0' }, 'stepIndex'],
    [{ stepName: '' }, 'stepName'], [{ stepName: 'x'.repeat(65) }, 'stepName'], [{ stepName: 'a\nb' }, 'stepName'], [{ stepName: null }, 'stepName'],
    [{ pass: 0 }, 'pass'], [{ pass: 101 }, 'pass'], [{ pass: 1.5 }, 'pass'],
    [{ questions: '' }, 'questions'], [{ questions: 'x'.repeat(4001) }, 'questions'], [{ questions: 'a\u0007b' }, 'questions'], [{ questions: 12 }, 'questions'], [{ questions: undefined }, 'questions'],
    [{ answer: '' }, 'answer'], [{ answer: '  ' }, 'answer'], [{ answer: 'x'.repeat(4001) }, 'answer'], [{ answer: 'a\tb' }, 'answer'], [{ answer: null }, 'answer'],
  ])('refuses %j', (patch, field) => {
    const { store } = setup();
    expect(() => store.add(answer(patch))).toThrow(`pipeline_run_answers: ${field} is invalid`);
    expect(store.list(RUN)).toEqual([]);
  });

  it('accepts the limits, and refuses unknown fields and non-objects', () => {
    const { store } = setup();
    expect(store.add(answer({ stepIndex: 32, pass: 100, stepName: 'x'.repeat(64), questions: 'x'.repeat(4000), answer: 'x'.repeat(4000) })).id).toBe(1);
    expect(() => store.add(answer({ extra: 1 }))).toThrow('extra is an unknown field');
    expect(() => store.add(null)).toThrow('an answer object is required');
    expect(() => store.list('nope')).toThrow('runId must be a UUID');
    expect(() => store.list(RUN, { stepIndex: 40 })).toThrow('stepIndex');
  });

  it.each([['step_name', ''], ['pass', 0], ['answer', ''], ['created_at', 'yesterday'], ['step_index', 99]])('fails loudly when stored column %s is invalid', (column, value) => {
    const { db, store } = setup();
    store.add(answer());
    db.prepare(`UPDATE pipeline_run_answers SET ${column} = ?`).run(value);
    expect(() => store.list(RUN)).toThrow(/pipeline_run_answers row 1 field/);
  });

  it('requires a database handle', () => {
    expect(() => createAnswerStore(null)).toThrow('a database handle is required');
  });
});
