import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createTerminalWaitingStore } from '../terminal-waiting-store.js';

const databases = [];
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, store: createTerminalWaitingStore(db) };
}
afterEach(() => { databases.splice(0).forEach(db => db.close()); });

describe('terminal waiting store', () => {
  it('reports no waiting record for an unmarked session', () => {
    const { store } = setup();
    expect(store.get('Demo-1')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('marks a session waiting and reads it back with its timestamp', () => {
    const { store } = setup();
    const record = store.mark('Demo-1', '2026-09-22T10:00:00.000Z');
    expect(record).toEqual({ sessionId: 'Demo-1', waitingAt: '2026-09-22T10:00:00.000Z' });
    expect(store.get('Demo-1')).toEqual(record);
  });

  it('keeps the original timestamp when the same session is marked again', () => {
    const { store } = setup();
    store.mark('Demo-1', '2026-09-22T10:00:00.000Z');
    expect(store.mark('Demo-1', '2026-09-22T11:00:00.000Z')).toEqual({
      sessionId: 'Demo-1',
      waitingAt: '2026-09-22T10:00:00.000Z',
    });
  });

  it('clears a waiting session and tolerates clearing an unmarked one', () => {
    const { store } = setup();
    store.mark('Demo-1', '2026-09-22T10:00:00.000Z');
    store.clear('Demo-1');
    expect(store.get('Demo-1')).toBeNull();
    expect(() => store.clear('Demo-1')).not.toThrow();
  });

  it('lists every waiting record ordered by session id', () => {
    const { store } = setup();
    store.mark('Demo-2', '2026-09-22T10:00:00.000Z');
    store.mark('Demo-1', '2026-09-22T09:00:00.000Z');
    expect(store.list()).toEqual([
      { sessionId: 'Demo-1', waitingAt: '2026-09-22T09:00:00.000Z' },
      { sessionId: 'Demo-2', waitingAt: '2026-09-22T10:00:00.000Z' },
    ]);
  });

  it('survives a reopen of the same database file', () => {
    const { db } = setup();
    createTerminalWaitingStore(db).mark('Demo-1', '2026-09-22T10:00:00.000Z');
    expect(createTerminalWaitingStore(db).get('Demo-1')).toEqual({
      sessionId: 'Demo-1',
      waitingAt: '2026-09-22T10:00:00.000Z',
    });
  });

  it.each([
    ['an empty session id', '', '2026-09-22T10:00:00.000Z'],
    ['a blank session id', '   ', '2026-09-22T10:00:00.000Z'],
    ['a null session id', null, '2026-09-22T10:00:00.000Z'],
    ['a non-string session id', 42, '2026-09-22T10:00:00.000Z'],
    ['a missing timestamp', 'Demo-1', null],
    ['a non-ISO timestamp', 'Demo-1', 'yesterday'],
    ['a non-string timestamp', 'Demo-1', 1758535200000],
  ])('rejects %s', (_label, sessionId, waitingAt) => {
    const { store } = setup();
    expect(() => store.mark(sessionId, waitingAt)).toThrow();
  });

  it('rejects reading or clearing with an invalid session id', () => {
    const { store } = setup();
    expect(() => store.get('')).toThrow();
    expect(() => store.clear(null)).toThrow();
  });

  it('rejects a row whose persisted identity does not match its key', () => {
    const { db, store } = setup();
    db.prepare('INSERT INTO terminal_waiting (session_id, waiting_at) VALUES (?, ?)').run('Demo-1', '');
    expect(() => store.get('Demo-1')).toThrow();
  });
});
