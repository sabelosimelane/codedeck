import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTerminalRuntime } from '../terminal-runtime.js';
import { attachBackgroundSession } from '../ws-handler.js';

async function waitForReplay(entry, needle, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = (entry.replayBuffer || []).map(chunk => chunk.data).join('');
    if (text.includes(needle)) return text;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in replay; saw ${JSON.stringify(text)}`);
}

// Private TMUX_TMPDIR isolates this from every user tmux session.
it('attaches in the background, writes echo, observes output, releases, and leaves the session', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cd-bg-attach-'));
  const work = mkdtempSync(path.join(os.tmpdir(), 'cd-bg-cwd-'));
  const previousTmp = process.env.TMUX_TMPDIR;
  const previousTmux = process.env.TMUX;
  process.env.TMUX_TMPDIR = dir;
  delete process.env.TMUX;
  const sessionId = 'pipeline-bg-1';
  const sessions = new Map();
  try {
    const runtime = createTerminalRuntime('tmux');
    runtime.createDetachedSession({ cwd: work, cols: 120, rows: 32, sessionId });
    expect(runtime.isSessionRecoverable(sessionId)).toBe(true);

    const handle = attachBackgroundSession(sessionId, sessions, runtime, new Set(), { cwd: work });
    expect(handle.entry.wsAttached).toBe(false);
    expect(handle.entry.backgroundHolds).toBe(1);

    handle.write('echo pipeline-bg-ok\r');
    await waitForReplay(handle.entry, 'pipeline-bg-ok');

    handle.release();
    expect(handle.entry.backgroundHolds).toBe(0);
    expect(handle.entry.alive).toBe(false);
    expect(handle.entry.clientDetached).toBe(true);
    expect(runtime.isSessionRecoverable(sessionId)).toBe(true);
  } finally {
    try { execFileSync('tmux', ['kill-server'], { stdio: 'pipe' }); }
    finally {
      if (previousTmp === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmp;
      if (previousTmux === undefined) delete process.env.TMUX; else process.env.TMUX = previousTmux;
      rmSync(dir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }
}, 15000);
