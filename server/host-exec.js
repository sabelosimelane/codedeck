/**
 * Host-aware command execution adapter.
 *
 * Bridges `command-runner.js` (local or multiplexed SSH) to the standard Node
 * `execFile(cmd, args, opts, callback)` contract already injected into
 * `run-worktree.js`, `task-service.js`, `task-landing.js`, `run-notes.js`, and
 * `project-repositories.js`.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { createCommandRunner, shellQuote } from './command-runner.js';
import { findHostByName } from './host-service.js';
import { LOCAL_HOST, normalizeHostName } from './project-config.js';

export class HostResolutionError extends Error {
  constructor(message, status, { host, detail } = {}) {
    super(message);
    this.status = status;
    this.host = host;
    this.detail = detail;
  }
}

/**
 * Resolve a host name to a command runner (`local` or SSH).
 * Throws `HostResolutionError` (404 unknown host, 503 unreachable host).
 */
export function resolveHostRunner(hostName, {
  loadHosts,
  createRunner = createCommandRunner,
  getReachability = null,
} = {}) {
  const normalized = normalizeHostName(hostName);
  if (normalized === LOCAL_HOST) {
    return { hostName: LOCAL_HOST, host: null, runner: createRunner(null) };
  }
  const hosts = typeof loadHosts === 'function' ? loadHosts() : [];
  const host = findHostByName(hosts, normalized);
  if (!host) {
    throw new HostResolutionError(`unknown host "${normalized}"`, 404, { host: normalized });
  }
  const live = getReachability?.(host.name);
  if (live?.reachability === 'unreachable') {
    throw new HostResolutionError('host unreachable', 503, {
      host: host.name,
      detail: live.lastError ? `${host.name}: ${live.lastError}` : undefined,
    });
  }
  return { hostName: host.name, host, runner: createRunner(host) };
}

/**
 * Adapt a `command-runner` instance into an `execFile(cmd, args, opts, cb)` function.
 *
 * - For `local` runners, delegates directly to `node:child_process.execFile` (with
 *   `GIT_TERMINAL_PROMPT=0` for `git` so credential prompts fail fast).
 * - For SSH runners, executes through `runner.run(...)` with POSIX single-quote
 *   wrapping; if `opts.cwd` is specified, runs `sh -c 'cd <cwd> && exec <cmd> <args>'`
 *   with every token safely quoted.
 */
export function createHostExecFile(runner, { localExecFile = nodeExecFile } = {}) {
  if (!runner || runner.kind === 'local') {
    return function hostLocalExecFile(cmd, args = [], opts = {}, cb) {
      let options = opts;
      let callback = cb;
      if (typeof opts === 'function') {
        callback = opts;
        options = {};
      }
      const nextOpts = cmd === 'git'
        ? { ...options, env: { ...process.env, ...options?.env, GIT_TERMINAL_PROMPT: '0' } }
        : options;
      return localExecFile(cmd, args, nextOpts, callback);
    };
  }

  return function hostRemoteExecFile(cmd, args = [], opts = {}, cb) {
    let options = opts;
    let callback = cb;
    if (typeof opts === 'function') {
      callback = opts;
      options = {};
    }

    const runOpts = {
      timeout: options?.timeout,
      maxBuffer: options?.maxBuffer,
    };

    const envPrefix = cmd === 'git' ? 'GIT_TERMINAL_PROMPT=0 ' : '';
    let promise;
    if (options?.cwd) {
      const quotedCmd = [cmd, ...args].map(shellQuote).join(' ');
      const script = `cd ${shellQuote(options.cwd)} && ${envPrefix}${quotedCmd}`;
      promise = runner.run('sh', ['-c', script], runOpts);
    } else if (envPrefix) {
      promise = runner.run('env', ['GIT_TERMINAL_PROMPT=0', cmd, ...args], runOpts);
    } else {
      promise = runner.run(cmd, args, runOpts);
    }

    if (typeof callback === 'function') {
      promise.then(
        ({ stdout, stderr }) => callback(null, stdout ?? '', stderr ?? ''),
        (err) => callback(err, err?.stdout ?? '', err?.stderr ?? ''),
      );
      return;
    }
    return promise;
  };
}
