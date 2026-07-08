import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  wsInstances: [],
  term: null,
  showToast: vi.fn(),
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
  useToast: () => ({ showToast: mocks.showToast }),
}));

import Terminal from '../Terminal';

describe('Terminal host-unreachable overlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.wsInstances = [];
    mocks.term = null;
    mocks.showToast.mockReset();

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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows host-unreachable as its own retryable state instead of the backend reconnect banner', () => {
    render(<Terminal sessionId="RemoteApp-1" cwd="/srv/remote-app" isVisible={true} />);
    act(() => {
      vi.advanceTimersByTime(0);
    });

    const firstSocket = mocks.wsInstances[0];
    act(() => {
      firstSocket.readyState = 1;
      firstSocket.onopen?.();
      firstSocket.onmessage?.({
        data: JSON.stringify({
          type: 'spawn_error',
          reason: 'host_unreachable',
          host: 'devbox',
          message: 'Host "devbox" is unreachable. connect timeout',
          data: '\r\nHost "devbox" is unreachable. connect timeout\r\n',
        }),
      });
    });

    expect(screen.getByText('Host unreachable')).toBeTruthy();
    expect(screen.getByText('Host "devbox" is unreachable. connect timeout')).toBeTruthy();
    expect(screen.queryByText('Reconnecting...')).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry devbox terminal connection' }));
    });

    expect(mocks.wsInstances).toHaveLength(2);
    expect(firstSocket.close).toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(mocks.wsInstances).toHaveLength(2);
  });
});
