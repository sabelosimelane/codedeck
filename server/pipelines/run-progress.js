import path from 'node:path';
import defaultFs from 'node:fs/promises';
import { composePrompt, isProgressFilePath } from '../../shared/pipeline-definitions.mjs';
import { NOTES_DIR } from './run-notes.js';
import { repairFindings } from './repair-evidence.js';

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
  const index = phases.findIndex(phase => phase.done < phase.total);
  const current = index === -1 ? null : phases[index];
  // number is the todo's own heading; position is where that phase sits in this todo (1-based).
  return { phaseCount: phases.length, phase: current ? { number: current.number, position: index + 1, title: current.title, tasksDone: current.done, tasksTotal: current.total } : null,
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

const SUITE_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// The last two fields are the recorded exit code and revision. Pipes inside a
// command are kept verbatim.
export function parseSuiteLines(noteContent) {
  if (typeof noteContent !== 'string') throw new TypeError('suite lines: note content must be a string');
  return noteContent.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('SUITE '))
    .map(line => {
      const fields = line.slice('SUITE '.length).split('|').map(field => field.trim());
      const repository = fields.shift();
      if (!repository) throw new Error('Suite line requires a repository');
      const revision = fields.pop();
      const exit = /^exit (\d+)$/.exec(fields.pop());
      if (!SUITE_HEAD.test(revision ?? '')) throw new Error(`Suite line for ${repository} requires a worktree revision`);
      const exitCode = exit ? Number(exit[1]) : NaN;
      if (!Number.isSafeInteger(exitCode) || exitCode > 255) throw new Error(`Suite line for ${repository} requires an exit code from 0 to 255`);
      const command = fields.join(' | ');
      if (!command) throw new Error(`Suite line for ${repository} requires a command`);
      return { repository, command, exitCode, revision };
    });
}

// Gate the closing Test decision of a Feature Build from Spec: only a fresh successful
// final verification with the required scope and suite evidence finishes the run. Every
// negative case names the specific missing or failed check so the run stays recoverable.
export function inspectClosingEvidence({ note, attempt, progress, suites, repos }) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('closing evidence: attempt must be a positive integer');
  if (!Array.isArray(suites) || !suites.every(item => item && typeof item === 'object')) throw new TypeError('closing evidence: suites must be an array');
  if (!Array.isArray(repos) || !repos.every(item => item && typeof item === 'object' && typeof item.repository === 'string')) {
    throw new TypeError('closing evidence: repos must be an array of { repository, head }');
  }
  if (progress !== null && (typeof progress !== 'object' || Array.isArray(progress))) throw new TypeError('closing evidence: progress must be null or an object');
  if (progress !== null) {
    if (progress.status === 'in_progress') {
      return { ok: false, missing: `Closing Test decision leaves an open task (${progress.tasksDone}/${progress.tasksTotal} in ${progress.file}); tick every task before closing` };
    }
    if (progress.status !== 'all_done' || !Number.isSafeInteger(progress.tasksTotal) || progress.tasksTotal <= 0 || progress.tasksDone !== progress.tasksTotal) {
      return { ok: false, missing: `Closing Test decision cannot read the required progress file (${progress.status}: ${progress.file}); restore the todo before closing` };
    }
  }
  if (!note || note.status !== 'written' || note.attempt !== attempt) {
    return { ok: false, missing: `Closing Test decision needs an updated verification note for this attempt (attempt ${attempt}); record the outcome before closing` };
  }
  if (!note.content?.trim()) {
    return { ok: false, missing: 'Closing Test decision needs a verification note that describes the outcome' };
  }
  const failed = repairFindings(note.content, attempt).map(line => line.split('|')[0].trim());
  if (failed.length > 0) {
    return { ok: false, missing: `Closing Test decision still reports a failed probe (${[...new Set(failed)].join(', ')}); repair it and rerun before closing` };
  }
  const verdicts = note.content.split(/\r?\n/).map(line => line.trim()).filter(line => line.startsWith('VERDICT '));
  if (verdicts.length !== 1 || verdicts[0] !== `VERDICT ${attempt} PASS`) {
    return { ok: false, missing: `Closing Test decision needs a passing verdict for attempt ${attempt} (VERDICT ${attempt} PASS)` };
  }
  for (const repo of repos) {
    const suite = suites.filter(item => item.repository === repo.repository).at(-1);
    if (!suite) {
      return { ok: false, missing: `Closing Test decision is missing a final suite for ${repo.repository}; run the suite on the final revision and record a SUITE line before closing` };
    }
    if (suite.exitCode !== 0) {
      return { ok: false, missing: `Closing Test decision reports a failed suite for ${repo.repository} (${suite.command} exit ${suite.exitCode}); fix it and rerun before closing` };
    }
    if (!SUITE_HEAD.test(suite.revision ?? '') || !SUITE_HEAD.test(repo.head ?? '')) {
      return { ok: false, missing: `Closing Test decision requires a final-suite revision for ${repo.repository}` };
    }
    if (suite.revision !== repo.head) {
      return { ok: false, missing: `Closing Test decision reports a changed revision for ${repo.repository} (suite ran at ${suite.revision}, worktree at ${repo.head}); rerun the suite before closing` };
    }
  }
  return { ok: true };
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
