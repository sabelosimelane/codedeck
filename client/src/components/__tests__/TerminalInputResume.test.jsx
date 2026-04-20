import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

/**
 * Tests for terminal input resume after visibility changes and reconnection.
 *
 * Validates:
 * - Input works when WS is open and no resume in flight
 * - Input is buffered when WS is not open, flushed on connect
 * - Terminal is focused on visibility change to visible
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

// --- Tests ---

describe('Terminal input resume after refocus', () => {
  let visibilityState;
  let visibilityHandler;
  let wsInstances;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.ws = null;
    mocks.term = null;
    wsInstances = [];
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
        wsInstances.push(this);
      }
    }
    WsMock.CONNECTING = 0;
    WsMock.OPEN = 1;
    WsMock.CLOSING = 2;
    WsMock.CLOSED = 3;
    global.WebSocket = WsMock;

    visibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      get: () => visibilityState,
      configurable: true,
    });

    visibilityHandler = null;
    vi.spyOn(document, 'addEventListener').mockImplementation((event, cb) => {
      if (event === 'visibilitychange') visibilityHandler = cb;
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends input directly when WS is open and no resume in flight', () => {
    render(<Terminal sessionId="s1" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 's1', existing: false }) });
    mocks.ws.send.mockClear();

    const onDataCb = mocks.term.onData.mock.calls[0]?.[0];
    onDataCb?.('test input');

    expect(mocks.ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'input', data: 'test input' })
    );
  });

  it('buffers input when WS is not open and flushes on connect', () => {
    render(<Terminal sessionId="s2" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    // WS still connecting (readyState = 0)
    const onDataCb = mocks.term.onData.mock.calls[0]?.[0];
    onDataCb?.('buffered 1');
    onDataCb?.('buffered 2');

    expect(mocks.ws.send).not.toHaveBeenCalled();

    // WS opens -> onopen flushes buffer
    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();

    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'buffered 1' }));
    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'input', data: 'buffered 2' }));
  });

  it('focuses terminal on visibility change to visible', () => {
    render(<Terminal sessionId="s3" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 's3', existing: false }) });

    mocks.term.focus.mockClear();

    // visibilityHandler must have been captured by the spy
    expect(visibilityHandler).not.toBeNull();

    // Hide then show
    visibilityState = 'hidden';
    visibilityHandler?.();
    visibilityState = 'visible';
    visibilityHandler?.();

    // Advance past the 50ms setTimeout in visibility handler
    vi.advanceTimersByTime(100);

    expect(mocks.term.focus).toHaveBeenCalled();
  });

  it('drops focus tracking protocol replies instead of forwarding them to the PTY', () => {
    render(<Terminal sessionId="s4" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 's4', existing: false }) });
    mocks.ws.send.mockClear();

    const onDataCb = mocks.term.onData.mock.calls[0]?.[0];
    onDataCb?.('\x1b[I');
    onDataCb?.('\x1b[O');

    const inputSends = mocks.ws.send.mock.calls.filter(([arg]) => arg.includes('"type":"input"'));
    expect(inputSends).toHaveLength(0);
  });

  it('does not reconnect when the server closes the socket for session takeover', () => {
    render(<Terminal sessionId="s5" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    expect(wsInstances).toHaveLength(1);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onclose?.({ code: 4001, reason: 'session_taken_over' });

    vi.advanceTimersByTime(2000);

    expect(wsInstances).toHaveLength(1);
  });

  it('does not reconnect when the server closes the socket for intentional session deletion', () => {
    render(<Terminal sessionId="s6" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    expect(wsInstances).toHaveLength(1);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onclose?.({ code: 4002, reason: 'session_deleted' });

    vi.advanceTimersByTime(2000);

    expect(wsInstances).toHaveLength(1);
  });

  it('does not recreate the socket when runtimeType metadata arrives after the terminal is already mounted', () => {
    const { rerender } = render(
      <Terminal sessionId="s7" cwd="/tmp" isVisible={true} runtimeType="pty" />
    );
    vi.advanceTimersByTime(16);

    expect(wsInstances).toHaveLength(1);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 's7', existing: false }) });

    rerender(<Terminal sessionId="s7" cwd="/tmp" isVisible={true} runtimeType="tmux" />);
    vi.advanceTimersByTime(16);

    expect(wsInstances).toHaveLength(1);
  });
});
