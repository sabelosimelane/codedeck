import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';
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

function mountTerminal(props = {}) {
  const result = render(
    <Terminal
      sessionId={props.sessionId ?? 's1'}
      cwd="/tmp"
      isVisible={true}
      runtimeType={props.runtimeType ?? 'pty'}
    />
  );
  vi.advanceTimersByTime(16);
  return result;
}

function connectSocket() {
  mocks.ws.readyState = 1;
  mocks.ws.onopen?.();
  mocks.ws.send.mockClear();
}

function detachViewport({ viewportY = 12, baseY = 24 } = {}) {
  const onScroll = mocks.term.onScroll.mock.calls[0]?.[0];
  expect(onScroll).toBeTruthy();

  act(() => {
    mocks.term.buffer.active = { type: 'normal', viewportY, baseY, length: 60 };
    onScroll();
  });
}

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
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows the Latest button when the user wheels upward while pinned at the bottom with scrollback', () => {
    mountTerminal({ sessionId: 's1' });

    const terminalViewport = mocks.term.open.mock.calls[0]?.[0];
    expect(terminalViewport).toBeTruthy();

    fireEvent.wheel(terminalViewport, { deltaY: -36 });

    expect(screen.getByTitle('Scroll to bottom')).toBeTruthy();
    expect(screen.getByText('Latest')).toBeTruthy();
  });

  it('keeps auto-follow enabled when the user wheels downward at the live bottom', () => {
    mountTerminal({ sessionId: 's2' });

    const terminalViewport = mocks.term.open.mock.calls[0]?.[0];
    expect(terminalViewport).toBeTruthy();

    fireEvent.wheel(terminalViewport, { deltaY: 36 });

    expect(screen.queryByTitle('Scroll to bottom')).toBeNull();
    expect(screen.queryByText('Latest')).toBeNull();
  });

  it('passes explicit wheel scroll sensitivity options to xterm', () => {
    mountTerminal({ sessionId: 's3' });

    expect(mocks.termOptions).toEqual(expect.objectContaining({
      scrollback: 10000,
      scrollSensitivity: 3,
      fastScrollSensitivity: 5,
      smoothScrollDuration: 0,
    }));
  });

  it('blocks xterm from translating wheel-up into ArrowUp when the normal buffer has no scrollback', () => {
    mountTerminal({ sessionId: 's4' });

    expect(mocks.term.attachCustomWheelEventHandler).toHaveBeenCalledTimes(1);

    const wheelHandler = mocks.term.attachCustomWheelEventHandler.mock.calls[0][0];
    mocks.term.buffer.active = { type: 'normal', viewportY: 0, baseY: 0, length: 30 };

    expect(wheelHandler({ deltaY: -36 })).toBe(false);
  });

  it('keeps wheel scrolling local to xterm even for tmux-backed sessions', () => {
    mountTerminal({ sessionId: 's5', runtimeType: 'tmux' });
    connectSocket();

    const wheelHandler = mocks.term.attachCustomWheelEventHandler.mock.calls[0][0];
    mocks.term.buffer.active = { type: 'alternate', viewportY: 0, baseY: 0, length: 30 };

    expect(wheelHandler({ deltaY: -120 })).toBe(true);
    expect(mocks.ws.send).not.toHaveBeenCalled();
  });

  it('does not change wheel behavior when runtime metadata later switches to tmux', () => {
    const { rerender } = mountTerminal({ sessionId: 's6', runtimeType: 'pty' });
    connectSocket();

    const wheelHandler = mocks.term.attachCustomWheelEventHandler.mock.calls[0][0];
    mocks.term.buffer.active = { type: 'alternate', viewportY: 0, baseY: 0, length: 30 };

    expect(wheelHandler({ deltaY: -120 })).toBe(true);
    expect(mocks.ws.send).not.toHaveBeenCalled();

    rerender(<Terminal sessionId="s6" cwd="/tmp" isVisible={true} runtimeType="tmux" />);

    expect(wheelHandler({ deltaY: -120 })).toBe(true);
    expect(mocks.ws.send).not.toHaveBeenCalled();
  });

  it('keeps the viewport detached while live output arrives below it', () => {
    mountTerminal({ sessionId: 's7' });
    connectSocket();
    detachViewport();

    mocks.term.scrollToBottom.mockClear();
    mocks.term.write.mockClear();

    act(() => {
      mocks.ws.onmessage?.({
        data: JSON.stringify({ type: 'output', seq: 1, data: 'new output\r\n' }),
      });
    });

    expect(screen.getByText('Latest')).toBeTruthy();
    expect(mocks.term.write).toHaveBeenCalledWith('new output\r\n');
    expect(mocks.term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('keeps the viewport detached when focus recovery replays active output below it', () => {
    mountTerminal({ sessionId: 's9' });
    connectSocket();
    detachViewport();

    mocks.term.scrollToBottom.mockClear();
    mocks.term.write.mockClear();

    act(() => {
      mocks.ws.onmessage?.({
        data: JSON.stringify({
          type: 'replay',
          chunks: [
            { seq: 1, data: 'replayed output\r\n' },
          ],
          overflow: false,
          missedCount: 0,
        }),
      });
    });

    expect(screen.getByText('Latest')).toBeTruthy();
    expect(mocks.term.write).toHaveBeenCalledWith('replayed output\r\n');
    expect(mocks.term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('re-enables auto-follow when the user clicks Latest', () => {
    mountTerminal({ sessionId: 's8' });
    connectSocket();
    detachViewport();

    mocks.term.scrollToBottom.mockClear();

    fireEvent.click(screen.getByTitle('Scroll to bottom'));

    expect(mocks.term.scrollToBottom).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Latest')).toBeNull();

    mocks.term.scrollToBottom.mockClear();

    act(() => {
      mocks.ws.onmessage?.({
        data: JSON.stringify({ type: 'output', seq: 2, data: '$ ' }),
      });
    });

    expect(mocks.term.scrollToBottom).toHaveBeenCalledTimes(1);
  });
});
