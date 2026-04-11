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
      entry.pty.kill();
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
  };
}

// ---------------------------------------------------------------------------
// tmux-backed runtime
// ---------------------------------------------------------------------------

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
        // Suppress tmux status bar — CodeDeck has its own tab/pane UI.
        // Without this, tmux's default status-interval (15s) generates
        // periodic PTY output that keeps the sidebar activity dot green.
        execFileSync('tmux', [
          'set-option', '-t', tmuxName, 'status', 'off',
        ], { stdio: 'pipe' });
      }

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
      entry.pty.kill();
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
