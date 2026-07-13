import { describe, it, expect, vi } from 'vitest';
import { handleWsConnection, computeSessionHealth, reseedRemoteDetachedSessions } from '../ws-handler.js';

// ---------------------------------------------------------------------------
// Harness — mirrors the mock factories used by ws-handler.test.js, plus a fake
// host terminal runtime standing in for an SSH-routed tmux (Spec §9: fake
// runner implementation, no real remote machine).
// ---------------------------------------------------------------------------

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
    emitExit(info) { exitListeners.forEach(cb => cb(info)); },
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

function createMockReq({ sessionId, cwd, cols, rows } = {}) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  if (cwd) params.set('cwd', cwd);
  if (cols) params.set('cols', String(cols));
  if (rows) params.set('rows', String(rows));
  return { url: `/ws/terminal?${params.toString()}` };
}

function createLocalRuntime(overrides = {}) {
  return {
    type: 'tmux',
    spawn: vi.fn(() => createMockPty()),
    kill: vi.fn(),
    isAvailable: vi.fn(() => true),
    getPtySpawnStatus: vi.fn(() => ({ available: true, error: null })),
    isSessionRecoverable: vi.fn(() => false),
    resizeSession: vi.fn(),
    captureSessionSnapshot: vi.fn(() => ({ data: '', lineCount: 0, windowLines: 10000, historyGuaranteed: true })),
    ...overrides,
  };
}

function transportError(message = 'connect timeout') {
  return Object.assign(new Error(message), { code: 255 });
}

function createFakeHostRuntime(opts = {}) {
  const runtime = {
    type: 'tmux',
    host: opts.host ?? 'devbox',
    ptys: [],
    checkTmuxAsync: vi.fn(async () => opts.tmuxCheck ?? { available: true, transport: false, error: null }),
    isSessionRecoverableAsync: vi.fn(async () => {
      if (opts.recoverableError) throw opts.recoverableError;
      return opts.recoverable ?? false;
    }),
    spawnAsync: vi.fn(async () => {
      if (opts.spawnError) throw opts.spawnError;
      const pty = createMockPty();
      runtime.ptys.push(pty);
      return pty;
    }),
    killAsync: vi.fn(async () => {}),
    captureSessionSnapshotAsync: vi.fn(async () => ({
      data: opts.snapshotData ?? 'remote-snapshot\r\n',
      lineCount: 1,
      windowLines: 10000,
      historyGuaranteed: true,
    })),
    resizeSessionAsync: vi.fn(async () => {}),
  };
  return runtime;
}

function sentMessages(ws) {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
}

async function flushAsync(times = 4) {
  for (let i = 0; i < times; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function attachRemote({
  sessionId = 'rp-1',
  cwd = '/srv/app',
  sessions = new Map(),
  hostRuntime = createFakeHostRuntime(),
  localRuntime = createLocalRuntime(),
  getReachability,
  deleted = new Set(),
  reserved = new Set(),
  ws = createMockWs(),
} = {}) {
  const result = handleWsConnection(
    ws,
    createMockReq({ sessionId, cwd, cols: 100, rows: 40 }),
    sessions,
    localRuntime,
    deleted,
    reserved,
    {
      resolveHostRuntime: () => ({ host: hostRuntime.host, hostRuntime }),
      getReachability,
    }
  );
  return { ws, sessions, hostRuntime, localRuntime, result };
}

// ---------------------------------------------------------------------------
// Remote attach
// ---------------------------------------------------------------------------

describe('remote session attach', () => {
  it('spawns through the host runtime, never the local runtime', async () => {
    const { ws, sessions, hostRuntime, localRuntime, result } = attachRemote();
    await result;

    expect(hostRuntime.spawnAsync).toHaveBeenCalledWith({ cwd: '/srv/app', cols: 100, rows: 40, sessionId: 'rp-1' });
    expect(localRuntime.spawn).not.toHaveBeenCalled();

    const entry = sessions.get('rp-1');
    expect(entry.host).toBe('devbox');
    expect(entry.hostRuntime).toBe(hostRuntime);
    expect(entry.runtimeType).toBe('tmux');

    const handshake = sentMessages(ws).find(m => m.type === 'session');
    expect(handshake).toMatchObject({ sessionId: 'rp-1', runtimeType: 'tmux' });
  });

  it('is not blocked by a missing LOCAL tmux — the requirement is per host (§8.3)', async () => {
    const { sessions, result } = attachRemote({
      localRuntime: createLocalRuntime({ isAvailable: vi.fn(() => false) }),
    });
    await result;
    expect(sessions.has('rp-1')).toBe(true);
  });

  it('blocks creation when the HOST lacks tmux, naming the host', async () => {
    const hostRuntime = createFakeHostRuntime({
      tmuxCheck: { available: false, transport: false, error: 'tmux: command not found' },
    });
    const { ws, sessions, result } = attachRemote({ hostRuntime });
    await result;

    const error = sentMessages(ws).find(m => m.type === 'spawn_error');
    expect(error.reason).toBe('missing_tmux');
    expect(error.message).toContain('devbox');
    expect(hostRuntime.spawnAsync).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
    expect(ws.close).toHaveBeenCalled();
  });

  it('fails fast without touching the host runtime when reachability is already unreachable', async () => {
    const hostRuntime = createFakeHostRuntime();
    const { ws, result } = attachRemote({
      hostRuntime,
      getReachability: () => ({ reachability: 'unreachable', lastError: 'connect timeout' }),
    });
    await result;

    const error = sentMessages(ws).find(m => m.type === 'spawn_error');
    expect(error).toMatchObject({ reason: 'host_unreachable', host: 'devbox' });
    expect(hostRuntime.checkTmuxAsync).not.toHaveBeenCalled();
    expect(hostRuntime.spawnAsync).not.toHaveBeenCalled();
  });

  it('fails the attach distinctly when the host is unreachable', async () => {
    const hostRuntime = createFakeHostRuntime({
      tmuxCheck: { available: false, transport: true, error: 'connect timeout' },
    });
    const { ws, result } = attachRemote({ hostRuntime });
    await result;

    const error = sentMessages(ws).find(m => m.type === 'spawn_error');
    expect(error.reason).toBe('host_unreachable');
    expect(error.message).toContain('devbox');
    expect(error.host).toBe('devbox');
  });

  it('honors the deleted-session guard for remote sessions', async () => {
    const { ws, hostRuntime, result } = attachRemote({ deleted: new Set(['rp-1']) });
    await result;
    expect(ws.close).toHaveBeenCalledWith(4002, 'session_deleted');
    expect(hostRuntime.checkTmuxAsync).not.toHaveBeenCalled();
  });

  it('performs a snapshot-first durable recovery when the remote tmux session survives without an entry', async () => {
    const hostRuntime = createFakeHostRuntime({ recoverable: true, snapshotData: 'preserved-remote\r\n' });
    const { ws, result } = attachRemote({ hostRuntime });
    await result;

    const messages = sentMessages(ws);
    const handshake = messages.find(m => m.type === 'session');
    const snapshot = messages.find(m => m.type === 'snapshot');
    expect(handshake.existing).toBe(true);
    expect(snapshot.data).toBe('preserved-remote\r\n');
    expect(hostRuntime.captureSessionSnapshotAsync).toHaveBeenCalled();
    expect(hostRuntime.resizeSessionAsync).toHaveBeenCalledWith('rp-1', 100, 40);
  });

  it('reseeds from a fresh remote snapshot on reconnect and takes over the old socket', async () => {
    const sessions = new Map();
    const hostRuntime = createFakeHostRuntime({ snapshotData: 'fresh-reseed\r\n' });
    const first = attachRemote({ sessions, hostRuntime });
    await first.result;

    const secondWs = createMockWs();
    const second = attachRemote({ sessions, hostRuntime, ws: secondWs });
    await second.result;

    expect(first.ws.close).toHaveBeenCalledWith(4001, 'session_taken_over');
    const snapshot = sentMessages(secondWs).find(m => m.type === 'snapshot');
    expect(snapshot.data).toBe('fresh-reseed\r\n');
    expect(sessions.get('rp-1').ws).toBe(secondWs);
  });
});

// ---------------------------------------------------------------------------
// Remote PTY exit — detach-vs-dead classification (§8.4)
// ---------------------------------------------------------------------------

describe('remote PTY exit classification', () => {
  it('re-attaches when the remote tmux session still exists (recoverable, not dead)', async () => {
    const hostRuntime = createFakeHostRuntime();
    const { ws, sessions, result } = attachRemote({ hostRuntime });
    await result;

    hostRuntime.isSessionRecoverableAsync.mockResolvedValue(true);
    hostRuntime.ptys[0].emitExit();
    await flushAsync();

    const entry = sessions.get('rp-1');
    expect(hostRuntime.spawnAsync).toHaveBeenCalledTimes(2);
    expect(entry.alive).toBe(true);
    expect(entry.pty).toBe(hostRuntime.ptys[1]);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('treats an SSH drop as a recoverable detach — never a death (§8.2)', async () => {
    const hostRuntime = createFakeHostRuntime();
    const { ws, sessions, result } = attachRemote({ hostRuntime });
    await result;

    hostRuntime.isSessionRecoverableAsync.mockRejectedValue(transportError());
    hostRuntime.ptys[0].emitExit();
    await flushAsync();

    const entry = sessions.get('rp-1');
    expect(entry.alive).toBe(false);
    expect(entry.remoteDetached).toBe(true);
    // The browser socket stays open — the session is suspended, not dead.
    expect(ws.close).not.toHaveBeenCalled();
    expect(entry.events.some(e => e.type === 'remote_ssh_drop')).toBe(true);
    // Every status surface must agree: never 'dead' on transport evidence (§8.2).
    expect(computeSessionHealth(entry)).not.toBe('dead');
    expect(computeSessionHealth(entry)).toBe('detached');
  });

  it('marks the session dead only on a definitive tmux answer', async () => {
    const hostRuntime = createFakeHostRuntime();
    const { ws, sessions, result } = attachRemote({ hostRuntime });
    await result;

    hostRuntime.isSessionRecoverableAsync.mockResolvedValue(false);
    hostRuntime.ptys[0].emitExit();
    await flushAsync();

    const entry = sessions.get('rp-1');
    expect(entry.alive).toBe(false);
    expect(entry.remoteDetached).toBeFalsy();
    expect(ws.close).toHaveBeenCalled();
  });

  it('does not respawn an orphan attachment when the browser detaches during the exit probe', async () => {
    const hostRuntime = createFakeHostRuntime();
    const { ws, sessions, result } = attachRemote({ hostRuntime });
    await result;

    let releaseProbe;
    hostRuntime.isSessionRecoverableAsync.mockImplementation(() => new Promise((resolve) => {
      releaseProbe = () => resolve(true);
    }));
    hostRuntime.ptys[0].emitExit(); // transient SSH drop — recovery probe in flight
    ws._emit('close');              // browser closes mid-probe
    releaseProbe();
    await flushAsync();

    const entry = sessions.get('rp-1');
    // No fresh ssh/tmux attachment may be spawned for a socketless session.
    expect(hostRuntime.spawnAsync).toHaveBeenCalledTimes(1);
    expect(entry.alive).toBe(false);
    expect(entry.clientDetached).toBe(true);
  });

  it('releases the fresh attachment when the browser detaches while the re-attach spawn is in flight', async () => {
    const hostRuntime = createFakeHostRuntime({ recoverable: true });
    const { ws, sessions, result } = attachRemote({ hostRuntime });
    await result;

    const replacementPty = createMockPty();
    let releaseSpawn;
    hostRuntime.spawnAsync.mockImplementation(() => new Promise((resolve) => {
      releaseSpawn = () => resolve(replacementPty);
    }));
    hostRuntime.ptys[0].emitExit();
    await flushAsync(); // probe resolved true; replacement spawn now in flight
    ws._emit('close');  // browser closes mid-spawn
    releaseSpawn();
    await flushAsync();

    const entry = sessions.get('rp-1');
    expect(replacementPty.kill).toHaveBeenCalledTimes(1);
    expect(entry.pty).not.toBe(replacementPty);
    expect(entry.alive).toBe(false);
    expect(entry.clientDetached).toBe(true);
  });

  it('treats a transport failure during re-attach as an SSH drop, not a death', async () => {
    const hostRuntime = createFakeHostRuntime();
    const { ws, sessions, result } = attachRemote({ hostRuntime });
    await result;

    hostRuntime.isSessionRecoverableAsync.mockResolvedValue(true);
    hostRuntime.spawnAsync.mockRejectedValue(transportError());
    hostRuntime.ptys[0].emitExit();
    await flushAsync();

    const entry = sessions.get('rp-1');
    expect(entry.alive).toBe(false);
    expect(entry.remoteDetached).toBe(true);
    expect(ws.close).not.toHaveBeenCalled();
  });
});


describe('remote host recovery reseed', () => {
  it('re-attaches remoteDetached waiting sockets and sends a fresh snapshot when the host recovers', async () => {
    const hostRuntime = createFakeHostRuntime({ recoverable: true, snapshotData: 'recovered-snapshot\r\n' });
    const ws = createMockWs();
    const oldPty = createMockPty();
    const sessions = new Map([
      ['rp-1', {
        host: 'devbox',
        hostRuntime,
        pty: oldPty,
        ws,
        cwd: '/srv/app',
        alive: false,
        remoteDetached: true,
        wsAttached: true,
        runtimeType: 'tmux',
        historyGuaranteed: true,
        historyWarningReason: null,
        historyWarningMessage: null,
        lastSeq: 7,
        replayBuffer: [],
        events: [],
      }],
    ]);

    const reseeded = await reseedRemoteDetachedSessions({ sessions, host: 'devbox', hostRuntime, cols: 120, rows: 30 });

    expect(reseeded).toEqual(['rp-1']);
    expect(hostRuntime.isSessionRecoverableAsync).toHaveBeenCalledWith('rp-1');
    expect(hostRuntime.spawnAsync).toHaveBeenCalledWith({ cwd: '/srv/app', cols: 120, rows: 30, sessionId: 'rp-1' });
    expect(hostRuntime.captureSessionSnapshotAsync).toHaveBeenCalled();
    const entry = sessions.get('rp-1');
    expect(entry.alive).toBe(true);
    expect(entry.remoteDetached).toBe(false);
    expect(entry.pty).toBe(hostRuntime.ptys[0]);
    const messages = sentMessages(ws);
    expect(messages.find(m => m.type === 'session')).toMatchObject({ sessionId: 'rp-1', existing: true, runtimeType: 'tmux' });
    expect(messages.find(m => m.type === 'snapshot').data).toBe('recovered-snapshot\r\n');
  });

  it('does not SSH for sessions on other hosts or sockets that are no longer waiting', async () => {
    const hostRuntime = createFakeHostRuntime({ recoverable: true });
    const sessions = new Map([
      ['other-1', { host: 'prod', hostRuntime, ws: createMockWs(), alive: false, remoteDetached: true, wsAttached: true, runtimeType: 'tmux', events: [], replayBuffer: [] }],
      ['closed-1', { host: 'devbox', hostRuntime, ws: { ...createMockWs(), readyState: 3 }, alive: false, remoteDetached: true, wsAttached: true, runtimeType: 'tmux', events: [], replayBuffer: [] }],
      ['live-1', { host: 'devbox', hostRuntime, ws: createMockWs(), alive: true, remoteDetached: false, wsAttached: true, runtimeType: 'tmux', events: [], replayBuffer: [] }],
    ]);

    await expect(reseedRemoteDetachedSessions({ sessions, host: 'devbox', hostRuntime })).resolves.toEqual([]);
    expect(hostRuntime.isSessionRecoverableAsync).not.toHaveBeenCalled();
    expect(hostRuntime.spawnAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Remote attach lifecycle — races and disconnects during the async window
// ---------------------------------------------------------------------------

describe('remote attach lifecycle', () => {
  it('serializes concurrent attaches for the same session — exactly one spawn, latest socket wins', async () => {
    const sessions = new Map();
    const hostRuntime = createFakeHostRuntime();
    const first = attachRemote({ sessions, hostRuntime });
    const second = attachRemote({ sessions, hostRuntime, ws: createMockWs() });
    await Promise.all([first.result, second.result]);

    expect(hostRuntime.spawnAsync).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(1);
    // The second connection took over the first (existing reconnect semantics).
    expect(first.ws.close).toHaveBeenCalledWith(4001, 'session_taken_over');
    expect(sessions.get('rp-1').ws).toBe(second.ws);
  });

  it('does not resurrect a session deleted while the attach was in flight', async () => {
    const sessions = new Map();
    const deleted = new Set();
    const hostRuntime = createFakeHostRuntime();
    let releaseSpawn;
    hostRuntime.spawnAsync.mockImplementation(() => new Promise((resolve) => {
      releaseSpawn = () => {
        const pty = createMockPty();
        hostRuntime.ptys.push(pty);
        resolve(pty);
      };
    }));

    const { result } = attachRemote({ sessions, hostRuntime, deleted });
    await flushAsync(2);
    // DELETE lands mid-attach: the id is tombstoned and any entry removed.
    deleted.add('rp-1');
    sessions.delete('rp-1');
    releaseSpawn();
    await result;
    await flushAsync();

    expect(sessions.has('rp-1')).toBe(false);
    // The spawned PTY was cleaned up, not leaked.
    expect(hostRuntime.ptys[0].kill).toHaveBeenCalled();
  });

  it('records the detach when the socket closes during the async attach window', async () => {
    const sessions = new Map();
    const hostRuntime = createFakeHostRuntime();
    let releaseSpawn;
    hostRuntime.spawnAsync.mockImplementation(() => new Promise((resolve) => {
      releaseSpawn = () => resolve(createMockPty());
    }));

    const attach = attachRemote({ sessions, hostRuntime });
    await flushAsync(2);
    attach.ws.readyState = 3; // CLOSED while spawn is still in flight
    releaseSpawn();
    await attach.result;

    const entry = sessions.get('rp-1');
    expect(entry.wsAttached).toBe(false);
    expect(entry.lastDetachAt).toBeTruthy();
    expect(entry.pty.kill).toHaveBeenCalledTimes(1);
  });

  it('releases the SSH attachment on browser close without reattaching or killing tmux', async () => {
    const hostRuntime = createFakeHostRuntime({ recoverable: true });
    const { ws, sessions, result } = attachRemote({ hostRuntime });
    await result;
    const entry = sessions.get('rp-1');
    const attachedPty = entry.pty;
    const recoverabilityCalls = hostRuntime.isSessionRecoverableAsync.mock.calls.length;

    ws._emit('close');
    expect(entry.wsAttached).toBe(false);
    expect(entry.alive).toBe(false);
    expect(entry.clientDetached).toBe(true);
    expect(computeSessionHealth(entry)).toBe('detached');
    expect(attachedPty.kill).toHaveBeenCalledTimes(1);

    attachedPty.emitExit({ exitCode: 0 });
    await flushAsync();
    expect(hostRuntime.spawnAsync).toHaveBeenCalledTimes(1);
    expect(hostRuntime.isSessionRecoverableAsync).toHaveBeenCalledTimes(recoverabilityCalls);
    expect(hostRuntime.killAsync).not.toHaveBeenCalled();
  });

  it('recovers if the previous browser closes while a replacement is hydrating', async () => {
    const sessions = new Map();
    const hostRuntime = createFakeHostRuntime({ recoverable: true });
    const first = attachRemote({ sessions, hostRuntime });
    await first.result;

    let releaseSnapshot;
    hostRuntime.captureSessionSnapshotAsync.mockImplementationOnce(() => new Promise((resolve) => {
      releaseSnapshot = () => resolve({
        data: 'fresh snapshot\r\n',
        lineCount: 1,
        windowLines: 10000,
        historyGuaranteed: true,
      });
    }));
    const second = attachRemote({ sessions, hostRuntime, ws: createMockWs() });
    await flushAsync(2);

    first.ws._emit('close');
    expect(sessions.get('rp-1').alive).toBe(false);
    releaseSnapshot();
    await second.result;

    const entry = sessions.get('rp-1');
    expect(hostRuntime.spawnAsync).toHaveBeenCalledTimes(2);
    expect(entry.ws).toBe(second.ws);
    expect(entry.wsAttached).toBe(true);
    expect(entry.alive).toBe(true);
    expect(entry.clientDetached).toBe(false);
  });

  it('fails the attach with spawn_error when the durable session dies while a replacement is hydrating', async () => {
    const sessions = new Map();
    const hostRuntime = createFakeHostRuntime({ recoverable: true });
    const first = attachRemote({ sessions, hostRuntime });
    await first.result;

    let releaseSnapshot;
    hostRuntime.captureSessionSnapshotAsync.mockImplementationOnce(() => new Promise((resolve) => {
      releaseSnapshot = () => resolve({ data: 'stale\r\n', lineCount: 1, windowLines: 10000, historyGuaranteed: true });
    }));
    const second = attachRemote({ sessions, hostRuntime, ws: createMockWs() });
    await flushAsync(2);

    first.ws._emit('close');
    // The remote tmux session terminates in the same window — nothing left to recover.
    hostRuntime.isSessionRecoverableAsync.mockResolvedValue(false);
    releaseSnapshot();
    await second.result;

    // Never a normal handshake wired to a dead PTY — the browser must learn the attach failed.
    const messages = sentMessages(second.ws);
    expect(messages.find(m => m.type === 'session')).toBeUndefined();
    expect(messages.find(m => m.type === 'spawn_error')).toMatchObject({ reason: 'spawn_failed' });
    expect(second.ws.close).toHaveBeenCalled();
    const entry = sessions.get('rp-1');
    expect(entry.alive).toBe(false);
    expect(entry.clientDetached).toBe(false);
  });

  it('refreshes the entry host runtime on reconnect so edited hosts take effect', async () => {
    const sessions = new Map();
    const originalRuntime = createFakeHostRuntime();
    const first = attachRemote({ sessions, hostRuntime: originalRuntime });
    await first.result;

    const updatedRuntime = createFakeHostRuntime();
    const second = attachRemote({ sessions, hostRuntime: updatedRuntime, ws: createMockWs() });
    await second.result;

    expect(sessions.get('rp-1').hostRuntime).toBe(updatedRuntime);
  });
});

// ---------------------------------------------------------------------------
// Remote message handling
// ---------------------------------------------------------------------------

describe('remote session messages', () => {
  it('routes input to the remote PTY and resize through the host runtime', async () => {
    const hostRuntime = createFakeHostRuntime();
    const { ws, sessions, result } = attachRemote({ hostRuntime });
    await result;

    ws._emit('message', JSON.stringify({ type: 'input', data: 'ls\n' }));
    expect(sessions.get('rp-1').pty.write).toHaveBeenCalledWith('ls\n');

    ws._emit('message', JSON.stringify({ type: 'resize', cols: 90, rows: 25 }));
    await flushAsync();
    expect(hostRuntime.resizeSessionAsync).toHaveBeenCalledWith('rp-1', 90, 25);
    expect(sessions.get('rp-1').pty.resize).toHaveBeenCalledWith(90, 25);
  });

  it('serves rehydrate from a fresh remote snapshot', async () => {
    const hostRuntime = createFakeHostRuntime({ snapshotData: 'rehydrated\r\n' });
    const { ws, result } = attachRemote({ hostRuntime });
    await result;
    ws.send.mockClear();

    ws._emit('message', JSON.stringify({ type: 'rehydrate' }));
    await flushAsync();

    const snapshot = sentMessages(ws).find(m => m.type === 'snapshot');
    expect(snapshot.data).toBe('rehydrated\r\n');
  });
});
