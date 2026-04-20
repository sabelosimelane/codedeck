import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import React from 'react';

/**
 * Tests for terminal file drag-and-drop and clipboard paste.
 *
 * Validates:
 * - Drag-and-drop uploads file and injects quoted path into PTY
 * - Clipboard paste of files uploads and injects path
 * - Regular text paste is not intercepted (xterm.js handles it)
 * - Oversized file upload shows error toast, no path injected
 * - Drop zone overlay appears during drag and disappears on drop/leave
 * - Directory drops show error toast
 * - Multiple files inject space-separated quoted paths
 */

// --- Hoisted mock state ---

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
      this.loadAddon = vi.fn();
      this.onData = vi.fn();
      this.onScroll = vi.fn();
      this.attachCustomKeyEventHandler = vi.fn();
      this.attachCustomWheelEventHandler = vi.fn();
      this.buffer = { active: { cursorY: 0, baseY: 0, length: 30 } };
      this.rows = 30;
      this.cols = 120;
      mocks.term = this;
    }
  }
  return { Terminal: MockTerminal };
});

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon { fit() {} }
  return { FitAddon: MockFitAddon };
});

vi.mock('@xterm/addon-web-links', () => {
  class MockWebLinksAddon {}
  return { WebLinksAddon: MockWebLinksAddon };
});

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
  shouldPauseAutoScrollOnWheel: () => false,
}));

vi.mock('../ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}));

import Terminal from '../Terminal';

// No helper needed — WsMock constructor assigns mocks.ws directly

/** Mount Terminal and connect WebSocket. */
function mountAndConnect() {
  const result = render(<Terminal sessionId="s1" cwd="/tmp" isVisible={true} />);
  vi.advanceTimersByTime(16);
  mocks.ws.readyState = 1;
  mocks.ws.onopen?.();
  mocks.ws.send.mockClear();
  mocks.showToast.mockClear();
  return result;
}

function createFile(name, size = 100, type = 'image/png') {
  return new File([new ArrayBuffer(size)], name, { type });
}

// Flush microtask queue (async upload promises)
async function flushAsync() {
  // Multiple rounds to flush chained promises (fetch -> .json() -> ws.send)
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

// --- Tests ---

describe('Terminal file drag-and-drop and paste', () => {
  let originalFetch;

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

    originalFetch = global.fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  describe('drag-and-drop', () => {
    it('shows drop zone overlay on dragenter and hides on dragleave', () => {
      const { container } = mountAndConnect();
      const wrapper = container.firstChild;

      fireEvent.dragEnter(wrapper);
      expect(wrapper.textContent).toContain('Drop file to paste path');

      fireEvent.dragLeave(wrapper);
      expect(wrapper.textContent).not.toContain('Drop file to paste path');
    });

    it('uploads file on drop and injects quoted path into PTY', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ path: '/tmp/codedeck-drops/123-test.png' }),
      });

      const { container } = mountAndConnect();
      const wrapper = container.firstChild;

      const file = createFile('test.png');
      const dropEvent = new Event('drop', { bubbles: true });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [file] },
      });
      wrapper.dispatchEvent(dropEvent);

      await flushAsync();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe('/api/upload');
      expect(opts.method).toBe('POST');

      expect(mocks.ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'input', data: '"/tmp/codedeck-drops/123-test.png"' })
      );
    });

    it('uploads multiple files and injects space-separated quoted paths', async () => {
      let callCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        const n = callCount;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ path: `/tmp/codedeck-drops/${n}-file${n}.png` }),
        });
      });

      const { container } = mountAndConnect();
      const wrapper = container.firstChild;

      const file1 = createFile('file1.png');
      const file2 = createFile('file2.png');
      const dropEvent = new Event('drop', { bubbles: true });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [file1, file2] },
      });
      wrapper.dispatchEvent(dropEvent);

      await flushAsync();

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(mocks.ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'input', data: '"/tmp/codedeck-drops/1-file1.png" "/tmp/codedeck-drops/2-file2.png"' })
      );
    });

    it('shows error toast when directory is dropped', async () => {
      const { container } = mountAndConnect();
      const wrapper = container.firstChild;

      const dirFile = new File([], 'my-folder', { type: '' });
      Object.defineProperty(dirFile, 'size', { value: 0 });

      const dropEvent = new Event('drop', { bubbles: true });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [dirFile] },
      });
      wrapper.dispatchEvent(dropEvent);

      await flushAsync();

      expect(mocks.showToast).toHaveBeenCalledWith({
        type: 'error',
        message: 'Directory uploads not supported',
      });
    });
  });

  describe('clipboard paste', () => {
    it('uploads pasted file and injects quoted path', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ path: '/tmp/codedeck-drops/456-screenshot.png' }),
      });

      const { container } = mountAndConnect();
      const wrapper = container.firstChild;

      const file = createFile('screenshot.png');
      const pasteEvent = new Event('paste', { bubbles: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: { files: [file] },
      });
      wrapper.dispatchEvent(pasteEvent);

      await flushAsync();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(mocks.ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'input', data: '"/tmp/codedeck-drops/456-screenshot.png"' })
      );
    });

    it('does not intercept text-only paste (no files)', () => {
      const { container } = mountAndConnect();
      const wrapper = container.firstChild;

      const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: { files: [] },
      });
      wrapper.dispatchEvent(pasteEvent);

      expect(pasteEvent.defaultPrevented).toBe(false);
    });
  });

  describe('error handling', () => {
    it('shows error toast when upload returns 413 (file too large)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
        json: () => Promise.resolve({ error: 'File too large (max 20MB)' }),
      });

      const { container } = mountAndConnect();
      const wrapper = container.firstChild;

      const file = createFile('huge.bin', 100);
      const dropEvent = new Event('drop', { bubbles: true });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [file] },
      });
      wrapper.dispatchEvent(dropEvent);

      await flushAsync();

      expect(mocks.showToast).toHaveBeenCalledWith({
        type: 'error',
        message: 'File too large (max 20MB)',
      });

      const inputSends = mocks.ws.send.mock.calls.filter(
        ([arg]) => arg.includes('"type":"input"')
      );
      expect(inputSends).toHaveLength(0);
    });

    it('shows error toast when upload fails (network error)', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const { container } = mountAndConnect();
      const wrapper = container.firstChild;

      const file = createFile('test.png');
      const dropEvent = new Event('drop', { bubbles: true });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [file] },
      });
      wrapper.dispatchEvent(dropEvent);

      await flushAsync();

      expect(mocks.showToast).toHaveBeenCalledWith({
        type: 'error',
        message: 'Network error',
      });
    });

    it('shows generic error when upload response has no error field', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      });

      const { container } = mountAndConnect();
      const wrapper = container.firstChild;

      const file = createFile('test.png');
      const dropEvent = new Event('drop', { bubbles: true });
      Object.defineProperty(dropEvent, 'dataTransfer', {
        value: { files: [file] },
      });
      wrapper.dispatchEvent(dropEvent);

      await flushAsync();

      expect(mocks.showToast).toHaveBeenCalledWith({
        type: 'error',
        message: 'Failed to upload file',
      });
    });
  });
});
