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
      this.buffer = { active: { viewportY: 24, baseY: 24, length: 60 } };
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
      scrollSensitivity: 3,
      fastScrollSensitivity: 5,
      smoothScrollDuration: 0,
    }));
  });
});
