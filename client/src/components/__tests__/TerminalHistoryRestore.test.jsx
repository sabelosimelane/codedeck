import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';

const mocks = vi.hoisted(() => ({
  ws: null,
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
  shouldResumeFromSessionHandshake: (msg) => msg?.type === 'session' && msg.existing === true && !msg.snapshotWindowLines,
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
  shouldPauseAutoScrollOnWheel: () => false,
  shouldBlockXtermWheelViewportFallback: () => false,
  shouldRouteWheelToTmuxHistory: () => false,
}));

vi.mock('../ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

import Terminal from '../Terminal';

describe('Terminal durable history restore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.ws = null;
    mocks.term = null;
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

  it('clears stale xterm state and writes authoritative snapshots before live output continues', () => {
    render(<Terminal sessionId="s-history" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.term.write.mockClear();
    mocks.term.clear.mockClear();
    mocks.term.reset.mockClear();
    mocks.term.scrollToBottom.mockClear();

    mocks.ws.onmessage?.({
      data: JSON.stringify({
        type: 'session',
        sessionId: 's-history',
        existing: true,
        runtimeType: 'tmux',
        snapshotWindowLines: 10000,
        historyGuaranteed: true,
      }),
    });

    mocks.ws.onmessage?.({
      data: JSON.stringify({
        type: 'snapshot',
        sessionId: 's-history',
        lastSeq: 42,
        data: 'older line 1\nolder line 2\n',
      }),
    });

    mocks.ws.onmessage?.({
      data: JSON.stringify({
        type: 'output',
        seq: 43,
        data: '$ ',
      }),
    });

    expect(mocks.term.reset).toHaveBeenCalledTimes(1);
    expect(mocks.term.clear).toHaveBeenCalledTimes(1);
    expect(mocks.term.write).toHaveBeenNthCalledWith(1, 'older line 1\nolder line 2\n');
    expect(mocks.term.write).toHaveBeenNthCalledWith(2, '$ ');
    expect(mocks.term.scrollToBottom).toHaveBeenCalled();
  });

  it('does not request replay when the session handshake advertises snapshot hydration', () => {
    render(<Terminal sessionId="s-history" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.send.mockClear();

    mocks.ws.onmessage?.({
      data: JSON.stringify({
        type: 'session',
        sessionId: 's-history',
        existing: true,
        runtimeType: 'tmux',
        snapshotWindowLines: 10000,
        historyGuaranteed: true,
      }),
    });

    const resumeCalls = mocks.ws.send.mock.calls.filter(([payload]) => payload.includes('"type":"resume"'));
    expect(resumeCalls).toHaveLength(0);
  });

  it('rebuilds modeful terminal state from snapshot metadata before writing restored content', () => {
    render(<Terminal sessionId="s-history" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.term.write.mockClear();
    mocks.term.clear.mockClear();
    mocks.term.reset.mockClear();

    mocks.ws.onmessage?.({
      data: JSON.stringify({
        type: 'session',
        sessionId: 's-history',
        existing: true,
        runtimeType: 'tmux',
        snapshotWindowLines: 10000,
        historyGuaranteed: true,
      }),
    });

    mocks.ws.onmessage?.({
      data: JSON.stringify({
        type: 'snapshot',
        sessionId: 's-history',
        lastSeq: 12,
        data: '\x1b[32m~\x1b[39m\n',
        terminalState: {
          screenMode: 'alternate',
          paneMode: null,
          cursorX: 4,
          cursorY: 2,
          cursorVisible: false,
          cursorShape: 'bar',
          cursorBlinking: false,
          cursorVeryVisible: false,
          insertMode: false,
          originMode: false,
          autoWrap: true,
          keypadMode: false,
          applicationCursorKeys: true,
          mouseMode: 'all',
          mouseEncoding: 'sgr',
          bracketedPaste: true,
        },
      }),
    });

    expect(mocks.term.reset).toHaveBeenCalledTimes(1);
    expect(mocks.term.clear).toHaveBeenCalledTimes(1);
    expect(mocks.term.write).toHaveBeenCalledTimes(1);
    const restoreWrite = mocks.term.write.mock.calls[0][0];
    expect(restoreWrite).toContain('\x1b[?1049h');
    expect(restoreWrite).toContain('\x1b[?1h');
    expect(restoreWrite).toContain('\x1b[?2004h');
    expect(restoreWrite).toContain('\x1b[?1003h');
    expect(restoreWrite).toContain('\x1b[?1006h');
    expect(restoreWrite).toContain('\x1b[?25l');
    expect(restoreWrite).toContain('\x1b[6 q');
    expect(restoreWrite).toContain('\x1b[32m~\x1b[39m\n');
    expect(restoreWrite.endsWith('\x1b[3;5H')).toBe(true);
  });

  it('shows an explicit warning when preserved history is unavailable after reconnect', () => {
    render(<Terminal sessionId="s-history" cwd="/tmp" isVisible={true} />);
    vi.advanceTimersByTime(16);

    mocks.ws.readyState = 1;
    mocks.ws.onopen?.();
    mocks.ws.send.mockClear();
    mocks.term.write.mockClear();
    mocks.term.clear.mockClear();
    mocks.term.reset.mockClear();

    act(() => {
      mocks.ws.onmessage?.({
        data: JSON.stringify({
          type: 'session',
          sessionId: 's-history',
          existing: true,
          runtimeType: 'tmux',
          snapshotWindowLines: 10000,
          historyGuaranteed: false,
        }),
      });

      mocks.ws.onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          sessionId: 's-history',
          lastSeq: 42,
          historyGuaranteed: false,
          data: '',
        }),
      });

      mocks.ws.onmessage?.({
        data: JSON.stringify({
          type: 'history_warning',
          sessionId: 's-history',
          reason: 'snapshot_unavailable',
          message: 'Recent scrollback could not be restored accurately. Live terminal output is attached, but preserved history is unavailable.',
        }),
      });

      mocks.ws.onmessage?.({
        data: JSON.stringify({
          type: 'output',
          seq: 43,
          data: '$ ',
        }),
      });
    });

    const resumeCalls = mocks.ws.send.mock.calls.filter(([payload]) => payload.includes('"type":"resume"'));

    expect(resumeCalls).toHaveLength(0);
    expect(mocks.term.reset).toHaveBeenCalledTimes(1);
    expect(mocks.term.clear).toHaveBeenCalledTimes(1);
    expect(mocks.term.write).toHaveBeenCalledWith('$ ');
    expect(mocks.showToast).toHaveBeenCalledWith({
      type: 'warning',
      message: 'Recent scrollback could not be restored accurately. Live terminal output is attached, but preserved history is unavailable.',
    });
    expect(screen.getByText('Recent scrollback could not be restored accurately. Live terminal output is attached, but preserved history is unavailable.')).toBeTruthy();
  });
});
