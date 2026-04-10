import React, { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useToast } from './ToastContext';

const MAX_RETRIES = 10;
const BASE_DELAY = 1000;
const MAX_DELAY = 30000;

export default function Terminal({ sessionId, cwd, isVisible }) {
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const fitRef = useRef(null);
  const termRef = useRef(null);
  const retryRef = useRef(0);
  const retryTimerRef = useRef(null);
  const mountedRef = useRef(true);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // 'connected' | 'connecting' | 'disconnected' | 'failed'
  const { showToast } = useToast();

  useEffect(() => {
    mountedRef.current = true;
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', monospace",
      lineHeight: 1.4,
      theme: {
        background: '#0e0e10',
        foreground: '#e4e4e8',
        cursor: '#6ee7b7',
        selectionBackground: '#6ee7b740',
        black: '#0e0e10',
        red: '#f87171',
        green: '#6ee7b7',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e8',
        brightBlack: '#5a5a66',
        brightRed: '#fca5a5',
        brightGreen: '#a7f3d0',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
      allowTransparency: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(containerRef.current);
    fitAddon.fit();
    fitRef.current = fitAddon;
    termRef.current = term;

    // Prevent browser from stealing terminal shortcuts (Ctrl+R, Ctrl+W, etc.)
    // We intercept these keys, block both browser and xterm default handling,
    // and send the control character directly to the PTY via WebSocket.
    const browserStolenKeys = new Set(['r', 'w', 't', 'n']);
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
        const key = event.key.toLowerCase();
        if (browserStolenKeys.has(key)) {
          event.preventDefault();
          // Send the control character directly (Ctrl+A=0x01, ..., Ctrl+Z=0x1A)
          const ctrlChar = String.fromCharCode(key.charCodeAt(0) - 96);
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: ctrlChar }));
          }
          return false; // prevent xterm from also processing it
        }
      }
      return true;
    });

    // Register onData once — route input to whichever ws is current
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    let wasConnectedBefore = false;

    function connect() {
      if (!mountedRef.current) return;

      const cols = term.cols;
      const rows = term.rows;
      const wsUrl = `ws://${window.location.host}/ws/terminal?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}&cols=${cols}&rows=${rows}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        const wasReconnect = wasConnectedBefore;
        wasConnectedBefore = true;
        retryRef.current = 0;
        setConnectionStatus('connected');
        if (wasReconnect) {
          showToast({ type: 'success', message: 'Reconnected' });
        }
      };

      let spawnFailed = false;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') {
            term.write(msg.data);
          } else if (msg.type === 'spawn_error') {
            spawnFailed = true;
            term.write(msg.data);
            setConnectionStatus('failed');
            showToast({ type: 'error', message: 'Failed to start terminal — check node-pty installation' });
          }
        } catch {
          term.write(event.data);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this — handle reconnection there
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;

        // Don't retry if the server reported a permanent spawn failure
        if (spawnFailed) return;

        if (retryRef.current >= MAX_RETRIES) {
          setConnectionStatus('failed');
          return;
        }

        setConnectionStatus('disconnected');
        const delay = Math.min(BASE_DELAY * Math.pow(2, retryRef.current), MAX_DELAY);
        retryRef.current += 1;
        retryTimerRef.current = setTimeout(connect, delay);
      };
    }

    // Defer connection so StrictMode's immediate unmount cancels it
    // before a WebSocket is ever created
    const connectTimer = setTimeout(connect, 0);

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      mountedRef.current = false;
      clearTimeout(connectTimer);
      clearTimeout(retryTimerRef.current);
      resizeObserver.disconnect();
      if (wsRef.current) wsRef.current.close();
      term.dispose();
    };
  }, [sessionId, cwd]);

  // Re-fit and sync dimensions when tab becomes visible
  useEffect(() => {
    if (isVisible && fitRef.current && termRef.current) {
      setTimeout(() => {
        try {
          fitRef.current.fit();
          const ws = wsRef.current;
          const term = termRef.current;
          if (ws && ws.readyState === WebSocket.OPEN && term) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        } catch {}
      }, 50);
    }
  }, [isVisible]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Reconnection banner */}
      {connectionStatus === 'disconnected' && (
        <div style={bannerStyle}>
          Connection lost — reconnecting...
        </div>
      )}
      {connectionStatus === 'failed' && (
        <div style={{ ...bannerStyle, background: '#450a0a', borderColor: '#dc2626' }}>
          Unable to connect to server. Check that the backend is running.
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          background: 'var(--bg-base)',
          padding: '4px 0 0 8px',
        }}
      />
    </div>
  );
}

const bannerStyle = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 10,
  padding: '6px 12px',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  textAlign: 'center',
  background: '#451a03',
  borderBottom: '1px solid #d97706',
  color: '#fde68a',
};
