import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTerminalRuntime } from '../terminal-runtime.js';

const tmux = args => execFileSync('tmux', args, { stdio: 'pipe', encoding: 'utf8' }).trim();
const pane = (format) => tmux(['display-message', '-p', '-t', 'respawn-test:0.0', format]);

async function until(check, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

describe('respawnMainPaneAsync', () => {
  it('requires an absolute folder for the new shell', async () => {
    const runtime = createTerminalRuntime('tmux');
    await expect(runtime.respawnMainPaneAsync('demo-1', 'relative/dir'))
      .rejects.toThrow('respawnMainPaneAsync: cwd must be an absolute path, got relative/dir');
    await expect(runtime.respawnMainPaneAsync('demo-1', undefined))
      .rejects.toThrow('respawnMainPaneAsync: cwd must be an absolute path, got undefined');
  });

  // A private TMUX_TMPDIR isolates this test from every user tmux session.
  it('ends what runs in the main pane, clears its terminal modes and starts a shell in the folder', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cd-respawn-'));
    const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'cd-respawn-work-')));
    const previousTmp = process.env.TMUX_TMPDIR; const previousTmux = process.env.TMUX;
    process.env.TMUX_TMPDIR = dir; delete process.env.TMUX;
    try {
      // Like a CodeDeck terminal: a pane with the default shell and no start command of its own.
      tmux(['new-session', '-d', '-s', 'respawn-test', '-x', '80', '-y', '24']);
      // A stand-in for a frozen agent: it switches mouse reporting on and never reads input.
      tmux(['send-keys', '-t', 'respawn-test:0.0', "printf '\\033[?1000h'; sleep 600", 'Enter']);
      await until(() => pane('#{pane_current_command}') === 'sleep' && pane('#{mouse_any_flag}') === '1', 'the stand-in agent');
      const shellPid = Number(pane('#{pane_pid}'));
      const agentPid = Number(execFileSync('pgrep', ['-P', String(shellPid), 'sleep'], { encoding: 'utf8' }).trim());

      await createTerminalRuntime('tmux').respawnMainPaneAsync('respawn-test', work);

      await until(() => !processAlive(agentPid) && !processAlive(shellPid), 'the stand-in agent and its shell to end');
      await until(() => pane('#{pane_current_path}') === work, 'the new shell in the folder');
      expect(Number(pane('#{pane_pid}'))).not.toBe(shellPid);
      expect(pane('#{pane_dead}')).toBe('0');
      expect(pane('#{mouse_any_flag}')).toBe('0');
      expect(pane('#{pane_current_command}')).not.toBe('sleep');
    } finally {
      try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); }
      finally {
        if (previousTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmp;
        if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
        rmSync(dir, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    }
  }, 20000);
});
