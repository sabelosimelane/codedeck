import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.fn();

vi.mock('child_process', () => ({
  execFileSync,
}));

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

describe('createTerminalRuntime', () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it('returns the stored cwd for raw pty sessions', async () => {
    execFileSync.mockImplementation((command, args) => {
      if (command === 'tmux' && args[0] === '-V') return 'tmux 3.4';
      throw new Error('unexpected command');
    });

    const { createTerminalRuntime } = await import('../terminal-runtime.js');
    const runtime = createTerminalRuntime('pty');

    expect(runtime.getSessionCwd({ cwd: '/tmp/original' }, 'demo-1')).toBe('/tmp/original');
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
