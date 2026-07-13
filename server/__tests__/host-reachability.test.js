import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  HostUnreachableError,
  createHostReachabilityManager,
  createHostReachabilityState,
} from '../host-reachability.js';

function transportError(message = 'connect timeout') {
  return Object.assign(new Error(message), { code: 255 });
}

describe('host reachability state machine', () => {
  it('starts stored remote hosts as unknown and records a successful command as reachable', () => {
    const state = createHostReachabilityState({ now: () => 1000 });
    expect(state.getReachability('devbox')).toEqual({ reachability: 'unknown' });

    const result = state.recordSuccess('devbox');
    expect(result.recovered).toBe(false);
    expect(state.getReachability('devbox')).toEqual({ reachability: 'reachable' });
  });

  it('tolerates one or two transport blips without becoming unreachable', () => {
    const state = createHostReachabilityState({ now: () => 2000 });

    state.recordFailure('devbox', transportError('first blip'));
    expect(state.getReachability('devbox')).toEqual({
      reachability: 'failing',
      lastError: 'first blip',
    });

    state.recordFailure('devbox', transportError('second blip'));
    expect(state.getReachability('devbox')).toEqual({
      reachability: 'failing',
      lastError: 'second blip',
    });
  });

  it('transitions to unreachable on the third consecutive transport failure', () => {
    let t = 3000;
    const state = createHostReachabilityState({ now: () => t });

    state.recordFailure('devbox', transportError('one'));
    state.recordFailure('devbox', transportError('two'));
    t = 3333;
    const result = state.recordFailure('devbox', transportError('connect timeout'));

    expect(result.transitionedToUnreachable).toBe(true);
    expect(state.getReachability('devbox')).toEqual({
      reachability: 'unreachable',
      lastError: 'connect timeout',
      unreachableSince: 3333,
    });
  });

  it('resets the failure counter after a successful command', () => {
    let t = 4000;
    const state = createHostReachabilityState({ now: () => t });

    state.recordFailure('devbox', transportError('one'));
    state.recordFailure('devbox', transportError('two'));
    state.recordSuccess('devbox');
    t = 4444;
    state.recordFailure('devbox', transportError('new blip'));

    expect(state.getReachability('devbox')).toEqual({
      reachability: 'failing',
      lastError: 'new blip',
    });
  });

  it('marks a successful unreachable-host probe as recovered reachable', () => {
    let t = 5000;
    const state = createHostReachabilityState({ now: () => t });
    state.recordFailure('devbox', transportError('one'));
    state.recordFailure('devbox', transportError('two'));
    state.recordFailure('devbox', transportError('three'));

    t = 6000;
    const result = state.recordSuccess('devbox');

    expect(result.recovered).toBe(true);
    expect(state.getReachability('devbox')).toEqual({ reachability: 'reachable' });
  });
});

describe('host reachability probe manager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules unreachable probes with capped 5→10→20→40→60 second backoff', async () => {
    const probeHost = vi.fn(async () => { throw transportError('still down'); });
    const manager = createHostReachabilityManager({ probeHost });
    const host = { name: 'devbox', sshTarget: 'devbox' };

    manager.recordTransportFailure(host, transportError('one'));
    manager.recordTransportFailure(host, transportError('two'));
    manager.recordTransportFailure(host, transportError('three'));
    expect(manager.getReachability('devbox').reachability).toBe('unreachable');
    expect(probeHost).not.toHaveBeenCalled();

    const backoffs = [5, 10, 20, 40, 60, 60];
    for (let i = 0; i < backoffs.length; i += 1) {
      await vi.advanceTimersByTimeAsync(backoffs[i] * 1000 - 1);
      expect(probeHost).toHaveBeenCalledTimes(i);
      await vi.advanceTimersByTimeAsync(1);
      expect(probeHost).toHaveBeenCalledTimes(i + 1);
    }

    expect(probeHost).toHaveBeenCalledTimes(backoffs.length);
    expect(probeHost.mock.calls.map(call => call[0])).toEqual([host, host, host, host, host, host]);
  });

  it('clears the unreachable state, cancels further probes, and runs recovery callbacks when a probe succeeds', async () => {
    const onRecovered = vi.fn();
    const probeHost = vi.fn()
      .mockRejectedValueOnce(transportError('still down'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' });
    const manager = createHostReachabilityManager({ probeHost, onRecovered });
    const host = { name: 'devbox', sshTarget: 'devbox' };

    manager.recordTransportFailure(host, transportError('one'));
    manager.recordTransportFailure(host, transportError('two'));
    manager.recordTransportFailure(host, transportError('three'));

    await vi.advanceTimersByTimeAsync(5000);
    expect(manager.getReachability('devbox').reachability).toBe('unreachable');

    await vi.advanceTimersByTimeAsync(10000);
    expect(manager.getReachability('devbox')).toEqual({ reachability: 'reachable' });
    expect(onRecovered).toHaveBeenCalledWith('devbox', host);

    await vi.advanceTimersByTimeAsync(60000);
    expect(probeHost).toHaveBeenCalledTimes(2);
  });

  it('throws a structured host-unreachable error without calling the wrapped runner while unreachable', async () => {
    const rawRunner = { run: vi.fn(async () => ({ stdout: '', stderr: '' })) };
    const manager = createHostReachabilityManager({ probeHost: vi.fn(async () => ({})) });
    const host = { name: 'devbox', sshTarget: 'devbox' };
    manager.recordTransportFailure(host, transportError('one'));
    manager.recordTransportFailure(host, transportError('two'));
    manager.recordTransportFailure(host, transportError('three'));

    const runner = manager.wrapRunner(host, rawRunner);
    await expect(runner.run('tmux', ['list-sessions'])).rejects.toBeInstanceOf(HostUnreachableError);
    expect(rawRunner.run).not.toHaveBeenCalled();
  });

  it('feeds wrapped runner transport outcomes into the state machine but treats remote command failures as reachable', async () => {
    const host = { name: 'devbox', sshTarget: 'devbox' };
    const manager = createHostReachabilityManager({ probeHost: vi.fn(async () => ({})) });
    const remoteCommandFailure = Object.assign(new Error('test: path missing'), { code: 1 });
    const rawRunner = {
      run: vi.fn()
        .mockRejectedValueOnce(transportError('one'))
        .mockRejectedValueOnce(remoteCommandFailure),
    };
    const runner = manager.wrapRunner(host, rawRunner);

    await expect(runner.run('tmux', ['display-message'])).rejects.toMatchObject({ code: 255 });
    expect(manager.getReachability('devbox')).toEqual({ reachability: 'failing', lastError: 'one' });

    await expect(runner.run('test', ['-d', '/missing'])).rejects.toMatchObject({ code: 1 });
    expect(manager.getReachability('devbox')).toEqual({ reachability: 'reachable' });
  });

  it('does not poison host reachability when the shared SSH master is at capacity', async () => {
    const host = { name: 'devbox', sshTarget: 'devbox' };
    const manager = createHostReachabilityManager({ probeHost: vi.fn(async () => ({})) });
    const capacityError = Object.assign(new Error('ssh capacity exhausted'), {
      code: 255,
      stderr: 'mux_client_request_session: session request failed: Session open refused by peer',
    });
    const runner = manager.wrapRunner(host, {
      run: vi.fn(async () => { throw capacityError; }),
    });

    await expect(runner.run('tmux', ['display-message'])).rejects.toBe(capacityError);
    expect(manager.getReachability('devbox')).toEqual({ reachability: 'unknown' });
  });
});
