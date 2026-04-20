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

  it('returns the stored cwd for raw pty sessions', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command === 'tmux' && args[0] === '-V') return 'tmux 3.4';
      throw new Error('unexpected command');
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('pty');

    expect(runtime.getSessionCwd({ cwd: '/tmp/original' }, 'demo-1')).toBe('/tmp/original');
    expect(runtime.getSessionScrollback('demo-1')).toBe('');
    expect(runtime.listSessionIds()).toEqual([]);
    expect(execFileSync).not.toHaveBeenCalled();
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

  it('keeps tmux mouse mode off when spawning a durable session so browser selection still works', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'has-session') throw new Error('missing session');
      if (args[0] === 'new-session') return '';
      if (args[0] === 'set-option') return '';
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

  it('scrolls tmux history up and exits copy mode when scrolling back down to the live bottom', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'display-message' && args[4] === '#{pane_id}') return '%7\n';
      if (args[0] === 'display-message' && args[4] === '#{pane_in_mode}') {
        return execFileSync.mock.calls.some(([, a]) => a[0] === 'copy-mode') ? '1\n' : '0\n';
      }
      if (args[0] === 'display-message' && args[4] === '#{scroll_position}') return '0\n';
      if (args[0] === 'copy-mode') return '';
      if (args[0] === 'send-keys') return '';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.scrollSessionHistory('demo-1', { direction: 'up', lines: 5 })).toBe(true);
    expect(runtime.scrollSessionHistory('demo-1', { direction: 'down', lines: 5 })).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith('tmux', ['copy-mode', '-t', '%7'], { stdio: 'pipe' });
    expect(execFileSync).toHaveBeenCalledWith('tmux', ['send-keys', '-X', '-t', '%7', '-N', '5', 'scroll-up'], { stdio: 'pipe' });
    expect(execFileSync).toHaveBeenCalledWith('tmux', ['send-keys', '-X', '-t', '%7', '-N', '5', 'scroll-down'], { stdio: 'pipe' });
    expect(execFileSync).toHaveBeenCalledWith('tmux', ['send-keys', '-X', '-t', '%7', 'cancel'], { stdio: 'pipe' });
  });

  it('captures tmux scrollback above the current viewport', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command !== 'tmux') throw new Error('unexpected command');
      if (args[0] === '-V') return 'tmux 3.4';
      if (args[0] === 'display-message') return '50\n';
      if (args[0] === 'capture-pane') return 'older line 1\nolder line 2';
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('tmux');

    expect(runtime.getSessionScrollback('demo-1')).toBe('older line 1\nolder line 2\n');
    expect(execFileSync).toHaveBeenCalledWith(
      'tmux',
      ['capture-pane', '-pJ', '-S', '-', '-E', '-50', '-t', 'demo-1'],
      { stdio: 'pipe', encoding: 'utf8' }
    );
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
