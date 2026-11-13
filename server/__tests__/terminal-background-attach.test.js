import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachBackgroundSession, handleWsConnection } from '../ws-handler.js';

function createMockPty() {
  const dataListeners = [];
  const exitListeners = [];
  return {
    onData(cb) { dataListeners.push(cb); },
    onExit(cb) { exitListeners.push(cb); },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    emitData(data) { dataListeners.forEach(cb => cb(data)); },
  };
}

function createMockWs() {
  const listeners = {};
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on(event, cb) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    _emit(event, data) {
      (listeners[event] || []).forEach(cb => cb(data));
    },
  };
}

function createMockRuntime(spawnFn, opts = {}) {
  return {
    type: opts.type || 'tmux',
    spawn: vi.fn(spawnFn),
    kill: vi.fn(entry => { entry.pty.kill(); }),
    isAvailable: vi.fn(() => true),
    isSessionRecoverable: vi.fn(() => opts.recoverable ?? true),
    resizeSession: vi.fn(),
    captureSessionSnapshot: vi.fn(() => ({
      data: '',
      lineCount: 0,
      windowLines: 10000,
      historyGuaranteed: true,
      historyWarningReason: null,
      historyWarningMessage: null,
    })),
    getSessionIncarnation: vi.fn(() => 'incarnation-1'),
  };
}

function createMockReq({ sessionId = 'demo-1', cwd = '/tmp/work', cols = 120, rows = 32 } = {}) {
  const params = new URLSearchParams({ protocol: '2', sessionId, cwd, cols: String(cols), rows: String(rows) });
  return { url: `/ws/terminal?${params}` };
}

describe('attachBackgroundSession', () => {
  let pty;
  let sessions;
  let deletedSessionIds;
  let runtime;

  beforeEach(() => {
    vi.useFakeTimers();
    pty = createMockPty();
    sessions = new Map();
    deletedSessionIds = new Set();
    runtime = createMockRuntime(() => pty, { recoverable: true });
  });
  afterEach(() => vi.useRealTimers());

  it('creates an entry with no socket, exposes write/observe/release, and reuses the loop engine for a later browser', () => {
    const handle = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, {
      cwd: '/tmp/work',
    });
    expect(sessions.get('demo-1')).toBe(handle.entry);
    expect(handle.entry.ws).toBeNull();
    expect(handle.entry.wsAttached).toBe(false);
    expect(handle.entry.backgroundHolds).toBe(1);
    expect(handle.workflow).toBe(handle.entry.workflow);

    const observed = [];
    handle.observe(state => observed.push(state));
    handle.workflow.start({
      requestId: 'bg-1',
      command: '/feature-dev demo.md',
      resetCommand: '/clear',
      maxIterations: 2,
    });
    expect(pty.write).toHaveBeenCalled();
    expect(observed.at(-1)).toMatchObject({ status: 'running', active: true, iteration: 1 });

    const ws = createMockWs();
    handleWsConnection(ws, createMockReq(), sessions, runtime, deletedSessionIds, new Set());
    expect(sessions.get('demo-1').workflow).toBe(handle.workflow);
    const sent = ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(sent).toContainEqual(expect.objectContaining({
      type: 'workflow_state',
      state: expect.objectContaining({ status: 'running', active: true }),
    }));
  });

  it('keeps the background hold when a browser attaches and leaves', () => {
    const handle = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    const ws = createMockWs();
    handleWsConnection(ws, createMockReq(), sessions, runtime, deletedSessionIds, new Set());
    expect(handle.entry.wsAttached).toBe(true);
    ws.readyState = 3;
    ws._emit('close');
    expect(handle.entry.wsAttached).toBe(false);
    expect(handle.entry.backgroundHolds).toBe(1);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(handle.entry.alive).toBe(true);
  });

  it('release decrements the hold and detaches when no browser is attached', () => {
    const handle = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    expect(handle.entry.backgroundHolds).toBe(1);
    handle.release();
    expect(handle.entry.backgroundHolds).toBe(0);
    expect(pty.kill).toHaveBeenCalled();
    expect(handle.entry.alive).toBe(false);
    expect(handle.entry.clientDetached).toBe(true);
  });

  it('ignores a second release on the same handle so another hold stays intact', () => {
    const first = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    const second = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    expect(first.entry.backgroundHolds).toBe(2);
    first.release();
    first.release();
    expect(first.entry.backgroundHolds).toBe(1);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(first.entry.alive).toBe(true);
    second.release();
  });

  it.each(['relative/path', '', null])('rejects non-absolute background cwd %#', cwd => {
    expect(() => attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd }))
      .toThrow(/cwd/);
    expect(sessions.has('demo-1')).toBe(false);
  });

  it('release does not detach while a browser is still attached', () => {
    const handle = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    const ws = createMockWs();
    handleWsConnection(ws, createMockReq(), sessions, runtime, deletedSessionIds, new Set());
    handle.release();
    expect(handle.entry.backgroundHolds).toBe(0);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(handle.entry.alive).toBe(true);
  });

  it('rejects a tombstoned session id', () => {
    deletedSessionIds.add('demo-1');
    expect(() => attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' }))
      .toThrow(/deleted|tombstone/i);
    expect(sessions.has('demo-1')).toBe(false);
  });

  it('respawns a dead recoverable entry and reuses its workflow when present', () => {
    const first = createMockPty();
    runtime = createMockRuntime(() => first, { recoverable: true });
    const handle = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    const workflow = handle.workflow;
    handle.entry.alive = false;
    handle.entry.clientDetached = true;
    const second = createMockPty();
    runtime.spawn = vi.fn(() => second);
    const again = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    expect(again.entry).toBe(handle.entry);
    expect(again.workflow).toBe(workflow);
    expect(again.entry.pty).toBe(second);
    expect(again.entry.alive).toBe(true);
    expect(again.entry.backgroundHolds).toBe(2);
    again.release();
    handle.release();
  });

  it('attaches to a live entry without respawning', () => {
    const handle = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
    const again = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    expect(again.entry).toBe(handle.entry);
    expect(again.entry.backgroundHolds).toBe(2);
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
  });

  it('calls observers on workflow notify and stops after release', () => {
    const handle = attachBackgroundSession('demo-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' });
    const observer = vi.fn();
    handle.observe(observer);
    handle.workflow.start({ requestId: 'bg-1', command: 'cmd', resetCommand: '/clear' });
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
    const calls = observer.mock.calls.length;
    handle.release();
    handle.workflow.stop();
    expect(observer).toHaveBeenCalledTimes(calls);
  });

  it('rejects when the session is not recoverable and no entry exists', () => {
    runtime = createMockRuntime(() => pty, { recoverable: false });
    expect(() => attachBackgroundSession('missing-1', sessions, runtime, deletedSessionIds, { cwd: '/tmp/work' }))
      .toThrow(/not recoverable|does not exist|ended/i);
  });
});
