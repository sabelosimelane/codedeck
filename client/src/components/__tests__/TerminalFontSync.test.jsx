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

    expect(mocks.fitAddon.fit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFontsReady();
      await Promise.resolve();
    });
    vi.advanceTimersByTime(16);

    expect(mocks.fitAddon.fit).toHaveBeenCalledTimes(2);
  });
});
