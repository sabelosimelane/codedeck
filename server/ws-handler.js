/**
 * WebSocket connection handler for terminal PTY sessions.
 *
 * Extracted from index.js to enable unit testing of listener management.
 * Key design: onData and onExit listeners are registered ONCE per PTY (when created).
 * They read the current WebSocket from entry.ws, avoiding closure-captured stale references.
 *
 * @param {WebSocket} ws - The incoming WebSocket connection
 * @param {http.IncomingMessage} req - The HTTP upgrade request
 * @param {Map} sessions - The sessions Map: sessionId -> session entry object
 * @param {object} runtime - Terminal runtime (from terminal-runtime.js) with spawn/kill/isSessionRecoverable
 */

import {
  getTerminalHistoryWarningMessage,
  getTerminalRuntimeStatus,
  TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE,
  TERMINAL_SNAPSHOT_WINDOW_LINES,
} from './terminal-runtime.js';
import { isTransportFailure } from './command-runner.js';

const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DCS_RE = /\x1bP[\s\S]*?\x1b\\/g;
const STRING_ESCAPE_RE = /\x1b[_^X][\s\S]*?\x1b\\/g;
const ISO2022_CHARSET_RE = /\x1b[\(\)\*\+\-\.\/][0-9A-Za-z]/g;
const ESC_SINGLE_RE = /\x1b[@-_]/g;
const CONTROL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const CARET_CSI_RE = /\^\[\[[0-?]*[ -/]*[@-~]/g;
const PRINTABLE_CHARSET_MARKER_RE = /\([0-9A-Za-z]/g;
const MAX_TIMELINE_EVENTS = 50;
export const REPLAY_BUFFER_SIZE = 1000;
export const SESSION_TAKEOVER_CLOSE_CODE = 4001;
export const SESSION_TAKEOVER_CLOSE_REASON = 'session_taken_over';
export const SESSION_DELETED_CLOSE_CODE = 4002;
export const SESSION_DELETED_CLOSE_REASON = 'session_deleted';
const MAX_TMUX_REATTACH = 3;

function stripTerminalControl(rawData) {
  return rawData
    .replace(OSC_RE, '')
    .replace(DCS_RE, '')
    .replace(STRING_ESCAPE_RE, '')
    .replace(ISO2022_CHARSET_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC_SINGLE_RE, '')
    .replace(/\r/g, '')
    .replace(CONTROL_CHAR_RE, '')
    .trim();
}

function normalizeSnapshotComparableText(rawData) {
  if (!rawData) return '';

  return rawData
    .replace(OSC_RE, '')
    .replace(DCS_RE, '')
    .replace(STRING_ESCAPE_RE, '')
    .replace(ISO2022_CHARSET_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC_SINGLE_RE, '')
    .replace(/\r/g, '')
    .replace(CONTROL_CHAR_RE, '');
}

export function sanitizePreviewLine(line) {
  if (!line) return '';

  return line
    .replace(PRINTABLE_CHARSET_MARKER_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isPreviewNoise(line) {
  if (!line) return true;
  if (line.replace(CARET_CSI_RE, '').trim() === '') return true;
  return false;
}

/**
 * Returns true if PTY output contains meaningful content (not just ANSI noise).
 * tmux status-bar refreshes produce short ANSI-only bursts with no newlines;
 * real command output virtually always contains newlines.
 */
export function isSubstantialOutput(rawData) {
  const stripped = stripTerminalControl(rawData);
  if (!stripped) return false;
  return stripped.includes('\n');
}

function isReplayNoise(rawData) {
  if (rawData.includes('\n') || rawData.includes('\r')) return false;

  const hasSaveCursor = rawData.includes('\x1b7') || rawData.includes('\x1b[s');
  const hasRestoreCursor = rawData.includes('\x1b8') || rawData.includes('\x1b[u');
  const hasCursorPosition = /\x1b\[[0-9;]*H/.test(rawData);

  return hasSaveCursor && hasRestoreCursor && hasCursorPosition;
}

function extractLastLine(rawData) {
  const stripped = stripTerminalControl(rawData);
  if (!stripped) return null;
  const lines = stripped.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return null;
  const line = sanitizePreviewLine(lines[lines.length - 1]);
  if (isPreviewNoise(line)) return null;
  return line.slice(0, 200);
}

/**
 * Push a diagnostic event onto a session's bounded timeline.
 */
function pushTimelineEvent(entry, type, detail) {
  const event = { type, at: new Date().toISOString() };
  if (detail) event.detail = detail;
  entry.events.push(event);
  if (entry.events.length > MAX_TIMELINE_EVENTS) {
    entry.events = entry.events.slice(-MAX_TIMELINE_EVENTS);
  }
}

function safeCloseSocket(ws, { sessionId, context, code, reason } = {}) {
  try {
    if (typeof code === 'number') {
      ws.close(code, reason);
      return;
    }

    ws.close();
  } catch (err) {
    console.warn(`[terminal] ws_close_failed session=${sessionId} context=${context} error=${err.message}`);
  }
}

function safeResizePty(entry, cols, rows, sessionId) {
  try {
    entry.pty.resize(cols, rows);
  } catch (err) {
    console.warn(`[terminal] pty_resize_failed session=${sessionId} cols=${cols} rows=${rows} error=${err.message}`);
  }
}

function safeResizeRuntimeSession(runtime, sessionId, cols, rows) {
  if (typeof runtime?.resizeSession !== 'function') return;

  try {
    runtime.resizeSession(sessionId, cols, rows);
  } catch (err) {
    console.warn(`[terminal] runtime_resize_failed session=${sessionId} cols=${cols} rows=${rows} error=${err.message}`);
  }
}

function beginBufferedAttach(entry, snapshotSeq) {
  const attachState = {
    mode: 'buffer_live_output',
    snapshotSeq,
    bufferedChunks: [],
  };
  entry.attachState = attachState;
  return attachState;
}

function beginBootstrapDropAttach(entry, snapshotSeq) {
  const attachState = {
    mode: 'drop_bootstrap_output',
    snapshotSeq,
    bufferedChunks: [],
  };
  entry.attachState = attachState;
  return attachState;
}

function trackOutputChunk(entry, data) {
  const now = new Date().toISOString();
  entry.lastOutputAt = now;
  if (isSubstantialOutput(data)) {
    entry.lastSubstantialOutputAt = now;
  }

  entry.lastSeq += 1;
  const seq = entry.lastSeq;
  const line = extractLastLine(data);
  if (line) entry.lastOutputLine = line;
  entry.replayBuffer.push({ seq, data });
  if (entry.replayBuffer.length > REPLAY_BUFFER_SIZE) {
    entry.replayBuffer = entry.replayBuffer.slice(-REPLAY_BUFFER_SIZE);
  }

  return { seq, data };
}

function isLikelyBootstrapRedraw(rawData) {
  if (!rawData) return false;

  const stripped = stripTerminalControl(rawData);
  if (!stripped) return false;

  const csiMatches = rawData.match(CSI_RE) ?? [];
  const hasCursorHome = /\x1b\[[0-9;]*H/.test(rawData);
  const hasEraseDisplay = /\x1b\[[0-9;]*J/.test(rawData);
  const hasEraseLine = /\x1b\[[0-9;]*K/.test(rawData);
  const hasAltScreenToggle = /\x1b\[\?(?:47|1047|1048|1049)[hl]/.test(rawData);
  const hasSaveRestoreCursor = (rawData.includes('\x1b7') || rawData.includes('\x1b[s'))
    && (rawData.includes('\x1b8') || rawData.includes('\x1b[u'));
  const hasFullScreenPaint = hasCursorHome && (hasEraseDisplay || hasEraseLine || csiMatches.length >= 3);

  return hasAltScreenToggle || hasFullScreenPaint || (hasSaveRestoreCursor && csiMatches.length >= 3);
}

function dropBootstrapRedrawPrefix(bufferedChunks) {
  let firstDeliverableIndex = 0;

  while (
    firstDeliverableIndex < bufferedChunks.length
    && isLikelyBootstrapRedraw(bufferedChunks[firstDeliverableIndex])
  ) {
    firstDeliverableIndex += 1;
  }

  return bufferedChunks.slice(firstDeliverableIndex);
}

function alignSnapshotBoundaryWithBufferedOutput(snapshotHydration, attachState) {
  if (!attachState || attachState.mode !== 'buffer_live_output' || attachState.bufferedChunks.length === 0) {
    return snapshotHydration;
  }

  const snapshotComparable = normalizeSnapshotComparableText(
    snapshotHydration?.snapshotMessage?.data ?? ''
  );
  if (!snapshotComparable) {
    return snapshotHydration;
  }

  let overlappedChunkCount = 0;
  let overlappedComparable = '';
  let effectiveSnapshotSeq = attachState.snapshotSeq ?? 0;

  for (const chunk of attachState.bufferedChunks) {
    const chunkComparable = normalizeSnapshotComparableText(chunk.data);
    if (!chunkComparable) break;

    const candidateOverlap = `${overlappedComparable}${chunkComparable}`;
    if (!snapshotComparable.endsWith(candidateOverlap)) {
      break;
    }

    overlappedComparable = candidateOverlap;
    overlappedChunkCount += 1;
    effectiveSnapshotSeq = chunk.seq;
  }

  if (overlappedChunkCount === 0) {
    return snapshotHydration;
  }

  attachState.bufferedChunks = attachState.bufferedChunks.slice(overlappedChunkCount);
  attachState.snapshotSeq = effectiveSnapshotSeq;
  snapshotHydration.snapshotMessage.lastSeq = effectiveSnapshotSeq;
  return snapshotHydration;
}

function flushBufferedAttachOutput(entry) {
  const attachState = entry.attachState;
  if (!attachState || attachState.mode !== 'buffer_live_output') return;
  if (!entry.ws || entry.ws.readyState !== 1) return;

  for (const chunk of attachState.bufferedChunks) {
    entry.ws.send(JSON.stringify({ type: 'output', seq: chunk.seq, data: chunk.data }));
  }

  entry.attachState = null;
}

function releaseBootstrapAttachOutput(entry, attachState) {
  if (!attachState || attachState.mode !== 'drop_bootstrap_output') return;

  setTimeout(() => {
    if (entry.attachState !== attachState) {
      return;
    }

    const deliverableChunks = dropBootstrapRedrawPrefix(attachState.bufferedChunks);
    entry.attachState = null;

    for (const data of deliverableChunks) {
      const chunk = trackOutputChunk(entry, data);
      if (entry.ws && entry.ws.readyState === 1) {
        entry.ws.send(JSON.stringify({ type: 'output', seq: chunk.seq, data: chunk.data }));
      }
    }
  }, 0);
}

function buildSnapshotHydration(snapshot, runtimeType, sessionId, snapshotSeq = 0) {
  const historyGuaranteed = snapshot.historyGuaranteed ?? (runtimeType === 'tmux');
  const historyWarningReason = historyGuaranteed
    ? null
    : (snapshot.historyWarningReason ?? TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE);
  const historyWarningMessage = historyWarningReason
    ? snapshot.historyWarningMessage ?? getTerminalHistoryWarningMessage(historyWarningReason)
    : null;
  const historyState = {
    historyGuaranteed,
    historyWarningReason,
    historyWarningMessage,
  };

  return {
    historyState,
    snapshotMessage: {
      type: 'snapshot',
      sessionId,
      windowLines: snapshot.windowLines ?? TERMINAL_SNAPSHOT_WINDOW_LINES,
      lineCount: snapshot.lineCount ?? 0,
      historyGuaranteed,
      lastSeq: snapshotSeq,
      data: snapshot.data ?? '',
      ...(snapshot.terminalState ? { terminalState: snapshot.terminalState } : {}),
    },
    historyWarningEvent: historyWarningReason
      ? {
          type: 'history_warning',
          sessionId,
          reason: historyWarningReason,
          message: historyWarningMessage,
        }
      : null,
  };
}

function resolveSnapshotHydration(runtime, sessionId, snapshotSeq = 0) {
  const snapshot = typeof runtime.captureSessionSnapshot === 'function'
    ? runtime.captureSessionSnapshot(sessionId, TERMINAL_SNAPSHOT_WINDOW_LINES)
    : {
        data: '',
        lineCount: 0,
        windowLines: TERMINAL_SNAPSHOT_WINDOW_LINES,
      };

  return buildSnapshotHydration(snapshot, runtime.type, sessionId, snapshotSeq);
}

function applySnapshotHistoryState(entry, historyState) {
  if (!entry || !historyState) return;
  entry.historyGuaranteed = historyState.historyGuaranteed;
  entry.historyWarningReason = historyState.historyWarningReason ?? null;
  entry.historyWarningMessage = historyState.historyWarningMessage ?? null;
}

function buildSessionHandshake(entry, sessionId, existing) {
  const runtimeType = entry?.runtimeType ?? 'pty';
  return {
    type: 'session',
    sessionId,
    existing,
    runtimeType,
    snapshotWindowLines: runtimeType === 'tmux' ? TERMINAL_SNAPSHOT_WINDOW_LINES : null,
    historyGuaranteed: entry?.historyGuaranteed ?? (runtimeType === 'tmux'),
  };
}

/**
 * Build a fresh session entry. Shared by the local and remote attach flows;
 * `extra` carries the remote-only fields (host, hostRuntime).
 */
function createSessionEntry({ pty, ws, cwd, runtimeType, extra = {} }) {
  const now = new Date().toISOString();
  return {
    pty,
    ws,
    cwd,
    startedAt: now,
    lastOutputAt: now,
    lastSubstantialOutputAt: now,
    lastOutputLine: '',
    alive: true,
    // Runtime type (Phase 5 — durable sessions)
    runtimeType,
    snapshotWindowLines: runtimeType === 'tmux' ? TERMINAL_SNAPSHOT_WINDOW_LINES : null,
    historyGuaranteed: runtimeType === 'tmux',
    historyWarningReason: null,
    historyWarningMessage: null,
    attachState: null,
    // Diagnostic metadata (Phase 1)
    wsAttached: true,
    lastAttachAt: now,
    lastDetachAt: null,
    lastClientAckAt: null,
    lastReplayAt: null,
    lastSeq: 0,
    stallReason: null,
    events: [],
    // Replay buffer (Phase 3 — loss-aware recovery)
    replayBuffer: [],
    // Client-reported diagnostics (Phase 2 — visibility-aware recovery)
    documentVisibility: 'visible',
    clientLastMessageAt: null,
    clientLastPaintAt: null,
    clientLastResizeAt: null,
    clientLastSeenSeq: 0,
    clientReconnectCount: 0,
    ...extra,
  };
}

/** Send the handshake (+snapshot/warning) and release any buffered attach output. */
function completeAttach(ws, entry, sessionId, isExisting, { snapshotMessage, historyWarningEvent, attachState }) {
  const sessionHandshake = buildSessionHandshake(entry, sessionId, isExisting);
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(sessionHandshake));
    if (snapshotMessage) {
      ws.send(JSON.stringify(snapshotMessage));
    }
    if (historyWarningEvent) {
      ws.send(JSON.stringify(historyWarningEvent));
    }
  }

  if (attachState?.mode === 'buffer_live_output') {
    flushBufferedAttachOutput(entry);
  } else if (attachState?.mode === 'drop_bootstrap_output') {
    releaseBootstrapAttachOutput(entry, attachState);
  }
}

/**
 * Register a PTY onData handler that routes output to the session's replay buffer
 * and current WebSocket. Extracted to avoid duplicating this across initial spawn,
 * tmux re-attach on exit, and tmux reconnect recovery.
 */
function registerPtyDataHandler(ptyProcess, sessionId, sessions) {
  ptyProcess.onData((data) => {
    const s = sessions.get(sessionId);
    if (!s) return;

    const attachState = s.attachState;
    if (attachState?.mode === 'drop_bootstrap_output') {
      attachState.bufferedChunks.push(data);
      return;
    }

    const chunk = trackOutputChunk(s, data);

    if (attachState?.mode === 'buffer_live_output') {
      attachState.bufferedChunks.push(chunk);
      return;
    }

    if (s.ws && s.ws.readyState === 1) {
      s.ws.send(JSON.stringify({ type: 'output', seq: chunk.seq, data: chunk.data }));
    }
  });
}

/**
 * Compute a health label for a session based on its diagnostic state.
 * Returns one of: 'healthy', 'detached', 'stalled', 'dead'
 * ('reconnecting' and 'replaying' are client-side transient states added in later phases)
 */
export function computeSessionHealth(entry) {
  // An SSH-dropped remote session is suspended — its tmux session is presumed
  // alive on the host, so reporting 'dead' would be a lie (Spec §8.2).
  if (!entry.alive) return entry.remoteDetached ? 'detached' : 'dead';
  if (!entry.wsAttached) return 'detached';

  // Stall detection: PTY has recent output but client hasn't acknowledged
  if (entry.lastOutputAt && entry.lastClientAckAt) {
    const outputTime = new Date(entry.lastOutputAt).getTime();
    const ackTime = new Date(entry.lastClientAckAt).getTime();
    if (outputTime - ackTime > 10_000) {
      return 'stalled';
    }
  }

  return 'healthy';
}

/**
 * Compute a stall reason string when health is 'stalled'.
 * Considers document visibility to distinguish stale-view from generic ack lag.
 */
export function computeStallReason(entry) {
  if (computeSessionHealth(entry) !== 'stalled') return null;

  if (entry.lastOutputAt && entry.lastClientAckAt) {
    const outputTime = new Date(entry.lastOutputAt).getTime();
    const ackTime = new Date(entry.lastClientAckAt).getTime();
    if (outputTime - ackTime > 10_000) {
      // When the document is hidden, the browser throttles updates — stale view, not transport issue
      if (entry.documentVisibility === 'hidden') {
        return 'stale_view_document_hidden';
      }
      // When visible but paint hasn't kept up with output, the view is stale
      if (entry.clientLastPaintAt) {
        const paintTime = new Date(entry.clientLastPaintAt).getTime();
        if (outputTime - paintTime > 10_000) {
          return 'stale_view_paint_lagging';
        }
      }
      return 'server_output_outpaced_client_ack';
    }
  }
  return null;
}

/**
 * Register the PTY exit handler with tmux-aware recovery.
 * In tmux mode, if the tmux session is still alive after PTY exit,
 * re-spawn a tmux attach and swap the entry's pty reference.
 * Limited to MAX_TMUX_REATTACH attempts to prevent infinite loops.
 */
function registerPtyExitHandler(ptyProcess, sessionId, sessions, runtime, cols, rows, reattachCount = 0) {
  ptyProcess.onExit(() => {
    const s = sessions.get(sessionId);
    if (!s) return;

    // In tmux mode, check if the underlying session survived
    if (reattachCount < MAX_TMUX_REATTACH && runtime.isSessionRecoverable(sessionId)) {
      pushTimelineEvent(s, 'tmux_client_exited', `tmux session still alive — re-attaching (attempt ${reattachCount + 1}/${MAX_TMUX_REATTACH})`);
      console.log(`[terminal] tmux_client_exited session=${sessionId} — re-attaching (${reattachCount + 1}/${MAX_TMUX_REATTACH})`);
      try {
        const newPty = runtime.spawn({ cwd: s.cwd, cols, rows, sessionId });
        s.pty = newPty;
        registerPtyDataHandler(newPty, sessionId, sessions);
        registerPtyExitHandler(newPty, sessionId, sessions, runtime, cols, rows, reattachCount + 1);
        pushTimelineEvent(s, 'tmux_reattach', 'new pty wrapper attached');
        console.log(`[terminal] tmux_reattach session=${sessionId}`);
        return;
      } catch (err) {
        pushTimelineEvent(s, 'tmux_reattach_failed', err.message);
        console.log(`[terminal] tmux_reattach_failed session=${sessionId} error=${err.message}`);
        // Fall through to mark dead
      }
    }

    if (reattachCount >= MAX_TMUX_REATTACH && runtime.isSessionRecoverable(sessionId)) {
      pushTimelineEvent(s, 'tmux_reattach_exhausted', `max re-attach attempts (${MAX_TMUX_REATTACH}) reached`);
      console.log(`[terminal] tmux_reattach_exhausted session=${sessionId}`);
    }

    s.alive = false;
    s.wsAttached = false;
    pushTimelineEvent(s, 'pty_exited');
    console.log(`[terminal] pty_exited session=${sessionId}`);
    if (s.ws) s.ws.close();
  });
}

export function handleWsConnection(ws, req, sessions, runtime, deletedSessionIds = new Set(), reservedSessionIds = new Set(), options = {}) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const cwd = params.get('cwd') || process.env.HOME;
  const sessionId = params.get('sessionId') || `s-${Date.now()}`;
  const cols = parseInt(params.get('cols') || '120', 10);
  const rows = parseInt(params.get('rows') || '30', 10);

  if (deletedSessionIds.has(sessionId)) {
    safeCloseSocket(ws, {
      sessionId,
      context: 'deleted_session',
      code: SESSION_DELETED_CLOSE_CODE,
      reason: SESSION_DELETED_CLOSE_REASON,
    });
    return;
  }

  reservedSessionIds.delete(sessionId);

  // Remote sessions route every tmux operation through their host runtime
  // (Spec §6.2/§8.4). This branch comes before the local tmux gate: a missing
  // LOCAL tmux must not block terminals on a host that has its own (§8.3).
  const hostResolution = typeof options.resolveHostRuntime === 'function'
    ? options.resolveHostRuntime(sessionId)
    : null;
  if (hostResolution && hostResolution.host && hostResolution.host !== 'local') {
    const liveReachability = typeof options.getReachability === 'function'
      ? options.getReachability(hostResolution.host)
      : null;
    if (liveReachability?.reachability === 'unreachable') {
      sendSpawnError(ws, {
        reason: 'host_unreachable',
        message: `Host "${hostResolution.host}" is unreachable. ${liveReachability.lastError || ''}`.trim(),
        host: hostResolution.host,
      });
      safeCloseSocket(ws, { sessionId, context: 'remote_host_unreachable_fast_fail' });
      return;
    }
    // The remote flow awaits SSH round-trips, so unlike the synchronous local
    // path it can interleave. Serialize attaches per session id: a second
    // connection waits for the first to finish, then follows the normal
    // reconnect/takeover path against the entry the first created.
    return enqueueRemoteAttach(sessions, sessionId, () =>
      handleRemoteWsConnection(ws, {
        sessionId,
        cwd,
        cols,
        rows,
        host: hostResolution.host,
        hostRuntime: hostResolution.hostRuntime,
      }, sessions, deletedSessionIds).catch((err) => {
        console.warn(`[terminal] remote_attach_failed session=${sessionId} host=${hostResolution.host} error=${err.message}`);
        sendSpawnError(ws, {
          reason: 'spawn_failed',
          message: `Failed to attach terminal on "${hostResolution.host}": ${err.message}`,
          host: hostResolution.host,
        });
        safeCloseSocket(ws, { sessionId, context: 'remote_attach_failed' });
      })
    );
  }

  if (runtime.type === 'tmux') {
    const runtimeStatus = getTerminalRuntimeStatus(runtime);
    if (!runtimeStatus.terminalCreationAllowed) {
      ws.send(JSON.stringify({
        type: 'spawn_error',
        reason: runtimeStatus.terminalRuntimeBlockedReason,
        message: runtimeStatus.terminalRuntimeBlockedMessage,
        data: `\r\n${runtimeStatus.terminalRuntimeBlockedMessage}\r\n`,
      }));
      safeCloseSocket(ws, {
        sessionId,
        context: 'runtime_blocked',
      });
      return;
    }
  }

  let entry = sessions.get(sessionId);
  const recoverableTmuxWithoutEntry = !entry
    && runtime.type === 'tmux'
    && runtime.isSessionRecoverable(sessionId);
  const recoverableTmuxDeadEntry = !!entry
    && entry.runtimeType === 'tmux'
    && !entry.alive
    && runtime.isSessionRecoverable(sessionId);
  const isExisting = !!entry || recoverableTmuxWithoutEntry || recoverableTmuxDeadEntry;
  let snapshotMessage = null;
  let historyWarningEvent = null;
  let snapshotHistoryState = null;
  let attachState = null;

  if (!entry) {
    if (recoverableTmuxWithoutEntry) {
      safeResizeRuntimeSession(runtime, sessionId, cols, rows);
      const snapshotHydration = resolveSnapshotHydration(runtime, sessionId, 0);
      snapshotMessage = snapshotHydration.snapshotMessage;
      historyWarningEvent = snapshotHydration.historyWarningEvent;
      snapshotHistoryState = snapshotHydration.historyState;
    }

    // New session — spawn PTY and register listeners ONCE
    let ptyProcess;
    try {
      ptyProcess = runtime.spawn({ cwd, cols, rows, sessionId });
    } catch (err) {
      const message = `Failed to start terminal: ${err.message}`;
      ws.send(JSON.stringify({
        type: 'spawn_error',
        reason: 'spawn_failed',
        message,
        data: `\r\n${message}\r\n`,
      }));
      ws.close();
      return;
    }

    entry = createSessionEntry({ pty: ptyProcess, ws, cwd, runtimeType: runtime.type });

    if (snapshotHistoryState) {
      applySnapshotHistoryState(entry, snapshotHistoryState);
    }

    if (recoverableTmuxWithoutEntry) {
      attachState = beginBootstrapDropAttach(entry, entry.lastSeq ?? 0);
    }

    sessions.set(sessionId, entry);

    const attachDetail = recoverableTmuxWithoutEntry ? 'durable recovery' : 'initial connection';
    const attachType = recoverableTmuxWithoutEntry ? 'durable_recovery' : 'initial';
    pushTimelineEvent(entry, 'attach', attachDetail);
    console.log(`[terminal] attach session=${sessionId} cwd=${cwd} type=${attachType}`);

    // PTY -> Browser: registered ONCE, reads entry.ws for current WebSocket
    registerPtyDataHandler(ptyProcess, sessionId, sessions);

    // PTY exit: registered ONCE, reads entry.ws for current WebSocket
    // In tmux mode, PTY exit may just mean the tmux client detached —
    // if the tmux session is still alive, re-attach automatically.
    registerPtyExitHandler(ptyProcess, sessionId, sessions, runtime, cols, rows);
  } else {
    if (entry.runtimeType === 'tmux' && entry.alive) {
      const snapshotSeq = entry.lastSeq ?? 0;
      attachState = beginBufferedAttach(entry, snapshotSeq);
      safeResizeRuntimeSession(runtime, sessionId, cols, rows);
      const snapshotHydration = alignSnapshotBoundaryWithBufferedOutput(
        resolveSnapshotHydration(runtime, sessionId, snapshotSeq),
        attachState,
      );
      snapshotMessage = snapshotHydration.snapshotMessage;
      historyWarningEvent = snapshotHydration.historyWarningEvent;
      snapshotHistoryState = snapshotHydration.historyState;
    } else if (recoverableTmuxDeadEntry) {
      attachState = beginBootstrapDropAttach(entry, entry.lastSeq ?? 0);
    }

    // Existing session — update the active WebSocket reference
    const previousWs = entry.ws;
    if (previousWs && previousWs !== ws) {
      safeCloseSocket(previousWs, {
        sessionId,
        context: 'session_takeover',
        code: SESSION_TAKEOVER_CLOSE_CODE,
        reason: SESSION_TAKEOVER_CLOSE_REASON,
      });
    }
    entry.ws = ws;
    entry.wsAttached = true;
    entry.lastAttachAt = new Date().toISOString();
    pushTimelineEvent(entry, 'attach', recoverableTmuxDeadEntry ? 'reconnect_recovery' : 'reconnect');
    console.log(`[terminal] attach session=${sessionId} type=${recoverableTmuxDeadEntry ? 'reconnect_recovery' : 'reconnect'}`);

    // In tmux mode, the old PTY wrapper may have died while the tmux session
    // is still alive. Re-spawn the attachment if needed.
    if (recoverableTmuxDeadEntry) {
      try {
        const newPty = runtime.spawn({ cwd: entry.cwd, cols, rows, sessionId });
        entry.pty = newPty;
        registerPtyDataHandler(newPty, sessionId, sessions);
        registerPtyExitHandler(newPty, sessionId, sessions, runtime, cols, rows);
        entry.alive = true;
        pushTimelineEvent(entry, 'tmux_reattach', 'recovered on reconnect');
        console.log(`[terminal] tmux_reattach session=${sessionId} type=reconnect_recovery`);
      } catch (err) {
        pushTimelineEvent(entry, 'tmux_reattach_failed', err.message);
        console.log(`[terminal] tmux_reattach_failed session=${sessionId} error=${err.message}`);
      }

      safeResizeRuntimeSession(runtime, sessionId, cols, rows);
      const snapshotHydration = resolveSnapshotHydration(runtime, sessionId, entry.lastSeq ?? 0);
      snapshotMessage = snapshotHydration.snapshotMessage;
      historyWarningEvent = snapshotHydration.historyWarningEvent;
      snapshotHistoryState = snapshotHydration.historyState;
    }

    if (snapshotHistoryState) {
      applySnapshotHistoryState(entry, snapshotHistoryState);
    }

    // Resize to match the new client's dimensions
    safeResizePty(entry, cols, rows, sessionId);
  }

  registerSessionSocketHandlers(ws, entry, sessionId, {
    resizeRuntime: (cols, rows) => {
      if (entry.runtimeType === 'tmux') {
        safeResizeRuntimeSession(runtime, sessionId, cols, rows);
      }
    },
    resolveHydration: typeof runtime.captureSessionSnapshot === 'function'
      ? (id, seq) => resolveSnapshotHydration(runtime, id, seq)
      : null,
  });

  completeAttach(ws, entry, sessionId, isExisting, { snapshotMessage, historyWarningEvent, attachState });
}

/**
 * Register the browser->PTY message and close handlers for an attached socket.
 * `ops` abstracts the runtime-touching pieces so local sessions keep their
 * synchronous flow while remote sessions route through their host runtime:
 * - resizeRuntime(cols, rows): align the durable tmux window (no-op for pty)
 * - resolveHydration(sessionId, seq): snapshot hydration — may return a
 *   Promise (remote); when it does, the rehydrate reply is sent on resolve.
 */
function registerSessionSocketHandlers(ws, entry, sessionId, ops) {
  // Browser -> PTY
  ws.on('message', (msg) => {
    if (entry.ws !== ws) return;

    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'input') {
        entry.pty.write(parsed.data);
      } else if (parsed.type === 'resize') {
        ops.resizeRuntime(parsed.cols, parsed.rows);
        entry.pty.resize(parsed.cols, parsed.rows);
      } else if (parsed.type === 'heartbeat') {
        entry.lastClientAckAt = new Date().toISOString();
        // Store client-reported diagnostics from heartbeat
        if (parsed.documentVisibility) entry.documentVisibility = parsed.documentVisibility;
        if (parsed.lastMessageAt) entry.clientLastMessageAt = parsed.lastMessageAt;
        if (parsed.lastPaintAt) entry.clientLastPaintAt = parsed.lastPaintAt;
        if (parsed.lastResizeAt) entry.clientLastResizeAt = parsed.lastResizeAt;
        if (typeof parsed.lastSeenSeq === 'number') entry.clientLastSeenSeq = parsed.lastSeenSeq;
        if (typeof parsed.reconnectCount === 'number') entry.clientReconnectCount = parsed.reconnectCount;
        // Update stall reason based on new ack
        const prevStallReason = entry.stallReason;
        entry.stallReason = computeStallReason(entry);
        if (entry.stallReason && entry.stallReason !== prevStallReason) {
          pushTimelineEvent(entry, 'stall_detected', entry.stallReason);
          console.log(`[terminal] stall session=${sessionId} reason=${entry.stallReason}`);
        }
      } else if (parsed.type === 'resume') {
        const lastSeenSeq = parsed.lastSeenSeq || 0;
        pushTimelineEvent(entry, 'replay_requested', `from seq ${lastSeenSeq}`);
        const chunks = entry.replayBuffer.filter(
          c => c.seq > lastSeenSeq && !isReplayNoise(c.data)
        );
        const oldestBufferedSeq = entry.replayBuffer.length > 0 ? entry.replayBuffer[0].seq : 0;
        const overflow = lastSeenSeq > 0 && oldestBufferedSeq > lastSeenSeq + 1;
        const missedCount = overflow ? oldestBufferedSeq - lastSeenSeq - 1 : 0;

        if (ws.readyState === 1) {
          ws.send(JSON.stringify({
            type: 'replay',
            chunks,
            overflow,
            missedCount,
          }));
        }
        entry.lastReplayAt = new Date().toISOString();
        entry.lastClientAckAt = new Date().toISOString();
        pushTimelineEvent(entry, 'replay_served', `${chunks.length} chunks, overflow=${overflow}`);
        console.log(`[terminal] replay session=${sessionId} chunks=${chunks.length} overflow=${overflow} missedCount=${missedCount}`);
      } else if (parsed.type === 'rehydrate') {
        if (entry.runtimeType !== 'tmux' || !ops.resolveHydration) {
          pushTimelineEvent(entry, 'rehydrate_skipped', 'snapshot hydration unavailable');
          return;
        }

        const snapshotSeq = entry.lastSeq ?? 0;
        const attachState = beginBufferedAttach(entry, snapshotSeq);
        const finishRehydrate = (hydration) => {
          const snapshotHydration = alignSnapshotBoundaryWithBufferedOutput(hydration, attachState);
          applySnapshotHistoryState(entry, snapshotHydration.historyState);

          if (ws.readyState === 1) {
            ws.send(JSON.stringify(snapshotHydration.snapshotMessage));
            if (snapshotHydration.historyWarningEvent) {
              ws.send(JSON.stringify(snapshotHydration.historyWarningEvent));
            }
          }

          flushBufferedAttachOutput(entry);
          entry.lastClientAckAt = new Date().toISOString();
          pushTimelineEvent(entry, 'rehydrate_served', `snapshot seq ${snapshotSeq}`);
          console.log(`[terminal] rehydrate session=${sessionId} snapshotSeq=${snapshotSeq}`);
        };

        // Local hydration resolves synchronously (send ordering preserved);
        // remote hydration arrives from the host runner asynchronously.
        const hydration = ops.resolveHydration(sessionId, snapshotSeq);
        if (hydration && typeof hydration.then === 'function') {
          hydration.then(finishRehydrate).catch((err) => {
            pushTimelineEvent(entry, 'rehydrate_failed', err.message);
            console.warn(`[terminal] rehydrate_failed session=${sessionId} error=${err.message}`);
          });
        } else {
          finishRehydrate(hydration);
        }
      } else if (parsed.type === 'recovery_action') {
        const action = parsed.action || 'unknown';
        pushTimelineEvent(entry, `recovery_${action}`, `user-initiated ${action}`);
        console.log(`[terminal] recovery action=${action} session=${sessionId}`);
      } else if (parsed.type === 'visibility_change') {
        entry.documentVisibility = parsed.state || 'visible';
        const eventType = parsed.state === 'hidden' ? 'visibility_hidden' : 'visibility_visible';
        pushTimelineEvent(entry, eventType);
        // Update stall reason — visibility change may clear or trigger stall
        const prevStall = entry.stallReason;
        entry.stallReason = computeStallReason(entry);
        if (entry.stallReason && entry.stallReason !== prevStall) {
          pushTimelineEvent(entry, 'stall_detected', entry.stallReason);
          console.log(`[terminal] stall session=${sessionId} reason=${entry.stallReason}`);
        }
      }
    } catch {
      // Raw string input fallback
      entry.pty.write(msg.toString());
    }
  });

  ws.on('close', () => {
    if (entry.ws !== ws) return;

    // Keep PTY alive for reconnection — only kill on explicit DELETE
    entry.wsAttached = false;
    entry.lastDetachAt = new Date().toISOString();
    pushTimelineEvent(entry, 'detach');
    console.log(`[terminal] detach session=${sessionId}`);
  });
}

// ---------------------------------------------------------------------------
// Remote-host sessions (Spec §6.3, §8.4)
// ---------------------------------------------------------------------------

// Per-sessions-map attach queues: Map<sessionId, tailPromise>. Serializes the
// async remote attach flow per session id (the sync local flow needs none).
const remoteAttachQueues = new WeakMap();

function enqueueRemoteAttach(sessions, sessionId, attach) {
  let queues = remoteAttachQueues.get(sessions);
  if (!queues) {
    queues = new Map();
    remoteAttachQueues.set(sessions, queues);
  }

  const previous = queues.get(sessionId) || Promise.resolve();
  // `attach` contains its own error handling; the chain never rejects.
  const next = previous.then(attach);
  queues.set(sessionId, next);
  next.finally(() => {
    if (queues.get(sessionId) === next) queues.delete(sessionId);
  });
  return next;
}

function sendSpawnError(ws, { reason, message, host }) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: 'spawn_error',
    reason,
    message,
    ...(host ? { host } : {}),
    data: `\r\n${message}\r\n`,
  }));
}

/**
 * PTY exit handler for remote sessions. The classification is the truthfulness
 * core (Spec §8.2/§8.4): a definitive tmux answer may re-attach or mark the
 * session dead, but a transport failure — the SSH connection dropped — means
 * the remote tmux session is PRESUMED ALIVE, so the exit is recorded as a
 * recoverable detach and the browser socket stays open.
 */
function registerRemotePtyExitHandler(ptyProcess, sessionId, sessions, hostRuntime, cols, rows, reattachCount = 0) {
  ptyProcess.onExit(() => {
    const s = sessions.get(sessionId);
    if (!s) return;

    const markRemoteDetached = (err) => {
      s.alive = false;
      s.wsAttached = s.wsAttached ?? false;
      s.remoteDetached = true;
      pushTimelineEvent(s, 'remote_ssh_drop', err?.message || 'ssh connection dropped');
      console.log(`[terminal] remote_ssh_drop session=${sessionId} host=${s.host} error=${err?.message}`);
      // Do NOT close the browser socket — the session is suspended, not dead.
    };

    const markDead = () => {
      s.alive = false;
      s.wsAttached = false;
      pushTimelineEvent(s, 'pty_exited');
      console.log(`[terminal] pty_exited session=${sessionId} host=${s.host}`);
      if (s.ws) s.ws.close();
    };

    hostRuntime.isSessionRecoverableAsync(sessionId)
      .then(async (recoverable) => {
        if (recoverable && reattachCount < MAX_TMUX_REATTACH) {
          pushTimelineEvent(s, 'tmux_client_exited', `remote tmux session still alive — re-attaching (attempt ${reattachCount + 1}/${MAX_TMUX_REATTACH})`);
          try {
            const newPty = await hostRuntime.spawnAsync({ cwd: s.cwd, cols, rows, sessionId });
            s.pty = newPty;
            s.alive = true;
            registerPtyDataHandler(newPty, sessionId, sessions);
            registerRemotePtyExitHandler(newPty, sessionId, sessions, hostRuntime, cols, rows, reattachCount + 1);
            pushTimelineEvent(s, 'tmux_reattach', 'new remote pty wrapper attached');
            console.log(`[terminal] tmux_reattach session=${sessionId} host=${s.host}`);
            return;
          } catch (err) {
            if (isTransportFailure(err)) {
              markRemoteDetached(err);
              return;
            }
            pushTimelineEvent(s, 'tmux_reattach_failed', err.message);
            // Fall through to mark dead
          }
        }

        if (recoverable && reattachCount >= MAX_TMUX_REATTACH) {
          pushTimelineEvent(s, 'tmux_reattach_exhausted', `max re-attach attempts (${MAX_TMUX_REATTACH}) reached`);
        }

        markDead();
      })
      .catch(markRemoteDetached);
  });
}

/**
 * When the reachability probe proves a host recovered, any browser socket that
 * was left waiting on a transport-detached remote session receives the normal
 * truthful reconnect treatment immediately: re-attach the tmux client and send
 * a fresh snapshot reseed over the still-open socket.
 */
export async function reseedRemoteDetachedSessions({
  sessions,
  host,
  hostRuntime,
  cols = 120,
  rows = 30,
} = {}) {
  const reseeded = [];

  for (const [sessionId, entry] of sessions) {
    if (entry?.host !== host) continue;
    if (!entry.remoteDetached || entry.alive) continue;
    if (!entry.ws || entry.ws.readyState !== 1) continue;

    const recoverable = await hostRuntime.isSessionRecoverableAsync(sessionId);
    if (!recoverable) continue;

    const ptyProcess = await hostRuntime.spawnAsync({
      cwd: entry.cwd,
      cols,
      rows,
      sessionId,
    });

    entry.pty = ptyProcess;
    entry.hostRuntime = hostRuntime;
    entry.alive = true;
    entry.remoteDetached = false;
    entry.wsAttached = true;
    entry.lastAttachAt = new Date().toISOString();
    registerPtyDataHandler(ptyProcess, sessionId, sessions);
    registerRemotePtyExitHandler(ptyProcess, sessionId, sessions, hostRuntime, cols, rows);

    const snapshot = await hostRuntime.captureSessionSnapshotAsync(sessionId, TERMINAL_SNAPSHOT_WINDOW_LINES);
    const snapshotHydration = buildSnapshotHydration(snapshot, 'tmux', sessionId, entry.lastSeq ?? 0);
    applySnapshotHistoryState(entry, snapshotHydration.historyState);
    completeAttach(entry.ws, entry, sessionId, true, {
      snapshotMessage: snapshotHydration.snapshotMessage,
      historyWarningEvent: snapshotHydration.historyWarningEvent,
      attachState: null,
    });
    pushTimelineEvent(entry, 'host_recovered_reseed', `fresh snapshot sent for host ${host}`);
    reseeded.push(sessionId);
  }

  return reseeded;
}

/**
 * Async attach flow for sessions whose project lives on a remote host. Mirrors
 * the local flow above but routes every tmux operation through the session's
 * host runtime. Kept separate so the local path stays fully synchronous — the
 * local suite's send-ordering guarantees depend on that.
 */
async function handleRemoteWsConnection(ws, { sessionId, cwd, cols, rows, host, hostRuntime }, sessions, deletedSessionIds = new Set()) {
  // Per-host tmux requirement (§8.3) — the message names the host, and an
  // unreachable host is reported distinctly from a missing tmux.
  const tmuxCheck = await hostRuntime.checkTmuxAsync();
  if (!tmuxCheck.available) {
    const message = tmuxCheck.transport
      ? `Host "${host}" is unreachable. ${tmuxCheck.error || ''}`.trim()
      : `Install tmux on "${host}" to enable durable CodeDeck terminals.`;
    sendSpawnError(ws, {
      reason: tmuxCheck.transport ? 'host_unreachable' : 'missing_tmux',
      message,
      host,
    });
    safeCloseSocket(ws, { sessionId, context: 'remote_runtime_blocked' });
    return;
  }

  let entry = sessions.get(sessionId);

  let recoverable = false;
  if (!entry || (!entry.alive && entry.runtimeType === 'tmux')) {
    try {
      recoverable = await hostRuntime.isSessionRecoverableAsync(sessionId);
    } catch (err) {
      sendSpawnError(ws, {
        reason: 'host_unreachable',
        message: `Host "${host}" is unreachable. ${err.message}`,
        host,
      });
      safeCloseSocket(ws, { sessionId, context: 'remote_host_unreachable' });
      return;
    }
  }

  const recoverableWithoutEntry = !entry && recoverable;
  const recoverableDeadEntry = !!entry && !entry.alive && recoverable;
  const isExisting = !!entry || recoverableWithoutEntry;
  let snapshotMessage = null;
  let historyWarningEvent = null;
  let snapshotHistoryState = null;
  let attachState = null;

  async function resolveRemoteHydration(snapshotSeq) {
    const snapshot = await hostRuntime.captureSessionSnapshotAsync(sessionId, TERMINAL_SNAPSHOT_WINDOW_LINES);
    return buildSnapshotHydration(snapshot, 'tmux', sessionId, snapshotSeq);
  }

  if (!entry) {
    if (recoverableWithoutEntry) {
      await hostRuntime.resizeSessionAsync(sessionId, cols, rows);
      const snapshotHydration = await resolveRemoteHydration(0);
      snapshotMessage = snapshotHydration.snapshotMessage;
      historyWarningEvent = snapshotHydration.historyWarningEvent;
      snapshotHistoryState = snapshotHydration.historyState;
    }

    let ptyProcess;
    try {
      ptyProcess = await hostRuntime.spawnAsync({ cwd, cols, rows, sessionId });
    } catch (err) {
      const transport = isTransportFailure(err);
      const message = transport
        ? `Host "${host}" is unreachable. ${err.message}`
        : `Failed to start terminal on "${host}": ${err.message}`;
      sendSpawnError(ws, {
        reason: transport ? 'host_unreachable' : 'spawn_failed',
        message,
        host,
      });
      ws.close();
      return;
    }

    // A DELETE may have landed while the spawn was in flight — never
    // resurrect a tombstoned session; clean up the PTY we just attached.
    if (deletedSessionIds.has(sessionId)) {
      try {
        ptyProcess.kill();
      } catch {
        // PTY may already be gone
      }
      safeCloseSocket(ws, {
        sessionId,
        context: 'deleted_during_attach',
        code: SESSION_DELETED_CLOSE_CODE,
        reason: SESSION_DELETED_CLOSE_REASON,
      });
      return;
    }

    entry = createSessionEntry({
      pty: ptyProcess,
      ws,
      cwd,
      runtimeType: 'tmux',
      extra: { host, hostRuntime },
    });

    if (snapshotHistoryState) {
      applySnapshotHistoryState(entry, snapshotHistoryState);
    }

    if (recoverableWithoutEntry) {
      attachState = beginBootstrapDropAttach(entry, entry.lastSeq ?? 0);
    }

    sessions.set(sessionId, entry);

    const attachType = recoverableWithoutEntry ? 'durable_recovery' : 'initial';
    pushTimelineEvent(entry, 'attach', `${attachType} (host ${host})`);
    console.log(`[terminal] attach session=${sessionId} host=${host} cwd=${cwd} type=${attachType}`);

    registerPtyDataHandler(ptyProcess, sessionId, sessions);
    registerRemotePtyExitHandler(ptyProcess, sessionId, sessions, hostRuntime, cols, rows);
  } else {
    if (entry.runtimeType === 'tmux' && entry.alive) {
      const snapshotSeq = entry.lastSeq ?? 0;
      attachState = beginBufferedAttach(entry, snapshotSeq);
      await hostRuntime.resizeSessionAsync(sessionId, cols, rows);
      const snapshotHydration = alignSnapshotBoundaryWithBufferedOutput(
        await resolveRemoteHydration(snapshotSeq),
        attachState,
      );
      snapshotMessage = snapshotHydration.snapshotMessage;
      historyWarningEvent = snapshotHydration.historyWarningEvent;
      snapshotHistoryState = snapshotHydration.historyState;
    } else if (recoverableDeadEntry) {
      attachState = beginBootstrapDropAttach(entry, entry.lastSeq ?? 0);
    }

    const previousWs = entry.ws;
    if (previousWs && previousWs !== ws) {
      safeCloseSocket(previousWs, {
        sessionId,
        context: 'session_takeover',
        code: SESSION_TAKEOVER_CLOSE_CODE,
        reason: SESSION_TAKEOVER_CLOSE_REASON,
      });
    }
    entry.ws = ws;
    entry.wsAttached = true;
    entry.lastAttachAt = new Date().toISOString();
    // Refresh the routing pin: the host's sshTarget may have changed since the
    // entry was created, and stale runtimes would keep SSHing the old target.
    entry.host = host;
    entry.hostRuntime = hostRuntime;
    pushTimelineEvent(entry, 'attach', recoverableDeadEntry ? 'reconnect_recovery' : 'reconnect');
    console.log(`[terminal] attach session=${sessionId} host=${host} type=${recoverableDeadEntry ? 'reconnect_recovery' : 'reconnect'}`);

    if (recoverableDeadEntry) {
      try {
        const newPty = await hostRuntime.spawnAsync({ cwd: entry.cwd, cols, rows, sessionId });
        entry.pty = newPty;
        registerPtyDataHandler(newPty, sessionId, sessions);
        registerRemotePtyExitHandler(newPty, sessionId, sessions, hostRuntime, cols, rows);
        entry.alive = true;
        entry.remoteDetached = false;
        pushTimelineEvent(entry, 'tmux_reattach', 'recovered on reconnect');
        console.log(`[terminal] tmux_reattach session=${sessionId} host=${host} type=reconnect_recovery`);
      } catch (err) {
        pushTimelineEvent(entry, 'tmux_reattach_failed', err.message);
        console.log(`[terminal] tmux_reattach_failed session=${sessionId} host=${host} error=${err.message}`);
      }

      await hostRuntime.resizeSessionAsync(sessionId, cols, rows);
      const snapshotHydration = await resolveRemoteHydration(entry.lastSeq ?? 0);
      snapshotMessage = snapshotHydration.snapshotMessage;
      historyWarningEvent = snapshotHydration.historyWarningEvent;
      snapshotHistoryState = snapshotHydration.historyState;
    }

    if (snapshotHistoryState) {
      applySnapshotHistoryState(entry, snapshotHistoryState);
    }

    safeResizePty(entry, cols, rows, sessionId);
  }

  registerSessionSocketHandlers(ws, entry, sessionId, {
    resizeRuntime: (resizeCols, resizeRows) => {
      // Best-effort remote resize; errors are swallowed inside the runtime.
      hostRuntime.resizeSessionAsync(sessionId, resizeCols, resizeRows);
    },
    resolveHydration: (id, seq) => resolveRemoteHydration(seq),
  });

  completeAttach(ws, entry, sessionId, isExisting, { snapshotMessage, historyWarningEvent, attachState });

  // The socket may have closed while we awaited SSH round-trips — its 'close'
  // event fired before our handler was registered, so record the detach here
  // or the entry would look attached forever and never be GC'd.
  if (ws.readyState !== 1 && entry.ws === ws) {
    entry.wsAttached = false;
    entry.lastDetachAt = new Date().toISOString();
    pushTimelineEvent(entry, 'detach', 'socket closed during attach');
  }
}
