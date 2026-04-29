import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';

/**
 * Multi-pane focus behavior on browser-level visibility/focus recovery.
 *
 * Bug: when two panes share the active tab and the user navigates away from the
 * window/tab and comes back, the global `visibilitychange`/`focus`/`pageshow`
 * listeners registered by every Terminal instance each schedule a 50ms
 * `term.focus()` call. They fire in mount order, so the last-mounted pane wins
 * — overriding the focus the user intended to put on an earlier pane.
 *
 * The active pane (whichever the user clicked) must keep focus. Inactive panes
 * in the same tab must NOT be refocused by global window/tab events.
 */

const mocks = vi.hoisted(() => ({
  terms: [],
  wsInstances: [],
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
      this.buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 30 } };
      this.rows = 30;
      this.cols = 120;
      mocks.terms.push(this);
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon { fit() {} },
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

describe('Multi-pane focus after window/visibility recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.terms = [];
    mocks.wsInstances = [];

    class WsMock {
      constructor() {
        this.readyState = 0;
        this.send = vi.fn();
        this.close = vi.fn();
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        mocks.wsInstances.push(this);
      }
    }
    WsMock.CONNECTING = 0;
    WsMock.OPEN = 1;
    WsMock.CLOSING = 2;
    WsMock.CLOSED = 3;
    global.WebSocket = WsMock;

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        ready: Promise.resolve(),
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

  it('does not refocus an inactive pane on window focus when another pane is the user-clicked active pane', () => {
    // Two panes in the same active tab. activePaneId is held in TerminalArea
    // state; when the user clicks pane 1, the click handler in pane 1 focuses
    // pane 1's xterm. Pane 2 is the inactive sibling.
    render(
      <>
        <Terminal sessionId="proj-1" cwd="/tmp" isVisible={true} isActivePane={true} />
        <Terminal sessionId="proj-2" cwd="/tmp" isVisible={true} isActivePane={false} />
      </>
    );

    // Let mount-time setTimeouts (the deferred connect) drain and bring both
    // WebSockets into OPEN state, mirroring how the panes look once attached.
    vi.advanceTimersByTime(20);
    expect(mocks.terms).toHaveLength(2);
    expect(mocks.wsInstances).toHaveLength(2);

    for (const ws of mocks.wsInstances) {
      ws.readyState = 1; // OPEN
      ws.onopen?.();
    }

    // Drain any post-open work (heartbeat scheduling, etc.) and clear focus
    // history so we can attribute every subsequent focus call to the recovery
    // path under test, not to mount/connect.
    vi.advanceTimersByTime(20);
    mocks.terms[0].focus.mockClear();
    mocks.terms[1].focus.mockClear();

    // Simulate the user clicking pane 1 — Terminal.jsx:848 calls term.focus()
    // synchronously on the container's mousedown, so pane 1 is the focused
    // xterm at the moment the racing recovery timers fire.
    mocks.terms[0].focus();
    mocks.terms[0].focus.mockClear();

    // Now the window regains focus (returning from another tab/window).
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    // scheduleViewportRecovery uses a 50ms setTimeout. Drain past it.
    vi.advanceTimersByTime(60);

    // The inactive sibling must NOT be refocused. If it is, focus is stolen
    // from pane 1 because the recovery handlers fire for every Terminal
    // instance and the last one wins.
    expect(mocks.terms[1].focus).not.toHaveBeenCalled();
  });

  it('does not refocus an inactive pane when its WebSocket receives a replay message', () => {
    // Resume-after-visibility-recovery causes every pane's WS to send a
    // 'resume' and receive a 'replay'. The replay handler used to call
    // term.focus() unconditionally — fine for a single pane, focus theft
    // for siblings.
    render(
      <>
        <Terminal sessionId="proj-1" cwd="/tmp" isVisible={true} isActivePane={true} />
        <Terminal sessionId="proj-2" cwd="/tmp" isVisible={true} isActivePane={false} />
      </>
    );

    vi.advanceTimersByTime(20);
    for (const ws of mocks.wsInstances) {
      ws.readyState = 1;
      ws.onopen?.();
    }
    vi.advanceTimersByTime(20);
    mocks.terms[0].focus.mockClear();
    mocks.terms[1].focus.mockClear();

    // Simulate the replay message that follows a resume request on the
    // inactive pane's WebSocket.
    act(() => {
      mocks.wsInstances[1].onmessage?.({
        data: JSON.stringify({ type: 'replay', chunks: [{ data: 'caught up\r\n', seq: 5 }] }),
      });
    });

    expect(mocks.terms[1].focus).not.toHaveBeenCalled();
  });
});
