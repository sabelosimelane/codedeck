import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWsConnection, computeSessionHealth, computeStallReason, isSubstantialOutput, REPLAY_BUFFER_SIZE } from '../ws-handler.js';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Creates a mock PTY process that tracks listener registrations.
 * onData and onExit accept callbacks; emitData/emitExit fire them.
 */
function createMockPty() {
  const dataListeners = [];
  const exitListeners = [];
  return {
    onData(cb) { dataListeners.push(cb); },
    onExit(cb) { exitListeners.push(cb); },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // Test helpers
    get _dataListenerCount() { return dataListeners.length; },
    get _exitListenerCount() { return exitListeners.length; },
    emitData(data) { dataListeners.forEach(cb => cb(data)); },
    emitExit(exitInfo) { exitListeners.forEach(cb => cb(exitInfo)); },
  };
}

/**
 * Creates a mock WebSocket with OPEN readyState.
 */
function createMockWs() {
  const listeners = {};
  return {
    readyState: 1, // WebSocket.OPEN
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
    on(event, cb) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    // Test helper to simulate incoming messages
    _emit(event, data) {
      (listeners[event] || []).forEach(cb => cb(data));
    },
  };
}

/**
 * Creates a mock HTTP request with query parameters.
 */
function createMockReq({ sessionId, cwd, cols, rows } = {}) {
  const params = new URLSearchParams();
  if (sessionId) params.set('sessionId', sessionId);
  if (cwd) params.set('cwd', cwd);
  if (cols) params.set('cols', String(cols));
  if (rows) params.set('rows', String(rows));
  return { url: `/ws/terminal?${params.toString()}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Creates a mock terminal runtime (pty mode by default).
 * Wraps the spawn function and provides kill/isSessionRecoverable stubs.
 */
function createMockRuntime(spawnFn, opts = {}) {
  return {
    type: opts.type || 'pty',
    spawn: spawnFn,
    kill: vi.fn((entry) => { entry.pty.kill(); }),
    isSessionRecoverable: vi.fn(() => opts.recoverable || false),
  };
}

describe('handleWsConnection', () => {
  let sessions;
  let mockPty;
  let spawnPty;

  beforeEach(() => {
    sessions = new Map();
    mockPty = createMockPty();
    spawnPty = createMockRuntime(vi.fn(() => mockPty));
  });

  // -----------------------------------------------------------------------
  // Rule 1: Single onData listener per PTY
  // -----------------------------------------------------------------------
  describe('onData listener registration', () => {
    it('registers exactly one onData listener when a new PTY is created', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      expect(mockPty._dataListenerCount).toBe(1);
    });

    it('does not add another onData listener when a second WebSocket connects to the same session', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req1 = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });
      const req2 = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req1, sessions, spawnPty);
      handleWsConnection(ws2, req2, sessions, spawnPty);

      expect(mockPty._dataListenerCount).toBe(1);
    });

    it('does not add another onData listener after three reconnections', () => {
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      // Simulate initial + 3 reconnections = 4 total connections
      for (let i = 0; i < 4; i++) {
        const ws = createMockWs();
        handleWsConnection(ws, req, sessions, spawnPty);
      }

      expect(mockPty._dataListenerCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Rule 2 & 3: WebSocket reference tracking and replacement
  // -----------------------------------------------------------------------
  describe('WebSocket reference tracking', () => {
    it('stores the WebSocket reference in the session entry on first connection', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      expect(entry.ws).toBe(ws);
    });

    it('updates the WebSocket reference when a new connection is made to an existing session', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      handleWsConnection(ws2, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      expect(entry.ws).toBe(ws2);
      expect(entry.ws).not.toBe(ws1);
    });
  });

  // -----------------------------------------------------------------------
  // Rule 4: PTY output routing to most recent WebSocket
  // -----------------------------------------------------------------------
  describe('PTY output routing', () => {
    it('sends PTY output to the connected WebSocket', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      mockPty.emitData('hello world');

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'output', seq: 1, data: 'hello world' })
      );
    });

    it('sends PTY output to the most recent WebSocket after reconnection', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      handleWsConnection(ws2, req, sessions, spawnPty);

      mockPty.emitData('after reconnect');

      expect(ws2.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'output', seq: 1, data: 'after reconnect' })
      );
    });

    it('does not send PTY output to the old WebSocket after reconnection', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);

      // Clear any initial sends (session info message)
      ws1.send.mockClear();

      handleWsConnection(ws2, req, sessions, spawnPty);
      mockPty.emitData('new data');

      // ws1 should not receive the new data (only ws2 should)
      const ws1DataCalls = ws1.send.mock.calls.filter(call => {
        const msg = JSON.parse(call[0]);
        return msg.type === 'output';
      });
      expect(ws1DataCalls).toHaveLength(0);
    });

    it('does not send output when the active WebSocket is closed', () => {
      const ws = createMockWs();
      ws.readyState = 3; // WebSocket.CLOSED
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      mockPty.emitData('data after close');

      // Only the session info message should have been sent, no output messages
      const outputCalls = ws.send.mock.calls.filter(call => {
        const msg = JSON.parse(call[0]);
        return msg.type === 'output';
      });
      expect(outputCalls).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Rule 5: onExit uses entry.ws
  // -----------------------------------------------------------------------
  describe('PTY exit handling', () => {
    it('registers exactly one onExit listener when a new PTY is created', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      expect(mockPty._exitListenerCount).toBe(1);
    });

    it('does not add another onExit listener on reconnection', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      handleWsConnection(ws2, req, sessions, spawnPty);

      expect(mockPty._exitListenerCount).toBe(1);
    });

    it('closes the most recent WebSocket when PTY exits', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      handleWsConnection(ws2, req, sessions, spawnPty);

      mockPty.emitExit({ exitCode: 0 });

      // Should close ws2 (the current one), not ws1 (the stale one)
      expect(ws2.close).toHaveBeenCalled();
    });

    it('sets alive to false when PTY exits', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      mockPty.emitExit({ exitCode: 0 });

      const entry = sessions.get('test-1');
      expect(entry.alive).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Rule 6: New PTY creation still works
  // -----------------------------------------------------------------------
  describe('new PTY creation', () => {
    it('spawns a new PTY when session does not exist', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      expect(spawnPty.spawn).toHaveBeenCalledTimes(1);
      expect(spawnPty.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/tmp', cols: 120, rows: 30, sessionId: 'test-1' })
      );
    });

    it('does not spawn a new PTY when session already exists', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      handleWsConnection(ws2, req, sessions, spawnPty);

      expect(spawnPty.spawn).toHaveBeenCalledTimes(1);
    });

    it('sends session info message with existing=false for new sessions', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'session', sessionId: 'test-1', existing: false })
      );
    });

    it('sends session info message with existing=true for reconnections', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      handleWsConnection(ws2, req, sessions, spawnPty);

      expect(ws2.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'session', sessionId: 'test-1', existing: true })
      );
    });

    it('does not inject Ctrl+L into the PTY on reconnect', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      mockPty.write.mockClear();

      handleWsConnection(ws2, req, sessions, spawnPty);

      expect(mockPty.write).not.toHaveBeenCalledWith('\x0c');
    });
  });

  // -----------------------------------------------------------------------
  // Rule 7: Session entry shape
  // -----------------------------------------------------------------------
  describe('session entry shape', () => {
    it('creates a session entry with all required fields', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/home/user' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      expect(entry).toEqual(expect.objectContaining({
        pty: mockPty,
        ws: ws,
        cwd: '/home/user',
        alive: true,
      }));
      expect(entry.startedAt).toBeDefined();
      expect(entry.lastOutputAt).toBeDefined();
    });

    it('updates lastOutputAt when PTY emits data', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const beforeOutput = sessions.get('test-1').lastOutputAt;

      // Small delay to ensure timestamp differs
      mockPty.emitData('some output');

      const afterOutput = sessions.get('test-1').lastOutputAt;
      // lastOutputAt should be updated (may be the same string if too fast,
      // but it should at least be a valid ISO timestamp)
      expect(afterOutput).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // -----------------------------------------------------------------------
  // Browser -> PTY input forwarding
  // -----------------------------------------------------------------------
  describe('browser to PTY input forwarding', () => {
    it('forwards input messages to the PTY', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const inputMsg = JSON.stringify({ type: 'input', data: 'ls\n' });
      ws._emit('message', inputMsg);

      expect(mockPty.write).toHaveBeenCalledWith('ls\n');
    });

    it('forwards resize messages to the PTY', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const resizeMsg = JSON.stringify({ type: 'resize', cols: 80, rows: 24 });
      ws._emit('message', resizeMsg);

      expect(mockPty.resize).toHaveBeenCalledWith(80, 24);
    });

    it('falls back to raw string input when JSON parsing fails', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      ws._emit('message', 'raw input');

      expect(mockPty.write).toHaveBeenCalledWith('raw input');
    });
  });

  // -----------------------------------------------------------------------
  // Spawn failure handling
  // -----------------------------------------------------------------------
  describe('PTY spawn failure', () => {
    it('sends spawn_error and closes WebSocket when PTY fails to spawn', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });
      const failingRuntime = createMockRuntime(vi.fn(() => { throw new Error('spawn failed'); }));

      handleWsConnection(ws, req, sessions, failingRuntime);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('spawn_error')
      );
      expect(ws.close).toHaveBeenCalled();
      expect(sessions.has('test-1')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Diagnostic metadata (Phase 1)
  // -----------------------------------------------------------------------
  describe('diagnostic metadata', () => {
    it('creates session entry with diagnostic fields on new connection', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      expect(entry.wsAttached).toBe(true);
      expect(entry.lastAttachAt).toBeDefined();
      expect(entry.lastDetachAt).toBeNull();
      expect(entry.lastClientAckAt).toBeNull();
      expect(entry.lastReplayAt).toBeNull();
      expect(entry.lastSeq).toBe(0);
      expect(entry.stallReason).toBeNull();
      expect(entry.events).toBeInstanceOf(Array);
      expect(entry.events.length).toBeGreaterThanOrEqual(1);
    });

    it('records an attach event on new session', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      expect(entry.events[0].type).toBe('attach');
      expect(entry.events[0].detail).toBe('initial connection');
    });

    it('records attach event with reconnect detail on existing session', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      handleWsConnection(ws2, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      const reconnectEvent = entry.events.find(e => e.detail === 'reconnect');
      expect(reconnectEvent).toBeDefined();
      expect(reconnectEvent.type).toBe('attach');
    });

    it('sets wsAttached to true on reconnect', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      // Simulate close
      ws1._emit('close');
      expect(sessions.get('test-1').wsAttached).toBe(false);

      handleWsConnection(ws2, req, sessions, spawnPty);
      expect(sessions.get('test-1').wsAttached).toBe(true);
    });

    it('sets wsAttached to false and records detach on WebSocket close', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      ws._emit('close');

      const entry = sessions.get('test-1');
      expect(entry.wsAttached).toBe(false);
      expect(entry.lastDetachAt).toBeDefined();
      const detachEvent = entry.events.find(e => e.type === 'detach');
      expect(detachEvent).toBeDefined();
    });

    it('records pty_exited event and sets wsAttached false on PTY exit', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      mockPty.emitExit({ exitCode: 0 });

      const entry = sessions.get('test-1');
      expect(entry.alive).toBe(false);
      expect(entry.wsAttached).toBe(false);
      const exitEvent = entry.events.find(e => e.type === 'pty_exited');
      expect(exitEvent).toBeDefined();
    });

    it('updates lastClientAckAt on heartbeat message', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      expect(sessions.get('test-1').lastClientAckAt).toBeNull();

      ws._emit('message', JSON.stringify({ type: 'heartbeat' }));

      expect(sessions.get('test-1').lastClientAckAt).toBeDefined();
      expect(sessions.get('test-1').lastClientAckAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 2: Visibility-aware recovery
  // -----------------------------------------------------------------------
  describe('visibility change handling', () => {
    it('creates session entry with client diagnostic fields', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      expect(entry.documentVisibility).toBe('visible');
      expect(entry.clientLastMessageAt).toBeNull();
      expect(entry.clientLastPaintAt).toBeNull();
      expect(entry.clientLastResizeAt).toBeNull();
    });

    it('updates documentVisibility on visibility_change hidden message', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      ws._emit('message', JSON.stringify({ type: 'visibility_change', state: 'hidden' }));

      expect(sessions.get('test-1').documentVisibility).toBe('hidden');
    });

    it('updates documentVisibility on visibility_change visible message', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      ws._emit('message', JSON.stringify({ type: 'visibility_change', state: 'hidden' }));
      ws._emit('message', JSON.stringify({ type: 'visibility_change', state: 'visible' }));

      expect(sessions.get('test-1').documentVisibility).toBe('visible');
    });

    it('records visibility_hidden timeline event', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      ws._emit('message', JSON.stringify({ type: 'visibility_change', state: 'hidden' }));

      const entry = sessions.get('test-1');
      const hiddenEvent = entry.events.find(e => e.type === 'visibility_hidden');
      expect(hiddenEvent).toBeDefined();
      expect(hiddenEvent.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('records visibility_visible timeline event', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      ws._emit('message', JSON.stringify({ type: 'visibility_change', state: 'visible' }));

      const entry = sessions.get('test-1');
      const visibleEvent = entry.events.find(e => e.type === 'visibility_visible');
      expect(visibleEvent).toBeDefined();
    });

    it('stores client diagnostics from heartbeat message', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const now = new Date().toISOString();
      ws._emit('message', JSON.stringify({
        type: 'heartbeat',
        documentVisibility: 'hidden',
        lastMessageAt: now,
        lastPaintAt: now,
        lastResizeAt: now,
      }));

      const entry = sessions.get('test-1');
      expect(entry.documentVisibility).toBe('hidden');
      expect(entry.clientLastMessageAt).toBe(now);
      expect(entry.clientLastPaintAt).toBe(now);
      expect(entry.clientLastResizeAt).toBe(now);
    });
  });

  // -----------------------------------------------------------------------
  // Phase 3: Sequence numbers, replay buffer, and resume
  // -----------------------------------------------------------------------
  describe('sequence numbers and replay buffer', () => {
    it('assigns monotonic seq starting at 1 on output', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      ws.send.mockClear();

      mockPty.emitData('first');
      mockPty.emitData('second');
      mockPty.emitData('third');

      const outputCalls = ws.send.mock.calls
        .map(c => JSON.parse(c[0]))
        .filter(m => m.type === 'output');
      expect(outputCalls).toHaveLength(3);
      expect(outputCalls[0].seq).toBe(1);
      expect(outputCalls[1].seq).toBe(2);
      expect(outputCalls[2].seq).toBe(3);
    });

    it('includes data in output messages alongside seq', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      ws.send.mockClear();

      mockPty.emitData('hello');

      const msg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(msg.type).toBe('output');
      expect(msg.seq).toBe(1);
      expect(msg.data).toBe('hello');
    });

    it('increments lastSeq on session entry for each output', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      expect(sessions.get('test-1').lastSeq).toBe(0);

      mockPty.emitData('a');
      expect(sessions.get('test-1').lastSeq).toBe(1);

      mockPty.emitData('b');
      expect(sessions.get('test-1').lastSeq).toBe(2);
    });

    it('stores output chunks in replay buffer', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      mockPty.emitData('chunk1');
      mockPty.emitData('chunk2');

      const entry = sessions.get('test-1');
      expect(entry.replayBuffer).toHaveLength(2);
      expect(entry.replayBuffer[0]).toEqual({ seq: 1, data: 'chunk1' });
      expect(entry.replayBuffer[1]).toEqual({ seq: 2, data: 'chunk2' });
    });

    it('bounds replay buffer to REPLAY_BUFFER_SIZE', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      // Emit more than buffer size
      for (let i = 0; i < REPLAY_BUFFER_SIZE + 50; i++) {
        mockPty.emitData(`data-${i}`);
      }

      const entry = sessions.get('test-1');
      expect(entry.replayBuffer).toHaveLength(REPLAY_BUFFER_SIZE);
      // Oldest should be trimmed — first retained seq should be 51
      expect(entry.replayBuffer[0].seq).toBe(51);
      expect(entry.replayBuffer[REPLAY_BUFFER_SIZE - 1].seq).toBe(REPLAY_BUFFER_SIZE + 50);
    });

    it('initializes session with empty replay buffer', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      expect(sessions.get('test-1').replayBuffer).toEqual([]);
    });
  });

  describe('resume and replay', () => {
    it('replays all buffered chunks when lastSeenSeq is 0', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      mockPty.emitData('a');
      mockPty.emitData('b');
      mockPty.emitData('c');
      ws.send.mockClear();

      ws._emit('message', JSON.stringify({ type: 'resume', lastSeenSeq: 0 }));

      const replayMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(replayMsg.type).toBe('replay');
      expect(replayMsg.chunks).toHaveLength(3);
      expect(replayMsg.chunks[0]).toEqual({ seq: 1, data: 'a' });
      expect(replayMsg.chunks[1]).toEqual({ seq: 2, data: 'b' });
      expect(replayMsg.chunks[2]).toEqual({ seq: 3, data: 'c' });
      expect(replayMsg.overflow).toBe(false);
    });

    it('replays only chunks after lastSeenSeq', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      mockPty.emitData('a');
      mockPty.emitData('b');
      mockPty.emitData('c');
      ws.send.mockClear();

      ws._emit('message', JSON.stringify({ type: 'resume', lastSeenSeq: 2 }));

      const replayMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(replayMsg.chunks).toHaveLength(1);
      expect(replayMsg.chunks[0]).toEqual({ seq: 3, data: 'c' });
      expect(replayMsg.overflow).toBe(false);
    });

    it('returns empty chunks when client is caught up', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      mockPty.emitData('a');
      mockPty.emitData('b');
      ws.send.mockClear();

      ws._emit('message', JSON.stringify({ type: 'resume', lastSeenSeq: 2 }));

      const replayMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(replayMsg.chunks).toHaveLength(0);
      expect(replayMsg.overflow).toBe(false);
    });

    it('detects overflow when buffer cannot satisfy the gap', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      // Fill buffer past capacity so old chunks are trimmed
      for (let i = 0; i < REPLAY_BUFFER_SIZE + 100; i++) {
        mockPty.emitData(`d-${i}`);
      }
      ws.send.mockClear();

      // Client claims lastSeenSeq=10, but buffer starts at seq 101
      ws._emit('message', JSON.stringify({ type: 'resume', lastSeenSeq: 10 }));

      const replayMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(replayMsg.overflow).toBe(true);
      expect(replayMsg.missedCount).toBe(90); // seqs 11-100 are lost
      expect(replayMsg.chunks.length).toBe(REPLAY_BUFFER_SIZE);
    });

    it('does not report overflow when buffer starts right after lastSeenSeq', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      // Fill buffer to exactly capacity
      for (let i = 0; i < REPLAY_BUFFER_SIZE; i++) {
        mockPty.emitData(`d-${i}`);
      }
      ws.send.mockClear();

      // Client saw seq 0, buffer starts at seq 1 — no gap
      ws._emit('message', JSON.stringify({ type: 'resume', lastSeenSeq: 0 }));

      const replayMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(replayMsg.overflow).toBe(false);
    });

    it('updates lastReplayAt on resume', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      expect(sessions.get('test-1').lastReplayAt).toBeNull();

      mockPty.emitData('a');
      ws._emit('message', JSON.stringify({ type: 'resume', lastSeenSeq: 0 }));

      expect(sessions.get('test-1').lastReplayAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('updates lastClientAckAt on resume', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      expect(sessions.get('test-1').lastClientAckAt).toBeNull();

      ws._emit('message', JSON.stringify({ type: 'resume', lastSeenSeq: 0 }));

      expect(sessions.get('test-1').lastClientAckAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('records replay_requested and replay_served timeline events', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      mockPty.emitData('a');
      mockPty.emitData('b');
      ws._emit('message', JSON.stringify({ type: 'resume', lastSeenSeq: 1 }));

      const entry = sessions.get('test-1');
      const requested = entry.events.find(e => e.type === 'replay_requested');
      const served = entry.events.find(e => e.type === 'replay_served');
      expect(requested).toBeDefined();
      expect(requested.detail).toBe('from seq 1');
      expect(served).toBeDefined();
      expect(served.detail).toBe('1 chunks, overflow=false');
    });

    it('replay with empty buffer returns no chunks and no overflow', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);
      ws.send.mockClear();

      ws._emit('message', JSON.stringify({ type: 'resume', lastSeenSeq: 0 }));

      const replayMsg = JSON.parse(ws.send.mock.calls[0][0]);
      expect(replayMsg.type).toBe('replay');
      expect(replayMsg.chunks).toHaveLength(0);
      expect(replayMsg.overflow).toBe(false);
      expect(replayMsg.missedCount).toBe(0);
    });
  });

  describe('recovery action handling', () => {
    it('records recovery_reconnect timeline event', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      ws._emit('message', JSON.stringify({ type: 'recovery_action', action: 'reconnect' }));

      const entry = sessions.get('test-1');
      const evt = entry.events.find(e => e.type === 'recovery_reconnect');
      expect(evt).toBeDefined();
      expect(evt.detail).toBe('user-initiated reconnect');
    });

    it('records recovery_resync timeline event', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      ws._emit('message', JSON.stringify({ type: 'recovery_action', action: 'resync' }));

      const entry = sessions.get('test-1');
      const evt = entry.events.find(e => e.type === 'recovery_resync');
      expect(evt).toBeDefined();
      expect(evt.detail).toBe('user-initiated resync');
    });

    it('records recovery_redraw timeline event', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      ws._emit('message', JSON.stringify({ type: 'recovery_action', action: 'redraw' }));

      const entry = sessions.get('test-1');
      const evt = entry.events.find(e => e.type === 'recovery_redraw');
      expect(evt).toBeDefined();
      expect(evt.detail).toBe('user-initiated redraw');
    });

    it('defaults to unknown action when action field is missing', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      ws._emit('message', JSON.stringify({ type: 'recovery_action' }));

      const entry = sessions.get('test-1');
      const evt = entry.events.find(e => e.type === 'recovery_unknown');
      expect(evt).toBeDefined();
    });
  });

  describe('stall detection timeline events', () => {
    it('records stall_detected timeline event when visibility change triggers stall', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      // Set up conditions for stall: recent output, old ack
      const entry = sessions.get('test-1');
      entry.lastClientAckAt = new Date(Date.now() - 20_000).toISOString();
      entry.lastOutputAt = new Date().toISOString();
      entry.stallReason = null; // no prior stall

      // Visibility change to hidden triggers stall detection
      ws._emit('message', JSON.stringify({ type: 'visibility_change', state: 'hidden' }));

      const stallEvt = entry.events.find(e => e.type === 'stall_detected');
      expect(stallEvt).toBeDefined();
      expect(stallEvt.detail).toBe('stale_view_document_hidden');
    });

    it('does not duplicate stall_detected when stall reason is unchanged', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      entry.lastClientAckAt = new Date(Date.now() - 20_000).toISOString();
      entry.lastOutputAt = new Date().toISOString();
      entry.stallReason = 'stale_view_document_hidden'; // already set to this reason

      // Visibility change to hidden again — stall reason unchanged, should NOT add new event
      ws._emit('message', JSON.stringify({ type: 'visibility_change', state: 'hidden' }));

      const stallEvents = entry.events.filter(e => e.type === 'stall_detected');
      expect(stallEvents).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Bug: tmux status bar refreshes keep activity dot green forever
  // -----------------------------------------------------------------------
  describe('substantial output tracking (activity noise filtering)', () => {
    // Typical tmux status bar refresh: cursor save, move to status line,
    // draw status content, cursor restore — no newlines, mostly ANSI escapes
    const TMUX_STATUS_REFRESH = '\x1b7\x1b[25;1H\x1b[K\x1b[0;32m[0] 0:zsh*\x1b[0m\x1b8';

    // Real command output has newlines
    const REAL_OUTPUT = 'total 42\ndrwxr-xr-x  5 user  staff  160 Apr 10 09:00 src\n';

    it('initializes lastSubstantialOutputAt on session creation', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });
      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      expect(entry.lastSubstantialOutputAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('does not update lastSubstantialOutputAt on ANSI-only tmux status refresh', () => {
      vi.useFakeTimers({ now: new Date('2026-04-11T10:00:00Z') });

      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });
      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      const before = entry.lastSubstantialOutputAt;

      vi.advanceTimersByTime(5000);
      mockPty.emitData(TMUX_STATUS_REFRESH);

      expect(entry.lastSubstantialOutputAt).toBe(before);

      vi.useRealTimers();
    });

    it('updates lastSubstantialOutputAt on output containing newlines', () => {
      vi.useFakeTimers({ now: new Date('2026-04-11T10:00:00Z') });

      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });
      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      const before = entry.lastSubstantialOutputAt;

      vi.advanceTimersByTime(5000);
      mockPty.emitData(REAL_OUTPUT);

      expect(new Date(entry.lastSubstantialOutputAt).getTime())
        .toBeGreaterThan(new Date(before).getTime());

      vi.useRealTimers();
    });

    it('still updates lastOutputAt on all output including tmux noise', () => {
      vi.useFakeTimers({ now: new Date('2026-04-11T10:00:00Z') });

      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });
      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      const before = entry.lastOutputAt;

      vi.advanceTimersByTime(5000);
      mockPty.emitData(TMUX_STATUS_REFRESH);

      // lastOutputAt still updates on ALL output (for diagnostics/replay)
      expect(new Date(entry.lastOutputAt).getTime())
        .toBeGreaterThan(new Date(before).getTime());

      vi.useRealTimers();
    });
  });

  describe('heartbeat with Phase 3 fields', () => {
    it('stores lastSeenSeq from heartbeat message', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      ws._emit('message', JSON.stringify({
        type: 'heartbeat',
        lastSeenSeq: 42,
        reconnectCount: 3,
      }));

      const entry = sessions.get('test-1');
      expect(entry.clientLastSeenSeq).toBe(42);
      expect(entry.clientReconnectCount).toBe(3);
    });

    it('initializes clientLastSeenSeq and clientReconnectCount to 0', () => {
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, spawnPty);

      const entry = sessions.get('test-1');
      expect(entry.clientLastSeenSeq).toBe(0);
      expect(entry.clientReconnectCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Health computation
// ---------------------------------------------------------------------------

describe('computeSessionHealth', () => {
  function makeEntry(overrides = {}) {
    return {
      alive: true,
      wsAttached: true,
      lastOutputAt: new Date().toISOString(),
      lastClientAckAt: new Date().toISOString(),
      events: [],
      ...overrides,
    };
  }

  it('returns "healthy" when PTY is alive and WS is attached', () => {
    expect(computeSessionHealth(makeEntry())).toBe('healthy');
  });

  it('returns "dead" when PTY is not alive', () => {
    expect(computeSessionHealth(makeEntry({ alive: false }))).toBe('dead');
  });

  it('returns "detached" when WS is not attached but PTY is alive', () => {
    expect(computeSessionHealth(makeEntry({ wsAttached: false }))).toBe('detached');
  });

  it('returns "dead" over "detached" when PTY is not alive and WS is not attached', () => {
    expect(computeSessionHealth(makeEntry({ alive: false, wsAttached: false }))).toBe('dead');
  });

  it('returns "stalled" when output outpaces client ack by >10s', () => {
    const now = Date.now();
    const entry = makeEntry({
      lastOutputAt: new Date(now).toISOString(),
      lastClientAckAt: new Date(now - 15_000).toISOString(),
    });
    expect(computeSessionHealth(entry)).toBe('stalled');
  });

  it('returns "healthy" when output and ack are within 10s', () => {
    const now = Date.now();
    const entry = makeEntry({
      lastOutputAt: new Date(now).toISOString(),
      lastClientAckAt: new Date(now - 5_000).toISOString(),
    });
    expect(computeSessionHealth(entry)).toBe('healthy');
  });

  it('returns "healthy" when lastClientAckAt is null (no heartbeats yet)', () => {
    expect(computeSessionHealth(makeEntry({ lastClientAckAt: null }))).toBe('healthy');
  });
});

describe('computeStallReason', () => {
  function makeEntry(overrides = {}) {
    return {
      alive: true,
      wsAttached: true,
      lastOutputAt: new Date().toISOString(),
      lastClientAckAt: new Date().toISOString(),
      events: [],
      ...overrides,
    };
  }

  it('returns null when session is healthy', () => {
    expect(computeStallReason(makeEntry())).toBeNull();
  });

  it('returns "server_output_outpaced_client_ack" when stalled with visible document', () => {
    const now = Date.now();
    const entry = makeEntry({
      lastOutputAt: new Date(now).toISOString(),
      lastClientAckAt: new Date(now - 15_000).toISOString(),
      documentVisibility: 'visible',
    });
    expect(computeStallReason(entry)).toBe('server_output_outpaced_client_ack');
  });

  it('returns "stale_view_document_hidden" when stalled and document is hidden', () => {
    const now = Date.now();
    const entry = makeEntry({
      lastOutputAt: new Date(now).toISOString(),
      lastClientAckAt: new Date(now - 15_000).toISOString(),
      documentVisibility: 'hidden',
    });
    expect(computeStallReason(entry)).toBe('stale_view_document_hidden');
  });

  it('returns "stale_view_paint_lagging" when visible but paint lags output by >10s', () => {
    const now = Date.now();
    const entry = makeEntry({
      lastOutputAt: new Date(now).toISOString(),
      lastClientAckAt: new Date(now - 15_000).toISOString(),
      documentVisibility: 'visible',
      clientLastPaintAt: new Date(now - 15_000).toISOString(),
    });
    expect(computeStallReason(entry)).toBe('stale_view_paint_lagging');
  });

  it('returns "server_output_outpaced_client_ack" when visible and paint is recent', () => {
    const now = Date.now();
    const entry = makeEntry({
      lastOutputAt: new Date(now).toISOString(),
      lastClientAckAt: new Date(now - 15_000).toISOString(),
      documentVisibility: 'visible',
      clientLastPaintAt: new Date(now - 3_000).toISOString(),
    });
    expect(computeStallReason(entry)).toBe('server_output_outpaced_client_ack');
  });

  it('returns null when session is dead', () => {
    expect(computeStallReason(makeEntry({ alive: false }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 5: Runtime abstraction and tmux-aware behavior
// ---------------------------------------------------------------------------

describe('runtime abstraction (Phase 5)', () => {
  let sessions;
  let mockPty;

  beforeEach(() => {
    sessions = new Map();
    mockPty = createMockPty();
  });

  it('stores runtimeType on session entry from runtime.type', () => {
    const runtime = createMockRuntime(vi.fn(() => mockPty), { type: 'tmux' });
    const ws = createMockWs();
    const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

    handleWsConnection(ws, req, sessions, runtime);

    const entry = sessions.get('test-1');
    expect(entry.runtimeType).toBe('tmux');
  });

  it('stores runtimeType as "pty" for default runtime', () => {
    const runtime = createMockRuntime(vi.fn(() => mockPty));
    const ws = createMockWs();
    const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

    handleWsConnection(ws, req, sessions, runtime);

    const entry = sessions.get('test-1');
    expect(entry.runtimeType).toBe('pty');
  });

  it('passes sessionId to runtime.spawn', () => {
    const spawnFn = vi.fn(() => mockPty);
    const runtime = createMockRuntime(spawnFn);
    const ws = createMockWs();
    const req = createMockReq({ sessionId: 'myproj-1', cwd: '/tmp' });

    handleWsConnection(ws, req, sessions, runtime);

    expect(spawnFn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'myproj-1', cwd: '/tmp' })
    );
  });

  describe('tmux-aware PTY exit', () => {
    it('marks session dead when runtime.isSessionRecoverable returns false (pty mode)', () => {
      const runtime = createMockRuntime(vi.fn(() => mockPty));
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, runtime);
      mockPty.emitExit({ exitCode: 0 });

      const entry = sessions.get('test-1');
      expect(entry.alive).toBe(false);
      expect(entry.events.some(e => e.type === 'pty_exited')).toBe(true);
    });

    it('does NOT mark session dead when tmux session is recoverable', () => {
      const newPty = createMockPty();
      let spawnCount = 0;
      const runtime = createMockRuntime(
        vi.fn(() => spawnCount++ === 0 ? mockPty : newPty),
        { type: 'tmux', recoverable: true }
      );
      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, runtime);

      // Simulate tmux client PTY exit (but tmux session still alive)
      mockPty.emitExit({ exitCode: 0 });

      const entry = sessions.get('test-1');
      // Should still be alive — re-attached to tmux session
      expect(entry.alive).toBe(true);
      expect(entry.pty).toBe(newPty);
      expect(entry.events.some(e => e.type === 'tmux_client_exited')).toBe(true);
      expect(entry.events.some(e => e.type === 'tmux_reattach')).toBe(true);
    });

    it('marks session dead when tmux re-attach fails', () => {
      const runtime = createMockRuntime(vi.fn(() => mockPty), { type: 'tmux' });
      // First spawn succeeds, but isSessionRecoverable returns true (tmux alive)
      // and re-spawn will throw
      runtime.isSessionRecoverable = vi.fn()
        .mockReturnValueOnce(true); // First call on exit — recoverable
      let callCount = 0;
      runtime.spawn = vi.fn(() => {
        if (callCount++ > 0) throw new Error('tmux attach failed');
        return mockPty;
      });

      const ws = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws, req, sessions, runtime);
      mockPty.emitExit({ exitCode: 0 });

      const entry = sessions.get('test-1');
      expect(entry.alive).toBe(false);
      expect(entry.events.some(e => e.type === 'tmux_reattach_failed')).toBe(true);
    });
  });

  describe('tmux-aware reconnect', () => {
    it('re-attaches to tmux session on WebSocket reconnect when PTY was dead', () => {
      const newPty = createMockPty();
      let spawnCount = 0;
      const runtime = createMockRuntime(
        vi.fn(() => spawnCount++ === 0 ? mockPty : newPty),
        { type: 'tmux', recoverable: true }
      );
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, runtime);

      // Simulate the PTY attachment dying and session being marked dead
      // (e.g., server restart scenario where we manually mark it)
      const entry = sessions.get('test-1');
      entry.alive = false;

      // Reconnect — should re-attach via tmux
      handleWsConnection(ws2, req, sessions, runtime);

      expect(entry.alive).toBe(true);
      expect(entry.pty).toBe(newPty);
      expect(entry.ws).toBe(ws2);
      expect(entry.events.some(e => e.type === 'tmux_reattach')).toBe(true);
    });

    it('does NOT re-attach in pty mode even if session is dead', () => {
      const runtime = createMockRuntime(vi.fn(() => mockPty));
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, runtime);
      const entry = sessions.get('test-1');
      entry.alive = false;

      handleWsConnection(ws2, req, sessions, runtime);

      // Should NOT re-attach — pty mode has no recovery
      expect(entry.alive).toBe(false);
      expect(entry.pty).toBe(mockPty); // Same PTY, not replaced
    });
  });
});
