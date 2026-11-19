import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createNoteStore } from '../pipelines/note-store.js';

const RUN = 'a2d0b1c2-3456-4789-8abc-def012345678';
const dbs = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function setup() {
  const db = new Database(':memory:');
  dbs.push(db);
  return { db, store: createNoteStore(db) };
}
const note = { runId: RUN, stepIndex: 1, stepName: 'Build', attempt: 1, pass: 1, status: 'written', summary: 'Done', content: '# Done\nWork', };

describe('pipeline note store', () => {
  it.each([
    ['runId', null], ['stepIndex', -1], ['stepName', ''], ['attempt', null],
    ['pass', 0], ['status', 'unknown'], ['summary', null], ['content', null],
  ])('rejects invalid %s on write', (field, value) => {
    const { store } = setup();
    expect(() => store.add({ ...note, [field]: value })).toThrow(field);
  });
  it('appends and pages records, and finds the latest per step and last written content', () => {
    const { store } = setup();
    const first = store.add(note);
    store.add({ ...note, pass: 2, status: 'unchanged', summary: null, content: null });
    expect(store.count(RUN)).toBe(2);
    expect(store.list(RUN, { offset: 1, limit: 1, direction: 'asc' })[0].status).toBe('unchanged');
    expect(store.latestByStep(RUN).get(1).pass).toBe(2);
    expect(store.lastContent(RUN, 1)).toBe('# Done\nWork');
    expect(store.list(RUN, { offset: 0, limit: 1, direction: 'desc' })[0].id).toBe(first.id + 1);
  });
  it('reads the last written note of a step in full, past passes that changed nothing', () => {
    const { store } = setup();
    expect(store.lastWritten(RUN, 1)).toBeNull();
    store.add(note);
    store.add({ ...note, pass: 2, summary: 'Again', content: '# Again\nMore' });
    store.add({ ...note, pass: 3, status: 'unchanged', summary: null, content: null });
    store.add({ ...note, stepIndex: 2, summary: 'Other step', content: '# Other step' });
    expect(store.lastWritten(RUN, 1)).toMatchObject({ runId: RUN, stepIndex: 1, pass: 2, status: 'written', summary: 'Again', content: '# Again\nMore' });
    expect(() => store.lastWritten('nope', 1)).toThrow('runId');
    expect(() => store.lastWritten(RUN, 33)).toThrow('stepIndex');
  });
  it('rejects bad write fields and corrupt stored rows', () => {
    const { db, store } = setup();
    expect(() => store.add({ ...note, attempt: null })).toThrow(/attempt/);
    expect(() => store.add({ ...note, status: 'unknown' })).toThrow(/status/);
    store.add(note);
    db.prepare("UPDATE pipeline_run_notes SET step_name = ''").run();
    expect(() => store.list(RUN, { offset: 0, limit: 10, direction: 'asc' })).toThrow(/step_name/);
  });
  it('finds an existing pass by validated run, step, attempt and pass', () => {
    const { store } = setup();
    const first = store.add(note);
    expect(store.hasPass(RUN, 1, 1, 1)).toBe(true);
    expect(store.hasPass(RUN, 1, 1, 2)).toBe(false);
    expect(store.hasPass(RUN, 1, 2, 1)).toBe(false);
    expect(() => store.hasPass('bad', 1, 1, 1)).toThrow(/runId/);
    expect(() => store.hasPass(RUN, -1, 1, 1)).toThrow(/stepIndex/);
    expect(() => store.hasPass(RUN, 1, 0, 1)).toThrow(/attempt/);
    expect(() => store.hasPass(RUN, 1, 1, 0)).toThrow(/pass/);
    expect(first.id).toBeGreaterThan(0);
  });
  it('returns only the newest metadata per step and checks corrupt rows', () => {
    const { db, store } = setup();
    for (let pass = 1; pass <= 5; pass++) {
      store.add({ ...note, pass });
      store.add({ ...note, stepIndex: 2, stepName: 'Test', pass });
    }
    const latest = store.latestByStep(RUN);
    expect([...latest.keys()]).toEqual([1, 2]);
    expect([...latest.values()].map(row => row.pass)).toEqual([5, 5]);
    expect(latest.get(1)).not.toHaveProperty('content');
    db.prepare("UPDATE pipeline_run_notes SET step_name = '' WHERE step_index = 2 AND pass = 5").run();
    expect(() => store.latestByStep(RUN)).toThrow(/step_name/);
  });
});
