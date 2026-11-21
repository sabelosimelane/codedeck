/**
 * Host-aware filesystem adapter.
 *
 * Provides the subset of `fs.promises` needed by tasks, worktrees, run notes,
 * progress reading, multi-repo discovery, and attachment publishing:
 * - For `local`, delegates directly to `node:fs/promises`.
 * - For remote SSH hosts, executes bounded, POSIX-quoted commands via
 *   `command-runner.js`.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { shellQuote } from './command-runner.js';

function makeFsError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function localSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filePath)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function parseStatLine(line) {
  const [kind, sizeRaw, mtimeRaw, nlinkRaw] = String(line ?? '').trim().split('\t');
  const size = Number(sizeRaw) || 0;
  const mtimeMs = (Number(mtimeRaw) || 0) * 1000;
  const nlink = nlinkRaw !== undefined && nlinkRaw !== '' ? Number(nlinkRaw) : 1;
  return {
    size,
    mtimeMs,
    nlink: Number.isFinite(nlink) ? nlink : 1,
    isFile: () => kind === 'f',
    isDirectory: () => kind === 'd',
    isSymbolicLink: () => kind === 'l',
  };
}

export function createHostFs(runner) {
  if (!runner || runner.kind === 'local') {
    return {
      kind: 'local',
      stat: (...args) => nodeFs.stat(...args),
      lstat: (...args) => nodeFs.lstat(...args),
      realpath: (...args) => nodeFs.realpath(...args),
      access: (...args) => nodeFs.access(...args),
      mkdir: (...args) => nodeFs.mkdir(...args),
      readdir: (...args) => nodeFs.readdir(...args),
      readFile: (...args) => nodeFs.readFile(...args),
      writeFile: (...args) => nodeFs.writeFile(...args),
      rename: (...args) => nodeFs.rename(...args),
      rm: (...args) => nodeFs.rm(...args),
      rmdir: (...args) => nodeFs.rmdir(...args),
      open: (...args) => nodeFs.open(...args),
      sha256: localSha256,
      async copyFromLocal(localPath, targetPath) {
        await nodeFs.copyFile(localPath, targetPath);
      },
    };
  }

  async function runStat(target, followSymlinks) {
    const q = shellQuote(target);
    // Portable across GNU (Linux) and BSD (macOS) stat.
    const checkLink = followSymlinks ? '' : `if [ -L ${q} ]; then k=l; `;
    const elifPrefix = followSymlinks ? 'if' : 'elif';
    const script = [
      `${checkLink}${elifPrefix} [ -d ${q} ]; then k=d; elif [ -f ${q} ]; then k=f; else echo "__ENOENT__"; exit 0; fi`,
      `s=$(stat -c '%s\t%Y\t%h' ${q} 2>/dev/null || stat -f '%z\t%m\t%l' ${q} 2>/dev/null || echo "0\t0\t1")`,
      `printf '%s\t%s\n' "$k" "$s"`,
    ].join('; ');
    const { stdout } = await runner.run('sh', ['-c', script]);
    if (stdout.trim() === '__ENOENT__') {
      throw makeFsError('ENOENT', `ENOENT: no such file or directory, stat '${target}'`);
    }
    return parseStatLine(stdout);
  }

  const hostFs = {
    kind: 'remote',
    host: runner.host,

    stat(target) {
      return runStat(target, true);
    },

    lstat(target) {
      return runStat(target, false);
    },

    async realpath(target) {
      const q = shellQuote(target);
      const script = `if [ ! -e ${q} ] && [ ! -L ${q} ]; then echo "__ENOENT__"; exit 0; fi; realpath ${q} 2>/dev/null || readlink -f ${q} 2>/dev/null || (cd ${q} 2>/dev/null && pwd -P) || (cd "$(dirname ${q})" 2>/dev/null && printf '%s/%s\n' "$(pwd -P)" "$(basename ${q})")`;
      const { stdout } = await runner.run('sh', ['-c', script]);
      const out = stdout.trim();
      if (!out || out === '__ENOENT__') {
        throw makeFsError('ENOENT', `ENOENT: no such file or directory, realpath '${target}'`);
      }
      return out;
    },

    async access(target) {
      const q = shellQuote(target);
      const { stdout } = await runner.run('sh', ['-c', `if [ -e ${q} ]; then echo ok; else echo __ENOENT__; fi`]);
      if (stdout.trim() !== 'ok') {
        throw makeFsError('ENOENT', `ENOENT: no such file or directory, access '${target}'`);
      }
    },

    async mkdir(target, opts = {}) {
      const args = opts?.recursive ? ['-p', '--', target] : ['--', target];
      try {
        await runner.run('mkdir', args);
      } catch (err) {
        const detail = `${err?.stderr || ''}\n${err?.message || ''}`;
        if (!opts?.recursive && /file exists/i.test(detail)) {
          throw makeFsError('EEXIST', `EEXIST: file already exists, mkdir '${target}'`);
        }
        throw err;
      }
    },

    async readdir(target, opts = {}) {
      const q = shellQuote(target);
      if (opts?.withFileTypes) {
        const script = `if [ ! -d ${q} ]; then echo "__ENOENT__"; exit 0; fi; for e in ${q}/* ${q}/.*; do b=$(basename "$e"); [ "$b" = "." ] || [ "$b" = ".." ] && continue; [ -e "$e" ] || [ -L "$e" ] || continue; if [ -L "$e" ]; then t=l; elif [ -d "$e" ]; then t=d; else t=f; fi; printf '%s\t%s\n' "$t" "$b"; done`;
        const { stdout } = await runner.run('sh', ['-c', script]);
        if (stdout.trim() === '__ENOENT__') {
          throw makeFsError('ENOENT', `ENOENT: no such file or directory, scandir '${target}'`);
        }
        return stdout.split('\n').filter(Boolean).map(line => {
          const tab = line.indexOf('\t');
          const t = line.slice(0, tab);
          const name = line.slice(tab + 1);
          return {
            name,
            isFile: () => t === 'f',
            isDirectory: () => t === 'd',
            isSymbolicLink: () => t === 'l',
          };
        });
      }
      const script = `if [ ! -d ${q} ]; then echo "__ENOENT__"; exit 0; fi; ls -A1 -- ${q}`;
      const { stdout } = await runner.run('sh', ['-c', script]);
      if (stdout.trim() === '__ENOENT__') {
        throw makeFsError('ENOENT', `ENOENT: no such file or directory, scandir '${target}'`);
      }
      return stdout.split('\n').filter(Boolean);
    },

    async readFile(target, encoding) {
      const q = shellQuote(target);
      const script = `if [ ! -f ${q} ]; then echo "__ENOENT__"; exit 0; fi; base64 < ${q}`;
      const { stdout } = await runner.run('sh', ['-c', script]);
      if (stdout.trim() === '__ENOENT__') {
        throw makeFsError('ENOENT', `ENOENT: no such file or directory, open '${target}'`);
      }
      const buf = Buffer.from(stdout.replace(/\s+/g, ''), 'base64');
      return encoding ? buf.toString(typeof encoding === 'string' ? encoding : encoding.encoding || 'utf8') : buf;
    },

    async writeFile(target, data) {
      const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(String(data), 'utf8').toString('base64');
      const q = shellQuote(target);
      const dir = shellQuote(path.dirname(target));
      const script = `mkdir -p -- ${dir} && printf '%s' ${shellQuote(b64)} | base64 -d > ${q}`;
      await runner.run('sh', ['-c', script]);
    },

    async rename(oldPath, newPath) {
      await runner.run('mv', ['-f', '--', oldPath, newPath]);
    },

    async rm(target, opts = {}) {
      const flags = [];
      if (opts?.recursive) flags.push('-r');
      if (opts?.force) flags.push('-f');
      await runner.run('rm', [...flags, '--', target]);
    },

    async rmdir(target) {
      await runner.run('rmdir', ['--', target]);
    },

    async open(target) {
      const buf = await hostFs.readFile(target);
      return {
        async stat() {
          return hostFs.stat(target);
        },
        async read(buffer, offset = 0, length = buffer.length, position = 0) {
          const start = position ?? 0;
          const end = Math.min(buf.length, start + length);
          const bytesRead = Math.max(0, end - start);
          if (bytesRead > 0) buf.copy(buffer, offset, start, end);
          return { bytesRead, buffer };
        },
        async readFile(encoding) {
          return encoding
            ? buf.toString(typeof encoding === 'string' ? encoding : encoding.encoding || 'utf8')
            : Buffer.from(buf);
        },
        async close() {},
      };
    },

    async sha256(target) {
      const q = shellQuote(target);
      const script = `if [ ! -f ${q} ]; then echo "__ENOENT__"; exit 0; fi; (sha256sum ${q} 2>/dev/null || shasum -a 256 ${q}) | awk '{print $1}'`;
      const { stdout } = await runner.run('sh', ['-c', script]);
      const digest = stdout.trim();
      if (!digest || digest === '__ENOENT__') {
        throw makeFsError('ENOENT', `ENOENT: no such file or directory, sha256 '${target}'`);
      }
      return digest;
    },

    async copyFromLocal(localPath, targetPath) {
      await hostFs.mkdir(path.dirname(targetPath), { recursive: true });
      await runner.copyTo(localPath, targetPath);
    },
  };

  return hostFs;
}
