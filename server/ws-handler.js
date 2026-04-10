/**
 * WebSocket connection handler for terminal PTY sessions.
 *
 * Extracted from index.js to enable unit testing of listener management.
 * Key design: onData and onExit listeners are registered ONCE per PTY (when created).
 * They read the current WebSocket from entry.ws, avoiding closure-captured stale references.
 *
 * @param {WebSocket} ws - The incoming WebSocket connection
 * @param {http.IncomingMessage} req - The HTTP upgrade request
 * @param {Map} sessions - The sessions Map: sessionId -> { pty, ws, cwd, startedAt, lastOutputAt, lastOutputLine, alive }
 * @param {Function} spawnPty - Factory function: ({ cwd, cols, rows }) => ptyProcess
 */

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function extractLastLine(rawData) {
  const stripped = rawData.replace(ANSI_RE, '').replace(/\r/g, '').trim();
  if (!stripped) return null;
  const lines = stripped.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return null;
  return lines[lines.length - 1].slice(0, 200);
}

export function handleWsConnection(ws, req, sessions, spawnPty) {
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
      ptyProcess = spawnPty({ cwd, cols, rows });
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
    };
    sessions.set(sessionId, entry);

    // PTY -> Browser: registered ONCE, reads entry.ws for current WebSocket
    ptyProcess.onData((data) => {
      const s = sessions.get(sessionId);
      if (s) {
        s.lastOutputAt = new Date().toISOString();
        const line = extractLastLine(data);
        if (line) s.lastOutputLine = line;
        if (s.ws && s.ws.readyState === 1) { // WebSocket.OPEN = 1
          s.ws.send(JSON.stringify({ type: 'output', data }));
        }
      }
    });

    // PTY exit: registered ONCE, reads entry.ws for current WebSocket
    ptyProcess.onExit(() => {
      const s = sessions.get(sessionId);
      if (s) {
        s.alive = false;
        if (s.ws) s.ws.close();
      }
    });
  } else {
    // Existing session — update the active WebSocket reference
    entry.ws = ws;
    // Resize to match the new client's dimensions
    try { entry.pty.resize(cols, rows); } catch {}
    // Send Ctrl+L to clear screen and redraw prompt in the new xterm instance
    entry.pty.write('\x0c');
  }

  // Browser -> PTY
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'input') {
        entry.pty.write(parsed.data);
      } else if (parsed.type === 'resize') {
        entry.pty.resize(parsed.cols, parsed.rows);
      }
    } catch {
      // Raw string input fallback
      entry.pty.write(msg.toString());
    }
  });

  ws.on('close', () => {
    // Keep PTY alive for reconnection — only kill on explicit DELETE
  });

  // Send session info — flag existing sessions so client can trigger prompt redraw
  ws.send(JSON.stringify({ type: 'session', sessionId, existing: isExisting }));
}
