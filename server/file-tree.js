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

export async function readTree(dir, depth = 0, maxDepth = 20) {
  if (depth >= maxDepth) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push({
        name: entry.name,
        type: 'dir',
        path: fullPath,
        children: await readTree(fullPath, depth + 1, maxDepth),
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
