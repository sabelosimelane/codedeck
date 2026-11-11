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
      this.write = vi.fn((data, callback) => callback?.());
      this.focus = vi.fn();
      this.resize = vi.fn();
      this.scrollToBottom = vi.fn();
      this.scrollLines = vi.fn();
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
      mobile={props.mobile ?? false}
    />
  );
  if (vi.isFakeTimers()) vi.advanceTimersByTime(16);
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

  function flick(mode = 'normal') {
    const rendered=mountTerminal({mobile:true});connectSocket();
    const viewport=mocks.term.open.mock.calls[0][0];
    Object.defineProperty(viewport,'clientHeight',{value:600});
    const wheel=vi.fn();
    if(mode==='alternate') {
      mocks.term.buffer.active={type:'alternate',baseY:0,viewportY:0};
      mocks.term.modes={mouseTrackingMode:'vt200'};
      mocks.term.element=viewport;
      viewport.addEventListener('wheel',wheel);
      act(()=>mocks.ws.onmessage({data:JSON.stringify({type:'session',attachmentId:'a',controllerId:'a',controlRevision:1,cols:80,rows:30})}));
    }
    fireEvent.touchStart(viewport,{touches:[{clientX:50,clientY:100}]});
    act(()=>vi.advanceTimersByTime(30));
    fireEvent.touchMove(viewport,{touches:[{clientX:50,clientY:160}]});
    fireEvent.touchEnd(viewport,{touches:[]});
    return {viewport,rendered,calls:mode==='alternate'?wheel:mocks.term.scrollLines};
  }

  it.each(['normal','alternate'])('continues a flick with bounded decaying momentum in %s mode',mode=>{
    const {calls}=flick(mode);const before=calls.mock.calls.length;
    act(()=>vi.advanceTimersByTime(100));
    expect(calls.mock.calls.length).toBeGreaterThan(before);
    const distance=()=>mode==='alternate'?calls.mock.calls.length:calls.mock.calls.reduce((sum,[lines])=>sum+Math.abs(lines),0);
    const early=distance();
    act(()=>vi.advanceTimersByTime(500));const lateStart=distance();
    act(()=>vi.advanceTimersByTime(100));expect(distance()-lateStart).toBeLessThan(early);
    act(()=>vi.advanceTimersByTime(1500));const stopped=calls.mock.calls.length;
    act(()=>vi.advanceTimersByTime(500));expect(calls).toHaveBeenCalledTimes(stopped);
  });

  it.each(['touch','cancel','unmount','disconnect','control'])('stops momentum on %s',reason=>{
    const {viewport,rendered,calls}=flick('alternate');
    act(()=>vi.advanceTimersByTime(50));
    expect(calls.mock.calls.length).toBeGreaterThan(3);
    if(reason==='touch')fireEvent.touchStart(viewport,{touches:[{clientX:50,clientY:160}]});
    if(reason==='cancel')fireEvent.touchCancel(viewport);
    if(reason==='unmount')rendered.unmount();
    if(reason==='disconnect')mocks.ws.readyState=3;
    if(reason==='control')act(()=>mocks.ws.onmessage({data:JSON.stringify({type:'control_state',controllerId:'b',controlRevision:2,cols:80,rows:30})}));
    const stopped=calls.mock.calls.length;
    act(()=>vi.advanceTimersByTime(500));expect(calls).toHaveBeenCalledTimes(stopped);
  });

  it('scrolls mobile history locally even when the child terminal consumes touch events', () => {
    mountTerminal({ mobile: true });connectSocket();
    const viewport=mocks.term.open.mock.calls[0][0];
    Object.defineProperty(viewport,'clientHeight',{value:600});
    const child=document.createElement('div');viewport.appendChild(child);
    const childMove=vi.fn(event=>event.stopPropagation());child.addEventListener('touchmove',childMove);
    mocks.term.focus.mockClear();mocks.term.scrollToBottom.mockClear();mocks.ws.send.mockClear();
    fireEvent.touchStart(child,{touches:[{clientX:50,clientY:100}]});
    fireEvent.touchMove(child,{touches:[{clientX:50,clientY:160}]});
    fireEvent.touchEnd(child,{touches:[]});
    expect(mocks.term.scrollLines).toHaveBeenCalledWith(-3);
    expect(childMove).not.toHaveBeenCalled();
    expect(screen.getByText('Latest')).toBeTruthy();
    expect(mocks.term.focus).not.toHaveBeenCalled();
    expect(mocks.ws.send).not.toHaveBeenCalled();
    act(()=>mocks.ws.onmessage({data:JSON.stringify({type:'output',seq:1,data:'new output'})}));
    expect(mocks.term.scrollToBottom).not.toHaveBeenCalled();
  });

  it('routes a swipe to the agent wheel handler when real xterm is in mouse-enabled alternate screen', async () => {
    vi.useRealTimers();
    const { Terminal: RealTerminal } = await vi.importActual('@xterm/xterm');
    const realTerm = new RealTerminal({ cols:80, rows:24 });
    await new Promise(resolve => realTerm.write('first\r\nsecond\x1b[?1049h\x1b[?1000h\x1b[?1006h', resolve));
    try {
      expect(realTerm.buffer.active.type).toBe('alternate');
      expect(realTerm.modes.mouseTrackingMode).toBe('vt200');
      realTerm.scrollLines(-3);
      expect(realTerm.buffer.active.viewportY).toBe(0);
      mountTerminal({mobile:true});
      mocks.term.buffer=realTerm.buffer;
      mocks.term.modes=realTerm.modes;
      const viewport=mocks.term.open.mock.calls[0][0];
      Object.defineProperty(viewport,'clientHeight',{value:600});
      const child=document.createElement('div');viewport.appendChild(child);
      mocks.term.element=child;
      const wheel=vi.fn();child.addEventListener('wheel',wheel);
      fireEvent.touchStart(child,{touches:[{clientX:50,clientY:100}]});
      fireEvent.touchMove(child,{touches:[{clientX:50,clientY:160}]});
      fireEvent.touchEnd(child,{touches:[]});
      expect(wheel).toHaveBeenCalledTimes(3);
      expect(wheel.mock.calls[0][0]).toMatchObject({deltaY:-1,deltaMode:1,clientX:50,clientY:160});
      expect(mocks.term.scrollLines).not.toHaveBeenCalled();
    } finally { realTerm.dispose(); }
  });

  it.each(['none','x10'])('does not send arrows or wheel input for alternate-screen mode %s', mode => {
    mountTerminal({mobile:true});connectSocket();
    mocks.term.buffer.active={type:'alternate',baseY:0,viewportY:0};
    mocks.term.modes={mouseTrackingMode:mode};
    const viewport=mocks.term.open.mock.calls[0][0];
    Object.defineProperty(viewport,'clientHeight',{value:600});
    const wheel=vi.fn();viewport.addEventListener('wheel',wheel);
    fireEvent.touchStart(viewport,{touches:[{clientX:50,clientY:100}]});
    fireEvent.touchMove(viewport,{touches:[{clientX:50,clientY:160}]});
    expect(wheel).not.toHaveBeenCalled();
    expect(mocks.ws.send).not.toHaveBeenCalled();
  });

  it('does not turn multi-touch or a cancelled mobile gesture into terminal input', () => {
    mountTerminal({mobile:true});connectSocket();
    const viewport=mocks.term.open.mock.calls[0][0];
    mocks.term.focus.mockClear();mocks.ws.send.mockClear();
    fireEvent.touchStart(viewport,{touches:[{clientX:0,clientY:100},{clientX:20,clientY:100}]});
    fireEvent.touchMove(viewport,{touches:[{clientX:0,clientY:160},{clientX:20,clientY:160}]});
    fireEvent.touchCancel(viewport);fireEvent.touchEnd(viewport,{touches:[]});
    expect(mocks.term.scrollLines).not.toHaveBeenCalled();
    expect(mocks.term.focus).not.toHaveBeenCalled();expect(mocks.ws.send).not.toHaveBeenCalled();
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

  it('keeps dim terminal input text clearly readable over ANSI backgrounds', () => {
    mountTerminal({ sessionId: 's3-contrast' });

    expect(mocks.termOptions).toEqual(expect.objectContaining({
      minimumContrastRatio: 14,
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
