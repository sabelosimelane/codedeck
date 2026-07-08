import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useToast } from './ToastContext';
import { AlertTriangle, ChevronsDown } from 'lucide-react';
import { shouldResumeFromSessionHandshake } from '../utils/terminalResume';
import { buildTerminalWebSocketUrl } from '../utils/terminalWsUrl';
import { isTerminalProtocolReply } from '../utils/terminalProtocolReplies';
import { buildTerminalSnapshotReplay } from '../utils/terminalSnapshotRestore';
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
const TERMINAL_SCROLLBACK = 10000;
const SESSION_TAKEOVER_CLOSE_CODE = 4001;
const SESSION_TAKEOVER_CLOSE_REASON = 'session_taken_over';
const SESSION_DELETED_CLOSE_CODE = 4002;
const SESSION_DELETED_CLOSE_REASON = 'session_deleted';
const DEFAULT_FAILURE_MESSAGE = 'Unable to connect to server. Check that the backend is running.';
const DEFAULT_HISTORY_WARNING_MESSAGE = 'Recent scrollback could not be restored accurately. Live terminal output is attached, but preserved history is unavailable.';

const Terminal = forwardRef(function Terminal({ sessionId, cwd, host = 'local', isVisible, isActivePane = true, runtimeType = 'pty' }, ref) {
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const fitRef = useRef(null);
  const termRef = useRef(null);
  const retryRef = useRef(0);
  const retryTimerRef = useRef(null);
  const heartbeatRef = useRef(null);
  const mountedRef = useRef(true);
  const [connectionStatus, setConnectionStatus] = useState('connecting'); // 'connected' | 'connecting' | 'disconnected' | 'failed'
  const [failureMessage, setFailureMessage] = useState(DEFAULT_FAILURE_MESSAGE);
  const [hostUnreachableInfo, setHostUnreachableInfo] = useState(null);
  const [historyWarning, setHistoryWarning] = useState(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const userScrolledUpRef = useRef(false);
  // Client-side diagnostics for visibility-aware recovery (Phase 2)
  const lastMessageAtRef = useRef(null);
  const lastPaintAtRef = useRef(null);
  const lastResizeAtRef = useRef(null);
  const documentVisibilityRef = useRef(document.visibilityState === 'visible' ? 'visible' : 'hidden');
  const isVisibleRef = useRef(isVisible);
  // Whether this pane is the user-selected pane within its tab. Browser-level
  // recovery (visibilitychange/window-focus/pageshow) and the React-level
  // tab-switch refocus must only refocus the active pane — every Terminal
  // listens to the same global events, so without this gate the
  // last-mounted pane wins and steals focus from the user's clicked pane.
  const isActivePaneRef = useRef(isActivePane);
  // Sequence tracking for loss-aware replay (Phase 3)
  const lastSeenSeqRef = useRef(0);
  const reconnectCountRef = useRef(0);
  const resumeInFlightRef = useRef(false);
  const pendingOutputRef = useRef([]);
  const pendingSnapshotRef = useRef(null);
  const inputBufferRef = useRef([]);
  const delayedViewportSyncTimerRef = useRef(null);
  const snapshotGeometryRef = useRef(null);
  const retryConnectionRef = useRef(() => {});
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const { showToast } = useToast();

  // Upload a file to the backend and return the saved path
  async function uploadFile(file, host) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('host', host || 'local');
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
        const path = await uploadFile(file, host);
        if (path) {
          paths.push(`"${path}"`);
        }
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

  function scheduleDelayedViewportSync({ focus = false } = {}) {
    if (delayedViewportSyncTimerRef.current) {
      clearTimeout(delayedViewportSyncTimerRef.current);
    }

    delayedViewportSyncTimerRef.current = setTimeout(() => {
      delayedViewportSyncTimerRef.current = null;

      // Remember what geometry the snapshot was hydrated at so we can tell
      // whether the delayed fit actually corrected anything. Consume the
      // reference as a one-shot: later user-driven resizes (ResizeObserver,
      // pageshow/focus/visibility) reach syncTerminalViewport too, and must
      // not rewrite the whole viewport just because cols/rows changed.
      const hydrationGeometry = snapshotGeometryRef.current;
      snapshotGeometryRef.current = null;

      syncTerminalViewport({ focus });

      const term = termRef.current;
      const ws = wsRef.current;
      if (
        hydrationGeometry
        && term
        && ws
        && ws.readyState === WebSocket.OPEN
        && (
          term.cols !== hydrationGeometry.cols
          || term.rows !== hydrationGeometry.rows
        )
      ) {
        ws.send(JSON.stringify({ type: 'rehydrate' }));
      }
    }, 100);
  }

  function resetTerminalForSnapshot(term) {
    if (typeof term.reset === 'function') {
      term.reset();
    }
    if (typeof term.clear === 'function') {
      term.clear();
    }
  }

  function hydrateSnapshot(term, snapshot) {
    resetTerminalForSnapshot(term);
    if (typeof snapshot.lastSeq === 'number') {
      lastSeenSeqRef.current = snapshot.lastSeq;
    }
    const snapshotReplay = buildTerminalSnapshotReplay(snapshot);
    if (snapshotReplay) {
      term.write(snapshotReplay);
      lastPaintAtRef.current = new Date().toISOString();
    }
    // Record the geometry the snapshot was painted at so the delayed
    // post-font-settle fit can tell whether anything actually shifted. The
    // ref is consumed as a one-shot by scheduleDelayedViewportSync so later
    // user-driven resizes never trip a full-viewport rewrite.
    snapshotGeometryRef.current = { cols: term.cols, rows: term.rows };
    setAutoScrollEnabled(true);
    term.scrollToBottom();
    // Some devices settle font metrics and pane width a beat after the initial
    // snapshot paint. Re-fit once more so restored scrollback does not keep the
    // stale right-edge column until the user manually resizes the pane.
    scheduleDelayedViewportSync();
  }

  function bufferOrHydrateSnapshot(term, snapshot) {
    resumeInFlightRef.current = false;
    pendingOutputRef.current = [];

    if (typeof snapshot.lastSeq === 'number') {
      lastSeenSeqRef.current = snapshot.lastSeq;
    }

    if (!canPaintCurrentViewport()) {
      pendingSnapshotRef.current = snapshot;
      return;
    }

    pendingSnapshotRef.current = null;
    hydrateSnapshot(term, snapshot);
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

    if (pendingSnapshotRef.current) {
      const snapshot = pendingSnapshotRef.current;
      pendingSnapshotRef.current = null;
      hydrateSnapshot(term, snapshot);
    }

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
    } catch (err) {
      console.warn(`[terminal] viewport sync failed session=${sessionId} error=${err.message}`);
    }

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

  useEffect(() => {
    setHistoryWarning(null);
    setHostUnreachableInfo(null);
  }, [sessionId]);

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
      // Force a non-destructive xterm repaint and resize sync. This must stay
      // local-only: a reconnect-style snapshot rehydrate is too heavy-handed
      // for a healthy live pane and can itself disturb the visible layout.
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
      scrollback: TERMINAL_SCROLLBACK,
      scrollSensitivity: 3,
      fastScrollSensitivity: 5,
      smoothScrollDuration: 0,
      macOptionClickForcesSelection: true,
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

    let fontSyncCancelled = false;
    const fontSet = document.fonts;
    const scheduleFontMeasurementSync = () => {
      if (fontSyncCancelled) return;
      requestAnimationFrame(() => {
        if (fontSyncCancelled || !mountedRef.current) return;
        syncTerminalViewport();
        scheduleDelayedViewportSync();
      });
    };

    // xterm measures character cells during boot. If JetBrains Mono arrives a
    // beat later than the initial mount, those measurements can be based on a
    // fallback font and fullscreen TUIs render against stale cols/rows until a
    // manual resize/redraw happens. Re-fit once fonts are ready and whenever a
    // late font load completes.
    if (fontSet?.ready && typeof fontSet.ready.then === 'function') {
      fontSet.ready
        .then(() => {
          scheduleFontMeasurementSync();
        })
        .catch((err) => {
          console.warn(`[terminal] font readiness sync failed session=${sessionId} error=${err?.message || err}`);
        });
    }
    fontSet?.addEventListener?.('loadingdone', scheduleFontMeasurementSync);

    const handleNativePaste = (event) => {
      const files = event.clipboardData?.files;
      if (files && files.length > 0) {
        event.preventDefault();
        event.stopPropagation();
        handleFilesDrop(Array.from(files));
        return;
      }

      const text = event.clipboardData?.getData?.('text/plain') ?? '';
      if (!text) return;

      // Route text paste through xterm's dedicated paste path so line endings
      // are normalized and bracketed-paste mode is honored when enabled.
      event.preventDefault();
      event.stopPropagation();
      term.paste(text);
    };
    containerRef.current.addEventListener('paste', handleNativePaste, true);

    requestAnimationFrame(() => {
      syncTerminalViewport();
    });

    // Track scroll position — detect when user scrolls away from bottom
    term.onScroll(() => {
      const buffer = term.buffer.active;
      setAutoScrollEnabled(isTerminalViewportAtBottom(buffer));
    });

    // Copy-on-select: mirror native terminal emulator behaviour so text is
    // always on the clipboard after a drag selection (needed because tmux
    // mouse mode prevents normal browser selection).
    let selectionCopyTimer = null;
    if (typeof term.onSelectionChange === 'function') {
      term.onSelectionChange(() => {
        if (selectionCopyTimer) {
          clearTimeout(selectionCopyTimer);
        }
        selectionCopyTimer = setTimeout(() => {
          selectionCopyTimer = null;
          const text = term.getSelection();
          if (text) {
            navigator.clipboard.writeText(text).catch(() => {});
          }
        }, 150);
      });
    }

    const handleWheel = (event) => {
      if (shouldPauseAutoScrollOnWheel({
        deltaY: event.deltaY,
        buffer: term.buffer.active,
      })) {
        setAutoScrollEnabled(false);
      }
    };
    containerRef.current.addEventListener('wheel', handleWheel, { passive: true });
    term.attachCustomWheelEventHandler(() => {
      const activeBuffer = term.buffer.active;

      // Keep ordinary wheel/trackpad scrolling purely local to xterm so the
      // browser viewport always behaves like a normal terminal emulator.
      // The only interception left is blocking xterm's no-scrollback fallback,
      // which can translate wheel-up into ArrowUp input for the shell.
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
        setFailureMessage(DEFAULT_FAILURE_MESSAGE);
        setHostUnreachableInfo(null);
        if (wasReconnect) {
          reconnectCountRef.current += 1;
          showToast({ type: 'success', message: 'Reconnected' });
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
          if (msg.type === 'session') {
            if (msg.historyGuaranteed === true) {
              setHistoryWarning(null);
            }
            if (shouldResumeFromSessionHandshake(msg, resumeInFlightRef.current)) {
              requestResume(ws);
            }
          } else if (msg.type === 'snapshot') {
            if (msg.historyGuaranteed !== false) {
              setHistoryWarning(null);
            }
            bufferOrHydrateSnapshot(term, {
              data: msg.data ?? '',
              lastSeq: msg.lastSeq,
              terminalState: msg.terminalState ?? null,
            });
            if (
              isActivePaneRef.current
              && isVisibleRef.current
              && documentVisibilityRef.current === 'visible'
            ) {
              term.focus();
            }
          } else if (msg.type === 'history_warning') {
            const message = msg.message || DEFAULT_HISTORY_WARNING_MESSAGE;
            setHistoryWarning({
              reason: msg.reason || 'snapshot_unavailable',
              message,
            });
            showToast({ type: 'warning', message });
          } else if (msg.type === 'output') {
            bufferOrWriteChunk(term, { data: msg.data, seq: msg.seq });
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
            // Rapid replay writes can trip xterm scroll events. Only restore
            // bottom-follow when the user has not intentionally detached the
            // viewport to read older output.
            if (!userScrolledUpRef.current) {
              setAutoScrollEnabled(true);
              term.scrollToBottom();
            }
            // Only refocus this pane if it is the user-selected one. Every
            // pane's WS gets its own replay after window/visibility recovery,
            // so an unconditional focus here lets the last replay-handler win
            // and steals focus from the pane the user actually clicked.
            if (isActivePaneRef.current) {
              term.focus();
            }
          } else if (msg.type === 'spawn_error') {
            spawnFailed = true;
            term.write(msg.data);
            if (msg.reason === 'host_unreachable') {
              setHostUnreachableInfo({
                host: msg.host || 'remote host',
                message: msg.message || 'Host is unreachable',
              });
              setConnectionStatus('host_unreachable');
              showToast({ type: 'warning', message: msg.message || 'Host is unreachable' });
              return;
            }
            setFailureMessage(msg.message || DEFAULT_FAILURE_MESSAGE);
            setConnectionStatus('failed');
            showToast({ type: 'error', message: msg.message || 'Failed to start terminal' });
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
          setFailureMessage(DEFAULT_FAILURE_MESSAGE);
          setConnectionStatus('failed');
          return;
        }

        setConnectionStatus('disconnected');
        const delay = Math.min(BASE_DELAY * Math.pow(2, retryRef.current), MAX_DELAY);
        retryRef.current += 1;
        retryTimerRef.current = setTimeout(connect, delay);
      };
    }

    retryConnectionRef.current = () => {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      retryRef.current = 0;
      resumeInFlightRef.current = false;
      setHostUnreachableInfo(null);
      setFailureMessage(DEFAULT_FAILURE_MESSAGE);
      setConnectionStatus('connecting');
      const currentWs = wsRef.current;
      if (currentWs && currentWs.readyState < WebSocket.CLOSING) {
        currentWs.close();
      }
      connect();
    };

    // Defer connection so StrictMode's immediate unmount cancels it
    // before a WebSocket is ever created
    const connectTimer = setTimeout(connect, 0);

    function scheduleViewportRecovery() {
      setTimeout(() => {
        syncTerminalViewport({ focus: isActivePaneRef.current, requestResumeAfterSync: true });
      }, 50);
    }

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
        scheduleViewportRecovery();
      }
    }

    function handleWindowFocus() {
      if (document.visibilityState === 'visible') {
        scheduleViewportRecovery();
      }
    }

    function handlePageShow() {
      documentVisibilityRef.current = document.visibilityState === 'visible' ? 'visible' : 'hidden';
      scheduleViewportRecovery();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('pageshow', handlePageShow);

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
      clearTimeout(delayedViewportSyncTimerRef.current);
      clearTimeout(selectionCopyTimer);
      delayedViewportSyncTimerRef.current = null;
      snapshotGeometryRef.current = null;
      pendingOutputRef.current = [];
      pendingSnapshotRef.current = null;
      inputBufferRef.current = [];
      fontSyncCancelled = true;
      retryConnectionRef.current = () => {};
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('pageshow', handlePageShow);
      document.fonts?.removeEventListener?.('loadingdone', scheduleFontMeasurementSync);
      containerRef.current?.removeEventListener('wheel', handleWheel);
      containerRef.current?.removeEventListener('paste', handleNativePaste, true);
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
        syncTerminalViewport({ focus: isActivePaneRef.current, requestResumeAfterSync: true });
      }, 50);
    }
  }, [isVisible]);

  // Keep isActivePaneRef in sync with the prop. Refs must be used here because
  // the timers above read the value at firing time, after the prop may have
  // changed (e.g., user clicks an inactive pane mid-recovery).
  useEffect(() => {
    isActivePaneRef.current = isActivePane;
  }, [isActivePane]);

  return (
    <div
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
            <span>{failureMessage}</span>
          </div>
        </div>
      )}
      {connectionStatus === 'host_unreachable' && hostUnreachableInfo && (
        <div style={hostUnreachableOverlayStyle}>
          <div style={hostUnreachableCardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fbbf24' }}>
              <AlertTriangle size={15} />
              <strong>Host unreachable</strong>
            </div>
            <span style={hostUnreachableMessageStyle}>{hostUnreachableInfo.message}</span>
            <button
              type="button"
              onClick={() => retryConnectionRef.current()}
              aria-label={`Retry ${hostUnreachableInfo.host} terminal connection`}
              style={hostUnreachableRetryButtonStyle}
            >
              Retry
            </button>
          </div>
        </div>
      )}
      {historyWarning && (
        <div style={historyWarningBannerStyle}>
          <AlertTriangle size={14} />
          <span style={historyWarningTextStyle}>{historyWarning.message}</span>
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

const hostUnreachableOverlayStyle = {
  ...reconnectOverlayStyle,
  background: 'rgba(11, 13, 18, 0.82)',
  pointerEvents: 'auto',
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

const hostUnreachableCardStyle = {
  ...reconnectCardStyle,
  flexDirection: 'column',
  alignItems: 'flex-start',
  maxWidth: 420,
  borderColor: 'rgba(251, 191, 36, 0.35)',
};

const hostUnreachableMessageStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  lineHeight: 1.45,
  color: 'var(--text-secondary)',
};

const hostUnreachableRetryButtonStyle = {
  marginTop: 2,
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid rgba(251, 191, 36, 0.45)',
  background: 'rgba(251, 191, 36, 0.12)',
  color: '#fbbf24',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  cursor: 'pointer',
};

const historyWarningBannerStyle = {
  position: 'absolute',
  top: 12,
  left: 12,
  right: 12,
  zIndex: 11,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 8,
  background: 'rgba(69, 26, 3, 0.96)',
  border: '1px solid rgba(217, 119, 6, 0.5)',
  color: '#fde68a',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
  pointerEvents: 'none',
};

const historyWarningTextStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  lineHeight: 1.45,
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
