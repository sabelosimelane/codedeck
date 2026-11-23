import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../shutdown.js';

/** A stand-in for the timer, fired by hand. */
function timers() {
  const state = { fire: null, cleared: false, ms: null };
  return {
    state,
    setTimer: (fn, ms) => { state.fire = fn; state.ms = ms; return 'timer'; },
    clearTimer: (id) => { if (id === 'timer') state.cleared = true; },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('createShutdown', () => {
  it('keeps the process alive until work in progress is finished, then exits cleanly', async () => {
    let finish;
    const pending = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const exit = vi.fn();
    const log = vi.fn();
    const clock = timers();
    const shutdown = createShutdown({ pending, timeoutMs: 60000, exit, log, ...clock });
    shutdown('SIGTERM');
    await settle();
    expect(pending).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(clock.state.ms).toBe(60000);
    finish();
    await settle();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(clock.state.cleared).toBe(true);
    expect(log).toHaveBeenCalledWith('[shutdown] SIGTERM: finishing work in progress before exiting');
  });

  it('exits with a failure, and says so, when the work is still going at the limit', async () => {
    const exit = vi.fn();
    const log = vi.fn();
    const clock = timers();
    const shutdown = createShutdown({ pending: () => new Promise(() => {}), timeoutMs: 5000, exit, log, ...clock });
    shutdown('SIGTERM');
    await settle();
    clock.state.fire();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('[shutdown] work in progress did not finish within 5000 ms; exiting with it unfinished');
  });

  it('exits with a failure when waiting for the work throws', async () => {
    const exit = vi.fn();
    const log = vi.fn();
    const shutdown = createShutdown({ pending: async () => { throw new Error('queue broke'); }, timeoutMs: 5000, exit, log, ...timers() });
    shutdown('SIGINT');
    await settle();
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('[shutdown] could not wait for work in progress: queue broke');
  });

  it('acts on the first signal only', async () => {
    let finish;
    const pending = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const exit = vi.fn();
    const shutdown = createShutdown({ pending, timeoutMs: 5000, exit, log: vi.fn(), ...timers() });
    shutdown('SIGTERM');
    shutdown('SIGTERM');
    shutdown('SIGINT');
    await settle();
    finish();
    await settle();
    expect(pending).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pending', { pending: 'x' }],
    ['timeoutMs', { timeoutMs: 0 }],
    ['timeoutMs', { timeoutMs: 1.5 }],
    ['exit', { exit: null }],
    ['log', { log: undefined }],
    ['setTimer', { setTimer: 1 }],
    ['clearTimer', { clearTimer: 1 }],
  ])('refuses a bad %s', (name, bad) => {
    const good = { pending: async () => {}, timeoutMs: 1000, exit: () => {}, log: () => {}, setTimer: () => 1, clearTimer: () => {} };
    expect(() => createShutdown({ ...good, ...bad })).toThrow(new RegExp(name));
  });

  it('refuses a signal it was not given by name', () => {
    const shutdown = createShutdown({ pending: async () => {}, timeoutMs: 1000, exit: () => {}, log: () => {}, ...timers() });
    expect(() => shutdown()).toThrow(/signal/);
    expect(() => shutdown('')).toThrow(/signal/);
  });
});
