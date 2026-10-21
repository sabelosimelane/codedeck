import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  ws: null,
  term: null,
  termOptions: null,
  showToast: vi.fn(),
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

vi.mock('../../theme', () => ({
  XTERM_THEMES: { dark: {}, light: {} },
  THEME_CHANGE_EVENT: 'codedeck-theme-change',
  getResolvedTheme: () => 'dark',
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

describe('Terminal explicit copy integration', () => {
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

  it('does not auto-copy when the selection changes', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mountTerminal();
    mocks.term.onSelectionChange.mock.calls[0]?.[0]();
    vi.advanceTimersByTime(200);
    expect(writeText).not.toHaveBeenCalled();
  });
  it('buffers output during Option-drag and resumes it on Escape', () => {
    mountTerminal(); connectSocket();
    const viewport = mocks.term.open.mock.calls[0][0];
    fireEvent.mouseDown(viewport, { button: 0, altKey: true });
    act(() => mocks.ws.onmessage({ data: JSON.stringify({ type: 'output', data: 'new output', seq: 1 }) }));
    expect(mocks.term.write.mock.calls.filter(([data]) => data !== '')).toEqual([]);
    expect(screen.getByText(/Display paused for selection/)).toBeTruthy();
    fireEvent.keyDown(viewport, { key: 'Escape' });
    expect(mocks.term.write).toHaveBeenCalledWith('new output');
  });
  it('disables Alt-click cursor movement and consumes OSC 52 without clipboard access', () => {
    mountTerminal();
    expect(mocks.termOptions.altClickMovesCursor).toBe(false);
    const handler = mocks.term.parser.registerOscHandler.mock.calls.find(([id]) => id === 52)?.[1];
    expect(handler).toBeTypeOf('function');
    expect(handler('c;YWJj')).toBe(true);
    expect(handler('c;?')).toBe(true);
  });
  it('holds a replacement snapshot plus later replay and output, then flushes them in order', () => {
    mountTerminal(); connectSocket();
    const viewport = mocks.term.open.mock.calls[0][0];
    fireEvent.mouseDown(viewport, { button: 0, altKey: true });
    const emit = message => act(() => mocks.ws.onmessage({ data: JSON.stringify(message) }));
    emit({ type: 'output', data: 'superseded', seq: 1 });
    emit({ type: 'snapshot', data: 'snapshot', lastSeq: 2 });
    emit({ type: 'replay', chunks: [{ data: 'replay', seq: 3 }], overflow: false });
    emit({ type: 'output', data: 'live', seq: 4 });
    fireEvent.focus(window);
    act(() => vi.advanceTimersByTime(100));
    expect(mocks.term.write.mock.calls.filter(([data]) => data !== '')).toEqual([]);
    fireEvent.keyDown(viewport, { key: 'Escape' });
    expect(mocks.term.write.mock.calls.filter(([data]) => data !== '').map(([data]) => data)).toEqual(['snapshot', 'replay', 'live']);
  });
  it('cancels selection visibly on actual resize and flushes held output', () => {
    mountTerminal(); connectSocket();
    const viewport = mocks.term.open.mock.calls[0][0];
    fireEvent.mouseDown(viewport, { button: 0, altKey: true });
    act(() => mocks.ws.onmessage({ data: JSON.stringify({ type: 'output', data: 'held', seq: 1 }) }));
    Object.defineProperty(viewport, 'clientWidth', { value: 600, configurable: true });
    act(() => resizeCallback());
    expect(screen.queryByText(/Display paused for selection/)).toBeNull();
    expect(mocks.term.write).toHaveBeenCalledWith('held');
    expect(mocks.showToast).toHaveBeenCalledWith({ type: 'warning', message: expect.stringContaining('size changed') });
  });
  it('does not drop the chunk that exceeds the selection output limit', () => {
    mountTerminal(); connectSocket();
    const viewport = mocks.term.open.mock.calls[0][0];
    fireEvent.mouseDown(viewport, { button: 0, altKey: true });
    const data = 'a'.repeat(4 * 1024 * 1024 + 1);
    act(() => mocks.ws.onmessage({ data: JSON.stringify({ type: 'output', data, seq: 1 }) }));
    expect(screen.queryByText(/Display paused for selection/)).toBeNull();
    expect(mocks.term.write).toHaveBeenCalledWith(data);
  });

});
