/**
 * Unified per-host tool resolver for Tasks, Worktrees, Multi-Repo, and Pipelines.
 *
 * Returns `{ host, runner, execFile, fs, pathExists, realpath, mkdir, rmdir, sha256 }`
 * bound to either the local machine or a remote SSH host's multiplexed runner.
 */

import { createCommandRunner } from './command-runner.js';
import { createHostExecFile, resolveHostRunner } from './host-exec.js';
import { createHostFs } from './host-fs.js';

export function createHostToolsResolver({
  loadHosts,
  createRunner = createCommandRunner,
  getReachability = null,
  localExecFile,
} = {}) {
  return function resolveHostTools(hostName) {
    const { hostName: resolvedHost, runner } = resolveHostRunner(hostName, {
      loadHosts,
      createRunner,
      getReachability,
    });
    const execFile = createHostExecFile(runner, { localExecFile });
    const fs = createHostFs(runner);
    return {
      host: resolvedHost,
      runner,
      execFile,
      fs,
      async pathExists(target) {
        try {
          await fs.access(target);
          return true;
        } catch (err) {
          if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return false;
          throw err;
        }
      },
      realpath: target => fs.realpath(target),
      mkdir: (target, opts) => fs.mkdir(target, opts),
      rmdir: target => fs.rmdir(target),
      sha256: target => fs.sha256(target),
    };
  };
}
