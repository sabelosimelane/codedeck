/**
 * WebSocket connection handler for terminal PTY sessions.
 *
 * Extracted from index.js to enable unit testing of listener management.
 * One PTY per session broadcasts to independently hydrated client attachments.
 * Explicit protocol-v2 claims fence input and terminal dimensions by revision.
 *
 * @param {WebSocket} ws - The incoming WebSocket connection
 * @param {http.IncomingMessage} req - The HTTP upgrade request
 * @param {Map} sessions - The sessions Map: sessionId -> session entry object
 * @param {object} runtime - Terminal runtime (from terminal-runtime.js) with spawn/kill/isSessionRecoverable
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  getTerminalHistoryWarningMessage,
  getTerminalRuntimeStatus,
  TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE,
  TERMINAL_SNAPSHOT_WINDOW_LINES,
} from './terminal-runtime.js';
import { isTransportFailure } from './command-runner.js';
import { INITIAL_COLS, INITIAL_ROWS } from './mobile-session-start.js';
import { createTerminalWorkflow } from './terminal-workflow.js';

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

export const TERMINAL_PROTOCOL_VERSION = 2;
const MAX_ATTACHMENT_BYTES = 1024 * 1024;

function ensureAttachment(entry, ws) {
  entry.attachments ??= new Map();
  if (!entry.attachments.has(ws)) {
    entry.attachments.set(ws, {
      id: randomUUID(), ws, ready: false, attachState: null, isCompanion: false,
      documentVisibility: 'visible', lastClientAckAt: null,
      clientLastMessageAt: null, clientLastPaintAt: null, clientLastResizeAt: null,
      clientLastSeenSeq: 0, clientReconnectCount: 0,
    });
  }
  return entry.attachments.get(ws);
}

function sendAttachment(entry, attachment, message) {
  if (attachment.ws.readyState !== 1) return;
  if (attachment.ws.bufferedAmount > MAX_ATTACHMENT_BYTES) {
    attachment.ws.close(4008, 'slow_client_reconnect');
    removeAttachment(entry, attachment.ws);
    return;
  }
  try { attachment.ws.send(JSON.stringify(message)); }
  catch { attachment.ws.close(4008, 'send_failed_reconnect'); removeAttachment(entry, attachment.ws); }
}

function broadcast(entry, message) {
  for (const attachment of entry.attachments?.values() ?? []) sendAttachment(entry, attachment, message);
}

function controlState(entry, requestId = null) {
  return { type: 'control_state', requestId, controllerId: entry.controllerId,
    controlRevision: entry.controlRevision, cols: entry.cols, rows: entry.rows };
}

function removeAttachment(entry, ws) {
  const attachment = entry.attachments?.get(ws);
  if (!attachment) return;
  entry.attachments.delete(ws);
  attachment.attachState?.releaseGeometry?.();
  attachment.attachState = null;
  if (entry.controllerId === attachment.id) {
    entry.controllerId = null;
    entry.controlRevision++;
    broadcast(entry, controlState(entry));
  }
  entry.wsAttached = entry.attachments.size > 0;
  if (entry.ws === ws) entry.ws = entry.attachments.keys().next().value ?? null;
  if (!entry.wsAttached) {
    entry.lastDetachAt = new Date().toISOString();
    detachTmuxClient(entry);
  }
}

function deliverOutput(entry, chunk) {
  for (const attachment of entry.attachments.values()) {
    if (attachment.attachState?.mode === 'buffer_live_output') {
      attachment.attachState.bufferedChunks.push(chunk);
      attachment.attachState.bytes += Buffer.byteLength(chunk.data);
      if (attachment.attachState.bytes > MAX_ATTACHMENT_BYTES) {
        attachment.ws.close(4008, 'slow_client_reconnect');
        removeAttachment(entry, attachment.ws);
      }
    } else sendAttachment(entry, attachment, { type: 'output', ...chunk });
  }
}

function validateIncarnation(ws, sessionId, actual, expected, options) {
  if (actual !== null && (typeof actual !== 'string' || actual.length === 0)) throw new Error('Terminal incarnation must identify the durable session.');
  if (actual !== null) options.adoptSessionIncarnation?.(sessionId, actual);
  if (expected !== null && actual !== expected) {
    ws.send(JSON.stringify({type:'protocol_error', message:'This session incarnation is no longer available.'}));
    ws.close(4002, 'session_incarnation_changed');
    return false;
  }
  return true;
}

function validDimensions(cols, rows) {
  return Number.isInteger(cols) && cols >= 2 && cols <= 1000
    && Number.isInteger(rows) && rows >= 1 && rows <= 1000;
}

function validateMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw new Error('Message type is required.');
  const fields = {
    claim_control: ['requestId', 'cols', 'rows'], input: ['data', 'controlRevision'], resize: ['cols', 'rows', 'controlRevision'],
    resume: ['lastSeenSeq'], rehydrate: [], visibility_change: ['state'], recovery_action: ['action'], user_activity: [],
    heartbeat: ['documentVisibility', 'lastMessageAt', 'lastPaintAt', 'lastResizeAt', 'lastSeenSeq', 'reconnectCount'],
    workflow_start: ['requestId', 'command', 'resetCommand', 'controlRevision'], workflow_stop: ['requestId', 'controlRevision'],
  };
  if (!fields[value.type]) throw new Error('Unknown message type.');
  if (Object.keys(value).some(key => key !== 'type' && !fields[value.type].includes(key))) throw new Error('Message contains an unknown field.');
  if (['claim_control', 'resize'].includes(value.type) && !validDimensions(value.cols, value.rows)) throw new Error('cols and rows must be valid terminal dimensions.');
  if (value.type === 'claim_control' && (typeof value.requestId !== 'string' || !/^[\w-]{1,128}$/.test(value.requestId))) throw new Error('requestId is required.');
  if (value.type === 'input' && (typeof value.data !== 'string' || value.data.length === 0 || Buffer.byteLength(value.data) > 65536)) throw new Error('data must contain 1–65536 bytes.');
  if (['input','resize','workflow_start','workflow_stop'].includes(value.type) && (!Number.isSafeInteger(value.controlRevision) || value.controlRevision < 0)) throw new Error('controlRevision must be a non-negative integer.');
  if (value.type === 'resume' && (!Number.isSafeInteger(value.lastSeenSeq) || value.lastSeenSeq < 0)) throw new Error('lastSeenSeq must be a non-negative integer.');
  if (value.type === 'visibility_change' && !['visible','hidden'].includes(value.state)) throw new Error('state must be visible or hidden.');
  if (value.type === 'recovery_action' && (typeof value.action !== 'string' || !/^[\w-]{1,64}$/.test(value.action))) throw new Error('action must identify a recovery action.');
  if (value.type === 'heartbeat') {
    for (const key of fields.heartbeat) {
      if (key === 'documentVisibility') { if (!['visible','hidden'].includes(value[key])) throw new Error('documentVisibility must be visible or hidden.'); }
      else if (['lastSeenSeq','reconnectCount'].includes(key)) { if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`${key} must be a non-negative integer.`); }
      else if (value[key] !== null && (typeof value[key] !== 'string' || !Number.isFinite(Date.parse(value[key])))) throw new Error(`${key} must be a timestamp or null.`);
    }
  }
}

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

function safeResizeRuntimeSession(runtime, sessionId, cols, rows) {
  if (typeof runtime?.resizeSession !== 'function') return;

  try {
    runtime.resizeSession(sessionId, cols, rows);
  } catch (err) {
    console.warn(`[terminal] runtime_resize_failed session=${sessionId} cols=${cols} rows=${rows} error=${err.message}`);
  }
}

function beginBufferedAttach(entry, snapshotSeq, ws) {
  const attachment = ensureAttachment(entry, ws);
  attachment.attachState?.releaseGeometry?.();
  let releaseGeometry;
  const geometryReady = new Promise(resolve => { releaseGeometry = resolve; });
  const attachState = {
    geometryReady, releaseGeometry,
    mode: 'buffer_live_output',
    bytes: 0,
    snapshotSeq,
    bufferedChunks: [],
  };
  ensureAttachment(entry, ws).attachState = attachState;
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

function flushBufferedAttachOutput(entry, ws) {
  const attachment = entry.attachments.get(ws);
  const attachState = attachment?.attachState;
  if (!attachState || attachState.mode !== 'buffer_live_output') return;
  if (ws.readyState !== 1) return;

  for (const chunk of attachState.bufferedChunks) sendAttachment(entry, attachment, { type: 'output', ...chunk });
  attachment.attachState = null;
  attachState.releaseGeometry?.();
}

function releaseBootstrapAttachOutput(entry, attachState, ready) {
  if (!attachState || attachState.mode !== 'drop_bootstrap_output') return;

  setTimeout(() => {
    if (entry.attachState !== attachState) {
      return;
    }

    const deliverableChunks = dropBootstrapRedrawPrefix(attachState.bufferedChunks);
    entry.attachState = null;

    for (const data of deliverableChunks) {
      const chunk = trackOutputChunk(entry, data);
      deliverOutput(entry, chunk);
    }
    ready();
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

function buildSessionHandshake(entry, sessionId, existing, ws) {
  const runtimeType = entry?.runtimeType ?? 'pty';
  return {
    type: 'session',
    protocol: TERMINAL_PROTOCOL_VERSION,
    attachmentId: ensureAttachment(entry, ws).id,
    controllerId: entry.controllerId,
    controlRevision: entry.controlRevision,
    cols: entry.cols, rows: entry.rows,
    incarnationId: entry.incarnationId,
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
function createSessionEntry({ pty, ws, cwd, cols, rows, incarnation, runtimeType, extra = {} }) {
  const now = new Date().toISOString();
  return {
    pty,
    ws,
    attachments: new Map(),
    controllerId: null, controlRevision: 0, controlConflicts: 0, cols, rows, incarnationId: incarnation,
    cwd,
    startedAt: now,
    lastOutputAt: now,
    lastSubstantialOutputAt: now,
    lastOutputLine: '',
    alive: true,
    clientDetached: false,
    // Runtime type (Phase 5 — durable sessions)
    runtimeType,
    snapshotWindowLines: runtimeType === 'tmux' ? TERMINAL_SNAPSHOT_WINDOW_LINES : null,
    historyGuaranteed: runtimeType === 'tmux',
    historyWarningReason: null,
    historyWarningMessage: null,
    attachState: null,
    // Diagnostic metadata (Phase 1)
    wsAttached: ws != null,
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
    backgroundHolds: 0,
    workflowObservers: [],
    ...extra,
  };
}

/** Send the handshake (+snapshot/warning) and release any buffered attach output. */
function completeAttach(ws, entry, sessionId, isExisting, { snapshotMessage, historyWarningEvent, attachState }) {
  const sessionHandshake = buildSessionHandshake(entry, sessionId, isExisting, ws);
  if (ws.readyState === 1) {
    // Restore the input lock before the browser can flush queued input at
    // the session handshake. The loop belongs to the session, not this socket.
    const workflowState = entry.workflow?.snapshot();
    if (workflowState) {
      ws.send(JSON.stringify({ type: 'workflow_state', requestId: null, state: workflowState }));
    }
    ws.send(JSON.stringify(sessionHandshake));
    if (snapshotMessage) {
      ws.send(JSON.stringify(snapshotMessage));
    }
    if (historyWarningEvent) {
      ws.send(JSON.stringify(historyWarningEvent));
    }
  }

  const ready = () => {
    const attachment = entry.attachments.get(ws);
    if (!attachment) return;
    attachment.ready = true;
    sendAttachment(entry, attachment, {type:'attachment_ready'});
  };
  if (attachState?.mode === 'buffer_live_output') {
    flushBufferedAttachOutput(entry, ws);
  } else if (attachState?.mode === 'drop_bootstrap_output') {
    releaseBootstrapAttachOutput(entry, attachState, ready);
    return;
  }
  ready();
}

/**
 * Register a PTY onData handler that routes output to the session's replay buffer
 * and current WebSocket. Extracted to avoid duplicating this across initial spawn,
 * tmux re-attach on exit, and tmux reconnect recovery.
 */
function registerPtyDataHandler(ptyProcess, sessionId, sessions) {
  ptyProcess.onData((data) => {
    const s = sessions.get(sessionId);
    if (!s || s.pty !== ptyProcess) return;

    const attachState = s.attachState;
    if (attachState?.mode === 'drop_bootstrap_output') {
      attachState.bufferedChunks.push(data);
      return;
    }

    // Live output still drives automation while browser hydration buffers it.
    if (s.pty === ptyProcess) s.workflow?.output(data);

    const chunk = trackOutputChunk(s, data);

    if (s.controlOutput) {
      s.controlOutput.push(chunk);
      s.controlOutputBytes += Buffer.byteLength(data);
      if (s.controlOutputBytes > MAX_ATTACHMENT_BYTES) {
        for (const attachment of [...s.attachments.values()]) { attachment.ws.close(4008, 'resize_output_overflow_reconnect'); removeAttachment(s, attachment.ws); }
        s.controlOutput = null;
      }
    } else deliverOutput(s, chunk);
  });
}

const intentionallyDetachedPtys = new WeakSet();

/** Release a tmux client attachment while leaving its durable session alive. */
function detachTmuxClient(entry) {
  if (entry?.workflow?.snapshot().active) return;
  if ((entry?.backgroundHolds ?? 0) > 0) return;
  if (entry?.runtimeType !== 'tmux' || !entry.alive || !entry.pty) return;
  const pty = entry.pty;
  intentionallyDetachedPtys.add(pty);
  entry.alive = false;
  entry.clientDetached = true;
  entry.remoteDetached = false;
  try {
    pty.kill();
  } catch (err) {
    // The attachment may already have exited; reconnect still re-resolves the
    // durable tmux session from the runtime. Surface the failure anyway — an
    // unkilled attachment is a leaked SSH process.
    pushTimelineEvent(entry, 'detach_kill_failed', err.message);
    console.warn(`[terminal] detach_kill_failed error=${err.message}`);
  }
}

function observeSessionInput(ops, sessionId, data) {
  if (!ops.onInput) return;
  queueMicrotask(() => {
    try { ops.onInput(sessionId, data); }
    catch { console.warn('[session-naming] input observation failed'); }
  });
}

function removeWorkflowObserver(entry, fn) {
  if (!fn || !entry.workflowObservers) return;
  const index = entry.workflowObservers.indexOf(fn);
  if (index !== -1) entry.workflowObservers.splice(index, 1);
}

/**
 * Lazily create the session's loop engine. Browser sockets and background
 * attaches share one engine so a later viewer receives the same workflow_state.
 */
function ensureSessionWorkflow(entry, ops) {
  if (entry.workflow) return entry.workflow;
  entry.workflowObservers ??= [];
  const workflow = createTerminalWorkflow({
    write: data => {
      if (!entry.alive || !ops.sessionExists()) throw new Error('Workflow terminal attachment is unavailable.');
      entry.pty.write(data);
      observeSessionInput(ops, ops.sessionId, data);
    },
    notify: state => {
      broadcast(entry, { type: 'workflow_state', requestId: null, state });
      for (const observer of entry.workflowObservers) {
        try { observer(state); }
        catch (err) { console.warn(`[workflow] observer failed error=${err.message}`); }
      }
      // Release our background attachment when the loop ends. Defer until
      // any PTY exit handler has finished updating the session lifecycle.
      if (!state.active) Promise.resolve().then(() => {
        if (!entry.wsAttached) detachTmuxClient(entry);
      });
    },
  });
  entry.workflow = workflow;
  return workflow;
}

function buildBackgroundHandle(entry, sessionId, sessions, deletedSessionIds, ops) {
  const workflow = ensureSessionWorkflow(entry, ops);
  entry.backgroundHolds = (entry.backgroundHolds ?? 0) + 1;
  let observer = null;
  let released = false;
  return {
    entry,
    workflow,
    write(data) {
      if (!entry.alive || sessions.get(sessionId) !== entry || deletedSessionIds.has(sessionId)) {
        throw new Error('Workflow terminal attachment is unavailable.');
      }
      entry.pty.write(data);
      observeSessionInput(ops, sessionId, data);
    },
    observe(fn) {
      if (typeof fn !== 'function') throw new Error('Workflow observe requires a function.');
      removeWorkflowObserver(entry, observer);
      observer = fn;
      entry.workflowObservers.push(fn);
    },
    release() {
      if (released) return;
      released = true;
      removeWorkflowObserver(entry, observer);
      observer = null;
      entry.backgroundHolds = Math.max(0, (entry.backgroundHolds ?? 1) - 1);
      if (!entry.wsAttached) detachTmuxClient(entry);
    },
  };
}

/**
 * Attach to a durable tmux session without a browser socket so a pipeline run
 * can drive the PTY. Mirrors the browser attach cases: no entry, live entry,
 * dead recoverable entry. Tombstoned ids are rejected.
 */
export function attachBackgroundSession(sessionId, sessions, runtime, deletedSessionIds = new Set(), options = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 256 || /[\x00-\x1f\x7f]/.test(sessionId)) {
    throw new Error('Background attach sessionId must be a valid terminal identity.');
  }
  if (deletedSessionIds.has(sessionId)) throw new Error('Background attach refused: session is deleted.');
  if (!runtime || typeof runtime.spawn !== 'function') throw new Error('Background attach requires a terminal runtime.');

  const cols = options.cols === undefined ? INITIAL_COLS : options.cols;
  const rows = options.rows === undefined ? INITIAL_ROWS : options.rows;
  if (!validDimensions(cols, rows)) throw new Error('Background attach cols and rows must be valid terminal dimensions.');
  const cwd = options.cwd === undefined ? (process.env.HOME || '/') : options.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0 || !path.isAbsolute(cwd) || cwd.includes('\0')) {
    throw new Error('Background attach cwd must be a nonempty absolute path.');
  }

  let entry = sessions.get(sessionId);
  const workflowOpsFor = (target) => ({
    sessionId,
    onInput: options.onInput,
    sessionExists: () => sessions.get(sessionId) === target && !deletedSessionIds.has(sessionId),
  });
  const recoverableWithoutEntry = !entry
    && runtime.type === 'tmux'
    && typeof runtime.isSessionRecoverable === 'function'
    && runtime.isSessionRecoverable(sessionId);
  const recoverableDeadEntry = !!entry
    && entry.runtimeType === 'tmux'
    && !entry.alive
    && typeof runtime.isSessionRecoverable === 'function'
    && runtime.isSessionRecoverable(sessionId);

  if (!entry) {
    if (!recoverableWithoutEntry) throw new Error('Background attach refused: session does not exist or is not recoverable.');
    const incarnation = typeof runtime.getSessionIncarnation === 'function'
      ? runtime.getSessionIncarnation(sessionId)
      : (options.getSessionIncarnation?.(sessionId) ?? null);
    const ptyProcess = runtime.spawn({ cwd, cols, rows, sessionId });
    entry = createSessionEntry({
      pty: ptyProcess, ws: null, cwd, cols, rows, incarnation, runtimeType: runtime.type,
      extra: { onSessionEnded: options.onSessionEnded, wsAttached: false },
    });
    sessions.set(sessionId, entry);
    registerPtyDataHandler(ptyProcess, sessionId, sessions);
    registerPtyExitHandler(ptyProcess, sessionId, sessions, runtime, cols, rows);
    pushTimelineEvent(entry, 'attach', 'background');
    console.log(`[terminal] attach session=${sessionId} type=background`);
    return buildBackgroundHandle(entry, sessionId, sessions, deletedSessionIds, workflowOpsFor(entry));
  }

  if (entry.alive) {
    return buildBackgroundHandle(entry, sessionId, sessions, deletedSessionIds, workflowOpsFor(entry));
  }

  if (!recoverableDeadEntry) throw new Error('Background attach refused: session ended.');

  const ptyProcess = runtime.spawn({ cwd: entry.cwd, cols, rows, sessionId });
  entry.pty = ptyProcess;
  registerPtyDataHandler(ptyProcess, sessionId, sessions);
  registerPtyExitHandler(ptyProcess, sessionId, sessions, runtime, cols, rows);
  entry.alive = true;
  entry.clientDetached = false;
  pushTimelineEvent(entry, 'tmux_reattach', 'background recovery');
  console.log(`[terminal] tmux_reattach session=${sessionId} type=background_recovery`);
  return buildBackgroundHandle(entry, sessionId, sessions, deletedSessionIds, workflowOpsFor(entry));
}

/**
 * Compute a health label for a session based on its diagnostic state.
 * Returns one of: 'healthy', 'detached', 'stalled', 'dead'
 * ('reconnecting' and 'replaying' are client-side transient states added in later phases)
 */
export function computeSessionHealth(entry) {
  // An SSH-dropped remote session is suspended — its tmux session is presumed
  // alive on the host, so reporting 'dead' would be a lie (Spec §8.2).
  if (!entry.alive) return entry.remoteDetached || entry.clientDetached ? 'detached' : 'dead';
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

    if (intentionallyDetachedPtys.delete(ptyProcess)) {
      pushTimelineEvent(s, 'pty_detached', 'browser socket closed; durable tmux session preserved');
      return;
    }
    if (s.pty !== ptyProcess) return;
    s.workflow?.stop();

    // In tmux mode, check if the underlying session survived
    if (reattachCount < MAX_TMUX_REATTACH && runtime.isSessionRecoverable(sessionId)) {
      pushTimelineEvent(s, 'tmux_client_exited', `tmux session still alive — re-attaching (attempt ${reattachCount + 1}/${MAX_TMUX_REATTACH})`);
      console.log(`[terminal] tmux_client_exited session=${sessionId} — re-attaching (${reattachCount + 1}/${MAX_TMUX_REATTACH})`);
      try {
        const newPty = runtime.spawn({ cwd: s.cwd, cols, rows, sessionId });
        s.pty = newPty;
        s.alive = true;
        s.clientDetached = false;
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
    s.clientDetached = false;
    s.wsAttached = false;
    s.onSessionEnded?.(sessionId);
    pushTimelineEvent(s, 'pty_exited');
    console.log(`[terminal] pty_exited session=${sessionId}`);
    for (const attachment of s.attachments?.values() ?? []) attachment.ws.close();
  });
}

export function handleWsConnection(ws, req, sessions, runtime, deletedSessionIds = new Set(), reservedSessionIds = new Set(), options = {}) {
  if (options.onDesktopActivity !== undefined && typeof options.onDesktopActivity !== 'function') throw new Error('onDesktopActivity must be a function.');
  try {
    return attachSessionSocket(ws, req, sessions, runtime, deletedSessionIds, reservedSessionIds, options);
  } catch {
    // Snapshot/identity failures affect this attachment, never the shared PTY or
    // another viewer. Do not expose provider errors or terminal content.
    for (const entry of sessions.values()) if (entry.attachments?.has(ws)) removeAttachment(entry, ws);
    sendSpawnError(ws, {reason:'attachment_failed',message:'Terminal attachment failed. Reconnect to retry.'});
    safeCloseSocket(ws, {code:4008,reason:'attachment_failed_reconnect'});
  }
}

function attachSessionSocket(ws, req, sessions, runtime, deletedSessionIds, reservedSessionIds, options) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  if (params.get('protocol') !== String(TERMINAL_PROTOCOL_VERSION)) {
    ws.send(JSON.stringify({type:'protocol_error', message:'Reload or update CodeDeck: terminal protocol 2 is required.', supportedProtocol:2}));
    ws.close(4006, 'protocol_update_required');
    return;
  }
  const queryFields = ['protocol','sessionId','cwd','cols','rows','incarnation','companion'];
  if ([...params.keys()].some(key => !queryFields.includes(key) || params.getAll(key).length !== 1 || params.get(key) === '')
    || (params.has('companion') && params.get('companion') !== '1')) {
    ws.send(JSON.stringify({type:'protocol_error',message:'Attachment query contains an invalid, empty, or duplicate field.'}));
    ws.close(4006, 'invalid_attachment'); return;
  }
  const cwd = params.get('cwd') ?? process.env.HOME;
  const sessionId = params.get('sessionId') ?? `s-${Date.now()}`;
  const cols = Number(params.get('cols') ?? '120');
  const rows = Number(params.get('rows') ?? '30');
  // Desktop session identities contain the project name, including spaces and
  // Unicode. Match the durable runtime's identity contract without rewriting IDs.
  if (!validDimensions(cols, rows) || !sessionId.trim() || sessionId.length > 256 || /[\x00-\x1f\x7f]/.test(sessionId) || typeof cwd !== 'string' || cwd.length === 0 || cwd.includes('\0')) {
    ws.send(JSON.stringify({type:'protocol_error', message:'sessionId, cwd, cols and rows must be valid.'})); ws.close(4006, 'invalid_attachment'); return;
  }
  let incarnation = options.getSessionIncarnation?.(sessionId, {create: !params.has('incarnation')}) ?? null;
  const requiresExisting = params.has('incarnation') || params.get('companion') === '1';
  const expectedIncarnation = params.get('incarnation');
  if (params.get('companion') === '1' && !params.has('incarnation')) {
    ws.send(JSON.stringify({type:'protocol_error', message:'This session incarnation is no longer available.'})); ws.close(4002, 'session_incarnation_changed'); return;
  }

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
        incarnation, expectedIncarnation, requiresExisting, isCompanion: params.get('companion') === '1',
        host: hostResolution.host,
        hostRuntime: hostResolution.hostRuntime,
      }, sessions, deletedSessionIds, options).catch((err) => {
        const entry = sessions.get(sessionId);
        if (entry) removeAttachment(entry, ws);
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
  if (typeof runtime.getSessionIncarnation === 'function' && (entry?.alive || recoverableTmuxWithoutEntry || recoverableTmuxDeadEntry)) {
    incarnation = runtime.getSessionIncarnation(sessionId);
  }
  if (!validateIncarnation(ws, sessionId, incarnation, expectedIncarnation, options)) return;
  if (requiresExisting && !(entry?.alive || recoverableTmuxWithoutEntry || recoverableTmuxDeadEntry)) {
    ws.send(JSON.stringify({type:'protocol_error',message:'This terminal session has ended.'}));
    ws.close(4002, 'session_ended'); return;
  }
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
      if (typeof runtime.getSessionIncarnation === 'function') {
        incarnation = runtime.getSessionIncarnation(sessionId);
        if (!validateIncarnation(ws, sessionId, incarnation, expectedIncarnation, options)) { ptyProcess.kill(); return; }
      }
    } catch (err) {
      if (ptyProcess) ptyProcess.kill();
      const message = 'Failed to start terminal or verify its durable identity.';
      ws.send(JSON.stringify({
        type: 'spawn_error',
        reason: 'spawn_failed',
        message,
        data: `\r\n${message}\r\n`,
      }));
      ws.close();
      return;
    }

    entry = createSessionEntry({ pty: ptyProcess, ws, cwd, cols, rows, incarnation, runtimeType: runtime.type, extra: {onSessionEnded: options.onSessionEnded} });

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
      attachState = beginBufferedAttach(entry, snapshotSeq, ws);
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
    ensureAttachment(entry, ws);
    entry.ws = ws;
    entry.incarnationId = incarnation;
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
        entry.clientDetached = false;
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


  }

  registerSessionSocketHandlers(ws, entry, sessionId, {
    onInput: options.onInput,
    onDesktopActivity: options.onDesktopActivity,
    isCompanion: params.get('companion') === '1',
    sessionExists: () => sessions.get(sessionId) === entry && !deletedSessionIds.has(sessionId),
    resizeRuntime: (cols, rows) => {
      if (entry.runtimeType === 'tmux' && typeof runtime.resizeSession === 'function') {
        return runtime.resizeSession(sessionId, cols, rows);
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
  const attachment = ensureAttachment(entry, ws);
  attachment.isCompanion = ops.isCompanion;
  const observeInput = (data) => observeSessionInput(ops, sessionId, data);
  const sendWorkflowState = (state, requestId = null) => {
    if (ws.readyState === 1 && entry.attachments.has(ws)) ws.send(JSON.stringify({ type: 'workflow_state', requestId, state }));
  };
  const workflow = ensureSessionWorkflow(entry, { ...ops, sessionId });
  const controlFailure = () => {
    entry.controlOutput = null;
    if (ws.readyState === 1) ws.send(JSON.stringify({type:'control_error', message:'Terminal control resize failed; reconnect and try again.'}));
  };
  const resizeAndPublish = (parsed, claim) => {
    // Snapshot data must reach its viewer before any new canonical grid. Capture
    // these holds now: later snapshots wait this operation, avoiding a cycle.
    const hydrationHolds = [...entry.attachments.values()].map(value => value.attachState?.geometryReady).filter(Boolean);
    const operation = () => {
      if (!entry.attachments.has(ws) || ws.readyState !== 1 || !ops.sessionExists()) return;
      if (!claim && (entry.controllerId !== attachment.id || parsed.controlRevision !== entry.controlRevision)) {
        entry.controlConflicts++;
        ws.send(JSON.stringify({...controlState(entry),type:'control_error',message:'Control changed before resize.'}));
        return;
      }
      entry.controlOutput = []; entry.controlOutputBytes = 0;
      const finish = () => {
        entry.pty.resize(parsed.cols, parsed.rows);
        entry.cols = parsed.cols; entry.rows = parsed.rows;
        if (claim && entry.attachments.has(ws) && ws.readyState === 1) {
          entry.controllerId = attachment.id; entry.controlRevision++;
        }
        broadcast(entry, controlState(entry, claim ? parsed.requestId : null));
        const buffered = entry.controlOutput ?? [];
        entry.controlOutput = null;
        for (const chunk of buffered) deliverOutput(entry, chunk);
      };
      const resized = ops.resizeRuntime(parsed.cols, parsed.rows);
      if (resized?.then) return resized.then(finish);
      finish();
    };
    const afterHydration = () => hydrationHolds.length ? Promise.all(hydrationHolds).then(operation) : operation();
    if (entry.controlPending) entry.controlPending = entry.controlPending.then(afterHydration).catch(controlFailure);
    else {
      const pending = afterHydration();
      if (pending?.then) entry.controlPending = pending.catch(controlFailure);
    }
    const pending = entry.controlPending;
    if (pending) pending.finally(() => { if (entry.controlPending === pending) entry.controlPending = null; });
  };
  // Browser -> PTY
  ws.on('message', (msg) => {
    if (!entry.attachments.has(ws) || !ops.sessionExists()) return;

    try {
      if (Buffer.byteLength(msg) > 131072) throw new Error('Terminal message exceeds maximum size.');
      const parsed = JSON.parse(msg.toString());
      validateMessage(parsed);
      if (parsed.type === 'user_activity') {
        if (!attachment.isCompanion) ops.onDesktopActivity?.();
        return;
      }
      if (parsed.type === 'claim_control') {
        if (!attachment.ready || !entry.alive) throw new Error('Attachment snapshot or terminal is not ready.');
        try { resizeAndPublish(parsed, true); } catch { controlFailure(); }
        return;
      }
      if (['input','resize','workflow_start','workflow_stop'].includes(parsed.type)
        && (entry.controlPending || entry.controllerId !== attachment.id || parsed.controlRevision !== entry.controlRevision)) {
        entry.controlConflicts++;
        ws.send(JSON.stringify({...controlState(entry), type:'control_error', message:'Control changed. Interact again to take control.'}));
        return;
      }
      if (typeof parsed?.type === 'string' && parsed.type.startsWith('workflow_')) {
        try {
          if (typeof parsed.requestId !== 'string' || !/^[\w-]{1,128}$/.test(parsed.requestId)) throw new Error('Workflow requestId must contain 1–128 letters, digits, underscores or hyphens.');
          const { type, controlRevision, ...request } = parsed;
          if (type === 'workflow_start') workflow.start(request);
          else if (type === 'workflow_stop') {
            if (Object.keys(request).some(key => key !== 'requestId')) throw new Error('Workflow stop contains an unknown field.');
            workflow.stop();
          } else throw new Error('Unknown workflow control type.');
          sendWorkflowState(workflow.snapshot(), parsed.requestId);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'workflow_error', requestId: typeof parsed.requestId === 'string' && /^[\w-]{1,128}$/.test(parsed.requestId) ? parsed.requestId : null, message: err.message }));
        }
      } else if (parsed.type === 'input') {
        if (workflow.snapshot().status === 'resetting') return;
        entry.pty.write(parsed.data);
        observeInput(parsed.data);
        workflow.input(parsed.data);
      } else if (parsed.type === 'resize') {
        try { resizeAndPublish(parsed, false); } catch { controlFailure(); }
      } else if (parsed.type === 'heartbeat') {
        attachment.lastClientAckAt = new Date().toISOString();
        // Store client-reported diagnostics from heartbeat
        if (parsed.documentVisibility) entry.documentVisibility = parsed.documentVisibility;
        if (parsed.lastMessageAt) entry.clientLastMessageAt = parsed.lastMessageAt;
        if (parsed.lastPaintAt) entry.clientLastPaintAt = parsed.lastPaintAt;
        if (parsed.lastResizeAt) entry.clientLastResizeAt = parsed.lastResizeAt;
        if (typeof parsed.lastSeenSeq === 'number') entry.clientLastSeenSeq = parsed.lastSeenSeq;
        if (typeof parsed.reconnectCount === 'number') entry.clientReconnectCount = parsed.reconnectCount;
        Object.assign(attachment, {documentVisibility:parsed.documentVisibility, clientLastMessageAt:parsed.lastMessageAt,clientLastPaintAt:parsed.lastPaintAt,clientLastResizeAt:parsed.lastResizeAt,clientLastSeenSeq:parsed.lastSeenSeq,clientReconnectCount:parsed.reconnectCount});
        entry.lastClientAckAt = attachment.lastClientAckAt;
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
        const attachState = beginBufferedAttach(entry, snapshotSeq, ws);
        const finishRehydrate = (hydration) => {
          if (!entry.attachments.has(ws) || attachment.attachState !== attachState) return;
          const snapshotHydration = alignSnapshotBoundaryWithBufferedOutput(hydration, attachState);
          applySnapshotHistoryState(entry, snapshotHydration.historyState);

          if (ws.readyState === 1) {
            ws.send(JSON.stringify(snapshotHydration.snapshotMessage));
            if (snapshotHydration.historyWarningEvent) {
              ws.send(JSON.stringify(snapshotHydration.historyWarningEvent));
            }
          }

          flushBufferedAttachOutput(entry, ws);
          entry.lastClientAckAt = new Date().toISOString();
          pushTimelineEvent(entry, 'rehydrate_served', `snapshot seq ${snapshotSeq}`);
          console.log(`[terminal] rehydrate session=${sessionId} snapshotSeq=${snapshotSeq}`);
        };

        // Local hydration resolves synchronously (send ordering preserved);
        // remote hydration arrives from the host runner asynchronously.
        const failHydration = (err) => {
          attachment.attachState?.releaseGeometry?.();
          attachment.attachState = null;
          ws.close(4008, 'snapshot_failed_reconnect');
          removeAttachment(entry, ws);
          pushTimelineEvent(entry, 'rehydrate_failed', 'snapshot capture failed');
          console.warn(`[terminal] rehydrate_failed session=${sessionId}`);
        };
        try {
          const hydration = ops.resolveHydration(sessionId, snapshotSeq);
          if (hydration && typeof hydration.then === 'function') hydration.then(finishRehydrate).catch(failHydration);
          else finishRehydrate(hydration);
        } catch (err) { failHydration(err); }
      } else if (parsed.type === 'recovery_action') {
        const action = parsed.action || 'unknown';
        pushTimelineEvent(entry, `recovery_${action}`, `user-initiated ${action}`);
        console.log(`[terminal] recovery action=${action} session=${sessionId}`);
      } else if (parsed.type === 'visibility_change') {
        attachment.documentVisibility = parsed.state;
        entry.documentVisibility = parsed.state;
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
    } catch (err) {
      if (ws.readyState === 1) ws.send(JSON.stringify({type:'protocol_error', message: err instanceof SyntaxError ? 'Terminal message must be valid JSON.' : err.message}));
    }
  });

  ws.on('close', () => {
    removeAttachment(entry, ws);
    pushTimelineEvent(entry, 'detach');
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

    if (intentionallyDetachedPtys.delete(ptyProcess)) {
      pushTimelineEvent(s, 'pty_detached', 'browser socket closed; durable remote tmux session preserved');
      return;
    }
    if (s.pty !== ptyProcess) return;
    s.workflow?.stop();

    const markRemoteDetached = (err) => {
      s.alive = false;
      s.clientDetached = false;
      s.wsAttached = s.wsAttached ?? false;
      s.remoteDetached = true;
      pushTimelineEvent(s, 'remote_ssh_drop', err?.message || 'ssh connection dropped');
      console.log(`[terminal] remote_ssh_drop session=${sessionId} host=${s.host} error=${err?.message}`);
      // Do NOT close the browser socket — the session is suspended, not dead.
    };

    const markDead = () => {
      s.alive = false;
      s.clientDetached = false;
      s.wsAttached = false;
      s.onSessionEnded?.(sessionId);
    pushTimelineEvent(s, 'pty_exited');
      console.log(`[terminal] pty_exited session=${sessionId} host=${s.host}`);
      for (const attachment of s.attachments?.values() ?? []) attachment.ws.close();
    };

    // The recoverability probe and respawn are async: a browser close (or a
    // reconnect that swapped the PTY) can land mid-flight, and respawning
    // after it would attach an SSH client nobody is connected to — exactly
    // the orphan this handler exists to prevent.
    const detachedDuringRecovery = () => s.clientDetached || s.pty !== ptyProcess;

    hostRuntime.isSessionRecoverableAsync(sessionId)
      .then(async (recoverable) => {
        if (detachedDuringRecovery()) {
          pushTimelineEvent(s, 'pty_detached', 'browser detached during exit probe; durable remote tmux session preserved');
          return;
        }
        if (recoverable && reattachCount < MAX_TMUX_REATTACH) {
          pushTimelineEvent(s, 'tmux_client_exited', `remote tmux session still alive — re-attaching (attempt ${reattachCount + 1}/${MAX_TMUX_REATTACH})`);
          try {
            const newPty = await hostRuntime.spawnAsync({ cwd: s.cwd, cols, rows, sessionId });
            if (detachedDuringRecovery()) {
              pushTimelineEvent(s, 'pty_detached', 'browser detached during re-attach; released fresh attachment');
              try {
                newPty.kill();
              } catch (killErr) {
                console.warn(`[terminal] reattach_release_failed session=${sessionId} error=${killErr.message}`);
              }
              return;
            }
            s.pty = newPty;
            s.alive = true;
            s.clientDetached = false;
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
      cols: entry.cols ?? cols,
      rows: entry.rows ?? rows,
      sessionId,
    });

    entry.pty = ptyProcess;
    entry.hostRuntime = hostRuntime;
    entry.alive = true;
    entry.clientDetached = false;
    entry.remoteDetached = false;
    entry.wsAttached = true;
    entry.lastAttachAt = new Date().toISOString();
    registerPtyDataHandler(ptyProcess, sessionId, sessions);
    registerRemotePtyExitHandler(ptyProcess, sessionId, sessions, hostRuntime, cols, rows);

    if (!entry.attachments) ensureAttachment(entry, entry.ws);
    const snapshotSeq = entry.lastSeq ?? 0;
    for (const attachment of entry.attachments.values()) beginBufferedAttach(entry, snapshotSeq, attachment.ws);
    const snapshot = await hostRuntime.captureSessionSnapshotAsync(sessionId, TERMINAL_SNAPSHOT_WINDOW_LINES);
    for (const attachment of entry.attachments.values()) {
      const snapshotHydration = alignSnapshotBoundaryWithBufferedOutput(buildSnapshotHydration(snapshot, 'tmux', sessionId, snapshotSeq), attachment.attachState);
      applySnapshotHistoryState(entry, snapshotHydration.historyState);
      completeAttach(attachment.ws, entry, sessionId, true, {
        snapshotMessage: snapshotHydration.snapshotMessage,
        historyWarningEvent: snapshotHydration.historyWarningEvent,
        attachState: attachment.attachState,
      });
    }
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
async function handleRemoteWsConnection(ws, { sessionId, cwd, cols, rows, incarnation, expectedIncarnation, requiresExisting, isCompanion, host, hostRuntime }, sessions, deletedSessionIds = new Set(), options = {}) {
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

  if (typeof hostRuntime.getSessionIncarnationAsync === 'function' && (entry?.alive || recoverable)) {
    incarnation = await hostRuntime.getSessionIncarnationAsync(sessionId);
  }
  if (!validateIncarnation(ws, sessionId, incarnation, expectedIncarnation, options)) return;
  if (requiresExisting && !(entry?.alive || recoverable)) {
    ws.send(JSON.stringify({type:'protocol_error',message:'This terminal session has ended.'}));
    ws.close(4002, 'session_ended'); return;
  }
  const recoverableWithoutEntry = !entry && recoverable;
  let recoverableDeadEntry = !!entry && !entry.alive && recoverable;
  const isExisting = !!entry || recoverableWithoutEntry;
  let snapshotMessage = null;
  let historyWarningEvent = null;
  let snapshotHistoryState = null;
  let attachState = null;

  async function resolveRemoteHydration(snapshotSeq) {
    const pendingControl = entry?.controlPending;
    if (pendingControl) await pendingControl;
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
      if (typeof hostRuntime.getSessionIncarnationAsync === 'function') {
        incarnation = await hostRuntime.getSessionIncarnationAsync(sessionId);
        if (!validateIncarnation(ws, sessionId, incarnation, expectedIncarnation, options)) { ptyProcess.kill(); return; }
      }
    } catch (err) {
      if (ptyProcess) ptyProcess.kill();
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
      cols, rows, incarnation,
      runtimeType: 'tmux',
      extra: { host, hostRuntime, onSessionEnded: options.onSessionEnded },
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
      attachState = beginBufferedAttach(entry, snapshotSeq, ws);
      const snapshotHydration = alignSnapshotBoundaryWithBufferedOutput(
        await resolveRemoteHydration(snapshotSeq),
        attachState,
      );
      snapshotMessage = snapshotHydration.snapshotMessage;
      historyWarningEvent = snapshotHydration.historyWarningEvent;
      snapshotHistoryState = snapshotHydration.historyState;

      // The prior browser can close while the SSH snapshot is in flight. Its
      // close handler deliberately releases the attachment PTY, so re-check
      // after hydration instead of binding this socket to the now-dead PTY.
      if (!entry.alive) {
        recoverableDeadEntry = await hostRuntime.isSessionRecoverableAsync(sessionId);
        if (recoverableDeadEntry) {
          attachState = beginBootstrapDropAttach(entry, entry.lastSeq ?? 0);
        } else {
          // The durable session itself is gone. Completing the attach would
          // hand the browser a normal handshake wired to a dead PTY — a
          // silently frozen pane. Mark the entry dead and fail the attach so
          // the caller sends a spawn_error and closes the socket.
          entry.clientDetached = false;
          entry.remoteDetached = false;
          entry.wsAttached = false;
          entry.attachState = null;
          pushTimelineEvent(entry, 'pty_exited', 'durable session ended during attach');
          throw new Error(`session "${sessionId}" ended while attaching`);
        }
      }
    } else if (recoverableDeadEntry) {
      attachState = beginBootstrapDropAttach(entry, entry.lastSeq ?? 0);
    }

    ensureAttachment(entry, ws);
    entry.ws = ws;
    entry.incarnationId = incarnation;
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
        entry.clientDetached = false;
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

  }

  registerSessionSocketHandlers(ws, entry, sessionId, {
    onInput: options.onInput,
    onDesktopActivity: options.onDesktopActivity,
    isCompanion,
    sessionExists: () => sessions.get(sessionId) === entry && !deletedSessionIds.has(sessionId),
    resizeRuntime: (resizeCols, resizeRows) => {
      // Best-effort remote resize; errors are swallowed inside the runtime.
      return hostRuntime.resizeSessionAsync(sessionId, resizeCols, resizeRows);
    },
    resolveHydration: (id, seq) => resolveRemoteHydration(seq),
  });

  completeAttach(ws, entry, sessionId, isExisting, { snapshotMessage, historyWarningEvent, attachState });

  // The socket may have closed while we awaited SSH round-trips — its 'close'
  // event fired before our handler was registered, so record the detach here
  // or the entry would look attached forever and never be GC'd.
  if (ws.readyState !== 1) {
    removeAttachment(entry, ws);
    pushTimelineEvent(entry, 'detach', 'socket closed during attach');
  }
}
