/**
 * Terminal runtime abstraction.
 *
 * CodeDeck now requires tmux for all real terminal sessions. This file keeps a
 * legacy raw-PTY helper for tests/reference, but the exported factory always
 * returns the tmux runtime contract consumed by `ws-handler.js`.
 */

import { spawn } from 'node-pty';
import { execFileSync } from 'child_process';
import { buildShellEnv } from './shell-env.js';

export const TERMINAL_SNAPSHOT_WINDOW_LINES = 10000;
const TMUX_HISTORY_LIMIT = TERMINAL_SNAPSHOT_WINDOW_LINES;
export const TERMINAL_RUNTIME_CONTRACT = 'tmux_required';
export const TERMINAL_RUNTIME_BLOCKED_REASON = 'missing_tmux';
export const TERMINAL_RUNTIME_BLOCKED_MESSAGE = 'Install tmux to enable durable CodeDeck terminals.';
export const TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE = 'snapshot_unavailable';
export const TERMINAL_HISTORY_WARNING_MESSAGE_SNAPSHOT_UNAVAILABLE = 'Recent scrollback could not be restored accurately. Live terminal output is attached, but preserved history is unavailable.';

export function getTerminalHistoryWarningMessage(reason = TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE) {
  if (reason === TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE) {
    return TERMINAL_HISTORY_WARNING_MESSAGE_SNAPSHOT_UNAVAILABLE;
  }

  return TERMINAL_HISTORY_WARNING_MESSAGE_SNAPSHOT_UNAVAILABLE;
}

export function getTerminalRuntimeStatus(runtime) {
  const tmuxAvailable = runtime?.type === 'tmux'
    ? runtime.isAvailable?.() ?? true
    : false;
  const terminalCreationAllowed = runtime?.type === 'tmux' && tmuxAvailable;

  return {
    terminalRuntime: runtime?.type ?? 'unknown',
    terminalRuntimeContract: TERMINAL_RUNTIME_CONTRACT,
    tmuxAvailable,
    terminalCreationAllowed,
    terminalRuntimeBlockedReason: terminalCreationAllowed ? null : TERMINAL_RUNTIME_BLOCKED_REASON,
    terminalRuntimeBlockedMessage: terminalCreationAllowed ? null : TERMINAL_RUNTIME_BLOCKED_MESSAGE,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a sessionId for use as a tmux session name.
 * tmux names cannot contain dots or colons.
 */
function sanitizeTmuxName(sessionId) {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Check whether a tmux session with the given name exists.
 */
function tmuxSessionExists(tmuxName) {
  try {
    execFileSync('tmux', ['has-session', '-t', tmuxName], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the tmux binary is available on this machine.
 */
export function isTmuxAvailable() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Raw PTY runtime
// ---------------------------------------------------------------------------

function createPtyRuntime() {
  return {
    type: 'pty',

    /**
     * Spawn a raw shell PTY.
     */
    spawn({ cwd, cols, rows }) {
      const shell = process.env.SHELL || '/bin/zsh';
      return spawn(shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: buildShellEnv(shell, process.env),
      });
    },

    /**
     * Kill a raw PTY session. After this the session is unrecoverable.
     */
    kill(entry, _sessionId) {
      if (!entry?.pty) return;
      try {
        entry.pty.kill();
      } catch {
        // PTY may already be gone
      }
    },

    /**
     * Raw PTY sessions cannot survive process death.
     */
    isSessionRecoverable() {
      return false;
    },

    /**
     * Raw PTY sessions do not expose a durable external cwd source.
     * Fall back to the server's last known value.
     */
    getSessionCwd(entry) {
      return entry.cwd;
    },

    /**
     * Raw PTY sessions do not have external durable sessions to enumerate.
     */
    listSessionIds() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// tmux-backed runtime
// ---------------------------------------------------------------------------

function ensureTmuxGlobalWindowOptions() {
  execFileSync('tmux', [
    'set-window-option', '-g', 'history-limit', String(TMUX_HISTORY_LIMIT),
  ], { stdio: 'pipe' });
}

function ensureTmuxSessionOptions(tmuxName) {
  execFileSync('tmux', [
    'set-option', '-t', tmuxName, 'status', 'off',
  ], { stdio: 'pipe' });
  execFileSync('tmux', [
    'set-window-option', '-t', tmuxName, 'history-limit', String(TMUX_HISTORY_LIMIT),
  ], { stdio: 'pipe' });
  execFileSync('tmux', [
    'set-option', '-t', tmuxName, 'mouse', 'off',
  ], { stdio: 'pipe' });
}

function getTmuxPaneNumberValue(target, format) {
  const raw = execFileSync(
    'tmux',
    ['display-message', '-p', '-t', target, format],
    { stdio: 'pipe', encoding: 'utf8' }
  ).trim();
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTmuxBoolean(value) {
  return value === '1';
}

function getTmuxPaneSnapshotState(target) {
  const format = [
    '#{alternate_on}',
    '#{pane_in_mode}',
    '#{pane_mode}',
    '#{cursor_x}',
    '#{cursor_y}',
    '#{cursor_flag}',
    '#{cursor_shape}',
    '#{cursor_blinking}',
    '#{cursor_very_visible}',
    '#{insert_flag}',
    '#{origin_flag}',
    '#{wrap_flag}',
    '#{keypad_flag}',
    '#{keypad_cursor_flag}',
    '#{mouse_standard_flag}',
    '#{mouse_button_flag}',
    '#{mouse_all_flag}',
    '#{mouse_utf8_flag}',
    '#{mouse_sgr_flag}',
    '#{bracketed_paste_flag}',
  ].join('\t');

  const raw = execFileSync(
    'tmux',
    ['display-message', '-p', '-t', target, format],
    { stdio: 'pipe', encoding: 'utf8' }
  ).replace(/\r/g, '').replace(/\n$/, '');
  const [
    alternateOnRaw = '0',
    paneInModeRaw = '0',
    paneModeRaw = '',
    cursorXRaw = '0',
    cursorYRaw = '0',
    cursorVisibleRaw = '1',
    cursorShapeRaw = 'block',
    cursorBlinkingRaw = '0',
    cursorVeryVisibleRaw = '0',
    insertModeRaw = '0',
    originModeRaw = '0',
    autoWrapRaw = '1',
    keypadModeRaw = '0',
    applicationCursorKeysRaw = '0',
    mouseStandardRaw = '0',
    mouseButtonRaw = '0',
    mouseAllRaw = '0',
    mouseUtf8Raw = '0',
    mouseSgrRaw = '0',
    bracketedPasteRaw = '0',
  ] = raw.split('\t');
  const paneInMode = parseInt(paneInModeRaw, 10) > 0;

  let mouseMode = 'off';
  if (parseTmuxBoolean(mouseAllRaw)) {
    mouseMode = 'all';
  } else if (parseTmuxBoolean(mouseButtonRaw)) {
    mouseMode = 'button';
  } else if (parseTmuxBoolean(mouseStandardRaw)) {
    mouseMode = 'standard';
  }

  let mouseEncoding = 'default';
  if (parseTmuxBoolean(mouseSgrRaw)) {
    mouseEncoding = 'sgr';
  } else if (parseTmuxBoolean(mouseUtf8Raw)) {
    mouseEncoding = 'utf8';
  }

  return {
    screenMode: paneInMode ? 'mode' : (parseTmuxBoolean(alternateOnRaw) ? 'alternate' : 'primary'),
    paneMode: paneModeRaw || null,
    cursorX: parseInt(cursorXRaw, 10) || 0,
    cursorY: parseInt(cursorYRaw, 10) || 0,
    cursorVisible: parseTmuxBoolean(cursorVisibleRaw),
    cursorShape: cursorShapeRaw || 'block',
    cursorBlinking: parseTmuxBoolean(cursorBlinkingRaw),
    cursorVeryVisible: parseTmuxBoolean(cursorVeryVisibleRaw),
    insertMode: parseTmuxBoolean(insertModeRaw),
    originMode: parseTmuxBoolean(originModeRaw),
    autoWrap: parseTmuxBoolean(autoWrapRaw),
    keypadMode: parseTmuxBoolean(keypadModeRaw),
    applicationCursorKeys: parseTmuxBoolean(applicationCursorKeysRaw),
    mouseMode,
    mouseEncoding,
    bracketedPaste: parseTmuxBoolean(bracketedPasteRaw),
  };
}

function normalizeCapturedSnapshot(output, windowLines = TERMINAL_SNAPSHOT_WINDOW_LINES, metadata = {}) {
  const normalizedWindowLines = Math.max(1, parseInt(windowLines, 10) || TERMINAL_SNAPSHOT_WINDOW_LINES);
  const historyGuaranteed = metadata.historyGuaranteed ?? true;
  const historyWarningReason = metadata.historyWarningReason ?? null;
  const historyWarningMessage = historyWarningReason
    ? metadata.historyWarningMessage ?? getTerminalHistoryWarningMessage(historyWarningReason)
    : null;

  if (!output) {
    return {
      data: '',
      lineCount: 0,
      windowLines: normalizedWindowLines,
      historyGuaranteed,
      historyWarningReason,
      historyWarningMessage,
      ...(metadata.terminalState ? { terminalState: metadata.terminalState } : {}),
    };
  }

  const lines = output.replace(/\r/g, '').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  const recentLines = lines.slice(-normalizedWindowLines);
  if (recentLines.length === 0) {
    return {
      data: '',
      lineCount: 0,
      windowLines: normalizedWindowLines,
      historyGuaranteed,
      historyWarningReason,
      historyWarningMessage,
      ...(metadata.terminalState ? { terminalState: metadata.terminalState } : {}),
    };
  }

  return {
    // Snapshot payloads are row dumps, not a live terminal byte stream.
    // Re-emit rows with CRLF separators so xterm restores each captured row
    // at column 0 instead of line-feeding from the previous cursor position.
    data: `${recentLines.join('\r\n')}\r\n`,
    lineCount: recentLines.length,
    windowLines: normalizedWindowLines,
    historyGuaranteed,
    historyWarningReason,
    historyWarningMessage,
    ...(metadata.terminalState ? { terminalState: metadata.terminalState } : {}),
  };
}

function createTmuxRuntime() {
  return {
    type: 'tmux',

    isAvailable() {
      return isTmuxAvailable();
    },

    /**
     * Spawn (or re-attach to) a tmux-backed session.
     *
     * If the tmux session doesn't exist yet, creates one detached with the
     * given cwd and dimensions, then attaches via a node-pty wrapper.
     * If it already exists (e.g. server restarted), just attaches.
     */
    spawn({ cwd, cols, rows, sessionId }) {
      if (!this.isAvailable()) {
        throw new Error(TERMINAL_RUNTIME_BLOCKED_MESSAGE);
      }

      const tmuxName = sanitizeTmuxName(sessionId);

      if (!tmuxSessionExists(tmuxName)) {
        // history-limit only affects the initial pane if it is in place before
        // the tmux session/window is created.
        ensureTmuxGlobalWindowOptions();
        execFileSync('tmux', [
          'new-session', '-d',
          '-s', tmuxName,
          '-c', cwd,
          '-x', String(cols),
          '-y', String(rows),
        ], { stdio: 'pipe' });
      }

      // Keep tmux session options aligned with the browser terminal.
      // history-limit matters for durable session restore after reload/server restart.
      ensureTmuxSessionOptions(tmuxName);

      // Attach via node-pty so we get the same onData/onExit/write/resize API
      return spawn('tmux', ['attach-session', '-t', tmuxName], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
      });
    },

    /**
     * Kill both the node-pty attachment and the underlying tmux session.
     */
    kill(entry, sessionId) {
      if (entry?.pty) {
        try {
          entry.pty.kill();
        } catch {
          // PTY wrapper may already be gone
        }
      }
      if (!this.isAvailable()) return;
      const tmuxName = sanitizeTmuxName(sessionId);
      try {
        execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'pipe' });
      } catch {
        // Session may already be gone
      }
    },

    /**
     * Check whether the underlying tmux session is still alive,
     * meaning the node-pty wrapper can be re-spawned to recover.
     */
    isSessionRecoverable(sessionId) {
      if (!this.isAvailable()) return false;
      const tmuxName = sanitizeTmuxName(sessionId);
      return tmuxSessionExists(tmuxName);
    },

    /**
     * Resolve the live cwd from the active tmux pane instead of the original
     * spawn directory. This keeps the UI in sync after `cd` commands.
     */
    getSessionCwd(entry, sessionId) {
      if (!this.isAvailable()) return entry.cwd;
      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const cwd = execFileSync(
          'tmux',
          ['display-message', '-p', '-t', tmuxName, '#{pane_current_path}'],
          { stdio: 'pipe', encoding: 'utf8' }
        ).trim();

        return cwd || entry.cwd;
      } catch {
        return entry.cwd;
      }
    },

    /**
     * Force the durable tmux window to the requested geometry before snapshot
     * capture so reconnect restores reflect the current browser size.
     */
    resizeSession(sessionId, cols, rows) {
      if (!this.isAvailable()) return;
      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        execFileSync(
          'tmux',
          ['resize-window', '-t', `${tmuxName}:0`, '-x', String(cols), '-y', String(rows)],
          { stdio: 'pipe' }
        );
      } catch {
        // Keep reconnect recovery best-effort if tmux rejects the resize.
      }
    },

    /**
     * Capture the authoritative recent tmux window used to rebuild browser
     * attachments. The snapshot includes the currently visible pane content and
     * is capped to the most recent 10,000 terminal lines.
     */
    captureSessionSnapshot(sessionId, windowLines = TERMINAL_SNAPSHOT_WINDOW_LINES) {
      if (!this.isAvailable()) {
        return normalizeCapturedSnapshot('', windowLines, {
          historyGuaranteed: false,
          historyWarningReason: TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE,
        });
      }

      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const normalizedWindowLines = Math.max(1, parseInt(windowLines, 10) || TERMINAL_SNAPSHOT_WINDOW_LINES);
        const terminalState = getTmuxPaneSnapshotState(tmuxName);
        const captureArgs = ['capture-pane', '-p'];

        if (terminalState.screenMode === 'mode') {
          captureArgs.push('-M', '-e', '-N');
        } else if (terminalState.screenMode === 'alternate') {
          captureArgs.push('-a', '-e', '-N');
        } else {
          const paneHeight = getTmuxPaneNumberValue(tmuxName, '#{pane_height}');
          const visiblePaneLines = Math.max(1, paneHeight || 0);
          const historyLines = Math.max(normalizedWindowLines - visiblePaneLines, 0);
          const startLine = historyLines > 0 ? `-${historyLines}` : '0';
          // Preserve the current tmux row layout for primary-screen scrollback
          // instead of joining wrapped rows into logical lines. Re-wrapping
          // joined rows on restore can recreate redraw corruption while
          // scrolling through restored history after a reconnect.
          captureArgs.push('-S', startLine);
        }

        captureArgs.push('-t', tmuxName);

        const output = execFileSync('tmux', captureArgs, {
          stdio: 'pipe',
          encoding: 'utf8',
        });

        return normalizeCapturedSnapshot(output, normalizedWindowLines, {
          historyGuaranteed: true,
          terminalState,
        });
      } catch {
        return normalizeCapturedSnapshot('', windowLines, {
          historyGuaranteed: false,
          historyWarningReason: TERMINAL_HISTORY_WARNING_REASON_SNAPSHOT_UNAVAILABLE,
        });
      }
    },

    /**
     * List known durable tmux session ids so the backend can allocate a fresh
     * browser terminal id without colliding with hidden historical sessions.
     */
    listSessionIds() {
      if (!this.isAvailable()) return [];
      try {
        const output = execFileSync(
          'tmux',
          ['list-sessions', '-F', '#S'],
          { stdio: 'pipe', encoding: 'utf8' }
        );
        return output
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a terminal runtime based on the requested mode.
 *
 * @param {'pty' | 'tmux'} mode
 * @returns {object} runtime with spawn/kill/isSessionRecoverable
 */
export function createTerminalRuntime(mode = 'tmux') {
  if (mode && mode !== 'tmux') {
    console.warn(`[terminal-runtime] ignoring unsupported runtime "${mode}" — tmux is required`);
  }

  const runtime = createTmuxRuntime();

  if (!runtime.isAvailable()) {
    console.warn('[terminal-runtime] tmux is required but not installed — terminal creation is blocked');
    return runtime;
  }

  console.log('[terminal-runtime] using tmux-backed sessions');
  return runtime;
}
