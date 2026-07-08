import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  shellQuote,
  createLocalRunner,
  createSshRunner,
  createCommandRunner,
  isTransportFailure,
  DEFAULT_RUN_TIMEOUT_MS,
  SSH_TARGET_REGEX,
} from '../command-runner.js';

// ---------------------------------------------------------------------------
// PATH shim harness (Spec §9): real `ssh`/`scp` scripts on PATH exercise the
// runner end-to-end. Each shim echoes its argv (so tests can assert composed
// flags) and simulates the remote shell (so quoting round-trips are verified).
// ---------------------------------------------------------------------------

let binDir;
let socketDir;
let originalPath;

const SSH_SHIM = `#!/usr/bin/env node
// Simulated ssh: emit argv on stderr, run the remote command through a shell
// (mimicking the remote sshd -> shell layer) on stdout.
const { execFileSync } = require('child_process');
const argv = process.argv.slice(2);
process.stderr.write('SSH_ARGV:' + JSON.stringify(argv) + '\\n');
// After '--' come [target, remoteCommand]; remoteCommand is the last element.
const remoteCommand = argv[argv.length - 1];
try {
  const out = execFileSync('/bin/sh', ['-c', remoteCommand], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.stdout.write(out);
  process.exit(0);
} catch (err) {
  process.exit(err.status == null ? 1 : err.status);
}
`;

const SCP_SHIM = `#!/usr/bin/env node
// Simulated scp: emit argv on stderr, then copy the local source to the
// unquoted remote path (after stripping the 'target:' prefix).
const { execFileSync } = require('child_process');
const fs = require('fs');
const argv = process.argv.slice(2);
process.stderr.write('SCP_ARGV:' + JSON.stringify(argv) + '\\n');
const remoteSpec = argv[argv.length - 1];
const localSource = argv[argv.length - 2];
const colon = remoteSpec.indexOf(':');
const quotedPath = remoteSpec.slice(colon + 1);
// Unquote the (possibly shell-quoted) remote path via the shell.
const dest = execFileSync('/bin/sh', ['-c', 'printf %s ' + quotedPath]).toString();
fs.copyFileSync(localSource, dest);
process.exit(0);
`;

function writeShim(name, body) {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

/** Round-trip a shell-quoted token back through /bin/sh to prove it survives intact. */
function shellRoundTrip(quoted) {
  return execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`]).toString();
}

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck-shim-bin-'));
  socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck-shim-sock-'));
  writeShim('ssh', SSH_SHIM);
  writeShim('scp', SCP_SHIM);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
});

afterAll(() => {
  process.env.PATH = originalPath;
  fs.rmSync(binDir, { recursive: true, force: true });
  fs.rmSync(socketDir, { recursive: true, force: true });
});

const tempFiles = [];
afterEach(() => {
  for (const f of tempFiles) {
    try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  tempFiles.length = 0;
});

function tempFile(contents = 'payload') {
  const file = path.join(os.tmpdir(), `codedeck-runner-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(file, contents);
  tempFiles.push(file);
  return file;
}

function readPtyOutput(pty, { killAfterMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let buffer = '';
    const timer = setTimeout(() => {
      try { pty.kill(); } catch { /* already gone */ }
      resolve(buffer);
    }, killAfterMs);
    pty.onData((chunk) => { buffer += chunk; });
    pty.onExit(() => {
      clearTimeout(timer);
      resolve(buffer);
    });
  });
}

function parseArgvMarker(stderr, marker) {
  const line = stderr.split('\n').find((l) => l.startsWith(marker));
  return line ? JSON.parse(line.slice(marker.length)) : null;
}

// ---------------------------------------------------------------------------
// shellQuote
// ---------------------------------------------------------------------------

describe('shellQuote', () => {
  it('wraps a simple token in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('wraps the empty string as a quoted empty token', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('escapes embedded single quotes so the value survives a shell round-trip', () => {
    const value = "it's a test";
    expect(shellRoundTrip(shellQuote(value))).toBe(value);
  });

  it.each([
    'spaces and tabs\tinside',
    'double "quotes" and $VARS and `backticks`',
    'new\nlines',
    'unicode ✅ 世界 🚀',
    "mix'ed \"quotes\" and spaces",
    '; rm -rf / && echo pwned',
  ])('round-trips %j intact through the shell', (value) => {
    expect(shellRoundTrip(shellQuote(value))).toBe(value);
  });
});

// ---------------------------------------------------------------------------
// Local runner
// ---------------------------------------------------------------------------

describe('local runner', () => {
  const runner = createLocalRunner();

  it('runs a command and captures stdout', async () => {
    const { stdout } = await runner.run('printf', ['%s', 'local-output']);
    expect(stdout).toBe('local-output');
  });

  it('rejects when the command exits non-zero', async () => {
    await expect(runner.run('sh', ['-c', 'exit 3'])).rejects.toMatchObject({ code: 3 });
  });

  it('copies a file via copyTo', async () => {
    const src = tempFile('copy-me');
    const dest = path.join(os.tmpdir(), `codedeck-runner-dest-${Math.random().toString(36).slice(2)}`);
    tempFiles.push(dest);
    await runner.copyTo(src, dest);
    expect(fs.readFileSync(dest, 'utf8')).toBe('copy-me');
  });

  it('spawns a PTY whose output flows', async () => {
    const pty = runner.spawnPty('sh', ['-c', 'printf pty-local'], { cols: 80, rows: 24 });
    const output = await readPtyOutput(pty);
    expect(output).toContain('pty-local');
  });

  it('enforces a timeout and kills the child', async () => {
    await expect(
      runner.run('sleep', ['5'], { timeout: 150 })
    ).rejects.toMatchObject({ killed: true });
  });

  it('reports itself as the local host', () => {
    expect(runner.host).toBe('local');
    expect(runner.kind).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// SSH runner
// ---------------------------------------------------------------------------

describe('ssh runner', () => {
  function makeRunner(sshTarget = 'devbox') {
    return createSshRunner({ name: 'devbox', sshTarget }, { socketDir });
  }

  it('composes ssh argv with BatchMode, ControlMaster options, ConnectTimeout, and -- before the target', async () => {
    const runner = makeRunner();
    const { stderr } = await runner.run('true', []);
    const argv = parseArgvMarker(stderr, 'SSH_ARGV:');
    expect(argv).toContain('-o');
    expect(argv).toContain('BatchMode=yes');
    expect(argv).toContain('ControlMaster=auto');
    expect(argv).toContain(`ControlPath=${path.join(socketDir, '%C')}`);
    expect(argv).toContain('ControlPersist=600');
    expect(argv).toContain('ConnectTimeout=5');
    // `--` immediately precedes the target so a hostile target can never be read as a flag.
    const dashDash = argv.indexOf('--');
    expect(dashDash).toBeGreaterThanOrEqual(0);
    expect(argv[dashDash + 1]).toBe('devbox');
  });

  it('does not include the interactive -tt flag for one-shot run', async () => {
    const runner = makeRunner();
    const { stderr } = await runner.run('true', []);
    const argv = parseArgvMarker(stderr, 'SSH_ARGV:');
    expect(argv).not.toContain('-tt');
  });

  it('round-trips arguments containing spaces and quotes intact to the remote command', async () => {
    const runner = makeRunner();
    const { stdout } = await runner.run('printf', ['%s', "a b 'c' \"d\""]);
    expect(stdout).toBe("a b 'c' \"d\"");
  });

  it('creates the ControlMaster socket dir mode 0700 on demand', async () => {
    const freshSocket = path.join(socketDir, 'nested', 'sockets');
    const runner = createSshRunner({ name: 'devbox', sshTarget: 'devbox' }, { socketDir: freshSocket });
    await runner.run('true', []);
    const stat = fs.statSync(freshSocket);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('enforces a timeout and kills the ssh child', async () => {
    const runner = makeRunner();
    await expect(
      runner.run('sleep', ['5'], { timeout: 200 })
    ).rejects.toMatchObject({ killed: true });
  });

  it('spawns an interactive PTY with ssh -tt and round-trips the remote command', async () => {
    const runner = makeRunner();
    const pty = runner.spawnPty('printf', ['%s', 'pty-remote'], { cols: 80, rows: 24 });
    const output = await readPtyOutput(pty);
    expect(output).toContain('SSH_ARGV:');
    expect(output).toContain('-tt');
    expect(output).toContain('pty-remote');
  });

  it('composes scp argv with batch flags, -- before the source, and a quoted target:path, and lands the bytes', async () => {
    const runner = makeRunner();
    const src = tempFile('scp-payload');
    const dest = path.join(os.tmpdir(), `codedeck-scp-dest-${Math.random().toString(36).slice(2)}`);
    tempFiles.push(dest);

    const { stderr } = await runner.copyTo(src, dest);
    const argv = parseArgvMarker(stderr, 'SCP_ARGV:');

    // Every scp call carries the same mandatory flags as ssh (Spec §5).
    expect(argv).toContain('BatchMode=yes');
    expect(argv).toContain('ControlMaster=auto');
    expect(argv).toContain(`ControlPath=${path.join(socketDir, '%C')}`);
    expect(argv).toContain('ControlPersist=600');
    expect(argv).toContain('ConnectTimeout=5');
    // `--` ends option parsing; the local source is the operand immediately after it.
    const dashDash = argv.indexOf('--');
    expect(dashDash).toBeGreaterThanOrEqual(0);
    expect(argv[dashDash + 1]).toBe(src);
    // The destination is target:quoted-remote-path so the far-side shell can't
    // re-interpret it and it can't be read as a flag.
    expect(argv[argv.length - 1]).toBe(`devbox:${shellQuote(dest)}`);

    expect(fs.readFileSync(dest, 'utf8')).toBe('scp-payload');
  });

  it('quotes and safely copies to a remote path containing spaces', async () => {
    const runner = makeRunner();
    const src = tempFile('spaced-payload');
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck-scp-spaced-'));
    tempFiles.push(destDir);
    const dest = path.join(destDir, 'a file with spaces.png');

    const { stderr } = await runner.copyTo(src, dest);
    const argv = parseArgvMarker(stderr, 'SCP_ARGV:');
    // The quoting contract is pinned on the argv itself, not inferred from a
    // downstream copy happening to succeed.
    expect(argv[argv.length - 1]).toBe(`devbox:${shellQuote(dest)}`);
    expect(fs.readFileSync(dest, 'utf8')).toBe('spaced-payload');
  });

  it('exposes the resolved host name and kind', () => {
    const runner = makeRunner();
    expect(runner.host).toBe('devbox');
    expect(runner.kind).toBe('ssh');
  });

  it.each([
    'has space',
    'evil;rm',
    '-oProxyCommand=x',
    'user@host&whoami',
    'target|pipe',
    '',
  ])('rejects an sshTarget that violates the §3 regex: %j', (sshTarget) => {
    expect(() => createSshRunner({ name: 'devbox', sshTarget }, { socketDir })).toThrow();
  });

  it('accepts a valid user@hostname sshTarget', () => {
    expect(() => createSshRunner({ name: 'devbox', sshTarget: 'deploy@dev.box-1' }, { socketDir })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createCommandRunner dispatch
// ---------------------------------------------------------------------------

describe('createCommandRunner', () => {
  it.each([undefined, null, 'local', { name: 'local' }])(
    'returns a local runner for %j',
    (host) => {
      const runner = createCommandRunner(host, { socketDir });
      expect(runner.kind).toBe('local');
      expect(runner.host).toBe('local');
    }
  );

  it('returns an ssh runner for a host descriptor with an sshTarget', () => {
    const runner = createCommandRunner({ name: 'devbox', sshTarget: 'devbox' }, { socketDir });
    expect(runner.kind).toBe('ssh');
    expect(runner.host).toBe('devbox');
  });

  it('exposes a sane default run timeout constant', () => {
    expect(DEFAULT_RUN_TIMEOUT_MS).toBe(10000);
  });

  it('classifies ssh transport failures distinctly from remote command failures', () => {
    // Transport-level: the host could not be reached — the remote state is UNKNOWN.
    expect(isTransportFailure({ killed: true })).toBe(true);            // timeout kill
    expect(isTransportFailure({ code: 255 })).toBe(true);               // ssh connection failure
    expect(isTransportFailure({ code: 'ENOENT' })).toBe(true);          // spawn-level failure
    // Definitive: ssh reached the host and the remote command reported its result.
    expect(isTransportFailure({ code: 1 })).toBe(false);                // e.g. tmux has-session: no such session
    expect(isTransportFailure({ code: 127 })).toBe(false);              // remote command not found
    expect(isTransportFailure({ code: 0 })).toBe(false);
    expect(isTransportFailure(null)).toBe(false);
    expect(isTransportFailure(undefined)).toBe(false);
  });

  it('exports the §3 sshTarget validation regex as a single source of truth', () => {
    expect(SSH_TARGET_REGEX.source).toBe('^[A-Za-z0-9._@-]+$');
    expect(SSH_TARGET_REGEX.test('deploy@dev-box.1')).toBe(true);
    // The regex allows `-` (hostnames like `dev-box`); rejecting a *leading* `-`
    // is a separate §3 rule the Phase 1 host service layers on top. The regex's
    // own job is to bar whitespace and shell metacharacters.
    expect(SSH_TARGET_REGEX.test('has space')).toBe(false);
    expect(SSH_TARGET_REGEX.test('evil;rm')).toBe(false);
  });
});
