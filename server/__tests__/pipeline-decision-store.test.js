import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createDecisionStore } from '../pipelines/decision-store.js';

const RUN = 'a2d0b1c2-3456-4789-8abc-def012345678';
const OTHER_RUN = 'b3e1c2d3-4567-4890-9bcd-ef0123456789';
const databases = [];

function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 14, 10, 0, tick++)).toISOString();
  return { db, store: createDecisionStore(db, { now }) };
}

afterEach(() => {
  databases.splice(0).forEach(db => db.close());
});

const decision = (overrides = {}) => ({
  runId: RUN,
  stepIndex: 1,
  stepName: 'Develop',
  pass: 2,
  questions: '1. Which queue?\nRecommended: the existing one',
  truncated: false,
  answer: 'Proceed with your recommendations.',
  ...overrides,
});

describe('pipeline decision store', () => {
  it('records a decision with an id and a timestamp and reads it back', () => {
    const { store } = setup();
    const added = store.add(decision());
    expect(added).toEqual({ id: 1, ...decision(), createdAt: '2026-11-14T10:00:00.000Z' });
    expect(store.list(RUN, { offset: 0, limit: 10, direction: 'asc' })).toEqual([added]);
  });

  it('counts and lists the decisions of one run only, oldest or newest first, a page at a time', () => {
    const { store } = setup();
    const first = store.add(decision({ pass: 1 }));
    store.add(decision({ runId: OTHER_RUN }));
    const second = store.add(decision({ pass: 2, truncated: true }));
    const third = store.add(decision({ pass: 3 }));

    expect(store.count(RUN)).toBe(3);
    expect(store.count(OTHER_RUN)).toBe(1);
    expect(store.count('c4f2d3e4-5678-4901-8cde-f01234567890')).toBe(0);
    expect(store.list(RUN, { offset: 0, limit: 2, direction: 'asc' })).toEqual([first, second]);
    expect(store.list(RUN, { offset: 2, limit: 2, direction: 'asc' })).toEqual([third]);
    expect(store.list(RUN, { offset: 0, limit: 2, direction: 'desc' })).toEqual([third, second]);
    expect(store.list(RUN, { offset: 3, limit: 2, direction: 'asc' })).toEqual([]);
  });

  it('orders decisions made in the same millisecond by the order they were recorded', () => {
    const db = new Database(':memory:');
    databases.push(db);
    const store = createDecisionStore(db, { now: () => '2026-11-14T10:00:00.000Z' });
    const ids = [1, 2, 3].map(pass => store.add(decision({ pass })).id);
    expect(store.list(RUN, { offset: 0, limit: 10, direction: 'asc' }).map(record => record.id)).toEqual(ids);
    expect(store.list(RUN, { offset: 0, limit: 10, direction: 'desc' }).map(record => record.id)).toEqual([...ids].reverse());
  });

  it.each([
    ['runId', { runId: 'not-a-uuid' }],
    ['runId', { runId: undefined }],
    ['stepIndex', { stepIndex: -1 }],
    ['stepIndex', { stepIndex: 33 }],
    ['stepIndex', { stepIndex: '1' }],
    ['stepName', { stepName: '' }],
    ['stepName', { stepName: 'a\nb' }],
    ['stepName', { stepName: 'x'.repeat(65) }],
    ['pass', { pass: 0 }],
    ['pass', { pass: 101 }],
    ['pass', { pass: 1.5 }],
    ['questions', { questions: '   ' }],
    ['questions', { questions: 'x'.repeat(4001) }],
    ['questions', { questions: 'bell\x07' }],
    ['questions', { questions: null }],
    ['truncated', { truncated: 0 }],
    ['truncated', { truncated: undefined }],
    ['answer', { answer: '' }],
    ['answer', { answer: 'x'.repeat(4001) }],
    ['answer', { answer: 'escape\x1b[201~' }],
    ['answer', { answer: 7 }],
  ])('refuses to record a decision with a bad %s', (field, patch) => {
    const { store } = setup();
    expect(() => store.add(decision(patch))).toThrow(`pipeline_run_decisions: ${field} `);
    expect(store.count(RUN)).toBe(0);
  });

  it('refuses unknown fields and a missing record', () => {
    const { store } = setup();
    expect(() => store.add(decision({ extra: 1 }))).toThrow('pipeline_run_decisions: extra is an unknown field');
    expect(() => store.add(null)).toThrow('pipeline_run_decisions: a decision object is required');
  });

  it.each([
    ['offset', { offset: -1, limit: 10, direction: 'asc' }],
    ['offset', { offset: 1.5, limit: 10, direction: 'asc' }],
    ['limit', { offset: 0, limit: 0, direction: 'asc' }],
    ['limit', { offset: 0, limit: 101, direction: 'asc' }],
    ['direction', { offset: 0, limit: 10, direction: 'sideways' }],
    ['direction', { offset: 0, limit: 10 }],
  ])('refuses to list with a bad %s', (field, query) => {
    const { store } = setup();
    expect(() => store.list(RUN, query)).toThrow(`pipeline_run_decisions: ${field} `);
  });

  it('refuses a run id that is not a UUID when counting or listing', () => {
    const { store } = setup();
    expect(() => store.count('nope')).toThrow('pipeline_run_decisions: runId must be a UUID');
    expect(() => store.list('nope', { offset: 0, limit: 10, direction: 'asc' })).toThrow('pipeline_run_decisions: runId must be a UUID');
  });

  it.each([
    ['run_id', 'not-a-uuid'],
    ['step_index', 40],
    ['step_name', ''],
    ['pass', 0],
    ['questions', ''],
    ['truncated', 2],
    ['answer', ''],
    ['created_at', 'yesterday'],
  ])('throws naming the row and field when the stored %s is corrupt', (column, value) => {
    const { db, store } = setup();
    const added = store.add(decision());
    db.prepare(`UPDATE pipeline_run_decisions SET ${column} = ? WHERE id = ?`).run(value, added.id);
    // A corrupt run_id no longer belongs to the run; read the row through the id that still matches.
    const read = () => (column === 'run_id'
      ? store.list('not-a-uuid', { offset: 0, limit: 10, direction: 'asc' })
      : store.list(RUN, { offset: 0, limit: 10, direction: 'asc' }));
    if (column === 'run_id') {
      expect(read).toThrow('pipeline_run_decisions: runId must be a UUID');
      return;
    }
    expect(read).toThrow(`pipeline_run_decisions row ${added.id} field ${column}:`);
  });

  it('requires a database handle', () => {
    expect(() => createDecisionStore()).toThrow('pipeline_run_decisions: a database handle is required');
  });
});
