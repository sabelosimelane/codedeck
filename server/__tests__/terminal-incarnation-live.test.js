import { expect, it } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTerminalRuntime, createHostTerminalRuntime } from '../terminal-runtime.js';

// A private TMUX_TMPDIR isolates this regression from every user tmux session.
it('initializes and reads real tmux session options through local and host runtime APIs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cd-tmux-'));
  const previousTmp = process.env.TMUX_TMPDIR; const previousTmux = process.env.TMUX;
  process.env.TMUX_TMPDIR = dir; delete process.env.TMUX;
  const run = promisify(execFile);
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', 'identity-test', 'sleep 60'], { stdio: 'pipe' });
    const local = createTerminalRuntime('tmux');
    const first = local.getSessionIncarnation('identity-test');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await local.getSessionIncarnationAsync('identity-test')).toBe(first);
    const remote = createHostTerminalRuntime({ run: (cmd, args, opts) => run(cmd, args, { ...opts, encoding: 'utf8' }) }, 'isolated-test');
    expect(await remote.getSessionIncarnationAsync('identity-test')).toBe(first);
    execFileSync('tmux', ['new-session', '-d', '-s', 'keep-server', 'sleep 60'], { stdio: 'pipe' });
    execFileSync('tmux', ['kill-session', '-t', 'identity-test'], { stdio: 'pipe' });
    execFileSync('tmux', ['new-session', '-d', '-s', 'identity-test', 'sleep 60'], { stdio: 'pipe' });
    const second = await remote.getSessionIncarnationAsync('identity-test');
    expect(second).not.toBe(first); expect(local.getSessionIncarnation('identity-test')).toBe(second);
  } finally {
    try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); }
    finally {
      if (previousTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmp;
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 15000);
