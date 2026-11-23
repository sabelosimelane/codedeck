import { describe, it, expect, vi } from 'vitest';
import { submitDetachedCommand } from '../../agent-history/submit.js';
const id = '11111111-1111-4111-8111-111111111111';
it('sends bracketed paste and then Enter to the runtime tmux name', async () => {
  const calls = [];
  await submitDetachedCommand('My Project-2', `claude --resume ${id}`, { execFile: (...args) => calls.push(args), sleep: async () => {} });
  expect(calls).toEqual([
    ['tmux', ['send-keys', '-t', '=My_Project-2:', '-l', `claude --resume ${id}`], { stdio: 'pipe' }],
    ['tmux', ['send-keys', '-t', '=My_Project-2:', 'Enter'], { stdio: 'pipe' }],
  ]);
});
it('rejects malformed command before touching tmux', async () => {
  const calls = [];
  await expect(submitDetachedCommand('Demo-1', 'echo unsafe', { execFile: (...args) => calls.push(args), sleep: async () => {} })).rejects.toThrow(/command/);
  expect(calls).toEqual([]);
});

describe('submitDetachedCommand awaiting', () => {
  it('does not resolve until deferred tmux submission completes', async () => {
    let resolveFirst;
    const firstGate = new Promise((resolve) => { resolveFirst = resolve; });
    const calls = [];
    const execFile = (...args) => {
      calls.push(args);
      if (calls.length === 1) return firstGate.then(() => ({ stdout: '', stderr: '' }));
      return Promise.resolve({ stdout: '', stderr: '' });
    };
    const pending = submitDetachedCommand('My Project-2', `claude --resume ${id}`, {
      execFile,
      sleep: async () => {},
    });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(calls).toHaveLength(1);
    resolveFirst();
    await pending;
    expect(settled).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1][1]).toContain('Enter');
  });

  it('propagates a deferred first-send failure without a second send', async () => {
    const failure = Object.assign(new Error('tmux send failed'), { code: 1 });
    let rejectFirst;
    const firstGate = new Promise((_, reject) => { rejectFirst = reject; });
    const execFile = vi.fn(() => firstGate);
    const pending = submitDetachedCommand('My Project-2', `claude --resume ${id}`, {
      execFile,
      sleep: async () => {},
    });
    const assertion = expect(pending).rejects.toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(execFile).toHaveBeenCalledTimes(1);
    rejectFirst(failure);
    await assertion;
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('propagates a deferred second-send failure', async () => {
    const failure = Object.assign(new Error('tmux enter failed'), { code: 1 });
    let rejectSecond;
    const secondGate = new Promise((_, reject) => { rejectSecond = reject; });
    const execFile = vi.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockImplementationOnce(() => secondGate);
    const pending = submitDetachedCommand('My Project-2', `claude --resume ${id}`, {
      execFile,
      sleep: async () => {},
    });
    const assertion = expect(pending).rejects.toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(execFile).toHaveBeenCalledTimes(2);
    rejectSecond(failure);
    await assertion;
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});

// The mocked cases above cannot tell whether tmux accepts the target, so this one drives a real session.
import { execFileSync } from 'node:child_process';
import { afterEach as afterEachReal, describe as describeReal, it as itReal, expect as expectReal } from 'vitest';
describeReal('submitDetachedCommand against real tmux', () => {
  const sessionId = `agenthist-test-${process.pid}-1`;
  afterEachReal(() => { execFileSync('tmux', ['kill-session', '-t', `=${sessionId}`], { stdio: 'pipe' }); });
  itReal('types the resume command into the detached session', async () => {
    // `cat` echoes what is typed, so nothing is executed.
    execFileSync('tmux', ['new-session', '-d', '-s', sessionId, '-x', '120', '-y', '10', 'cat'], { stdio: 'pipe' });
    const uuid = '11111111-1111-4111-8111-111111111111';
    await submitDetachedCommand(sessionId, `claude --resume ${uuid}`, { execFile: execFileSync, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
    await new Promise(resolve => setTimeout(resolve, 200));
    const screen = execFileSync('tmux', ['capture-pane', '-p', '-t', `=${sessionId}:`], { encoding: 'utf8' });
    expectReal(screen).toContain(`claude --resume ${uuid}`);
  });
});
describeReal('submitDetachedCommand typed text', () => {
  const sessionId = `agenthist-test-${process.pid}-2`;
  afterEachReal(() => { execFileSync('tmux', ['kill-session', '-t', `=${sessionId}`], { stdio: 'pipe' }); });
  itReal('leaves no paste escape markers on screen when the shell has not started its line editor yet', async () => {
    execFileSync('tmux', ['new-session', '-d', '-s', sessionId, '-x', '120', '-y', '10', 'cat -v'], { stdio: 'pipe' });
    await submitDetachedCommand(sessionId, 'codex resume 11111111-1111-4111-8111-111111111111', { execFile: execFileSync, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
    await new Promise(resolve => setTimeout(resolve, 200));
    const screen = execFileSync('tmux', ['capture-pane', '-p', '-t', `=${sessionId}:`], { encoding: 'utf8' });
    expectReal(screen).not.toContain('200~');
    expectReal(screen).toContain('codex resume 11111111-1111-4111-8111-111111111111');
  });
});
