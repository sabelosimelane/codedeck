import fs from 'fs/promises';
import path from 'path';

export const IGNORED = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'target',
  '.idea',
  '__pycache__',
  '.DS_Store',
]);

async function readDirEntriesLocal(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.map(entry => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
  }));
}

async function readDirEntriesRemote(runner, dir) {
  const { stdout } = await runner.run('ls', ['-1pA', dir]);
  const lines = stdout.split('\n').filter(Boolean);
  return lines.map(line => {
    const isDirectory = line.endsWith('/');
    const name = isDirectory ? line.slice(0, -1) : line;
    return { name, isDirectory };
  });
}

export async function readDirEntries(runner, dir) {
  if (runner.kind === 'local') {
    return readDirEntriesLocal(dir);
  }
  return readDirEntriesRemote(runner, dir);
}

export async function readTree(runner, dir, depth = 0, maxDepth = 20) {
  if (depth >= maxDepth) return [];

  const entries = await readDirEntries(runner, dir);
  const result = [];

  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;

    // Use POSIX path separator since remote host might be Linux/Mac even if local is Windows.
    // If we rely on path.join, it uses local OS separator.
    const fullPath = `${dir}${dir.endsWith('/') ? '' : '/'}${entry.name}`;
    if (entry.isDirectory) {
      result.push({
        name: entry.name,
        type: 'dir',
        path: fullPath,
        children: await readTree(runner, fullPath, depth + 1, maxDepth),
      });
    } else {
      result.push({ name: entry.name, type: 'file', path: fullPath });
    }
  }

  return result.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'dir' ? -1 : 1;
  });
}
