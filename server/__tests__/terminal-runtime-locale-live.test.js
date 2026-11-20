import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTerminalRuntime } from '../terminal-runtime.js';

const LOCALE = ['LANG', 'LC_ALL', 'LC_CTYPE'];

async function until(check, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Without a UTF-8 locale tmux 3.8 prints a tab in a -F format as `_`. The backend can be started
// from such a shell, so every read that splits tmux output on tabs must not depend on the locale.
describe('tmux reads without a UTF-8 locale', () => {
  it('read a terminal\'s state and end its processes', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'cd-locale-'));
    const saved = Object.fromEntries([...LOCALE, 'TMUX_TMPDIR', 'TMUX'].map(name => [name, process.env[name]]));
    for (const name of [...LOCALE, 'TMUX']) delete process.env[name];
    process.env.TMUX_TMPDIR = dir;
    try {
      execFileSync('tmux', ['new-session', '-d', '-s', 'locale-test', '-x', '80', '-y', '24'], { stdio: 'pipe' });
      const runtime = createTerminalRuntime('tmux');
      await until(() => runtime.getSessionExecutionState('locale-test').executionReason !== 'tmux_lookup_failed', 'the sync state read');
      const state = await runtime.getSessionExecutionStateAsync('locale-test');
      expect(state.executionReason).not.toBe('tmux_lookup_failed');
      expect(state.foregroundCommand).toBeTruthy();

      await runtime.killAsync(null, 'locale-test');
      expect(() => execFileSync('tmux', ['has-session', '-t', '=locale-test'], { stdio: 'pipe' })).toThrow();
    } finally {
      try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); } catch (error) {
        if (!/no server running|error connecting/.test(String(error.stderr))) throw error;
      }
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});
