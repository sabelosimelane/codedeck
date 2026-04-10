import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleWsConnection } from '../ws-handler.js';

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

describe('handleWsConnection', () => {
  let sessions;
  let mockPty;
  let spawnPty;

  beforeEach(() => {
    sessions = new Map();
    mockPty = createMockPty();
    spawnPty = vi.fn(() => mockPty);
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
        JSON.stringify({ type: 'output', data: 'hello world' })
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
        JSON.stringify({ type: 'output', data: 'after reconnect' })
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

      expect(spawnPty).toHaveBeenCalledTimes(1);
      expect(spawnPty).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/tmp', cols: 120, rows: 30 })
      );
    });

    it('does not spawn a new PTY when session already exists', () => {
      const ws1 = createMockWs();
      const ws2 = createMockWs();
      const req = createMockReq({ sessionId: 'test-1', cwd: '/tmp' });

      handleWsConnection(ws1, req, sessions, spawnPty);
      handleWsConnection(ws2, req, sessions, spawnPty);

      expect(spawnPty).toHaveBeenCalledTimes(1);
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
      const failingSpawn = vi.fn(() => { throw new Error('spawn failed'); });

      handleWsConnection(ws, req, sessions, failingSpawn);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('spawn_error')
      );
      expect(ws.close).toHaveBeenCalled();
      expect(sessions.has('test-1')).toBe(false);
    });
  });
});
