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

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const MAX_TIMELINE_EVENTS = 50;
export const REPLAY_BUFFER_SIZE = 1000;
const MAX_TMUX_REATTACH = 3;

function extractLastLine(rawData) {
  const stripped = rawData.replace(ANSI_RE, '').replace(/\r/g, '').trim();
  if (!stripped) return null;
  const lines = stripped.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return null;
  return lines[lines.length - 1].slice(0, 200);
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

/**
 * Register a PTY onData handler that routes output to the session's replay buffer
 * and current WebSocket. Extracted to avoid duplicating this across initial spawn,
 * tmux re-attach on exit, and tmux reconnect recovery.
 */
function registerPtyDataHandler(ptyProcess, sessionId, sessions) {
  ptyProcess.onData((data) => {
    const s = sessions.get(sessionId);
    if (s) {
      s.lastOutputAt = new Date().toISOString();
      s.lastSeq += 1;
      const seq = s.lastSeq;
      const line = extractLastLine(data);
      if (line) s.lastOutputLine = line;
      s.replayBuffer.push({ seq, data });
      if (s.replayBuffer.length > REPLAY_BUFFER_SIZE) {
        s.replayBuffer = s.replayBuffer.slice(-REPLAY_BUFFER_SIZE);
      }
      if (s.ws && s.ws.readyState === 1) {
        s.ws.send(JSON.stringify({ type: 'output', seq, data }));
      }
    }
  });
}

/**
 * Compute a health label for a session based on its diagnostic state.
 * Returns one of: 'healthy', 'detached', 'stalled', 'dead'
 * ('reconnecting' and 'replaying' are client-side transient states added in later phases)
 */
export function computeSessionHealth(entry) {
  if (!entry.alive) return 'dead';
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

export function handleWsConnection(ws, req, sessions, runtime) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const cwd = params.get('cwd') || process.env.HOME;
  const sessionId = params.get('sessionId') || `s-${Date.now()}`;
  const cols = parseInt(params.get('cols') || '120');
  const rows = parseInt(params.get('rows') || '30');

  let entry = sessions.get(sessionId);
  const isExisting = !!entry;

  if (!entry) {
    // New session — spawn PTY and register listeners ONCE
    let ptyProcess;
    try {
      ptyProcess = runtime.spawn({ cwd, cols, rows, sessionId });
    } catch (err) {
      ws.send(JSON.stringify({ type: 'spawn_error', data: `\r\nFailed to start terminal: ${err.message}\r\n` }));
      ws.close();
      return;
    }

    const now = new Date().toISOString();
    entry = {
      pty: ptyProcess,
      ws,
      cwd,
      startedAt: now,
      lastOutputAt: now,
      lastOutputLine: '',
      alive: true,
      // Runtime type (Phase 5 — durable sessions)
      runtimeType: runtime.type,
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
    };
    sessions.set(sessionId, entry);

    pushTimelineEvent(entry, 'attach', `initial connection`);
    console.log(`[terminal] attach session=${sessionId} cwd=${cwd} type=initial`);

    // PTY -> Browser: registered ONCE, reads entry.ws for current WebSocket
    registerPtyDataHandler(ptyProcess, sessionId, sessions);

    // PTY exit: registered ONCE, reads entry.ws for current WebSocket
    // In tmux mode, PTY exit may just mean the tmux client detached —
    // if the tmux session is still alive, re-attach automatically.
    registerPtyExitHandler(ptyProcess, sessionId, sessions, runtime, cols, rows);
  } else {
    // Existing session — update the active WebSocket reference
    entry.ws = ws;
    entry.wsAttached = true;
    entry.lastAttachAt = new Date().toISOString();
    pushTimelineEvent(entry, 'attach', 'reconnect');
    console.log(`[terminal] attach session=${sessionId} type=reconnect`);

    // In tmux mode, the old PTY wrapper may have died while the tmux session
    // is still alive. Re-spawn the attachment if needed.
    if (entry.runtimeType === 'tmux' && !entry.alive && runtime.isSessionRecoverable(sessionId)) {
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
    }

    // Resize to match the new client's dimensions
    try { entry.pty.resize(cols, rows); } catch {}
    // Send Ctrl+L to clear screen and redraw prompt in the new xterm instance
    if (entry.alive) entry.pty.write('\x0c');
  }

  // Browser -> PTY
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'input') {
        entry.pty.write(parsed.data);
      } else if (parsed.type === 'resize') {
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
        // Find chunks in replay buffer after lastSeenSeq
        const chunks = entry.replayBuffer.filter(c => c.seq > lastSeenSeq);
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
      } else if (parsed.type === 'recovery_action') {
        const action = parsed.action || 'unknown';
        pushTimelineEvent(entry, `recovery_${action}`, `user-initiated ${action}`);
        console.log(`[terminal] recovery action=${action} session=${sessionId}`);
      } else if (parsed.type === 'visibility_change') {
        const prevVisibility = entry.documentVisibility;
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
    // Keep PTY alive for reconnection — only kill on explicit DELETE
    entry.wsAttached = false;
    entry.lastDetachAt = new Date().toISOString();
    pushTimelineEvent(entry, 'detach');
    console.log(`[terminal] detach session=${sessionId}`);
  });

  // Send session info — flag existing sessions so client can trigger prompt redraw
  ws.send(JSON.stringify({ type: 'session', sessionId, existing: isExisting }));
}
