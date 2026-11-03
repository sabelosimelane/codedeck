import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  ws: null,
  term: null,
  termOptions: null,
  showToast: vi.fn(),
  webLinksHandler: null,
}));

let resizeCallback;
global.ResizeObserver = class { constructor(callback) { resizeCallback = callback; } observe() {} disconnect() {} };

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    constructor(options) {
      mocks.termOptions = options;
      this.open = vi.fn(element => { this.element = element; });
      this.dispose = vi.fn();
      this.write = vi.fn((_data, callback) => callback?.());
      this.focus = vi.fn();
      this.resize = vi.fn();
      this.scrollToBottom = vi.fn();
      this.refresh = vi.fn();
      this.clear = vi.fn();
      this.loadAddon = vi.fn();
      this.parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
      this.hasSelection = () => true;
      this.getSelection = () => 'docs/todos/security-deposit-ledger-frontend.md';
      this.clearSelection = vi.fn();
      this.onSelectionChange = vi.fn();
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
  WebLinksAddon: class MockWebLinksAddon { constructor(handler) { mocks.webLinksHandler = handler; } },
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

vi.mock('../../theme', () => ({
  XTERM_THEMES: { dark: {}, light: {} },
  THEME_CHANGE_EVENT: 'codedeck-theme-change',
  getResolvedTheme: () => 'dark',
}));

vi.mock('../ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

import Terminal from '../Terminal';

function mountTerminal() {
  render(<Terminal sessionId="s1" cwd="/tmp" isVisible={true} runtimeType="pty" />);
  vi.advanceTimersByTime(16);
}

function spyOnLinkOpens() {
  const opened = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
    opened.push({ href: this.href, target: this.target, rel: this.rel });
  });
  return opened;
}

describe('Terminal link activation', () => {
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

  it('opens OSC 8 hyperlinks in a new tab without a confirm dialog', () => {
    const confirm = vi.spyOn(window, 'confirm');
    const opened = spyOnLinkOpens();
    mountTerminal();
    const { linkHandler } = mocks.termOptions;
    expect(linkHandler.allowNonHttpProtocols).not.toBe(true);
    linkHandler.activate(new MouseEvent('mouseup'), 'https://gitlab.com/org/repo/-/merge_requests/232');
    expect(confirm).not.toHaveBeenCalled();
    expect(opened).toEqual([{ href: 'https://gitlab.com/org/repo/-/merge_requests/232', target: '_blank', rel: 'noopener' }]);
  });

  it('opens plain-text URLs the same way', () => {
    const opened = spyOnLinkOpens();
    mountTerminal();
    mocks.webLinksHandler(new MouseEvent('mouseup'), 'https://example.com/path');
    expect(opened).toEqual([{ href: 'https://example.com/path', target: '_blank', rel: 'noopener' }]);
  });
});
