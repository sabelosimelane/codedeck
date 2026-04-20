import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  ws: null,
  term: null,
  termOptions: null,
  showToast: vi.fn(),
}));

global.ResizeObserver = class { observe() {} disconnect() {} };

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    constructor(options) {
      mocks.termOptions = options;
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
      this.buffer = { active: { type: 'normal', viewportY: 24, baseY: 24, length: 60 } };
      this.rows = 30;
      this.cols = 120;
      mocks.term = this;
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

vi.mock('../ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

import Terminal from '../Terminal';

describe('Terminal auto-scroll mouse takeover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.ws = null;
    mocks.term = null;
    mocks.termOptions = null;
    mocks.showToast = vi.fn();

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
    vi.restoreAllMocks();
  });

  it('shows the Latest button when the user wheels while pinned at the bottom with scrollback', () => {
    render(<Terminal sessionId="s1" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    const terminalViewport = mocks.term.open.mock.calls[0]?.[0];
    expect(terminalViewport).toBeTruthy();

    fireEvent.wheel(terminalViewport, { deltaY: 36 });

    expect(screen.getByTitle('Scroll to bottom')).toBeTruthy();
    expect(screen.getByText('Latest')).toBeTruthy();
  });

  it('passes explicit wheel scroll sensitivity options to xterm', () => {
    render(<Terminal sessionId="s2" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    expect(mocks.termOptions).toEqual(expect.objectContaining({
      scrollback: 10000,
      scrollSensitivity: 3,
      fastScrollSensitivity: 5,
      smoothScrollDuration: 0,
    }));
  });

  it('blocks xterm from translating wheel-up into ArrowUp when the normal buffer has no scrollback', () => {
    render(<Terminal sessionId="s3" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    expect(mocks.term.attachCustomWheelEventHandler).toHaveBeenCalledTimes(1);

    const wheelHandler = mocks.term.attachCustomWheelEventHandler.mock.calls[0][0];
    mocks.term.buffer.active = { type: 'normal', viewportY: 0, baseY: 0, length: 30 };

    expect(wheelHandler({ deltaY: -36 })).toBe(false);
  });

  it('routes wheel scrolling to tmux history instead of enabling tmux mouse mode', () => {
    render(<Terminal sessionId="s4" cwd="/tmp" isVisible={true} runtimeType="tmux" />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.send.mockClear();

    const wheelHandler = mocks.term.attachCustomWheelEventHandler.mock.calls[0][0];
    mocks.term.buffer.active = { type: 'alternate', viewportY: 0, baseY: 0, length: 30 };

    expect(wheelHandler({ deltaY: -120 })).toBe(false);
    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'scroll_history',
      direction: 'up',
      lines: 5,
    }));
  });

  it('updates tmux wheel routing when runtimeType metadata arrives without recreating the terminal', () => {
    const { rerender } = render(<Terminal sessionId="s5" cwd="/tmp" isVisible={true} runtimeType="pty" />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.send.mockClear();

    const wheelHandler = mocks.term.attachCustomWheelEventHandler.mock.calls[0][0];
    mocks.term.buffer.active = { type: 'alternate', viewportY: 0, baseY: 0, length: 30 };

    expect(wheelHandler({ deltaY: -120 })).toBe(true);
    expect(mocks.ws.send).not.toHaveBeenCalled();

    rerender(<Terminal sessionId="s5" cwd="/tmp" isVisible={true} runtimeType="tmux" />);

    expect(wheelHandler({ deltaY: -120 })).toBe(false);
    expect(mocks.ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'scroll_history',
      direction: 'up',
      lines: 5,
    }));
  });
});
