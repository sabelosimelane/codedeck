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
  let windowFocusHandler;
  let pageShowHandler;
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
    windowFocusHandler = null;
    pageShowHandler = null;
    vi.spyOn(document, 'addEventListener').mockImplementation((event, cb) => {
      if (event === 'visibilitychange') visibilityHandler = cb;
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation(() => {});
    vi.spyOn(window, 'addEventListener').mockImplementation((event, cb) => {
      if (event === 'focus') windowFocusHandler = cb;
      if (event === 'pageshow') pageShowHandler = cb;
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => {});
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

  it('does not leave input blocked when a mount-time resume is lost before remote attach completes', () => {
    // Remote attach awaits SSH before registering message handlers. The
    // mount-time isVisible recovery still fires at 50ms. A resume sent in that
    // window is dropped server-side, and if resumeInFlight stays true, typing
    // is silently gated until remount — the "can't type until navigate away"
    // bug on first open of a remote terminal.
    render(<Terminal sessionId="remote-1" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.send.mockClear();

    // Mount-time visibility recovery fires before the remote handshake.
    // Resume must not be sent yet — there is no handler on the server.
    vi.advanceTimersByTime(50);
    const resumeSends = mocks.ws.send.mock.calls.filter(([arg]) =>
      typeof arg === 'string' && arg.includes('"type":"resume"')
    );
    expect(resumeSends).toHaveLength(0);
    mocks.ws.send.mockClear();

    // Attach finally completes: brand-new remote session, no snapshot, no replay.
    mocks.ws.onmessage?.({
      data: JSON.stringify({
        type: 'session',
        sessionId: 'remote-1',
        existing: false,
        snapshotWindowLines: 10000,
      }),
    });

    const onDataCb = mocks.term.onData.mock.calls[0]?.[0];
    onDataCb?.('ls\r');

    expect(mocks.ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'input', data: 'ls\r' })
    );
  });

  it('clears a stale resume gate when the session handshake arrives without a replay', () => {
    // Defense in depth: if resumeInFlight was set somehow before the handshake
    // (e.g. older client path), the session message must clear it so a fresh
    // remote attach without snapshot/replay does not leave typing blocked.
    render(<Terminal sessionId="remote-2" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();

    // Force the stuck-gate condition the remote race used to leave behind.
    const onDataCb = mocks.term.onData.mock.calls[0]?.[0];
    // Trigger requestResume via the public recovery path after faking readiness
    // by sending a session, then re-arming the gate as if a later resume was lost.
    mocks.ws.onmessage?.({
      data: JSON.stringify({ type: 'session', sessionId: 'remote-2', existing: true }),
    });
    // existing:true without snapshotWindowLines requests resume; drop the replay
    // so the gate stays true — then a second session (or the same late handshake
    // path) must clear it. Simulate lost-replay by never sending replay, then
    // deliver a fresh new-session handshake that should unblock input.
    mocks.ws.send.mockClear();
    onDataCb?.('blocked');
    // Still gated by the in-flight resume from the existing handshake.
    expect(
      mocks.ws.send.mock.calls.filter(([arg]) => typeof arg === 'string' && arg.includes('"type":"input"'))
    ).toHaveLength(0);

    mocks.ws.onmessage?.({
      data: JSON.stringify({
        type: 'session',
        sessionId: 'remote-2',
        existing: false,
        snapshotWindowLines: 10000,
      }),
    });
    mocks.ws.send.mockClear();

    onDataCb?.('ls\r');
    expect(mocks.ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'input', data: 'ls\r' })
    );
  });

  it('buffers input until the session handshake, then flushes in order', () => {
    render(<Terminal sessionId="s2" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    // WS still connecting (readyState = 0)
    const onDataCb = mocks.term.onData.mock.calls[0]?.[0];
    onDataCb?.('buffered 1');

    expect(mocks.ws.send).not.toHaveBeenCalled();

    // Socket open is NOT enough: a remote attach registers its server-side
    // message handlers only after SSH round-trips, so input flushed at onopen
    // would be silently dropped. It must stay buffered.
    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    onDataCb?.('buffered 2');
    expect(
      mocks.ws.send.mock.calls.filter(([arg]) => arg.includes('"type":"input"'))
    ).toHaveLength(0);

    // The session handshake proves handlers are registered — flush now.
    mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 's2', existing: false }) });

    const inputSends = mocks.ws.send.mock.calls
      .map(([arg]) => arg)
      .filter(arg => arg.includes('"type":"input"'));
    expect(inputSends).toEqual([
      JSON.stringify({ type: 'input', data: 'buffered 1' }),
      JSON.stringify({ type: 'input', data: 'buffered 2' }),
    ]);
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

  it('re-syncs terminal layout when the browser window regains focus without a visibility change', () => {
    render(<Terminal sessionId="s-focus" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 's-focus', existing: false }) });
    mocks.ws.send.mockClear();
    mocks.term.focus.mockClear();

    expect(windowFocusHandler).not.toBeNull();

    windowFocusHandler?.();
    vi.advanceTimersByTime(100);

    expect(mocks.term.focus).toHaveBeenCalled();
    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resume', lastSeenSeq: 0 }));
  });

  it('re-syncs terminal layout after pageshow restores the app shell', () => {
    render(<Terminal sessionId="s-pageshow" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.onmessage?.({ data: JSON.stringify({ type: 'session', sessionId: 's-pageshow', existing: false }) });
    mocks.ws.send.mockClear();
    mocks.term.focus.mockClear();

    expect(pageShowHandler).not.toBeNull();

    pageShowHandler?.({ persisted: true });
    vi.advanceTimersByTime(100);

    expect(mocks.term.focus).toHaveBeenCalled();
    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resume', lastSeenSeq: 0 }));
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

  it('keeps redraw as a non-destructive local viewport sync', () => {
    const terminalRef = React.createRef();
    render(<Terminal ref={terminalRef} sessionId="s8" cwd="/tmp" isVisible={true} runtimeType="tmux" />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.send.mockClear();

    terminalRef.current?.redraw();

    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'recovery_action', action: 'redraw' }));
    expect(mocks.ws.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'rehydrate' }));
  });
});
