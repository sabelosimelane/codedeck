import { isSshCapacityError, isTransportFailure, STATUS_POLL_TIMEOUT_MS } from './command-runner.js';

export const REACHABILITY_UNKNOWN = 'unknown';
export const REACHABILITY_REACHABLE = 'reachable';
export const REACHABILITY_FAILING = 'failing';
export const REACHABILITY_UNREACHABLE = 'unreachable';

export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_PROBE_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];

function errorMessage(err) {
  return err?.message || String(err || 'host unreachable');
}

function emptyRecord() {
  return {
    reachability: REACHABILITY_UNKNOWN,
    consecutiveFailures: 0,
    lastError: null,
    unreachableSince: null,
    probeAttempt: 0,
  };
}

function publicReachability(record) {
  return {
    reachability: record.reachability,
    ...(record.lastError != null ? { lastError: record.lastError } : {}),
    ...(record.unreachableSince != null ? { unreachableSince: record.unreachableSince } : {}),
  };
}

export class HostUnreachableError extends Error {
  constructor(host, detail = null) {
    super(detail ? `${host}: ${detail}` : `${host}: host unreachable`);
    this.name = 'HostUnreachableError';
    this.code = 'HOST_UNREACHABLE';
    this.status = 503;
    this.host = host;
    this.error = 'host unreachable';
    this.detail = detail ? `${host}: ${detail}` : undefined;
  }

  toJSON() {
    return {
      error: this.error,
      ...(this.detail ? { detail: this.detail } : {}),
      host: this.host,
    };
  }
}

export function createHostUnreachableError(host, reachability = {}) {
  return new HostUnreachableError(host, reachability.lastError || 'host unreachable');
}

export function createHostReachabilityState({
  now = () => Date.now(),
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  probeBackoffMs = DEFAULT_PROBE_BACKOFF_MS,
} = {}) {
  const records = new Map();

  function getRecord(hostName) {
    const key = String(hostName);
    let record = records.get(key);
    if (!record) {
      record = emptyRecord();
      records.set(key, record);
    }
    return record;
  }

  function getReachability(hostName) {
    return publicReachability(getRecord(hostName));
  }

  function isUnreachable(hostName) {
    return getRecord(hostName).reachability === REACHABILITY_UNREACHABLE;
  }

  function assertReachable(hostName) {
    const live = getReachability(hostName);
    if (live.reachability === REACHABILITY_UNREACHABLE) {
      throw createHostUnreachableError(hostName, live);
    }
  }

  function recordSuccess(hostName) {
    const record = getRecord(hostName);
    const recovered = record.reachability === REACHABILITY_UNREACHABLE;
    record.reachability = REACHABILITY_REACHABLE;
    record.consecutiveFailures = 0;
    record.lastError = null;
    record.unreachableSince = null;
    record.probeAttempt = 0;
    return { reachability: getReachability(hostName), recovered };
  }

  function recordFailure(hostName, err) {
    const record = getRecord(hostName);
    const wasUnreachable = record.reachability === REACHABILITY_UNREACHABLE;
    record.consecutiveFailures += 1;
    record.lastError = errorMessage(err);

    let transitionedToUnreachable = false;
    if (record.consecutiveFailures >= failureThreshold) {
      if (!wasUnreachable) {
        record.unreachableSince = now();
        record.probeAttempt = 0;
        transitionedToUnreachable = true;
      }
      record.reachability = REACHABILITY_UNREACHABLE;
    } else {
      record.reachability = REACHABILITY_FAILING;
      record.unreachableSince = null;
    }

    return { reachability: getReachability(hostName), transitionedToUnreachable };
  }

  function nextProbeDelayMs(hostName) {
    const record = getRecord(hostName);
    const idx = Math.min(record.probeAttempt, probeBackoffMs.length - 1);
    const delay = probeBackoffMs[idx];
    record.probeAttempt += 1;
    return delay;
  }

  return {
    getReachability,
    isUnreachable,
    assertReachable,
    recordSuccess,
    recordFailure,
    nextProbeDelayMs,
  };
}

function hostNameOf(hostOrName) {
  return typeof hostOrName === 'string' ? hostOrName : hostOrName?.name;
}

export function createHostReachabilityManager({
  now = () => Date.now(),
  probeHost = async (host, runner) => runner?.run?.('true', [], { timeout: STATUS_POLL_TIMEOUT_MS }),
  onRecovered = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  probeBackoffMs = DEFAULT_PROBE_BACKOFF_MS,
} = {}) {
  const state = createHostReachabilityState({ now, failureThreshold, probeBackoffMs });
  const hosts = new Map();
  const timers = new Map();

  function rememberHost(hostOrName) {
    const name = hostNameOf(hostOrName);
    if (!name) return name;
    if (typeof hostOrName === 'object') hosts.set(name, hostOrName);
    return name;
  }

  function clearProbe(hostName) {
    const timer = timers.get(hostName);
    if (timer) clearTimeoutFn(timer);
    timers.delete(hostName);
  }

  function scheduleProbe(hostName) {
    if (timers.has(hostName)) return;
    const delay = state.nextProbeDelayMs(hostName);
    const timer = setTimeoutFn(async () => {
      timers.delete(hostName);
      const host = hosts.get(hostName) || { name: hostName, sshTarget: hostName };
      try {
        await probeHost(host);
        const result = state.recordSuccess(hostName);
        clearProbe(hostName);
        if (result.recovered) await onRecovered(hostName, host);
      } catch (err) {
        state.recordFailure(hostName, err);
        if (state.isUnreachable(hostName)) scheduleProbe(hostName);
      }
    }, delay);
    timer?.unref?.();
    timers.set(hostName, timer);
  }

  function getReachability(hostName) {
    if (hostName === 'local') return { reachability: REACHABILITY_REACHABLE };
    return state.getReachability(hostName);
  }

  function isUnreachable(hostName) {
    return hostName !== 'local' && state.isUnreachable(hostName);
  }

  function assertReachable(hostName) {
    if (hostName === 'local') return;
    const live = getReachability(hostName);
    if (live.reachability === REACHABILITY_UNREACHABLE) {
      throw createHostUnreachableError(hostName, live);
    }
  }

  function recordSuccess(hostOrName) {
    const hostName = rememberHost(hostOrName);
    if (!hostName || hostName === 'local') return { reachability: { reachability: REACHABILITY_REACHABLE }, recovered: false };
    const result = state.recordSuccess(hostName);
    if (result.recovered) clearProbe(hostName);
    return result;
  }

  function recordTransportFailure(hostOrName, err) {
    const hostName = rememberHost(hostOrName);
    if (!hostName || hostName === 'local') return { reachability: { reachability: REACHABILITY_REACHABLE }, transitionedToUnreachable: false };
    const result = state.recordFailure(hostName, err);
    if (result.transitionedToUnreachable) scheduleProbe(hostName);
    return result;
  }

  function observeCommand(host, fn) {
    const hostName = rememberHost(host);
    return Promise.resolve()
      .then(() => {
        assertReachable(hostName);
        return fn();
      })
      .then((value) => {
        recordSuccess(hostName);
        return value;
      })
      .catch((err) => {
        if (isSshCapacityError(err)) {
          // A full ControlMaster proves neither reachability nor failure. Keep
          // the previous state intact and let the caller retry after pressure
          // subsides.
          throw err;
        }
        if (isTransportFailure(err)) recordTransportFailure(host, err);
        else recordSuccess(hostName);
        throw err;
      });
  }

  function wrapRunner(host, runner) {
    const hostName = rememberHost(host);
    if (!hostName || hostName === 'local') return runner;
    return {
      ...runner,
      run(cmd, args = [], opts = {}) {
        return observeCommand(host, () => runner.run(cmd, args, opts));
      },
      copyTo(localPath, remotePath, opts = {}) {
        if (typeof runner.copyTo !== 'function') return undefined;
        return observeCommand(host, () => runner.copyTo(localPath, remotePath, opts));
      },
      spawnPty(cmd, args = [], opts = {}) {
        assertReachable(hostName);
        return runner.spawnPty(cmd, args, opts);
      },
    };
  }

  return {
    getReachability,
    isUnreachable,
    assertReachable,
    recordSuccess,
    recordTransportFailure,
    wrapRunner,
  };
}
