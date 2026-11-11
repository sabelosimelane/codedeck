import { describe, expect, it, vi } from 'vitest';
import { createHostTerminalRuntime, TERMINAL_SNAPSHOT_WINDOW_LINES } from '../terminal-runtime.js';

function transportError(message = 'connect timeout') {
  return Object.assign(new Error(message), { code: 255 });
}

function exitError(code, message = 'command failed') {
  return Object.assign(new Error(message), { code });
}

/**
 * Fake runner: records every run/spawnPty call; per-tmux-subcommand canned
 * responses (string stdout, Error to reject, or fn(args) for dynamic).
 */
function fakeRunner(responses = {}) {
  const calls = [];
  const ptys = [];
  return {
    calls,
    ptys,
    tmuxCalls(subcommand) {
      return calls.filter(c => c.cmd === 'tmux' && c.args[0] === subcommand);
    },
    run: vi.fn((cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const responder = responses[cmd === 'tmux' ? args[0] : cmd];
      if (responder instanceof Error) return Promise.reject(responder);
      if (typeof responder === 'function') {
        try {
          const value = responder(args);
          return value instanceof Error ? Promise.reject(value) : Promise.resolve({ stdout: value ?? '', stderr: '' });
        } catch (err) {
          return Promise.reject(err);
        }
      }
      return Promise.resolve({ stdout: responder ?? '', stderr: '' });
    }),
    spawnPty: vi.fn((cmd, args, opts) => {
      const pty = { cmd, args, opts, kill: vi.fn() };
      ptys.push(pty);
      return pty;
    }),
  };
}

const HOST = 'devbox';

function makeRuntime(runner) {
  return createHostTerminalRuntime(runner, HOST);
}

// ---------------------------------------------------------------------------
// spawnAsync
// ---------------------------------------------------------------------------

describe('createHostTerminalRuntime.spawnAsync', () => {
  it('creates a detached tmux session then attaches via the runner PTY when none exists', async () => {
    const runner = fakeRunner({ 'has-session': exitError(1, 'no such session') });
    const runtime = makeRuntime(runner);

    const pty = await runtime.spawnAsync({ cwd: '/srv/app', cols: 120, rows: 30, sessionId: 'proj-1' });

    expect(runner.tmuxCalls('has-session')[0].args).toEqual(['has-session', '-t', '=proj-1']);
    expect(runner.tmuxCalls('new-session')[0].args).toEqual([
      'new-session', '-d', '-s', 'proj-1', '-c', '/srv/app', '-x', '120', '-y', '30',
    ]);
    // Session options mirror the local runtime (status off, history-limit, mouse on).
    const setOptionCalls = runner.calls.filter(c => c.cmd === 'tmux' && c.args[0].startsWith('set-'));
    expect(setOptionCalls.length).toBeGreaterThanOrEqual(3);
    expect(runner.spawnPty).toHaveBeenCalledWith(
      'tmux', ['-T', 'hyperlinks', 'attach-session', '-t', 'proj-1'], { cols: 120, rows: 30 }
    );
    expect(runner.calls.filter(call => call.cmd === 'systemctl')).toHaveLength(0);
    expect(pty).toBe(runner.ptys[0]);
  });

  it('attaches without creating when the tmux session already exists', async () => {
    const runner = fakeRunner({});
    const runtime = makeRuntime(runner);

    await runtime.spawnAsync({ cwd: '/srv/app', cols: 80, rows: 24, sessionId: 'proj-1' });

    expect(runner.tmuxCalls('new-session')).toHaveLength(0);
    expect(runner.calls.filter(call => call.cmd === 'systemctl')).toHaveLength(0);
    expect(runner.spawnPty).toHaveBeenCalledTimes(1);
  });

  it('sanitizes session ids into valid tmux names', async () => {
    const runner = fakeRunner({ 'has-session': exitError(1) });
    const runtime = makeRuntime(runner);

    await runtime.spawnAsync({ cwd: '/x', cols: 80, rows: 24, sessionId: 'my.proj-1' });

    expect(runner.tmuxCalls('new-session')[0].args).toContain('my_proj-1');
    expect(runner.spawnPty.mock.calls[0][1]).toEqual(['-T', 'hyperlinks', 'attach-session', '-t', 'my_proj-1']);
  });

  it('propagates a transport failure from the has-session probe', async () => {
    const runner = fakeRunner({ 'has-session': transportError() });
    const runtime = makeRuntime(runner);

    await expect(
      runtime.spawnAsync({ cwd: '/x', cols: 80, rows: 24, sessionId: 'proj-1' })
    ).rejects.toMatchObject({ code: 255 });
    expect(runner.spawnPty).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// killAsync
// ---------------------------------------------------------------------------

describe('createHostTerminalRuntime.killAsync', () => {
  it.each([
    ['already exited', false, false],
    ['force killed', true, false],
    ['survived SIGKILL', true, true],
  ])('%s uses remote kill only for collected survivors', async (_case, survivor, persists) => {
    let time = 0;
    let killed = false;
    const runner = fakeRunner({
      'list-panes': '200\t/dev/pts/3\n',
      ps: '200 1 pts/3\n201 200 ??\n999 1 other\n',
      'has-session': exitError(1, "can't find session"),
      kill: args => {
        if (args[0] === '-9') { killed = true; return ''; }
        if (args[1] === '201' && survivor && (!killed || persists)) return '';
        return exitError(1, 'No such process');
      },
    });
    const pty = { kill: vi.fn() };
    const runtime = createHostTerminalRuntime(runner, HOST, {
      now: () => time, sleep: async ms => { time += ms; }, excludePids: [process.pid, process.ppid],
    });
    if (persists) {
      await expect(runtime.killAsync({ pty }, 'proj-1')).rejects.toThrow(/proj-1.*201/);
      expect(pty.kill).not.toHaveBeenCalled();
    } else {
      await runtime.killAsync({ pty }, 'proj-1');
      expect(pty.kill).toHaveBeenCalledOnce();
    }
    expect(runner.calls.filter(c => c.cmd === 'kill' && c.args[0] === '-9').map(c => c.args)).toEqual(survivor ? [['-9', '201']] : []);
    expect(runner.calls.some(c => c.cmd === 'kill' && c.args[1] === '999')).toBe(false);
  });

  it('does not run ps or pid kill for a missing session and propagates host transport errors', async () => {
    const missing = fakeRunner({ 'list-panes': exitError(1, "can't find session"), 'kill-session': exitError(1, "can't find session") });
    await makeRuntime(missing).killAsync({ pty: { kill: vi.fn() } }, 'proj-1');
    expect(missing.calls.some(c => c.cmd === 'ps' || c.cmd === 'kill')).toBe(false);
    const failed = fakeRunner({ 'list-panes': transportError() });
    await expect(makeRuntime(failed).killAsync({}, 'proj-1')).rejects.toMatchObject({ code: 255 });
    expect(failed.tmuxCalls('kill-session')).toHaveLength(0);
  });
  it('kills the PTY wrapper and the remote tmux session', async () => {
    const runner = fakeRunner({ 'has-session': exitError(1, "can't find session") });
    const runtime = makeRuntime(runner);
    const entry = { pty: { kill: vi.fn() } };

    await runtime.killAsync(entry, 'proj-1');

    expect(entry.pty.kill).toHaveBeenCalled();
    expect(runner.tmuxCalls('kill-session')[0].args).toEqual(['kill-session', '-t', '=proj-1']);
    expect(runner.tmuxCalls('list-panes')[0].args[3]).toBe('=proj-1:');
    expect(runner.tmuxCalls('has-session')).toHaveLength(1);
    expect(runner.calls.findIndex(c => c.args?.[0] === 'kill-session')).toBeLessThan(runner.calls.findIndex(c => c.args?.[0] === 'has-session'));
  });

  it('accepts an already missing remote session', async () => {
    const runner = fakeRunner({ 'kill-session': exitError(1, "can't find session") });
    const runtime = makeRuntime(runner);

    await expect(runtime.killAsync({ pty: null }, 'proj-1')).resolves.toBeUndefined();
  });

  it.each([exitError(1, 'permission denied'), transportError()])('preserves the PTY when kill-session fails: %s', async error => {
    const runtime = makeRuntime(fakeRunner({ 'kill-session': error }));
    const entry = { pty: { kill: vi.fn() } };
    await expect(runtime.killAsync(entry, 'proj-1')).rejects.toThrow(error.code === 255 ? 'connect timeout' : /proj-1.*permission denied/);
    expect(entry.pty.kill).not.toHaveBeenCalled();
  });

  it('rejects when the tmux session still exists after kill-session', async () => {
    const entry = { pty: { kill: vi.fn() } };
    await expect(makeRuntime(fakeRunner({})).killAsync(entry, 'proj-1')).rejects.toThrow(/proj-1.*still exists/);
    expect(entry.pty.kill).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// isSessionRecoverableAsync — the detach-vs-dead hinge
// ---------------------------------------------------------------------------

describe('createHostTerminalRuntime.isSessionRecoverableAsync', () => {
  it('returns true when the remote tmux session exists', async () => {
    const runtime = makeRuntime(fakeRunner({}));
    await expect(runtime.isSessionRecoverableAsync('proj-1')).resolves.toBe(true);
  });

  it('returns false when tmux definitively reports the session gone', async () => {
    const runtime = makeRuntime(fakeRunner({ 'has-session': exitError(1, 'no such session') }));
    await expect(runtime.isSessionRecoverableAsync('proj-1')).resolves.toBe(false);
  });

  it('throws on a transport failure — the remote state is unknown, not dead', async () => {
    const runtime = makeRuntime(fakeRunner({ 'has-session': transportError() }));
    await expect(runtime.isSessionRecoverableAsync('proj-1')).rejects.toMatchObject({ code: 255 });
  });
});

// ---------------------------------------------------------------------------
// captureSessionSnapshotAsync
// ---------------------------------------------------------------------------

const PRIMARY_PANE_STATE_RAW = [
  '0', '0', '', '4', '2', '1', 'block', '0', '0', '0', '0', '1', '0', '0', '0', '0', '0', '0', '0', '1',
].join('\t');

describe('createHostTerminalRuntime.captureSessionSnapshotAsync', () => {
  it('captures the primary screen through the runner and returns the local snapshot shape', async () => {
    const runner = fakeRunner({
      'display-message': (args) => {
        const format = args[args.length - 1];
        if (format.includes('alternate_on')) return PRIMARY_PANE_STATE_RAW;
        if (format === '#{pane_height}') return '30\n';
        if (format === '#{pane_width}') return '80\n';
        return '';
      },
      'capture-pane': 'line-one\nline-two\n',
    });
    const runtime = makeRuntime(runner);

    const snapshot = await runtime.captureSessionSnapshotAsync('proj-1');

    expect(snapshot.data).toBe('line-one\r\nline-two\r\n');
    expect(snapshot.lineCount).toBe(2);
    expect(snapshot.windowLines).toBe(TERMINAL_SNAPSHOT_WINDOW_LINES);
    expect(snapshot.historyGuaranteed).toBe(true);
    expect(snapshot.terminalState).toMatchObject({
      screenMode: 'primary',
      cursorX: 4,
      cursorY: 2,
      bracketedPaste: true,
    });
    // The capture ran through the runner with a history start line.
    const captureCall = runner.tmuxCalls('capture-pane')[0];
    expect(captureCall.args).toContain('-S');
    expect(captureCall.args).toContain('-t');
  });

  it('clamps primary-screen rows to the live pane width in terminal cells', async () => {
    const runner = fakeRunner({
      'display-message': (args) => {
        const format = args[args.length - 1];
        if (format.includes('alternate_on')) return PRIMARY_PANE_STATE_RAW;
        if (format === '#{pane_height}') return '30\n';
        if (format === '#{pane_width}') return '4\n';
        return '';
      },
      'capture-pane': 'abcdefgh\n',
    });
    const runtime = makeRuntime(runner);

    const snapshot = await runtime.captureSessionSnapshotAsync('proj-1');
    expect(snapshot.data).toBe('abcd\r\n');
  });

  it('degrades honestly on failure: empty snapshot with a history warning', async () => {
    const runner = fakeRunner({ 'display-message': transportError() });
    const runtime = makeRuntime(runner);

    const snapshot = await runtime.captureSessionSnapshotAsync('proj-1');

    expect(snapshot.data).toBe('');
    expect(snapshot.historyGuaranteed).toBe(false);
    expect(snapshot.historyWarningReason).toBe('snapshot_unavailable');
    expect(snapshot.historyWarningMessage).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// resizeSessionAsync / getSessionCwdAsync / getSessionStatusAsync / listSessionIdsAsync
// ---------------------------------------------------------------------------

describe('createHostTerminalRuntime auxiliary ops', () => {
  it('resizes the durable tmux window through the runner (best-effort)', async () => {
    const runner = fakeRunner({});
    const runtime = makeRuntime(runner);
    await runtime.resizeSessionAsync('proj-1', 100, 40);
    expect(runner.tmuxCalls('resize-window')[0].args).toEqual([
      'resize-window', '-t', 'proj-1:0', '-x', '100', '-y', '40',
    ]);

    const failing = makeRuntime(fakeRunner({ 'resize-window': exitError(1) }));
    await expect(failing.resizeSessionAsync('proj-1', 100, 40)).resolves.toBeUndefined();
  });

  it('resolves the live cwd through the runner and falls back to the entry cwd on failure', async () => {
    const runner = fakeRunner({ 'display-message': '/srv/app/sub\n' });
    const runtime = makeRuntime(runner);
    await expect(runtime.getSessionCwdAsync({ cwd: '/srv/app' }, 'proj-1')).resolves.toBe('/srv/app/sub');

    const failing = makeRuntime(fakeRunner({ 'display-message': transportError() }));
    await expect(failing.getSessionCwdAsync({ cwd: '/srv/app' }, 'proj-1')).resolves.toBe('/srv/app');
  });

  it('falls back to an unknown execution state when the aggregate status command fails', async () => {
    const failing = makeRuntime(fakeRunner({ sh: transportError() }));
    const status = await failing.getSessionStatusAsync({ cwd: '/srv/app' }, 'proj-1');
    expect(status.cwd).toBe('/srv/app');
    expect(status.executionState.executionStatus).toBe('unknown');
    expect(status.executionState.executionReason).toBe('tmux_lookup_failed');
    expect(status.executionState).toMatchObject({ agentCli: null, backgroundAgents: 0, backgroundShells: 0, needsInput: false });
  });

  it('fetches cwd and execution state through one aggregate remote command', async () => {
    const runner = fakeRunner({
      sh: `1794348000\u00000\tzsh\t0\t1794348000\t/srv/app/sub\n\u0000$ \n\u0000`,
    });
    const runtime = makeRuntime(runner);

    const status = await runtime.getSessionStatusAsync({ cwd: '/srv/app' }, 'proj-1');

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].cmd).toBe('sh');
    expect(status.cwd).toBe('/srv/app/sub');
    expect(status.executionState.executionStatus).not.toBe('unknown');
  });

  it('reads the remote clock after the pane activity time it is compared against', async () => {
    const runner = fakeRunner({
      sh: `1794348000\u00000\tzsh\t0\t1794348000\t/srv/app\n\u0000$ \n\u0000`,
    });
    await makeRuntime(runner).getSessionStatusAsync({ cwd: '/srv/app' }, 'proj-1');

    const script = runner.calls[0].args[1];
    const paneRead = script.indexOf('tmux list-panes');
    const clockRead = script.indexOf('date +%s');
    expect(paneRead).toBeGreaterThanOrEqual(0);
    expect(clockRead).toBeGreaterThan(paneRead);
  });

  it('rejects invalid remote clock through the existing lookup failure state', async () => {
    const runner = fakeRunner({ sh: 'bad\u00000\tzsh\t0\t1\t/srv/app\n\u0000$ \n\u0000' });
    const status = await makeRuntime(runner).getSessionStatusAsync({ cwd: '/srv/app' }, 'proj-1');
    expect(status.executionState.executionReason).toBe('tmux_lookup_failed');
    expect(runner.calls).toHaveLength(1);
  });

  it('lists remote session ids and returns [] when the host cannot be reached', async () => {
    const runner = fakeRunner({ 'list-sessions': 'proj-1\nproj-2\n' });
    const runtime = makeRuntime(runner);
    await expect(runtime.listSessionIdsAsync()).resolves.toEqual(['proj-1', 'proj-2']);

    const failing = makeRuntime(fakeRunner({ 'list-sessions': transportError() }));
    await expect(failing.listSessionIdsAsync()).resolves.toEqual([]);
  });

  it('rethrows transport failures in strict mode so callers can fail fast instead of colliding', async () => {
    const failing = makeRuntime(fakeRunner({ 'list-sessions': transportError() }));
    await expect(failing.listSessionIdsAsync({ strict: true })).rejects.toMatchObject({ code: 255 });

    // Definitive tmux answers ("no server running" = no sessions) stay [] even in strict mode.
    const noServer = makeRuntime(fakeRunner({ 'list-sessions': exitError(1, 'no server running') }));
    await expect(noServer.listSessionIdsAsync({ strict: true })).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkTmuxAsync — remote tmux requirement (§8.3)
// ---------------------------------------------------------------------------

describe('createHostTerminalRuntime.checkTmuxAsync', () => {
  it('reports tmux available', async () => {
    const runtime = makeRuntime(fakeRunner({ '-V': 'tmux 3.4\n' }));
    await expect(runtime.checkTmuxAsync()).resolves.toEqual({ available: true, transport: false, error: null });
  });

  it('reports tmux missing (definitive)', async () => {
    const runtime = makeRuntime(fakeRunner({ '-V': exitError(127, 'tmux: command not found') }));
    const result = await runtime.checkTmuxAsync();
    expect(result.available).toBe(false);
    expect(result.transport).toBe(false);
  });

  it('reports a transport failure distinctly (host unreachable, tmux state unknown)', async () => {
    const runtime = makeRuntime(fakeRunner({ '-V': transportError() }));
    const result = await runtime.checkTmuxAsync();
    expect(result.available).toBe(false);
    expect(result.transport).toBe(true);
    expect(result.error).toBeTruthy();
  });

  it('exposes its host name and type', () => {
    const runtime = makeRuntime(fakeRunner({}));
    expect(runtime.host).toBe(HOST);
    expect(runtime.type).toBe('tmux');
  });
});

describe('createHostTerminalRuntime.createDetachedSessionAsync', () => {
  it('creates a durable session on the host without opening a PTY', async () => {
    const runner = fakeRunner({ 'has-session': exitError(1, 'no such session') });
    await makeRuntime(runner).createDetachedSessionAsync({ cwd: '/srv/app', cols: 120, rows: 32, sessionId: 'proj-2' });
    expect(runner.tmuxCalls('new-session')[0].args).toEqual(['new-session', '-d', '-s', 'proj-2', '-c', '/srv/app', '-x', '120', '-y', '32']);
    expect(runner.spawnPty).not.toHaveBeenCalled();
  });

  it('refuses a reserved id that already has a session on the host', async () => {
    const runner = fakeRunner({});
    await expect(makeRuntime(runner).createDetachedSessionAsync({ cwd: '/srv/app', cols: 120, rows: 32, sessionId: 'proj-2' })).rejects.toThrow(/already exists/);
    expect(runner.tmuxCalls('new-session')).toHaveLength(0);
  });

  it('treats an unreachable host as a transport failure, never as a missing session', async () => {
    const runner = fakeRunner({ 'has-session': transportError() });
    await expect(makeRuntime(runner).createDetachedSessionAsync({ cwd: '/srv/app', cols: 120, rows: 32, sessionId: 'proj-2' })).rejects.toThrow(/connect timeout/);
    expect(runner.tmuxCalls('new-session')).toHaveLength(0);
  });
});

describe('createHostTerminalRuntime.getSessionActivityAsync', () => {
  it('reads the exact session\'s last activity from tmux in milliseconds', async () => {
    const runner = fakeRunner({ 'display-message': '1794300000\n' });
    expect(await makeRuntime(runner).getSessionActivityAsync('Equinox Local-15')).toBe(1794300000000);
    expect(runner.tmuxCalls('display-message')[0].args).toEqual(['display-message', '-p', '-t', '=Equinox_Local-15:', '#{session_activity}']);
  });
  it.each(['', 'soon', '-5', '0'])('rejects tmux output %j instead of inventing a time', async output => {
    const runner = fakeRunner({ 'display-message': output });
    await expect(makeRuntime(runner).getSessionActivityAsync('proj-1')).rejects.toThrow(/activity/);
  });
});
