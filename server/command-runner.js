/**
 * Command runner abstraction (Spec §5).
 *
 * One primitive underlies every host-touching capability (terminal runtime,
 * file tree, preview, directory browser, upload, session GC). A runner is
 * resolved per host and injected into those code paths. `local` is the trivial
 * implementation (direct execFile / node-pty / fs.copyFile); remote hosts route
 * through `ssh`/`scp` with ControlMaster multiplexing.
 *
 * Invariants:
 * - All process launching uses execFile-style argv arrays — never
 *   string-concatenated shell commands.
 * - Every remote argument is shell-quoted before it crosses the single remote
 *   shell layer, so spaces / quotes / metacharacters can never smuggle flags or
 *   break out of the command.
 * - The SSH surface is async-only. Every ssh/scp call carries BatchMode (fail
 *   fast, never hang on a prompt), ControlMaster multiplexing, and timeouts.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { spawn as ptySpawn } from 'node-pty';

const execFileAsync = promisify(execFile);

// Per-call timeouts (Spec §5). `run` defaults to 10s; status-poll callers pass
// the shorter budget explicitly. `ConnectTimeout` additionally bounds SSH
// connection establishment so a dead host fails fast instead of blocking.
export const DEFAULT_RUN_TIMEOUT_MS = 10000;
export const STATUS_POLL_TIMEOUT_MS = 5000;
export const SSH_CONNECT_TIMEOUT_S = 5;
export const SSH_CONTROL_PERSIST_S = 600;

// Command output can be sizeable (e.g. a captured tmux window). Give run() a
// generous buffer so large-but-bounded stdout does not error as ENOBUFS.
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

// CodeDeck-owned directory for ssh ControlMaster sockets. Created on demand,
// mode 0700 (Spec §5). `%C` is an ssh ControlPath token (a per-connection
// hash) — it is passed to ssh literally, not interpolated here.
const DEFAULT_SOCKET_DIR = path.join(os.homedir(), '.codedeck', 'ssh');

const LOCAL_HOST_NAME = 'local';

/**
 * Validation regex for `sshTarget` (Spec §3). Exported as the single source of
 * truth so the host service (Phase 1) and this runner validate identically. The
 * value is passed as an argument to ssh/scp, so it must never carry whitespace,
 * shell metacharacters, or a leading `-` — the `--` guard blocks flag injection
 * but not target-structure abuse (e.g. `evil;rm` or a space-split target), so
 * the runner re-asserts this regex as defense-in-depth.
 */
export const SSH_TARGET_REGEX = /^[A-Za-z0-9._@-]+$/;

/**
 * POSIX single-quote wrapping (Spec §5 — argument safety). Wrapping a value in
 * single quotes makes the shell treat every byte literally; the only character
 * that cannot appear inside single quotes is a single quote itself, which we
 * emit as `'\''` (close quote, escaped literal quote, reopen quote). The result
 * survives one shell layer byte-for-byte.
 */
export function shellQuote(arg) {
  const value = String(arg);
  if (value === '') return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Join a command + args into a single remote command string, each token quoted. */
function composeRemoteCommand(cmd, args) {
  return [cmd, ...args].map(shellQuote).join(' ');
}

/**
 * Classify a failed runner.run() error: transport failure (the host could not
 * be reached — remote state is UNKNOWN) versus a definitive remote result (ssh
 * reached the host and the remote command exited non-zero). ssh reserves exit
 * 255 for connection/protocol failures; a timeout kill or a spawn-level error
 * (string `code` like ENOENT) also means we never heard from the host. Callers
 * use this to distinguish "session gone" from "can't tell" (Spec §8.2 — never
 * mark a session dead on evidence we don't have).
 */
export function isTransportFailure(err) {
  if (!err) return false;
  if (err.killed === true) return true;
  if (err.code === 255) return true;
  if (typeof err.code === 'string') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Local runner
// ---------------------------------------------------------------------------

/**
 * Create a runner that executes directly on the local machine. Behavior is
 * byte-identical to CodeDeck's pre-host-connectors code paths.
 */
export function createLocalRunner(deps = {}) {
  const runExecFile = deps.execFile ? promisify(deps.execFile) : execFileAsync;
  const spawnPtyFn = deps.spawn || ptySpawn;
  const copyFileFn = deps.copyFile || fs.promises.copyFile;

  return {
    kind: 'local',
    host: LOCAL_HOST_NAME,

    /** One-shot command with captured stdout/stderr and an enforced timeout. */
    run(cmd, args = [], opts = {}) {
      return runExecFile(cmd, args, {
        timeout: opts.timeout ?? DEFAULT_RUN_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: 'utf8',
        cwd: opts.cwd,
      });
    },

    /** Interactive PTY-attached process. */
    spawnPty(cmd, args = [], { cols, rows, cwd } = {}) {
      return spawnPtyFn(cmd, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
      });
    },

    /** Move a file to a local destination path. */
    copyTo(localPath, remotePath) {
      return copyFileFn(localPath, remotePath);
    },
  };
}

// ---------------------------------------------------------------------------
// SSH runner
// ---------------------------------------------------------------------------

/**
 * Create a runner that executes on a remote host over SSH with a multiplexed
 * ControlMaster connection. Caller is responsible for having validated
 * `sshTarget` against the §3 regex — this layer additionally guards it behind
 * `--` so the ssh CLI can never read the target as an option.
 */
export function createSshRunner(host, deps = {}) {
  const { name, sshTarget } = host;
  if (typeof sshTarget !== 'string' || !SSH_TARGET_REGEX.test(sshTarget)) {
    throw new Error(
      `invalid sshTarget for host "${name}": must match ${SSH_TARGET_REGEX.source}`
    );
  }
  const socketDir = deps.socketDir || DEFAULT_SOCKET_DIR;
  const runExecFile = deps.execFile ? promisify(deps.execFile) : execFileAsync;
  const spawnPtyFn = deps.spawn || ptySpawn;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;

  let socketDirReady = false;
  function ensureSocketDir() {
    if (socketDirReady) return;
    mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    socketDirReady = true;
  }

  /** SSH/scp flags applied to every invocation (Spec §5). */
  function baseFlags(connectTimeout = SSH_CONNECT_TIMEOUT_S) {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${path.join(socketDir, '%C')}`,
      '-o', `ControlPersist=${SSH_CONTROL_PERSIST_S}`,
      '-o', `ConnectTimeout=${connectTimeout}`,
    ];
  }

  return {
    kind: 'ssh',
    host: name,
    sshTarget,

    run(cmd, args = [], opts = {}) {
      ensureSocketDir();
      const argv = [
        ...baseFlags(opts.connectTimeout),
        '--', sshTarget,
        composeRemoteCommand(cmd, args),
      ];
      return runExecFile('ssh', argv, {
        timeout: opts.timeout ?? DEFAULT_RUN_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: 'utf8',
      });
    },

    // `cwd` is intentionally not accepted here: for the remote case the working
    // directory belongs to the remote command (e.g. tmux `new-session -c`), not
    // to the local `ssh` client process, so honoring a local cwd would be
    // misleading. The local runner honors cwd; the remote runner does not.
    spawnPty(cmd, args = [], { cols, rows } = {}) {
      ensureSocketDir();
      const argv = [
        '-tt',
        ...baseFlags(),
        '--', sshTarget,
        composeRemoteCommand(cmd, args),
      ];
      return spawnPtyFn('ssh', argv, {
        name: 'xterm-256color',
        cols,
        rows,
      });
    },

    copyTo(localPath, remotePath, opts = {}) {
      ensureSocketDir();
      const argv = [
        ...baseFlags(opts.connectTimeout),
        '--', localPath,
        `${sshTarget}:${remotePath}`,
      ];
      return runExecFile('scp', argv, {
        timeout: opts.timeout ?? DEFAULT_RUN_TIMEOUT_MS,
        maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
        encoding: 'utf8',
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Resolve a runner for the given host reference. `undefined`, `null`, the
 * literal string `local`, or a `{ name: 'local' }` descriptor all resolve to
 * the built-in local runner; any other descriptor with an `sshTarget` yields an
 * SSH runner.
 */
export function createCommandRunner(host, deps = {}) {
  if (host == null) return createLocalRunner(deps);
  if (typeof host === 'string') {
    return host === LOCAL_HOST_NAME
      ? createLocalRunner(deps)
      : createSshRunner({ name: host, sshTarget: host }, deps);
  }
  if (host.name === LOCAL_HOST_NAME || !host.sshTarget) {
    return createLocalRunner(deps);
  }
  return createSshRunner(host, deps);
}
