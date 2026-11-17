import path from 'node:path';
import defaultFs from 'node:fs/promises';
import { composePrompt, isProgressFilePath } from '../../shared/pipeline-definitions.mjs';

const LIMIT = 1_048_576;

export function resolveRunProgressFile({ definitionProgressFile, workflowProgressFile, input }) {
  if (definitionProgressFile !== null && typeof definitionProgressFile !== 'string') throw new TypeError('definitionProgressFile must be null or a string');
  if (workflowProgressFile !== null && typeof workflowProgressFile !== 'string') throw new TypeError('workflowProgressFile must be null or a string');
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  if (definitionProgressFile !== null) return definitionProgressFile;
  if (workflowProgressFile === null) return null;
  const composed = composePrompt(workflowProgressFile, input);
  return isProgressFilePath(composed, 512) ? composed : null;
}

export function parsePhaseProgress(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');
  const phases = [];
  let current = null;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^(?:```|~~~)/)?.[0] ?? null;
    if (marker) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (/^#{1,2}[ \t]/.test(line)) current = null;
    const heading = line.match(/^##[ \t]+Phase[ \t]+(\d+)(?:[ \t]*[:.\-–—][ \t]*(.*))?[ \t]*#*[ \t]*$/i);
    if (heading) {
      current = { number: Number(heading[1]), title: (heading[2] ?? '').trim().replace(/#+$/, '').trim().slice(0, 120), tasksDone: 0, tasksTotal: 0 };
      phases.push(current);
      continue;
    }
    const task = current && line.match(/^\s*[-*+]\s+\[( |x|X)\]\s/);
    if (task) {
      current.tasksTotal += 1;
      if (task[1].toLowerCase() === 'x') current.tasksDone += 1;
    }
  }
  return { phaseCount: phases.length, phase: phases.find(phase => phase.tasksDone < phase.tasksTotal) ?? null };
}

const inside = (root, target) => target !== root && !path.relative(root, target).startsWith('..' + path.sep) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target));

export async function inspectProgressFile({ worktreePath, progressFile, fs = defaultFs } = {}) {
  if (typeof worktreePath !== 'string' || !worktreePath || !path.isAbsolute(worktreePath)) throw new TypeError('worktreePath must be a non-empty absolute path');
  if (typeof progressFile !== 'string' || !progressFile) throw new TypeError('progressFile must be a non-empty string');
  if (!fs || typeof fs.stat !== 'function' || typeof fs.realpath !== 'function') throw new TypeError('fs must support stat and realpath');
  const target = path.resolve(worktreePath, progressFile);
  if (!inside(worktreePath, target)) return 'outside worktree';
  try {
    const [realRoot, realTarget] = await Promise.all([fs.realpath(worktreePath), fs.realpath(target)]);
    if (!inside(realRoot, realTarget)) return 'outside worktree real path';
    return (await fs.stat(target)).isFile() ? 'present' : 'not a regular file';
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
    throw error;
  }
}

export async function isProgressFileInWorktree(options) {
  return (await inspectProgressFile(options)) === 'present';
}

export function createRunProgressReader({ fs = defaultFs } = {}) {
  if (!fs || typeof fs.stat !== 'function' || typeof fs.realpath !== 'function' || typeof fs.open !== 'function') throw new TypeError('fs must support stat, realpath and open');
  const cache = new Map();
  const reasons = new Map();
  const result = (file, status, parsed = null) => ({ file, status, phaseCount: status === 'in_progress' || status === 'all_done' ? parsed.phaseCount : null, phase: status === 'in_progress' ? parsed.phase : null });
  const unreadable = (file, key, reason) => {
    if (reasons.get(key) !== reason) console.warn(`[pipeline-progress] ${reason} path=${key}`);
    reasons.set(key, reason);
    return result(file, 'unreadable');
  };
  return {
    async read({ worktreePath, progressFile }) {
      if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) throw new TypeError('worktreePath must be a non-empty absolute path');
      if (typeof progressFile !== 'string' || progressFile.length === 0) throw new TypeError('progressFile must be a non-empty string');
      const target = path.resolve(worktreePath, progressFile);
      try {
        const presence = await inspectProgressFile({ worktreePath, progressFile, fs });
        if (presence === 'missing') return result(progressFile, 'missing');
        if (presence !== 'present') return unreadable(progressFile, target, presence);
        const stat = await fs.stat(target);
        if (stat.size > LIMIT) return unreadable(progressFile, target, 'file exceeds 1 MiB');
        const cached = cache.get(target);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return result(progressFile, cached.parsed.phase ? 'in_progress' : cached.parsed.phaseCount ? 'all_done' : 'no_phases', cached.parsed);
        const handle = await fs.open(target, 'r');
        let markdown;
        try {
          const buffer = Buffer.alloc(stat.size);
          const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
          markdown = buffer.subarray(0, bytesRead).toString('utf8');
        } finally {
          await handle.close();
        }
        const parsed = parsePhaseProgress(markdown);
        cache.delete(target);
        cache.set(target, { mtimeMs: stat.mtimeMs, size: stat.size, parsed });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        reasons.delete(target);
        return result(progressFile, parsed.phase ? 'in_progress' : parsed.phaseCount ? 'all_done' : 'no_phases', parsed);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return result(progressFile, 'missing');
        return unreadable(progressFile, target, error?.code ?? 'read error');
      }
    },
  };
}
