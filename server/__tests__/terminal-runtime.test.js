import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();
const ptySpawn = vi.fn();

vi.mock('child_process', () => ({
  execFileSync,
}));

vi.mock('node-pty', () => ({
  spawn: ptySpawn,
}));

describe('createTerminalRuntime', () => {
  beforeEach(() => {
    execFileSync.mockReset();
    ptySpawn.mockReset();
    ptySpawn.mockReturnValue({});
  });

  it('keeps tmux unavailable instead of falling back to raw pty', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command === 'tmux' && args[0] === '-V') throw new Error('tmux missing');
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const {
      createTerminalRuntime,
      getTerminalRuntimeStatus,
      TERMINAL_RUNTIME_BLOCKED_MESSAGE,
    } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.type).toBe('tmux');
    expect(runtime.isAvailable()).toBe(false);
    expect(getTerminalRuntimeStatus(runtime)).toMatchObject({
      terminalRuntime: 'tmux',
      terminalRuntimeContract: 'tmux_required',
      tmuxAvailable: false,
      terminalCreationAllowed: false,
      terminalRuntimeBlockedReason: 'missing_tmux',
      terminalRuntimeBlockedMessage: TERMINAL_RUNTIME_BLOCKED_MESSAGE,
    });
    expect(() => runtime.spawn({ cwd: '/tmp/demo', cols: 120, rows: 30, sessionId: 'demo-1' })).toThrow(TERMINAL_RUNTIME_BLOCKED_MESSAGE);
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  it('ignores explicit pty mode requests and still uses the tmux runtime contract', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command === 'tmux' && args[0] === '-V') return 'tmux 3.4';
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('pty');

    expect(runtime.type).toBe('tmux');
    expect(runtime.isAvailable()).toBe(true);
  });

  it('reads the live cwd from tmux for tmux-backed sessions', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'display-message') return '/tmp/live\n';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionCwd({ cwd: '/tmp/original' }, 'demo-1')).toBe('/tmp/live');
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['display-message', '-p', '-t', 'demo-1', '#{pane_current_path}'],
      { stdio: 'pipe', encoding: 'utf8' }
    );
  });

  it('can resize a durable tmux session window before reconnect snapshot capture', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'resize-window') return '';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    runtime.resizeSession('demo-1', 80, 24);

    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['resize-window', '-t', 'demo-1:0', '-x', '80', '-y', '24'],
      { stdio: 'pipe' }
    );
  });

  it('falls back to the stored cwd when tmux cwd lookup fails', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'display-message') throw new Error('tmux not reachable');
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionCwd({ cwd: '/tmp/original' }, 'demo-1')).toBe('/tmp/original');
  });

  it('sets the tmux window history limit before creating a new session so the first pane keeps the full snapshot window', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'has-session') throw new Error('missing session');
      if (args[0] === 'new-session') return '';
      if (args[0] === 'set-option') return '';
      if (args[0] === 'set-window-option') return '';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime, TERMINAL_SNAPSHOT_WINDOW_LINES } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    runtime.spawn({ cwd: '/tmp/demo', cols: 120, rows: 30, sessionId: 'demo-1' });

    const globalHistoryIndex = execFileSync.mock.calls.findIndex(([, args]) => (
      args[0] === 'set-window-option'
      && args[1] === '-g'
      && args[2] === 'history-limit'
      && args[3] === String(TERMINAL_SNAPSHOT_WINDOW_LINES)
    ));
    const newSessionIndex = execFileSync.mock.calls.findIndex(([, args]) => args[0] === 'new-session');

    expect(globalHistoryIndex).toBeGreaterThanOrEqual(0);
    expect(newSessionIndex).toBeGreaterThan(globalHistoryIndex);
  });

  it('keeps tmux mouse mode off when spawning a durable session so browser selection still works', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'has-session') throw new Error('missing session');
      if (args[0] === 'new-session') return '';
      if (args[0] === 'set-option') return '';
      if (args[0] === 'set-window-option') return '';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    runtime.spawn({ cwd: '/tmp/demo', cols: 120, rows: 30, sessionId: 'demo-1' });

    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['set-option', '-t', 'demo-1', 'mouse', 'off'],
      { stdio: 'pipe' }
    );
  });

  it('does not expose legacy tmux history helpers that used to drive copy-mode scrolling', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionScrollback).toBeUndefined();
    expect(runtime.scrollSessionHistory).toBeUndefined();
  });

  it('captures authoritative snapshots capped to the most recent 10,000 lines', async () => {
    const snapshotLines = Array.from({ length: 10020 }, (_, index) => `line ${index + 1}`).join('\n');

    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'display-message') return '40\n';
      if (args[0] === 'capture-pane') return snapshotLines;
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime, TERMINAL_SNAPSHOT_WINDOW_LINES } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');
    const snapshot = runtime.captureSessionSnapshot('demo-1');

    expect(snapshot.windowLines).toBe(TERMINAL_SNAPSHOT_WINDOW_LINES);
    expect(snapshot.lineCount).toBe(TERMINAL_SNAPSHOT_WINDOW_LINES);
    expect(snapshot.data.startsWith('line 21\r\n')).toBe(true);
    expect(snapshot.data.endsWith('line 10020\r\n')).toBe(true);
    expect(snapshot.historyGuaranteed).toBe(true);
    expect(snapshot.historyWarningReason).toBeNull();
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['capture-pane', '-p', '-S', '-9960', '-t', 'demo-1'],
      { stdio: 'pipe', encoding: 'utf8' }
    );
  });

  it('captures alternate-screen snapshots with terminal state metadata for modeful restores', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'display-message' && args[4] === '#{alternate_on}\t#{pane_in_mode}\t#{pane_mode}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{cursor_shape}\t#{cursor_blinking}\t#{cursor_very_visible}\t#{insert_flag}\t#{origin_flag}\t#{wrap_flag}\t#{keypad_flag}\t#{keypad_cursor_flag}\t#{mouse_standard_flag}\t#{mouse_button_flag}\t#{mouse_all_flag}\t#{mouse_utf8_flag}\t#{mouse_sgr_flag}\t#{bracketed_paste_flag}') {
        return '1\t0\t\t4\t2\t1\tbar\t0\t0\t0\t0\t1\t0\t1\t0\t0\t1\t0\t1\t1\n';
      }
      if (args[0] === 'capture-pane') return '\x1b[32m~\x1b[39m\n';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');
    const snapshot = runtime.captureSessionSnapshot('demo-1');

    expect(snapshot).toMatchObject({
      data: '\x1b[32m~\x1b[39m\r\n',
      lineCount: 1,
      historyGuaranteed: true,
      terminalState: {
        screenMode: 'alternate',
        cursorX: 4,
        cursorY: 2,
        cursorShape: 'bar',
        cursorBlinking: false,
        keypadMode: false,
        applicationCursorKeys: true,
        mouseMode: 'all',
        mouseEncoding: 'sgr',
        bracketedPaste: true,
      },
    });
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['capture-pane', '-p', '-a', '-e', '-N', '-t', 'demo-1'],
      { stdio: 'pipe', encoding: 'utf8' }
    );
  });

  it('captures tmux mode screens instead of the primary pane buffer when the pane is in a tmux mode', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'display-message' && args[4] === '#{alternate_on}\t#{pane_in_mode}\t#{pane_mode}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{cursor_shape}\t#{cursor_blinking}\t#{cursor_very_visible}\t#{insert_flag}\t#{origin_flag}\t#{wrap_flag}\t#{keypad_flag}\t#{keypad_cursor_flag}\t#{mouse_standard_flag}\t#{mouse_button_flag}\t#{mouse_all_flag}\t#{mouse_utf8_flag}\t#{mouse_sgr_flag}\t#{bracketed_paste_flag}') {
        return '0\t1\tcopy-mode\t1\t3\t1\tblock\t1\t0\t0\t0\t1\t0\t0\t0\t0\t0\t0\t0\t0\n';
      }
      if (args[0] === 'capture-pane') return 'copy mode line\n';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');
    const snapshot = runtime.captureSessionSnapshot('demo-1');

    expect(snapshot).toMatchObject({
      data: 'copy mode line\r\n',
      lineCount: 1,
      terminalState: {
        screenMode: 'mode',
        paneMode: 'copy-mode',
      },
    });
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['capture-pane', '-p', '-M', '-e', '-N', '-t', 'demo-1'],
      { stdio: 'pipe', encoding: 'utf8' }
    );
  });

  it('marks preserved history unavailable when tmux snapshot capture fails', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'display-message') return '40\n';
      if (args[0] === 'capture-pane') throw new Error('capture failed');
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const {
      createTerminalRuntime,
      TERMINAL_HISTORY_WARNING_MESSAGE_SNAPSHOT_UNAVAILABLE,
      TERMINAL_SNAPSHOT_WINDOW_LINES,
    } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');
    const snapshot = runtime.captureSessionSnapshot('demo-1');

    expect(snapshot).toEqual({
      data: '',
      lineCount: 0,
      windowLines: TERMINAL_SNAPSHOT_WINDOW_LINES,
      historyGuaranteed: false,
      historyWarningReason: 'snapshot_unavailable',
      historyWarningMessage: TERMINAL_HISTORY_WARNING_MESSAGE_SNAPSHOT_UNAVAILABLE,
    });
  });

  it('lists durable tmux session ids', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'list-sessions') return 'demo-1\ndemo-3\n';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.listSessionIds()).toEqual(['demo-1', 'demo-3']);
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['list-sessions', '-F', '#S'],
      { stdio: 'pipe', encoding: 'utf8' }
    );
  });
});
