import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useToast } from './ToastContext';
import { ChevronsDown } from 'lucide-react';
import { shouldResumeFromSessionHandshake } from '../utils/terminalResume';
import { buildTerminalWebSocketUrl } from '../utils/terminalWsUrl';
import { isTerminalProtocolReply } from '../utils/terminalProtocolReplies';
import {
  shouldSyncVisibleTerminal,
  shouldWriteTerminalViewport,
} from '../utils/terminalVisibility';
import {
  isTerminalViewportAtBottom,
  shouldBlockXtermWheelViewportFallback,
  shouldPauseAutoScrollOnWheel,
} from '../utils/terminalAutoScroll';

const MAX_RETRIES = 10;
const BASE_DELAY = 1000;
const MAX_DELAY = 30000;
const SESSION_TAKEOVER_CLOSE_CODE = 4001;
const SESSION_TAKEOVER_CLOSE_REASON = 'session_taken_over';
const SESSION_DELETED_CLOSE_CODE = 4002;
const SESSION_DELETED_CLOSE_REASON = 'session_deleted';

const Terminal = forwardRef(function Terminal({ sessionId, cwd, isVisible }, ref) {
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const fitRef = useRef(null);
  const termRef = useRef(null);
  const retryRef = useRef(0);
  const retryTimerRef = useRef(null);
  const heartbeatRef = useRef(null);
  const mountedRef = useRef(true);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // 'connected' | 'connecting' | 'disconnected' | 'failed'
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const userScrolledUpRef = useRef(false);
  // Client-side diagnostics for visibility-aware recovery (Phase 2)
  const lastMessageAtRef = useRef(null);
  const lastPaintAtRef = useRef(null);
  const lastResizeAtRef = useRef(null);
  const documentVisibilityRef = useRef(document.visibilityState === 'visible' ? 'visible' : 'hidden');
  const isVisibleRef = useRef(isVisible);
  // Sequence tracking for loss-aware replay (Phase 3)
  const lastSeenSeqRef = useRef(0);
  const reconnectCountRef = useRef(0);
  const resumeInFlightRef = useRef(false);
  const pendingOutputRef = useRef([]);
  const inputBufferRef = useRef([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const { showToast } = useToast();

  // Upload a file to the backend and return the saved path
  async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to upload file');
    }
    const data = await res.json();
    return data.path;
  }

  // Upload files and inject quoted paths into the focused PTY
  async function handleFilesDrop(files) {
    // Directory detection — File API: directories have no type and size 0,
    // or we can try reading them (which fails for directories)
    for (const file of files) {
      if (file.size === 0 && file.type === '') {
        showToast({ type: 'error', message: 'Directory uploads not supported' });
        return;
      }
    }

    const paths = [];
    for (const file of files) {
      try {
        const path = await uploadFile(file);
        paths.push(`"${path}"`);
      } catch (err) {
        showToast({ type: 'error', message: err.message });
        return;
      }
    }

    if (paths.length > 0) {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: paths.join(' ') }));
      }
    }
  }

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFilesDrop(files);
    }
  }, []);

  const handlePaste = useCallback((e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length > 0) {
      e.preventDefault();
      e.stopPropagation();
      handleFilesDrop(Array.from(files));
    }
    // No files — let xterm.js handle normal text paste
  }, []);

  function setAutoScrollEnabled(enabled) {
    userScrolledUpRef.current = !enabled;
    setShowScrollBtn(!enabled);
  }

  function requestResume(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN || resumeInFlightRef.current) return;
    resumeInFlightRef.current = true;
    ws.send(JSON.stringify({
      type: 'resume',
      lastSeenSeq: lastSeenSeqRef.current,
    }));
  }

  function canSyncCurrentTerminal() {
    const container = containerRef.current;
    return shouldSyncVisibleTerminal({
      isVisible: isVisibleRef.current,
      width: container?.clientWidth ?? 0,
      height: container?.clientHeight ?? 0,
    });
  }

  function canPaintCurrentViewport() {
    return shouldWriteTerminalViewport({
      isVisible: isVisibleRef.current,
      documentVisibility: documentVisibilityRef.current,
    });
  }

  function writeChunkToTerminal(term, chunk) {
    term.write(chunk.data);
    lastPaintAtRef.current = new Date().toISOString();
    if (typeof chunk.seq === 'number') {
      lastSeenSeqRef.current = chunk.seq;
    }
    if (!userScrolledUpRef.current) {
      term.scrollToBottom();
    }
  }

  function bufferOrWriteChunk(term, chunk) {
    if (typeof chunk.seq === 'number') {
      lastSeenSeqRef.current = chunk.seq;
    }

    if (!canPaintCurrentViewport()) {
      pendingOutputRef.current.push(chunk);
      return;
    }

    writeChunkToTerminal(term, chunk);
  }

  function flushPendingOutput() {
    const term = termRef.current;
    if (!term || !canPaintCurrentViewport()) return;

    if (pendingOutputRef.current.length > 0) {
      for (const chunk of pendingOutputRef.current) {
        writeChunkToTerminal(term, chunk);
      }
      pendingOutputRef.current = [];
    }

    term.refresh(0, Math.max(term.rows - 1, 0));
    if (!userScrolledUpRef.current) {
      term.scrollToBottom();
    }
  }

  function syncTerminalViewport({ focus = false, requestResumeAfterSync = false } = {}) {
    if (!mountedRef.current) return;
    if (!canSyncCurrentTerminal()) return;

    const term = termRef.current;
    const fitAddon = fitRef.current;
    const currentWs = wsRef.current;

    try {
      if (fitAddon) fitAddon.fit();
      flushPendingOutput();
      lastResizeAtRef.current = new Date().toISOString();
      if (currentWs && currentWs.readyState === WebSocket.OPEN && term) {
        currentWs.send(JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }));
        if (requestResumeAfterSync) {
          requestResume(currentWs);
        }
      }
    } catch {}

    // Focus MUST happen outside the try/catch and outside flushPendingOutput.
    // Focus is an input concern — it must not be blocked by fit() errors
    // or paint-visibility gates that only apply to output rendering.
    if (focus && term) {
      term.focus();
    }
  }

  // Send a recovery action notification to the backend for timeline tracking
  function sendRecoveryAction(action) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'recovery_action', action }));
    }
  }

  useImperativeHandle(ref, () => ({
    focus() {
      if (termRef.current) {
        termRef.current.focus();
      }
    },
    clear() {
      if (termRef.current) {
        termRef.current.clear();
        termRef.current.scrollToBottom();
      }
    },
    reconnect() {
      // Drop current WebSocket — onclose handler will trigger reconnect flow
      const ws = wsRef.current;
      if (ws) {
        retryRef.current = 0; // Reset retry counter for fresh reconnect
        ws.close();
      }
      // Notify backend about the recovery action
      sendRecoveryAction('reconnect');
    },
    resync() {
      // Request replay from last seen seq without dropping the socket
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        requestResume(ws);
        sendRecoveryAction('resync');
      }
    },
    redraw() {
      // Force xterm repaint and resize sync
      if (termRef.current && fitRef.current) {
        syncTerminalViewport({ focus: true });
        sendRecoveryAction('redraw');
      }
    },
  }), []);

  useEffect(() => {
    mountedRef.current = true;
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily: "'JetBrains Mono', monospace",
      lineHeight: 1.4,
      scrollSensitivity: 3,
      fastScrollSensitivity: 5,
      smoothScrollDuration: 0,
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
    const webLinksAddon = new WebLinksAddon((event, url) => {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
    });
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(containerRef.current);
    fitRef.current = fitAddon;
    termRef.current = term;
    requestAnimationFrame(() => {
      syncTerminalViewport();
    });

    // Track scroll position — detect when user scrolls away from bottom
    term.onScroll(() => {
      const buffer = term.buffer.active;
      setAutoScrollEnabled(isTerminalViewportAtBottom(buffer));
    });

    const handleWheel = (event) => {
      if (shouldPauseAutoScrollOnWheel({
        deltaY: event.deltaY,
        buffer: term.buffer.active,
      })) {
        setAutoScrollEnabled(false);
      }
    };
    containerRef.current.addEventListener('wheel', handleWheel, { passive: true });
    term.attachCustomWheelEventHandler((event) => {
      const activeBuffer = term.buffer.active;
      return !shouldBlockXtermWheelViewportFallback(activeBuffer);
    });

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
          } else {
            inputBufferRef.current.push(ctrlChar);
          }
          return false; // prevent xterm from also processing it
        }
      }
      return true;
    });

    // Register onData once — route input to whichever ws is current.
    // During replay, DROP all onData. Replayed chunks contain terminal queries
    // (DA \x1b[c, CPR \x1b[6n) that xterm.js responds to synchronously via
    // onData. These stale responses, if sent to the PTY, appear as garbage
    // stdin to the shell and corrupt zsh/readline's line editor state —
    // causing the "typing doesn't echo until Ctrl+C" symptom. The replay
    // window is <100ms so dropped user keystrokes are negligible.
    //
    // DA/CPR responses also occur OUTSIDE replay — e.g. fitAddon.fit() on
    // tab switch triggers a resize, the shell sends DA queries, and xterm.js
    // emits responses here. Focus tracking replies can also be emitted when the
    // terminal regains focus. Filter these protocol replies unconditionally.
    term.onData((data) => {
      if (resumeInFlightRef.current) return;
      if (isTerminalProtocolReply(data)) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      } else {
        inputBufferRef.current.push(data);
      }
    });

    let wasConnectedBefore = false;

    function connect() {
      if (!mountedRef.current) return;

      const cols = term.cols;
      const rows = term.rows;
      const wsUrl = buildTerminalWebSocketUrl({
        location: window.location,
        cwd,
        sessionId,
        cols,
        rows,
      });
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        const wasReconnect = wasConnectedBefore;
        wasConnectedBefore = true;
        retryRef.current = 0;
        setConnectionStatus('connected');
        if (wasReconnect) {
          reconnectCountRef.current += 1;
          showToast({ type: 'success', message: 'Reconnected' });
          requestResume(ws);
        }
        // Flush any input that was typed during reconnection
        if (inputBufferRef.current.length > 0) {
          for (const data of inputBufferRef.current) {
            ws.send(JSON.stringify({ type: 'input', data }));
          }
          inputBufferRef.current = [];
        }
        // Send periodic heartbeats with client diagnostics for visibility-aware recovery
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = setInterval(() => {
          const currentWs = wsRef.current;
          if (currentWs && currentWs.readyState === WebSocket.OPEN) {
            currentWs.send(JSON.stringify({
              type: 'heartbeat',
              documentVisibility: documentVisibilityRef.current,
              lastMessageAt: lastMessageAtRef.current,
              lastPaintAt: lastPaintAtRef.current,
              lastResizeAt: lastResizeAtRef.current,
              lastSeenSeq: lastSeenSeqRef.current,
              reconnectCount: reconnectCountRef.current,
            }));
          }
        }, 5000);
      };

      let spawnFailed = false;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          lastMessageAtRef.current = new Date().toISOString();
          if (msg.type === 'output') {
            bufferOrWriteChunk(term, { data: msg.data, seq: msg.seq });
          } else if (shouldResumeFromSessionHandshake(msg, resumeInFlightRef.current)) {
            requestResume(ws);
          } else if (msg.type === 'replay') {
            // Write chunks BEFORE clearing resumeInFlight. term.write()
            // causes xterm.js to process terminal queries embedded in the
            // replayed data and emit responses synchronously via onData.
            // Keeping the flag true ensures those responses are dropped.
            if (msg.chunks && msg.chunks.length > 0) {
              for (const chunk of msg.chunks) {
                bufferOrWriteChunk(term, chunk);
              }
            }
            resumeInFlightRef.current = false;
            if (msg.overflow) {
              showToast({ type: 'warning', message: `Replay buffer overflow — ${msg.missedCount} output chunks lost` });
            }
            // Reset auto-scroll (rapid writes can trip onScroll) and focus
            setAutoScrollEnabled(true);
            term.scrollToBottom();
            term.focus();
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

      ws.onclose = (event) => {
        if (!mountedRef.current) return;

        // Don't retry if the server reported a permanent spawn failure
        if (spawnFailed) return;

        const wasSessionTakeover = event?.code === SESSION_TAKEOVER_CLOSE_CODE
          || event?.reason === SESSION_TAKEOVER_CLOSE_REASON;
        if (wasSessionTakeover) {
          setConnectionStatus('connected');
          return;
        }

        const wasSessionDeleted = event?.code === SESSION_DELETED_CLOSE_CODE
          || event?.reason === SESSION_DELETED_CLOSE_REASON;
        if (wasSessionDeleted) {
          setConnectionStatus('disconnected');
          return;
        }

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

    // Track browser-level visibility changes for deterministic refocus recovery
    function handleVisibilityChange() {
      const state = document.visibilityState === 'visible' ? 'visible' : 'hidden';
      documentVisibilityRef.current = state;

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'visibility_change', state }));
      }

      // On refocus: force fit, resend dimensions, request replay of missed output
      if (state === 'visible') {
        setTimeout(() => {
          syncTerminalViewport({ focus: true, requestResumeAfterSync: true });
        }, 50);
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      syncTerminalViewport();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      mountedRef.current = false;
      clearTimeout(connectTimer);
      clearTimeout(retryTimerRef.current);
      clearInterval(heartbeatRef.current);
      inputBufferRef.current = [];
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      containerRef.current?.removeEventListener('wheel', handleWheel);
      resizeObserver.disconnect();
      if (wsRef.current) wsRef.current.close();
      term.dispose();
    };
  }, [sessionId, cwd]);

  // Re-fit and sync dimensions when tab becomes visible (React-level tab switch)
  useEffect(() => {
    isVisibleRef.current = isVisible;
    if (isVisible && fitRef.current && termRef.current) {
      setTimeout(() => {
        syncTerminalViewport({ focus: true, requestResumeAfterSync: true });
      }, 50);
    }
  }, [isVisible]);

  return (
    <div
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {/* Reconnecting overlay — dims terminal and shows spinner so user knows input is paused */}
      {connectionStatus === 'disconnected' && (
        <div style={reconnectOverlayStyle}>
          <div style={reconnectCardStyle}>
            <div className="reconnect-spinner" />
            <span>Reconnecting...</span>
          </div>
        </div>
      )}
      {connectionStatus === 'failed' && (
        <div style={failedOverlayStyle}>
          <div style={{ ...reconnectCardStyle, borderColor: 'rgba(248, 113, 113, 0.3)' }}>
            <span>Unable to connect to server. Check that the backend is running.</span>
          </div>
        </div>
      )}
      {/* Drop zone overlay — shown during file drag */}
      {isDragOver && (
        <div style={dropZoneOverlayStyle}>
          <div style={dropZoneLabelStyle}>
            Drop file to paste path
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        onMouseDown={() => {
          syncTerminalViewport({ focus: true });
          // Direct fallback: ensure focus even if syncTerminalViewport gates bail early
          if (termRef.current) termRef.current.focus();
        }}
        style={{
          width: '100%',
          height: '100%',
          background: 'var(--bg-base)',
          padding: '4px 0 0 8px',
        }}
      />
      {/* Scroll to bottom button */}
      {showScrollBtn && (
        <button
          onClick={() => {
            if (termRef.current) {
              termRef.current.scrollToBottom();
              setAutoScrollEnabled(true);
            }
          }}
          style={scrollBtnStyle}
          title="Scroll to bottom"
        >
          <ChevronsDown size={14} />
          <span>Latest</span>
        </button>
      )}
    </div>
  );
});

export default Terminal;

const scrollBtnStyle = {
  position: 'absolute',
  bottom: 16,
  right: 16,
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '6px 12px',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-sidebar)',
  color: 'var(--accent)',
  border: '1px solid var(--accent)',
  borderRadius: 6,
  cursor: 'pointer',
  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
};

const reconnectOverlayStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(11, 13, 18, 0.75)',
  backdropFilter: 'blur(2px)',
  pointerEvents: 'none',
};

const failedOverlayStyle = {
  ...reconnectOverlayStyle,
  background: 'rgba(11, 13, 18, 0.85)',
};

const reconnectCardStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 18px',
  borderRadius: 8,
  background: 'rgba(22, 27, 36, 0.95)',
  border: '1px solid rgba(110, 231, 183, 0.2)',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  color: 'var(--text-secondary)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
};

const dropZoneOverlayStyle = {
  position: 'absolute',
  inset: 0,
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(11, 13, 18, 0.75)',
  backdropFilter: 'blur(2px)',
  border: '2px dashed var(--accent)',
  borderRadius: 4,
  pointerEvents: 'none',
};

const dropZoneLabelStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: '13px',
  color: 'var(--accent)',
  padding: '8px 16px',
  borderRadius: 6,
  background: 'rgba(22, 27, 36, 0.95)',
  border: '1px solid rgba(110, 231, 183, 0.2)',
};
