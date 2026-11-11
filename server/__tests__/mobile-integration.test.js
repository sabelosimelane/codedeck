import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMobileStore } from '../mobile-store.js';
import { createMobileDiscovery } from '../mobile-integration.js';
function attentionDeps(overrides = {}) {
  const seen = new Map();
  return {
    attention: { knows: id => seen.has(id), observe: vi.fn(({ sessionId, status, activityHint }) => { if (!seen.has(sessionId)) seen.set(sessionId, { activity: activityHint }); seen.get(sessionId).status = status; }) },
    describeState: id => ({ sessionId: id, finished: false, muted: false, waiting: false, lastActivityAt: seen.get(id)?.activity ?? null }),
    getSessionActivity: vi.fn(async () => 777000),
    ...overrides,
  };
}
it('refreshes detached remote sessions without a browser and preserves freshness and incarnation', async () => {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  const hostRuntime = {};
  const record = { executionState: { executionStatus: 'running', needsInput: true }, updatedAt: 123 };
  const cache = { refreshSessionList: vi.fn(async () => ['Demo-1']), refreshSession: vi.fn(async () => record) };
  const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 123, getSessionIncarnation: async id => store.ensureIncarnation(id), store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: cache,
    loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => ({ host: 'remote', hostRuntime }), getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => ({ title: 'Agent' }) } });
  const listed = await discovery.listSessions();
  expect(listed[0]).toMatchObject({ id: 'Demo-1', title: 'Agent', projectId: 'Demo', host: 'remote', status: 'running', live: true, incarnationId: store.currentIncarnation('Demo-1') });
  expect(listed[0].needsInput).toBe(true);
  expect(cache.refreshSession.mock.calls[0][0]).toMatchObject({ hostRuntime, alive: true });
  expect(await discovery.listObservations()).toEqual([{ sessionId: 'Demo-1', incarnationId: store.currentIncarnation('Demo-1'), executionStatus: 'running', workflowStatus: null, needsInput: true, observedAt: 123, reachable: true }]);
  record.executionState.executionStatus = 'unknown';
  expect((await discovery.listSessions())[0].live).toBe(false);
  db.close();
});
it('reports workflow transitions independently, never calls unreachable hosts dead, retires confirmed exits', async () => {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  const entries = new Map([['Demo-1', { alive: true, host: 'remote', cwd: '/x', workflow: { snapshot: () => ({ status: 'needs_input' }) } }]]);
  let reachable = 'unreachable';
  const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 123, getSessionIncarnation: async id => store.ensureIncarnation(id), store, sessions: entries, deletedSessionIds: new Set(), statusCache: { refreshSessionList: async () => [], refreshSession: async () => ({ executionState: { executionStatus: 'idle' }, updatedAt: 123 }) }, loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => null, getReachability: () => ({ reachability: reachable }), namingStore: { get: () => null } });
  expect((await discovery.listObservations())[0]).toMatchObject({ executionStatus: 'unknown', reachable: false });
  reachable = 'reachable';
  expect((await discovery.listObservations())[0].workflowStatus).toBe('needs_input');
  entries.get('Demo-1').alive = false;
  expect((await discovery.listObservations())[0].executionStatus).toBe('dead');
  expect(store.currentIncarnation('Demo-1')).toBeNull();
  db.close();
});
it('retires a durable detached session after an authoritative dead status', async () => {
  const db = new Database(':memory:'); const store = createMobileStore(db); const original = store.ensureIncarnation('Demo-1');
  try {
    const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 123, getSessionIncarnation: async id => store.ensureIncarnation(id), store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: { refreshSessionList: async () => ['Demo-1'], refreshSession: async () => ({ executionState: { executionStatus: 'dead' }, updatedAt: 123 }) }, loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => null, getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => null } });
    expect((await discovery.listObservations())[0]).toMatchObject({ incarnationId: original, executionStatus: 'dead' });
    expect(store.currentIncarnation('Demo-1')).toBeNull();
  } finally { db.close(); }
});
it('uses tmux identity to replace an old registry incarnation after backend downtime', async () => {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  const old = store.ensureIncarnation('Demo-1');
  const actual = 'ab140f48-1848-4330-8723-940c478e7267';
  try {
    const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 123, store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: { refreshSessionList: async () => ['Demo-1'], refreshSession: async () => ({ executionState: { executionStatus: 'idle' }, updatedAt: 123 }) }, loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => null, getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => null }, getSessionIncarnation: async () => actual });
    expect((await discovery.listSessions())[0].incarnationId).toBe(actual);
    expect(store.currentIncarnation('Demo-1')).not.toBe(old);
  } finally { db.close(); }
});
it('bounds the entire status and identity pipeline to four concurrent sessions and preserves order', async () => {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  const ids = Array.from({ length: 12 }, (_, i) => `Demo-${i + 1}`); let active = 0; let maxActive = 0;
  const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 123, store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: { refreshSessionList: async () => ids, refreshSession: async () => ({ executionState: { executionStatus: 'running' }, updatedAt: 123 }) }, loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => null, getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => null }, getSessionIncarnation: async id => { active += 1; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 1)); active -= 1; return store.ensureIncarnation(id); } });
  try { expect((await discovery.listSessions()).map(r => r.id)).toEqual(ids); expect(maxActive).toBeLessThanOrEqual(4); } finally { db.close(); }
});
it('isolates an identified transport failure as unknown while other sessions remain live', async () => {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 123, store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: { refreshSessionList: async () => ['Demo-1', 'Demo-2'], refreshSession: async () => ({ executionState: { executionStatus: 'running' }, updatedAt: 123 }) }, loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => null, getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => null }, getSessionIncarnation: async id => { if (id === 'Demo-1') throw Object.assign(new Error('connection lost'), { code: 255 }); return store.ensureIncarnation(id); } });
  try { const records = await discovery.listSessions(); expect(records[0]).toMatchObject({ id: 'Demo-1', status: 'unknown', live: false }); expect(records[1]).toMatchObject({ id: 'Demo-2', status: 'running', live: true }); } finally { db.close(); }
});
it.each([0, 1, 100001])('reports epoch/stale/future observation timestamp %i as unknown without an identity probe', async updatedAt => {
  const db = new Database(':memory:'); const store = createMobileStore(db); const getSessionIncarnation = vi.fn(async id => store.ensureIncarnation(id));
  const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 100000, store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: { refreshSessionList: async () => ['Demo-1'], refreshSession: async () => ({ executionState: { executionStatus: 'idle' }, updatedAt }) }, loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => null, getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => null }, getSessionIncarnation });
  try { expect((await discovery.listSessions())[0]).toMatchObject({ status: 'unknown', live: false }); expect(getSessionIncarnation).not.toHaveBeenCalled(); } finally { db.close(); }
});
it('does not mask a domain validation failure as a transient transport problem', async () => {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 123, store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: { refreshSessionList: async () => ['Demo-1'], refreshSession: async () => ({ executionState: { executionStatus: 'running' }, updatedAt: 123 }) }, loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => null, getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => null }, getSessionIncarnation: async () => { throw new Error('Invalid terminal incarnation'); } });
  try { await expect(discovery.listSessions()).rejects.toThrow('Invalid terminal incarnation'); } finally { db.close(); }
});
it('measures freshness after an awaited status probe rather than rejecting its newer timestamp', async () => {
  const db = new Database(':memory:'); const store = createMobileStore(db); let clock = 1000;
  const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => clock, store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: { refreshSessionList: async () => ['Demo-1'], refreshSession: async () => { clock = 1100; return { executionState: { executionStatus: 'running' }, updatedAt: clock }; } }, loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => null, getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => null }, getSessionIncarnation: async id => store.ensureIncarnation(id) });
  try { expect((await discovery.listSessions())[0]).toMatchObject({ status: 'running', live: true }); } finally { db.close(); }
});
it('describes each project as active, waiting or shelved using the desktop sidebar precedence', () => {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 123, getSessionIncarnation: async id => store.ensureIncarnation(id), store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: { refreshSessionList: async () => [], refreshSession: async () => null },
    loadProjects: () => [
      { name: 'Live', shelved: false, shelvedAt: null, waiting: false, waitingAt: null },
      { name: 'Parked', shelved: false, shelvedAt: null, waiting: true, waitingAt: '2026-11-02T08:00:00.000Z' },
      { name: 'Shelf', shelved: true, shelvedAt: '2026-11-01T10:00:00.000Z', waiting: true, waitingAt: '2026-10-01T10:00:00.000Z' },
      { name: 'Legacy', shelved: true },
    ],
    resolveHostRuntime: () => null, getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => null } });
  expect(discovery.listProjects()).toEqual([
    { id: 'Live', name: 'Live', state: 'active', stateChangedAt: null },
    { id: 'Parked', name: 'Parked', state: 'waiting', stateChangedAt: '2026-11-02T08:00:00.000Z' },
    { id: 'Shelf', name: 'Shelf', state: 'shelved', stateChangedAt: '2026-11-01T10:00:00.000Z' },
    { id: 'Legacy', name: 'Legacy', state: 'shelved', stateChangedAt: null },
  ]);
  db.close();
});
it('lists detached sessions of projects whose names tmux sanitized, under their real ids', async () => {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const discovery = createMobileDiscovery({ ...attentionDeps(), now: () => 123, getSessionIncarnation: async id => store.ensureIncarnation(id), store,
      sessions: new Map([['Equinox Local-16', { alive: true, cwd: '/x' }]]), deletedSessionIds: new Set(),
      statusCache: { refreshSessionList: async () => ['Equinox_Local-15', 'Equinox_Local-16', 'A_B-1', 'Plain-2', 'Stranger-1'], refreshSession: async () => ({ executionState: { executionStatus: 'idle' }, updatedAt: 123 }) },
      loadProjects: () => [{ name: 'Equinox Local' }, { name: 'A B' }, { name: 'A?B' }, { name: 'Plain' }],
      resolveHostRuntime: () => null, getReachability: () => ({ reachability: 'reachable' }), namingStore: { get: () => null } });
    const ids = (await discovery.listSessions()).map(session => session.id).sort();
    expect(ids).toEqual(['Equinox Local-15', 'Equinox Local-16', 'Plain-2']);
    expect(warn.mock.calls.map(args => args.join(' ')).join('\n')).toContain('A_B-1');
  } finally { warn.mockRestore(); db.close(); }
});

function discoveryWith({ deps = attentionDeps(), sessions = new Map(), ids = ['Demo-1'], status = 'idle', reachable = 'reachable' } = {}) {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  const discovery = createMobileDiscovery({ ...deps, now: () => 123, getSessionIncarnation: async id => store.ensureIncarnation(id), store, sessions, deletedSessionIds: new Set(),
    statusCache: { refreshSessionList: async () => ids, refreshSession: async () => ({ executionState: { executionStatus: status }, updatedAt: 123 }) },
    loadProjects: () => [{ name: 'Demo' }], resolveHostRuntime: () => null, getReachability: () => ({ reachability: reachable }), namingStore: { get: () => null } });
  return { discovery, deps, db };
}
it('feeds every reading to the attention tracker and publishes the shared state', async () => {
  const { discovery, deps, db } = discoveryWith({ status: 'running' });
  const [session] = await discovery.listSessions();
  expect(deps.attention.observe).toHaveBeenCalledWith({ sessionId: 'Demo-1', status: 'running', activityHint: 777000 });
  expect(session).toMatchObject({ finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: 777000 });
  db.close();
});
it('asks tmux for a detached session\'s activity only the first time it is seen', async () => {
  const { discovery, deps, db } = discoveryWith();
  await discovery.listSessions(); await discovery.listSessions();
  expect(deps.getSessionActivity).toHaveBeenCalledTimes(1);
  expect(deps.attention.observe).toHaveBeenLastCalledWith({ sessionId: 'Demo-1', status: 'idle' });
  db.close();
});
it('seeds an attached session from its own output time without asking tmux', async () => {
  const sessions = new Map([['Demo-1', { alive: true, cwd: '/x', startedAt: '2026-11-10T10:00:00.000Z', lastSubstantialOutputAt: '2026-11-10T12:00:00.000Z' }]]);
  const { discovery, deps, db } = discoveryWith({ sessions, ids: [] });
  expect((await discovery.listSessions())[0].lastActivityAt).toBe(Date.parse('2026-11-10T12:00:00.000Z'));
  expect(deps.getSessionActivity).not.toHaveBeenCalled();
  db.close();
});
it('reports a workflow waiting on the user as needing input', async () => {
  const sessions = new Map([['Demo-1', { alive: true, cwd: '/x', startedAt: '2026-11-10T10:00:00.000Z', workflow: { snapshot: () => ({ status: 'needs_input' }) } }]]);
  const { discovery, db } = discoveryWith({ sessions, ids: [] });
  expect((await discovery.listSessions())[0].needsInput).toBe(true);
  db.close();
});
it('leaves activity unknown, and invents nothing, for a never-seen session on an unreachable host', async () => {
  const { discovery, deps, db } = discoveryWith({ reachable: 'unreachable' });
  const [session] = await discovery.listSessions();
  expect(session).toMatchObject({ status: 'unknown', lastActivityAt: null });
  expect(deps.attention.observe).not.toHaveBeenCalled(); expect(deps.getSessionActivity).not.toHaveBeenCalled();
  db.close();
});
it('treats a transport failure while reading activity as unknown but propagates real faults', async () => {
  const transport = attentionDeps({ getSessionActivity: vi.fn(async () => { throw Object.assign(new Error('connection lost'), { code: 255 }); }) });
  const first = discoveryWith({ deps: transport });
  expect((await first.discovery.listSessions())[0].lastActivityAt).toBeNull(); first.db.close();
  const broken = attentionDeps({ getSessionActivity: vi.fn(async () => { throw new Error('Invalid tmux activity'); }) });
  const second = discoveryWith({ deps: broken });
  await expect(second.discovery.listSessions()).rejects.toThrow('Invalid tmux activity'); second.db.close();
});
it.each(['attention', 'describeState', 'getSessionActivity'])('requires %s', field => {
  const db = new Database(':memory:'); const store = createMobileStore(db);
  expect(() => createMobileDiscovery({ ...attentionDeps(), [field]: undefined, store, sessions: new Map(), deletedSessionIds: new Set(), statusCache: {}, loadProjects: () => [], resolveHostRuntime: () => null, getReachability: () => null, namingStore: {}, getSessionIncarnation: async () => null })).toThrow();
  db.close();
});
