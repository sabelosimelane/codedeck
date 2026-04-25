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

  it('reports a non-shell foreground tmux command as running', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'display-message') return 'npm\t0\n';
      if (args[0] === 'capture-pane') return 'running tests without output\n';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionExecutionState('demo-1')).toEqual({
      executionStatus: 'running',
      foregroundCommand: 'npm',
    });
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['display-message', '-p', '-t', 'demo-1', '#{pane_current_command}\t#{pane_dead}'],
      { stdio: 'pipe', encoding: 'utf8' }
    );
  });

  it('keeps a working agent CLI pane running even when its prompt line is visible', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'display-message') return 'node\t0\n';
      if (args[0] === 'capture-pane') return [
        '• Working (34s • esc to interrupt)',
        '',
        '› Summarize recent commits',
        '',
        '  gpt-5.5 medium · ~/git/mace/backend',
      ].join('\n');
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionExecutionState('demo-1')).toEqual({
      executionStatus: 'running',
      foregroundCommand: 'node',
    });
  });

  it('reports a completed agent CLI pane as idle when the prompt is visible', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'display-message') return '2.1.114\t0\n';
      if (args[0] === 'capture-pane') return [
        'Want me to also verify there are not other blocks?',
        '',
        '───────────────────────────────────────────────────────────',
        '❯',
        '───────────────────────────────────────────────────────────',
        '  sabside ~/git/equinox/backend Opus 4.7',
      ].join('\n');
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionExecutionState('demo-1')).toEqual({
      executionStatus: 'idle',
      foregroundCommand: '2.1.114',
    });
  });

  it('reports an idle Codex CLI pane as idle when the input prompt is visible', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'display-message') return 'node\t0\n';
      if (args[0] === 'capture-pane') return [
        'Remaining risk: I did not run a live browser/API smoke',
        '',
        '',
        '› Summarize recent commits',
        '',
        '  gpt-5.5 medium · ~/git/equinox/backend',
      ].join('\n');
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionExecutionState('demo-1')).toEqual({
      executionStatus: 'idle',
      foregroundCommand: 'node',
    });
  });

  it('reports an interactive shell foreground tmux command as idle', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'display-message') return 'zsh\t0\n';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionExecutionState('demo-1')).toEqual({
      executionStatus: 'idle',
      foregroundCommand: 'zsh',
    });
  });

  it('reports unknown execution state when tmux foreground lookup fails', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'display-message') throw new Error('tmux not reachable');
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionExecutionState('demo-1')).toEqual({
      executionStatus: 'unknown',
      foregroundCommand: null,
    });
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

  it('still creates a new tmux session when global history options fail before a tmux server exists', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.6a';
      if (args[0] === 'has-session') throw new Error('missing session');
      if (args[0] === 'new-session') return '';
      if (args[0] === 'set-option') return '';
      if (args[0] === 'set-window-option') {
        if (args[1] === '-g') {
          throw new Error('error connecting to /private/tmp/tmux-502/default (No such file or directory)');
        }
        return '';
      }
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(() => runtime.spawn({ cwd: '/tmp/demo', cols: 120, rows: 30, sessionId: 'demo-1' })).not.toThrow();
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      [
        'new-session', '-d',
        '-s', 'demo-1',
        '-c', '/tmp/demo',
        '-x', '120',
        '-y', '30',
      ],
      { stdio: 'pipe' }
    );
    expect(ptySpawn).toHaveBeenCalledWith('tmux', ['attach-session', '-t', 'demo-1'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: '/tmp/demo',
    });
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

  it('truncates primary-screen rows to the current pane width so restored scrollback does not wrap in xterm', async () => {
    // Historical tmux scrollback is stored at its original render width. When
    // the pane was rendered wider than it is now (e.g. the user resized the
    // browser pane narrower), capture-pane still returns those historical rows
    // at their original wide length. Writing rows wider than xterm.cols causes
    // xterm to auto-wrap each one, stamping a visible column of box-border
    // remnants down the right edge of the viewport.
    const paneWidth = 40;
    const wideRow = '│ content that exceeds the current pane width │';
    const capturedOutput = `${wideRow}\n${wideRow}\n`;

    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'display-message') {
        const format = args[args.length - 1];
        if (format === '#{pane_height}') return '20\n';
        if (format === '#{pane_width}') return `${paneWidth}\n`;
        // Default pane-state query — primary screen, no special modes.
        return '0\t0\t\t0\t0\t1\tblock\t0\t0\t0\t0\t1\t0\t0\t0\t0\t0\t0\t0\t0\n';
      }
      if (args[0] === 'capture-pane') return capturedOutput;
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');
    const snapshot = runtime.captureSessionSnapshot('demo-1');

    const rows = snapshot.data.split('\r\n').filter(Boolean);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.length).toBeLessThanOrEqual(paneWidth);
    }
  });

  it('clamps primary-screen rows by terminal display cells rather than UTF-16 code units', async () => {
    // pane_width is a terminal cell count, not a string length. CJK glyphs,
    // most emoji and Hangul syllables occupy two cells each, while combining
    // marks and variation selectors are zero-width. If we truncate by
    // String.prototype length/slice we let rows slip past the pane width
    // (wide chars) or cut mid-grapheme (surrogate pairs, combining marks),
    // and the original right-edge wrap artifact returns.
    const paneWidth = 10; // 10 terminal cells
    // 7 Hiragana/CJK glyphs = 14 cells — more than double the pane width.
    // A naive slice(0, 10) would keep all 7 glyphs (they are 1 UTF-16 unit
    // each in the BMP), producing a 14-cell row that still wraps.
    const cjkRow = '日本語あいうえ';
    // Combining-mark + wide mix: base 'e' + combining acute, then a rocket
    // emoji (surrogate pair, 2 cells). Grapheme-aware truncation must keep
    // each cluster intact rather than splitting the surrogate pair.
    const mixedRow = `e${String.fromCodePoint(0x0301)}🚀 rocket-padded-so-it-is-wider-than-pane`;

    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'display-message') {
        const format = args[args.length - 1];
        if (format === '#{pane_height}') return '20\n';
        if (format === '#{pane_width}') return `${paneWidth}\n`;
        return '0\t0\t\t0\t0\t1\tblock\t0\t0\t0\t0\t1\t0\t0\t0\t0\t0\t0\t0\t0\n';
      }
      if (args[0] === 'capture-pane') return `${cjkRow}\n${mixedRow}\n`;
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');
    const snapshot = runtime.captureSessionSnapshot('demo-1');

    const rows = snapshot.data.split('\r\n').filter(Boolean);
    expect(rows.length).toBe(2);

    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const measureCells = (text) => {
      let cells = 0;
      for (const { segment } of segmenter.segment(text)) {
        const cp = segment.codePointAt(0);
        const isWide = (
          (cp >= 0x1100 && cp <= 0x115F)
          || (cp >= 0x2E80 && cp <= 0x303E)
          || (cp >= 0x3041 && cp <= 0x33FF)
          || (cp >= 0x3400 && cp <= 0x4DBF)
          || (cp >= 0x4E00 && cp <= 0x9FFF)
          || (cp >= 0xA000 && cp <= 0xA4CF)
          || (cp >= 0xAC00 && cp <= 0xD7A3)
          || (cp >= 0xF900 && cp <= 0xFAFF)
          || (cp >= 0xFE30 && cp <= 0xFE4F)
          || (cp >= 0xFF00 && cp <= 0xFF60)
          || (cp >= 0xFFE0 && cp <= 0xFFE6)
          || (cp >= 0x1F300 && cp <= 0x1F64F)
          || (cp >= 0x1F680 && cp <= 0x1F6FF)
          || (cp >= 0x1F900 && cp <= 0x1F9FF)
          || (cp >= 0x1FA00 && cp <= 0x1FAFF)
          || (cp >= 0x20000 && cp <= 0x2FFFD)
          || (cp >= 0x30000 && cp <= 0x3FFFD)
        );
        cells += isWide ? 2 : 1;
      }
      return cells;
    };

    // Every restored row must fit inside the live pane — measured in cells.
    for (const row of rows) {
      expect(measureCells(row)).toBeLessThanOrEqual(paneWidth);
    }

    // The mixed row must not lose surrogate pair halves during truncation.
    // If any codepoint above the BMP (e.g. the rocket emoji) survives, both
    // UTF-16 code units must appear together.
    for (const row of rows) {
      for (let i = 0; i < row.length; i += 1) {
        const code = row.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
          // high surrogate — next code unit must be a low surrogate
          const next = row.charCodeAt(i + 1);
          expect(next).toBeGreaterThanOrEqual(0xDC00);
          expect(next).toBeLessThanOrEqual(0xDFFF);
          i += 1;
        }
      }
    }
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

describe('terminal cell width helpers', () => {
  it('counts regional-indicator flag emojis as two cells', async () => {
    // Flag graphemes are two regional indicator codepoints (e.g. 🇿🇦 =
    // RI_Z + RI_A). Intl.Segmenter groups them into a single grapheme whose
    // first codepoint sits in the 0x1F1E6–0x1F1FF block. xterm renders that
    // grapheme as two cells (UAX #11 classifies regional indicators as
    // Wide), so the width helper must do the same or narrow-pane truncation
    // still lets flag-bearing rows overflow and wrap in the live viewport.
    const { measureTerminalCellWidth, truncateToTerminalCells } = await import('../terminal-runtime.js');
    expect(measureTerminalCellWidth('🇿🇦')).toBe(2);
    expect(measureTerminalCellWidth('🇺🇸')).toBe(2);
    // Two flags should be 4 cells and fit exactly in a 4-cell pane.
    expect(measureTerminalCellWidth('🇿🇦🇺🇸')).toBe(4);
    // In a 3-cell pane only the first flag fits; the second must be dropped
    // whole rather than sliced through the middle of a regional indicator.
    const truncated = truncateToTerminalCells('🇿🇦🇺🇸', 3);
    expect(measureTerminalCellWidth(truncated)).toBeLessThanOrEqual(3);
    expect(truncated).toBe('🇿🇦');
  });

  it('counts VS16-promoted emoji graphemes as two cells', async () => {
    const { measureTerminalCellWidth, truncateToTerminalCells } = await import('../terminal-runtime.js');
    const airplane = '\u2708\uFE0F';
    const checkbox = '\u2611\uFE0F';

    // These glyphs live in otherwise narrow blocks and only become emoji-width
    // when FE0F promotes them to emoji presentation.
    expect(measureTerminalCellWidth(airplane)).toBe(2);
    expect(measureTerminalCellWidth(checkbox)).toBe(2);

    const truncated = truncateToTerminalCells(`${airplane}${checkbox}`, 3);
    expect(measureTerminalCellWidth(truncated)).toBeLessThanOrEqual(3);
    expect(truncated).toBe(airplane);
  });

  it('counts keycap emoji graphemes as two cells', async () => {
    const { measureTerminalCellWidth, truncateToTerminalCells } = await import('../terminal-runtime.js');
    const oneKeycap = '\u0031\uFE0F\u20E3';
    const twoKeycap = '\u0032\uFE0F\u20E3';

    expect(measureTerminalCellWidth(oneKeycap)).toBe(2);
    expect(measureTerminalCellWidth(twoKeycap)).toBe(2);

    const truncated = truncateToTerminalCells(`${oneKeycap}${twoKeycap}`, 3);
    expect(measureTerminalCellWidth(truncated)).toBeLessThanOrEqual(3);
    expect(truncated).toBe(oneKeycap);
  });

  it('falls back to manual grapheme grouping when Intl.Segmenter is unavailable', async () => {
    const segmenterDescriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');

    vi.resetModules();
    Object.defineProperty(Intl, 'Segmenter', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const { measureTerminalCellWidth, truncateToTerminalCells } = await import('../terminal-runtime.js');

      expect(measureTerminalCellWidth('🇿🇦')).toBe(2);
      expect(measureTerminalCellWidth('\u2708\uFE0F')).toBe(2);
      expect(measureTerminalCellWidth('\u0031\uFE0F\u20E3')).toBe(2);

      const truncated = truncateToTerminalCells('🇿🇦\u2708\uFE0F\u0031\uFE0F\u20E3', 5);
      expect(measureTerminalCellWidth(truncated)).toBeLessThanOrEqual(5);
      expect(truncated).toBe('🇿🇦\u2708\uFE0F');
    } finally {
      vi.resetModules();
      if (segmenterDescriptor) {
        Object.defineProperty(Intl, 'Segmenter', segmenterDescriptor);
      } else {
        Reflect.deleteProperty(Intl, 'Segmenter');
      }
    }
  });

  it('counts BMP emoji-presentation codepoints below U+1F000 as two cells', async () => {
    // Unicode EAW (UAX #11) classifies scattered codepoints in the 0x23xx,
    // 0x25xx, 0x26xx, 0x27xx and 0x2Bxx blocks as Wide — xterm renders them
    // as two cells. A width table that only covers the contiguous 0x1Fxxx
    // emoji planes still lets rows containing status glyphs (✅/❌/⏳) or
    // sports/weather/zodiac emoji (⚽/⛄/♈) exceed pane_width after truncate,
    // which reopens the right-edge wrap regression for any shell that prints
    // those characters in progress output or prompt decorations.
    const { measureTerminalCellWidth, truncateToTerminalCells } = await import('../terminal-runtime.js');

    const wideSamples = [
      '\u231A',   // ⌚ watch
      '\u231B',   // ⌛ hourglass
      '\u23F0',   // ⏰ alarm clock
      '\u23F3',   // ⏳ hourglass with flowing sand
      '\u25FD',   // ◽ white medium small square
      '\u2614',   // ☔ umbrella with rain
      '\u2648',   // ♈ Aries
      '\u267F',   // ♿ wheelchair symbol
      '\u2693',   // ⚓ anchor
      '\u26A1',   // ⚡ high voltage
      '\u26BD',   // ⚽ soccer ball
      '\u26C4',   // ⛄ snowman without snow
      '\u26D4',   // ⛔ no entry
      '\u26F5',   // ⛵ sailboat
      '\u2705',   // ✅ white heavy check mark
      '\u270A',   // ✊ raised fist
      '\u2728',   // ✨ sparkles
      '\u274C',   // ❌ cross mark
      '\u2753',   // ❓ question mark
      '\u2757',   // ❗ heavy exclamation mark
      '\u2795',   // ➕ heavy plus sign
      '\u27B0',   // ➰ curly loop
      '\u2B1B',   // ⬛ black large square
      '\u2B50',   // ⭐ white medium star
      '\u2B55',   // ⭕ heavy large circle
    ];
    for (const glyph of wideSamples) {
      expect(measureTerminalCellWidth(glyph)).toBe(2);
    }

    // A '✅ OK' row measures 2 + 1 + 1 + 1 = 5 cells. In a 4-cell pane it has
    // to lose the trailing 'K' (or more) to fit — but only if ✅ is actually
    // measured as two cells. With the buggy 1-cell accounting the whole row
    // survives truncation and stays 4 visible string characters = 5 cells.
    const truncated = truncateToTerminalCells('\u2705 OK', 4);
    expect(measureTerminalCellWidth(truncated)).toBeLessThanOrEqual(4);
  });
});
