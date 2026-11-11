import { beforeEach, expect, it, vi } from 'vitest';
const { execFileSync, execFile, spawn } = vi.hoisted(() => ({ execFileSync: vi.fn(), execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('child_process', () => ({ execFileSync, execFile }));
vi.mock('node-pty', () => ({ spawn }));
import { createTerminalRuntime, createHostTerminalRuntime } from '../terminal-runtime.js';
const UUID = 'f8074056-8d77-42cc-910b-dc96b2cbba7a';
const OPTION = '@codedeck_incarnation';
beforeEach(() => { execFileSync.mockReset(); execFile.mockReset(); spawn.mockReset(); spawn.mockReturnValue({ kill() {} }); });
function local(initial) {
  let stored = initial;
  execFileSync.mockImplementation((_command, args) => {
    if (args[0] === 'show-options') return stored === undefined ? '' : `${stored}\n`;
    if (args[0] === 'set-option' && args.includes(OPTION)) { stored ??= args.at(-1); return ''; }
    if (args[0] === '-V') return 'tmux 3.8';
    return '';
  });
  return { runtime: createTerminalRuntime('tmux'), replace: value => { stored = value; } };
}
function remote(initial) {
  let stored = initial;
  const runner = { run: vi.fn(async (_command, args) => {
    if (args[0] === 'show-options') return { stdout: stored === undefined ? '' : `${stored}\n`, stderr: '' };
    if (args[0] === 'set-option' && args.includes(OPTION)) stored ??= args.at(-1);
    return { stdout: '', stderr: '' };
  }), spawnPty: vi.fn(() => ({ kill() {} })) };
  return { runtime: createHostTerminalRuntime(runner, 'remote'), runner, replace: value => { stored = value; } };
}
it('reads existing local durable identity without writing and uses an exact tmux target', () => {
  const { runtime } = local(UUID); expect(runtime.getSessionIncarnation('Demo-1')).toBe(UUID);
  expect(execFileSync).toHaveBeenCalledWith('tmux', ['show-options', '-qv', '-t', '=Demo-1:', OPTION], expect.objectContaining({ encoding: 'utf8', timeout: expect.any(Number) }));
  expect(execFileSync.mock.calls.some(([, args]) => args[0] === 'set-option')).toBe(false);
});
it('initializes a legacy local session once and changes identity after external recreation', () => {
  const { runtime, replace } = local(undefined); const original = runtime.getSessionIncarnation('Demo-1');
  expect(original).toMatch(/^[0-9a-f-]{36}$/); expect(runtime.getSessionIncarnation('Demo-1')).toBe(original);
  replace(undefined); expect(runtime.getSessionIncarnation('Demo-1')).not.toBe(original);
  expect(execFileSync.mock.calls.filter(([, args]) => args.includes(OPTION) && args[0] === 'set-option').every(([, args]) => args.includes('-oq'))).toBe(true);
});
it('preserves remote identity with racing initializers and never touches local tmux', async () => {
  const { runtime, runner } = remote(undefined);
  const results = await Promise.all([runtime.getSessionIncarnationAsync('Demo-1'), runtime.getSessionIncarnationAsync('Demo-1')]);
  expect(results[0]).toMatch(/^[0-9a-f-]{36}$/); expect(results[1]).toBe(results[0]);
  expect(execFileSync).not.toHaveBeenCalled(); expect(runner.run.mock.calls.every(([cmd, args, opts]) => cmd === 'tmux' && args.includes('=Demo-1:') && opts.timeout > 0)).toBe(true);
});
it('does not reuse an old remote incarnation after same-name recreation', async () => {
  const { runtime, replace } = remote(UUID); expect(await runtime.getSessionIncarnationAsync('Demo-1')).toBe(UUID);
  replace(undefined); expect(await runtime.getSessionIncarnationAsync('Demo-1')).not.toBe(UUID);
});
it.each([null, '', '   ', 'a'.repeat(300), 'bad\nvalue'])('rejects invalid session identity %j', async sessionId => {
  const { runtime } = local(UUID); expect(() => runtime.getSessionIncarnation(sessionId)).toThrow(/sessionId/);
  const remoteRuntime = remote(UUID).runtime; await expect(remoteRuntime.getSessionIncarnationAsync(sessionId)).rejects.toThrow(/sessionId/);
});
it.each(['not-a-uuid', 'private\ninvalid', null])('fails loudly on invalid persisted incarnation without exposing contents', async value => {
  const { runtime } = local(value); expect(() => runtime.getSessionIncarnation('Demo-1')).toThrow(/incarnation.*Demo-1/);
  const remoteRuntime = remote(value).runtime; await expect(remoteRuntime.getSessionIncarnationAsync('Demo-1')).rejects.toThrow(/incarnation.*Demo-1/);
});
it('fails loudly when initialization cannot be read back', () => {
  const { runtime } = local(undefined); execFileSync.mockReturnValue('');
  expect(() => runtime.getSessionIncarnation('Demo-1')).toThrow(/incarnation/);
});
it('propagates remote transport failure rather than allocating a replacement identity', async () => {
  const { runtime, runner } = remote(UUID); runner.run.mockRejectedValue(Object.assign(new Error('unreachable'), { code: 255 }));
  await expect(runtime.getSessionIncarnationAsync('Demo-1')).rejects.toMatchObject({ code: 255 }); expect(runner.run).toHaveBeenCalledTimes(1);
});
it('initializes a session option before local and remote PTY attachment', async () => {
  const { runtime } = local(undefined); runtime.spawn({ cwd: '/tmp', cols: 80, rows: 24, sessionId: 'Demo-1' });
  expect(execFileSync.mock.calls.some(([, args]) => args[0] === 'set-option' && args.includes(OPTION))).toBe(true);
  const { runtime: remoteRuntime, runner } = remote(undefined); await remoteRuntime.spawnAsync({ cwd: '/tmp', cols: 80, rows: 24, sessionId: 'Demo-1' });
  expect(runner.run.mock.calls.some(([, args]) => args[0] === 'set-option' && args.includes(OPTION))).toBe(true);
});
it('reads and initializes local async identities through bounded execFile calls', async () => {
  let stored;
  const { runtime } = local(undefined);
  execFile.mockImplementation((_cmd, args, options, callback) => {
    if (args[0] === 'set-option') stored ??= args.at(-1);
    // The mocked execFile has no Node custom promisifier, so return its promised shape.
    callback(null, { stdout: args[0] === 'show-options' ? `${stored ?? ''}\n` : '', stderr: '' });
  });
  const identity = await runtime.getSessionIncarnationAsync('Demo-1');
  expect(identity).toMatch(/^[0-9a-f-]{36}$/); expect(await runtime.getSessionIncarnationAsync('Demo-1')).toBe(identity);
  expect(execFile.mock.calls.every(([cmd, args, options]) => cmd === 'tmux' && args.includes('=Demo-1:') && options.timeout > 0)).toBe(true);
});
