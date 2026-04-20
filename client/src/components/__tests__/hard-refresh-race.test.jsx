import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

/**
 * Tests for the hard refresh terminal resume flow.
 *
 * After a hard refresh, Terminal reconnects to an existing PTY session and
 * replays buffered output. The fix under test:
 *
 * - Replayed chunks contain terminal queries (DA, CPR) that xterm.js responds
 *   to synchronously via onData. If these stale responses reach the PTY, they
 *   corrupt the shell's line editor — causing "typing doesn't echo until Ctrl+C".
 * - Fix: DROP all onData while resumeInFlightRef is true, and keep the flag
 *   true until all replay chunks are written to xterm.js.
 */

// --- Hoisted mock state ---

const mocks = vi.hoisted(() => ({
  ws: null,
  term: null,
}));

global.ResizeObserver = class { observe() {} disconnect() {} };

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    constructor() {
      this.open = vi.fn();
      this.dispose = vi.fn();
      this.write = vi.fn();
      this.focus = vi.fn();
      this.resize = vi.fn();
      this.scrollToBottom = vi.fn();
      this.refresh = vi.fn();
      this.clear = vi.fn();
      this.loadAddon = vi.fn();
      this.onData = vi.fn();
      this.onScroll = vi.fn();
      this.attachCustomKeyEventHandler = vi.fn();
      this.attachCustomWheelEventHandler = vi.fn();
      this.buffer = { active: { cursorY: 0, baseY: 0, length: 30 } };
      this.rows = 30;
      this.cols = 120;
      mocks.term = this;
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon { fit() {} }
  return { FitAddon: MockFitAddon };
});

vi.mock('@xterm/addon-web-links', () => {
  class MockWebLinksAddon {}
  return { WebLinksAddon: MockWebLinksAddon };
});

vi.mock('../../utils/terminalResume', () => ({
  shouldResumeFromSessionHandshake: (msg, inFlight) =>
    !inFlight && msg?.type === 'session' && msg.existing === true,
}));

vi.mock('../../utils/terminalWsUrl', () => ({
  buildTerminalWebSocketUrl: () => 'ws://localhost/ws/terminal',
}));

vi.mock('../../utils/terminalVisibility', () => ({
  shouldSyncVisibleTerminal: () => true,
  shouldWriteTerminalViewport: () => true,
}));

vi.mock('../../utils/terminalAutoScroll', () => ({
  getTmuxHistoryScrollLines: () => 5,
  isTerminalViewportAtBottom: () => true,
  shouldBlockXtermWheelViewportFallback: () => false,
  shouldPauseAutoScrollOnWheel: () => false,
  shouldRouteWheelToTmuxHistory: () => false,
}));

vi.mock('../ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

import Terminal from '../Terminal';

// --- Helpers ---

/** Mount Terminal, connect WS, trigger session handshake + replay. */
function mountAndReplay(replayChunks) {
  const chunks = replayChunks ?? [
    { seq: 1, data: '$ echo hello\r\nhello\r\n' },
    { seq: 2, data: '$ ' },
  ];

  render(<Terminal sessionId="s1" cwd="/tmp" isVisible={true} />);
  vi.advanceTimersByTime(16);

  mocks.ws.readyState = 1;
  mocks.ws.onopen?.();
  mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 's1', existing: true }) });

  // Clear mocks so post-replay assertions are isolated
  mocks.term.scrollToBottom.mockClear();
  mocks.term.focus.mockClear();
  mocks.term.clear.mockClear();
  mocks.term.write.mockClear();
  mocks.ws.send.mockClear();

  mocks.ws.onmessage?.({
    data: JSON.stringify({ type: 'replay', chunks, overflow: false, missedCount: 0 }),
  });
}

// --- Tests ---

describe('Hard refresh -> replay -> input resume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.ws = null;
    mocks.term = null;
    class WsMock {
      constructor() {
        this.readyState = 0;
        this.send = vi.fn();
        this.close = vi.fn();
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        mocks.ws = this;
      }
    }
    WsMock.CONNECTING = 0;
    WsMock.OPEN = 1;
    WsMock.CLOSING = 2;
    WsMock.CLOSED = 3;
    global.WebSocket = WsMock;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls to bottom after replay', () => {
    mountAndReplay();
    expect(mocks.term.scrollToBottom).toHaveBeenCalled();
  });

  it('focuses the terminal after replay', () => {
    mountAndReplay();
    expect(mocks.term.focus).toHaveBeenCalled();
  });

  it('does NOT clear the terminal (preserves replay content)', () => {
    mountAndReplay();
    expect(mocks.term.clear).not.toHaveBeenCalled();
  });

  it('writes replay chunks to xterm', () => {
    mountAndReplay([{ seq: 1, data: 'prompt$ ' }]);
    expect(mocks.term.write).toHaveBeenCalledWith('prompt$ ');
  });

  it('drops onData during replay (prevents stale terminal responses reaching PTY)', () => {
    render(<Terminal sessionId="s2" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 's2', existing: true }) });
    mocks.ws.send.mockClear();

    // Simulate xterm.js emitting a DA response during replay (resumeInFlight is true)
    const onDataCb = mocks.term.onData.mock.calls[0]?.[0];
    onDataCb?.('\x1b[?64;1;2c');

    // Should be dropped, not sent or buffered
    const inputSends = mocks.ws.send.mock.calls.filter(([arg]) => arg.includes('"type":"input"'));
    expect(inputSends).toHaveLength(0);

    // After replay completes, input should work normally
    mocks.ws.onmessage?.({
      data: JSON.stringify({ type: 'replay', chunks: [{ seq: 1, data: '$ ' }], overflow: false, missedCount: 0 }),
    });
    mocks.ws.send.mockClear();

    onDataCb?.('ls');
    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'ls' }));
  });

  it('allows immediate input for new sessions (no resume gate)', () => {
    render(<Terminal sessionId="new" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 'new', existing: false }) });
    mocks.ws.send.mockClear();

    const onDataCb = mocks.term.onData.mock.calls[0]?.[0];
    onDataCb?.('ls');

    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'ls' }));
  });
});
