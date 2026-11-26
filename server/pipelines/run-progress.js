import path from 'node:path';
import defaultFs from 'node:fs/promises';
import { composePrompt, isProgressFilePath } from '../../shared/pipeline-definitions.mjs';
import { NOTES_DIR } from './run-notes.js';

const LIMIT = 1_048_576;

export function resolveRunProgressFile({ definitionProgressFile, workflowProgressFile, input, notesDir }) {
  if (definitionProgressFile !== null && typeof definitionProgressFile !== 'string') throw new TypeError('definitionProgressFile must be null or a string');
  if (workflowProgressFile !== null && typeof workflowProgressFile !== 'string') throw new TypeError('workflowProgressFile must be null or a string');
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  if (notesDir !== null && (typeof notesDir !== 'string' || !NOTES_DIR.test(notesDir))) throw new TypeError('notesDir must be null or a run notes path');
  if (definitionProgressFile !== null) return { file: definitionProgressFile, optional: false };
  if (workflowProgressFile === null) return notesDir === null ? null : { file: `${notesDir}/plan.md`, optional: true };
  const composed = composePrompt(workflowProgressFile, input);
  return isProgressFilePath(composed, 512) ? { file: composed, optional: false } : null;
}

export function parsePhaseBreakdown(markdown) {
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
      current = { number: Number(heading[1]), title: (heading[2] ?? '').trim().replace(/#+$/, '').trim().slice(0, 120), done: 0, total: 0 };
      phases.push(current);
      continue;
    }
    const task = current && line.match(/^\s*[-*+]\s+\[( |x|X)\]\s/);
    if (task) {
      current.total += 1;
      if (task[1].toLowerCase() === 'x') current.done += 1;
    }
  }
  return phases;
}

export function parsePhaseProgress(markdown) {
  const phases = parsePhaseBreakdown(markdown);
  const current = phases.find(phase => phase.done < phase.total);
  return { phaseCount: phases.length, phase: current ? { number: current.number, title: current.title, tasksDone: current.done, tasksTotal: current.total } : null,
    tasksDone: phases.reduce((sum, phase) => sum + phase.done, 0),
    tasksTotal: phases.reduce((sum, phase) => sum + phase.total, 0) };
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
  const result = (file, status, parsed = null) => ({ file, status, phaseCount: status === 'in_progress' || status === 'all_done' ? parsed.phaseCount : null, phase: status === 'in_progress' ? parsed.phase : null,
    tasksDone: parsed?.tasksDone ?? null, tasksTotal: parsed?.tasksTotal ?? null });
  const unreadable = (file, key, reason) => {
    if (reasons.get(key) !== reason) console.warn(`[pipeline-progress] ${reason} path=${key}`);
    reasons.set(key, reason);
    return result(file, 'unreadable');
  };
  return {
    async worktreeExists(worktreePath) {
      if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) throw new TypeError('worktreePath must be an absolute path');
      try { return (await fs.stat(worktreePath)).isDirectory(); }
      catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
        throw error;
      }
    },
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

/**
 * A progress reader that answers a repeated question from its last answer while that answer is
 * younger than `ttlMs`, and lets concurrent askers share one read. For a remote host, where every
 * stat, realpath and read is an SSH round trip and several views poll every two seconds. A failed
 * read is never kept.
 */
export function createCachedProgressReader(reader, { ttlMs, now = Date.now } = {}) {
  if (!reader || typeof reader.read !== 'function' || typeof reader.worktreeExists !== 'function') throw new TypeError('reader must support read and worktreeExists');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive number');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const answers = new Map();
  const ask = (key, load) => {
    const kept = answers.get(key);
    if (kept && now() - kept.at < ttlMs) return kept.promise;
    const promise = load();
    const entry = { at: now(), promise };
    answers.set(key, entry);
    promise.catch(() => { if (answers.get(key) === entry) answers.delete(key); });
    if (answers.size > 200) answers.delete(answers.keys().next().value);
    return promise;
  };
  return {
    worktreeExists: worktreePath => ask(`exists\0${worktreePath}`, () => reader.worktreeExists(worktreePath)),
    read: ({ worktreePath, progressFile }) => ask(`read\0${worktreePath}\0${progressFile}`, () => reader.read({ worktreePath, progressFile })),
  };
}

export async function readRunProgress({ run, workflowProgressFile, progressReader }) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new TypeError('run must be an object');
  if (!run.definition || typeof run.definition !== 'object') throw new TypeError('run.definition must be an object');
  if (typeof run.definition.progressFile !== 'string' && run.definition.progressFile !== null) throw new TypeError('run.definition.progressFile must be null or a string');
  if (typeof run.definition.notesDir !== 'string' && run.definition.notesDir !== null) throw new TypeError('run.definition.notesDir must be null or a string');
  if (typeof run.input !== 'string') throw new TypeError('run.input must be a string');
  if (typeof run.worktreePath !== 'string' || !path.isAbsolute(run.worktreePath)) throw new TypeError('run.worktreePath must be an absolute path');
  if (typeof run.worktreeState !== 'string') throw new TypeError('run.worktreeState must be a string');
  if (workflowProgressFile !== null && typeof workflowProgressFile !== 'string') throw new TypeError('workflowProgressFile must be null or a string');
  if (!progressReader || typeof progressReader.read !== 'function') throw new TypeError('progressReader.read must be a function');
  if (typeof progressReader.worktreeExists !== 'function') throw new TypeError('progressReader.worktreeExists must be a function');
  const source = resolveRunProgressFile({ definitionProgressFile: run.definition.progressFile,
    workflowProgressFile, input: run.input, notesDir: run.definition.notesDir });
  if (source === null || !['present', 'external', 'removal_blocked'].includes(run.worktreeState)) return null;
  const exists = await progressReader.worktreeExists(run.worktreePath);
  if (typeof exists !== 'boolean') throw new TypeError('progressReader.worktreeExists must return a boolean');
  if (!exists) return null;
  const progress = await progressReader.read({ worktreePath: run.worktreePath, progressFile: source.file });
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) throw new TypeError('progressReader result must be an object');
  if (typeof progress.file !== 'string') throw new TypeError('progressReader result.file must be a string');
  if (typeof progress.status !== 'string') throw new TypeError('progressReader result.status must be a string');
  if (progress.phaseCount !== null && (!Number.isSafeInteger(progress.phaseCount) || progress.phaseCount < 0)) throw new TypeError('progressReader result.phaseCount must be null or a nonnegative integer');
  if (progress.phase !== null && typeof progress.phase !== 'object') throw new TypeError('progressReader result.phase must be null or an object');
  if (progress.tasksDone !== null && (!Number.isSafeInteger(progress.tasksDone) || progress.tasksDone < 0)) throw new TypeError('progressReader result.tasksDone must be null or a nonnegative integer');
  if (progress.tasksTotal !== null && (!Number.isSafeInteger(progress.tasksTotal) || progress.tasksTotal < 0)) throw new TypeError('progressReader result.tasksTotal must be null or a nonnegative integer');
  if (source.optional && ['missing', 'no_phases'].includes(progress.status)) return null;
  return progress;
}
