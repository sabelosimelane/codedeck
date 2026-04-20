/**
 * Terminal runtime abstraction.
 *
 * Provides a uniform spawn/kill/recovery interface for two backends:
 *   - 'pty'  — raw node-pty (ephemeral)
 *   - 'tmux' — tmux-backed sessions (default, durable across server restarts)
 *
 * The browser-side pane model stays identical regardless of backend.
 * ws-handler.js consumes the runtime via dependency injection.
 */

import { spawn } from 'node-pty';
import { execFileSync } from 'child_process';
import { buildShellEnv } from './shell-env.js';

const TMUX_HISTORY_LIMIT = 10000;

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
     * Raw PTY sessions have no durable external history to hydrate.
     */
    getSessionScrollback() {
      return '';
    },

    /**
     * Raw PTY sessions do not support server-driven history scrolling.
     */
    scrollSessionHistory() {
      return false;
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

function ensureTmuxSessionOptions(tmuxName) {
  execFileSync('tmux', [
    'set-option', '-t', tmuxName, 'status', 'off',
  ], { stdio: 'pipe' });
  execFileSync('tmux', [
    'set-option', '-t', tmuxName, 'history-limit', String(TMUX_HISTORY_LIMIT),
  ], { stdio: 'pipe' });
  execFileSync('tmux', [
    'set-option', '-t', tmuxName, 'mouse', 'off',
  ], { stdio: 'pipe' });
}

function getTmuxPaneTarget(sessionId) {
  const tmuxName = sanitizeTmuxName(sessionId);
  return execFileSync(
    'tmux',
    ['display-message', '-p', '-t', tmuxName, '#{pane_id}'],
    { stdio: 'pipe', encoding: 'utf8' }
  ).trim();
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

function createTmuxRuntime() {
  return {
    type: 'tmux',

    /**
     * Spawn (or re-attach to) a tmux-backed session.
     *
     * If the tmux session doesn't exist yet, creates one detached with the
     * given cwd and dimensions, then attaches via a node-pty wrapper.
     * If it already exists (e.g. server restarted), just attaches.
     */
    spawn({ cwd, cols, rows, sessionId }) {
      const tmuxName = sanitizeTmuxName(sessionId);

      if (!tmuxSessionExists(tmuxName)) {
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
      const tmuxName = sanitizeTmuxName(sessionId);
      return tmuxSessionExists(tmuxName);
    },

    /**
     * Resolve the live cwd from the active tmux pane instead of the original
     * spawn directory. This keeps the UI in sync after `cd` commands.
     */
    getSessionCwd(entry, sessionId) {
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
     * Capture tmux scrollback that sits ABOVE the currently visible pane.
     * attach-session repaints the current viewport, but not the older history.
     * Returning only the rows above the live viewport avoids duplicating the
     * visible screen when the browser hydrates durable session history.
     */
    getSessionScrollback(sessionId) {
      const tmuxName = sanitizeTmuxName(sessionId);

      try {
        const paneHeight = parseInt(
          execFileSync(
            'tmux',
            ['display-message', '-p', '-t', tmuxName, '#{pane_height}'],
            { stdio: 'pipe', encoding: 'utf8' }
          ).trim(),
          10,
        );

        if (!Number.isFinite(paneHeight) || paneHeight <= 0) {
          return '';
        }

        const output = execFileSync(
          'tmux',
          ['capture-pane', '-pJ', '-S', '-', '-E', `-${paneHeight}`, '-t', tmuxName],
          { stdio: 'pipe', encoding: 'utf8' }
        );

        if (!output || output.trim().length === 0) {
          return '';
        }

        return output.endsWith('\n') ? output : `${output}\n`;
      } catch {
        return '';
      }
    },

    /**
     * Scroll tmux history without enabling tmux mouse mode.
     * This preserves normal browser text selection while still letting the UI
     * drive tmux copy-mode history on wheel events.
     */
    scrollSessionHistory(sessionId, { direction, lines = 1 } = {}) {
      const target = getTmuxPaneTarget(sessionId);
      const count = Math.max(1, Math.min(parseInt(lines, 10) || 1, 200));
      const paneInMode = getTmuxPaneNumberValue(target, '#{pane_in_mode}') === 1;

      if (direction === 'up') {
        if (!paneInMode) {
          execFileSync('tmux', ['copy-mode', '-t', target], { stdio: 'pipe' });
        }
        execFileSync('tmux', ['send-keys', '-X', '-t', target, '-N', String(count), 'scroll-up'], { stdio: 'pipe' });
        return true;
      }

      if (direction === 'down') {
        if (!paneInMode) {
          return false;
        }
        execFileSync('tmux', ['send-keys', '-X', '-t', target, '-N', String(count), 'scroll-down'], { stdio: 'pipe' });
        const scrollPosition = getTmuxPaneNumberValue(target, '#{scroll_position}');
        if (scrollPosition <= 0) {
          execFileSync('tmux', ['send-keys', '-X', '-t', target, 'cancel'], { stdio: 'pipe' });
        }
        return true;
      }

      return false;
    },

    /**
     * List known durable tmux session ids so the backend can allocate a fresh
     * browser terminal id without colliding with hidden historical sessions.
     */
    listSessionIds() {
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
  if (mode === 'tmux') {
    if (!isTmuxAvailable()) {
      console.warn('[terminal-runtime] tmux mode requested but tmux is not installed — falling back to pty');
      return createPtyRuntime();
    }
    console.log('[terminal-runtime] using tmux-backed sessions');
    return createTmuxRuntime();
  }
  console.log('[terminal-runtime] using raw pty sessions');
  return createPtyRuntime();
}
