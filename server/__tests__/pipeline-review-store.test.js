import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createReviewStore } from '../pipelines/review-store.js';

const RUN = 'a2d0b1c2-3456-4789-8abc-def012345678';
const databases = [];
const review = { runId: RUN, stepIndex: 1, stepName: 'Analyse', attempt: 1, verdict: 'sent_back', comment: 'Please clarify\nsection 2' };
const setup = () => { const db = new Database(':memory:'); databases.push(db); return { db, store: createReviewStore(db) }; };
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe('pipeline review store', () => {
  it('appends reviews in order and leaves approved comments null', () => {
    const { store } = setup();
    expect(store.add(review)).toMatchObject(review);
    expect(store.add({ ...review, verdict: 'approved', comment: null })).toMatchObject({ verdict: 'approved', comment: null });
    store.add({ ...review, stepIndex: 2, comment: 'Other step' });
    store.add({ ...review, comment: 'Second send-back' });
    expect(store.listSentBack(RUN, 1).map(row => row.comment)).toEqual([review.comment, 'Second send-back']);
  });
  it.each([
    ['runId', 'bad', 'sent_back'], ['stepIndex', -1, 'sent_back'], ['stepName', '', 'sent_back'],
    ['stepName', 'x'.repeat(65), 'sent_back'], ['attempt', 0, 'sent_back'],
    ['verdict', 'maybe', 'sent_back'], ['comment', '', 'sent_back'],
    ['comment', '\u0000', 'sent_back'], ['comment', 'x'.repeat(4001), 'sent_back'],
    ['comment', 'not allowed', 'approved'],
  ])('rejects invalid %s on write (%s)', (field, value, verdict) => {
    const { store } = setup();
    expect(() => store.add({ ...review, verdict, comment: verdict === 'approved' ? null : review.comment, [field]: value })).toThrow(new RegExp(field));
  });
  it.each([
    ['run_id', 'bad'], ['step_index', -1], ['step_name', ''], ['attempt', 0],
    ['verdict', 'maybe'], ['comment', ''], ['created_at', 'bad'],
  ])('rejects corrupt %s on read', (column, value) => {
    const { db, store } = setup();
    const row = store.add(review);
    db.pragma('ignore_check_constraints = ON');
    db.prepare(`UPDATE pipeline_run_reviews SET ${column} = ? WHERE id = ?`).run(value, row.id);
    expect(() => store.get(row.id)).toThrow(new RegExp(column));
  });
});
