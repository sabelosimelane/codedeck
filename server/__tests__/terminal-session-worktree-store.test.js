import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createTerminalSessionWorktreeStore } from '../terminal-session-worktree-store.js';
import { pruneTerminalSessions } from '../session-gc.js';
import { listTerminalSessions } from '../terminal-session-status-service.js';

const databases = [];
function setup() {
  const db = new Database(':memory:');
  databases.push(db);
  return { db, store: createTerminalSessionWorktreeStore(db) };
}
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe('terminal session worktree store', () => {
  const row = { sessionId: 'Demo-1', project: 'Demo', worktreePath: '/tmp/demo-worktree', createdAt: '2026-11-17T10:00:00.000Z' };

  it('sets, replaces, lists and clears a mapping', () => {
    const { store } = setup();
    expect(store.get(row.sessionId)).toBeNull();
    store.set(row);
    expect(store.get(row.sessionId)).toEqual(row);
    store.set({ ...row, worktreePath: '/tmp/second' });
    expect(store.all()).toEqual([{ ...row, worktreePath: '/tmp/second' }]);
    store.clear(row.sessionId);
    expect(store.all()).toEqual([]);
  });

  it.each([
    [{ ...row, sessionId: '' }, 'sessionId'],
    [{ ...row, sessionId: null }, 'sessionId'],
    [{ ...row, project: null }, 'project'],
    [{ ...row, project: '' }, 'project'],
    [{ ...row, worktreePath: '' }, 'worktreePath'],
    [{ ...row, worktreePath: 'relative/path' }, 'worktreePath'],
    [{ ...row, worktreePath: null }, 'worktreePath'],
    [{ ...row, createdAt: 'yesterday' }, 'createdAt'],
    [{ ...row, createdAt: null }, 'createdAt'],
  ])('rejects invalid field on write', (bad, field) => {
    const { store } = setup();
    expect(() => store.set(bad)).toThrow(field);
  });

  it.each([
    ['session_id', ''],
    ['project', ''],
    ['worktree_path', 'relative/path'],
    ['created_at', 'yesterday'],
  ])('rejects corrupt %s on read', (field, value) => {
    const { db, store } = setup();
    store.set(row);
    db.prepare(`UPDATE terminal_session_worktree SET ${field} = ?`).run(value);
    expect(() => store.all()).toThrow();
  });

  it('clears a mapping on prune and an allocated-again session id reports no worktree', () => {
    const { store } = setup();
    store.set(row);
    const sessions = new Map([[row.sessionId, { alive: false, wsAttached: false, startedAt: '2026-11-17T10:00:00.000Z' }]]);
    pruneTerminalSessions({ sessions, runtime: { isSessionRecoverable: () => false, kill: () => {} }, nowMs: Date.parse('2026-11-17T10:01:00.000Z'), onPruned: id => store.clear(id) });
    expect(store.get(row.sessionId)).toBeNull();
    sessions.set(row.sessionId, { cwd: '/tmp/demo', startedAt: row.createdAt, lastOutputAt: null, lastOutputLine: '', alive: false });
    const [status] = listTerminalSessions({ sessions, runtime: { type: 'tmux', listSessionIds: () => [] }, projects: [{ name: 'Demo', path: '/tmp/demo' }], computeHealth: () => 'dead', computeStallReason: () => null, sanitizePreviewLine: value => value, worktreeStore: store });
    expect(status.worktreePath).toBeNull();
  });
});
