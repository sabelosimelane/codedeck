import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  ws: null,
  term: null,
  fitAddon: null,
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
      this.reset = vi.fn();
      this.loadAddon = vi.fn();
      this.onData = vi.fn();
      this.onScroll = vi.fn();
      this.attachCustomKeyEventHandler = vi.fn();
      this.attachCustomWheelEventHandler = vi.fn();
      this.buffer = { active: { type: 'normal', viewportY: 24, baseY: 24, length: 60 } };
      this.rows = 30;
      this.cols = 120;
      mocks.term = this;
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    constructor() {
      this.fit = vi.fn();
      mocks.fitAddon = this;
    }
  },
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

vi.mock('../../utils/terminalResume', () => ({
  shouldResumeFromSessionHandshake: () => false,
}));

vi.mock('../../utils/terminalWsUrl', () => ({
  buildTerminalWebSocketUrl: () => 'ws://localhost/ws/terminal',
}));

vi.mock('../../utils/terminalVisibility', () => ({
  shouldSyncVisibleTerminal: () => true,
  shouldWriteTerminalViewport: () => true,
}));

vi.mock('../../utils/terminalAutoScroll', () => ({
  isTerminalViewportAtBottom: () => true,
  shouldBlockXtermWheelViewportFallback: () => false,
  shouldPauseAutoScrollOnWheel: () => false,
}));

vi.mock('../ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

import Terminal from '../Terminal';

describe('Terminal font-measurement recovery', () => {
  let resolveFontsReady;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.ws = null;
    mocks.term = null;
    mocks.fitAddon = null;

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

    const ready = new Promise((resolve) => {
      resolveFontsReady = resolve;
    });

    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-fits after late web-font readiness changes terminal character measurements', async () => {
    render(<Terminal sessionId="font-sync" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    const initialFitCount = mocks.fitAddon.fit.mock.calls.length;
    expect(initialFitCount).toBeGreaterThanOrEqual(1);

    await act(async () => {
      resolveFontsReady();
      await Promise.resolve();
    });
    vi.advanceTimersByTime(16);

    const afterReadyFitCount = mocks.fitAddon.fit.mock.calls.length;
    expect(afterReadyFitCount).toBeGreaterThan(initialFitCount);

    vi.advanceTimersByTime(100);

    expect(mocks.fitAddon.fit.mock.calls.length).toBeGreaterThan(afterReadyFitCount);
  });

  it('runs a delayed re-fit after snapshot hydration to clear stale edge columns', () => {
    render(<Terminal sessionId="font-sync-snapshot" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.fitAddon.fit.mockClear();

    act(() => {
      mocks.ws.onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          sessionId: 'font-sync-snapshot',
          lastSeq: 1,
          data: 'restored line\r\n',
        }),
      });
    });

    const fitCountBeforeDelayedRecovery = mocks.fitAddon.fit.mock.calls.length;

    vi.advanceTimersByTime(100);

    expect(mocks.fitAddon.fit.mock.calls.length).toBeGreaterThan(fitCountBeforeDelayedRecovery);
  });

  it('requests an in-place tmux rehydrate when delayed fit changes snapshot geometry', () => {
    render(<Terminal sessionId="font-sync-rehydrate" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.send.mockClear();

    act(() => {
      mocks.ws.onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          sessionId: 'font-sync-rehydrate',
          lastSeq: 1,
          data: 'restored line\r\n',
        }),
      });
    });

    mocks.fitAddon.fit.mockImplementation(() => {
      mocks.term.cols = 100;
      mocks.term.rows = 28;
    });

    vi.advanceTimersByTime(100);

    const sentMessages = mocks.ws.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(sentMessages).toContainEqual({ type: 'resize', cols: 100, rows: 28 });
    expect(sentMessages).toContainEqual({ type: 'rehydrate' });
    expect(sentMessages.findIndex(message => message.type === 'resize'))
      .toBeLessThan(sentMessages.findIndex(message => message.type === 'rehydrate'));
  });

  it('does not request a rehydrate on user-driven resizes after the delayed post-font-settle fit', () => {
    // Rehydrate is meant as a one-shot correction for the single delayed fit
    // that runs after snapshot hydration — font metrics or container width
    // may have settled a beat later. Any subsequent geometry change comes
    // from the user (dragging a split, focusing the tab, pageshow) and must
    // not rewrite the whole viewport, because doing so wipes scroll position
    // and repaints history during an ordinary resize.
    render(<Terminal sessionId="font-sync-user-resize" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();

    act(() => {
      mocks.ws.onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          sessionId: 'font-sync-user-resize',
          lastSeq: 1,
          data: 'restored line\r\n',
        }),
      });
    });

    // The delayed fit runs at t≈100ms with no font-metric shift, so geometry
    // is still identical to the hydration geometry. This consumes the
    // one-shot — the client has made its best pass at correcting snapshot
    // geometry and must not attempt it again from later call paths.
    vi.advanceTimersByTime(100);

    mocks.ws.send.mockClear();

    // Simulate a user drag that changes the pane geometry a few hundred ms
    // later. scheduleViewportRecovery (triggered by pageshow/focus/visibility
    // and the React-level isVisible change) calls syncTerminalViewport on a
    // 50ms timer — exactly the same codepath a ResizeObserver would take.
    mocks.fitAddon.fit.mockImplementation(() => {
      mocks.term.cols = 80;
      mocks.term.rows = 20;
    });

    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    vi.advanceTimersByTime(50);

    const sentMessages = mocks.ws.send.mock.calls.map(([payload]) => JSON.parse(payload));
    expect(sentMessages.some(message => message.type === 'rehydrate')).toBe(false);
    // Resize must still be forwarded so the backend tracks the new geometry.
    expect(sentMessages).toContainEqual({ type: 'resize', cols: 80, rows: 20 });
  });
});
