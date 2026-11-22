import path from 'node:path';
import {validateGradleReceipt} from './gradle-proof.mjs';
import defaultFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile as defaultExecFile } from 'node:child_process';
import { runGit } from './run-worktree.js';

export const NOTES_DIR = /^\.codedeck\/runs\/[0-9a-f]{8}$/;
const LIMIT = 262_144;

function requireDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new TypeError('definition must be an object');
  if (definition.notesDir !== null && (typeof definition.notesDir !== 'string' || !NOTES_DIR.test(definition.notesDir))) throw new TypeError('definition.notesDir must be null or a run notes path');
  if (!Array.isArray(definition.steps)) throw new TypeError('definition.steps must be an array');
}

function requireStep(definition, stepIndex) {
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= definition.steps.length || stepIndex > 99) throw new TypeError('stepIndex must identify a step');
  const step = definition.steps[stepIndex];
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new TypeError('step must be an object');
  if (step.kind !== 'setup' && step.kind !== 'node') throw new TypeError('step.kind must be setup or node');
  if (typeof step.name !== 'string' || !step.name.trim()) throw new TypeError('step.name must be a non-empty string');
  if (!step.agent || typeof step.agent !== 'object' || typeof step.agent.name !== 'string' || !step.agent.name.trim()) throw new TypeError('step.agent.name must be a non-empty string');
  return step;
}

export function noteFileName(stepIndex, stepName) {
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > 99) throw new TypeError('stepIndex must be an integer from 0 to 99');
  if (typeof stepName !== 'string' || !stepName.trim()) throw new TypeError('stepName must be a non-empty string');
  const slug = stepName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'step';
  return `${String(stepIndex).padStart(2, '0')}-${slug}.md`;
}

export function notePath(definition, stepIndex) {
  requireDefinition(definition);
  const step = requireStep(definition, stepIndex);
  return definition.notesDir === null || step.kind === 'setup' ? null : `${definition.notesDir}/${noteFileName(stepIndex, step.name)}`;
}

export function feedbackPath(definition, stepIndex) {
  const file = notePath(definition, stepIndex);
  return file === null ? null : file.replace(/\.md$/, '.feedback.md');
}

export async function writeFeedback({ worktreePath, definition, stepIndex, reviews, fs = defaultFs } = {}) {
  requireWorktree(worktreePath);
  requireDefinition(definition);
  requireFs(fs, ['realpath', 'lstat', 'open', 'writeFile', 'rename', 'rm']);
  if (!Array.isArray(reviews)) throw new TypeError('reviews must be an array');
  const relative = feedbackPath(definition, stepIndex);
  if (relative === null || reviews.length === 0) return null;
  for (const review of reviews) {
    if (!review || review.verdict !== 'sent_back' || typeof review.comment !== 'string' || !review.comment.trim()
      || review.comment.length > 4000 || /[\x00-\x09\x0b-\x1f\x7f]/.test(review.comment)
      || typeof review.createdAt !== 'string' || Number.isNaN(Date.parse(review.createdAt))) {
      throw new TypeError('reviews must contain valid send-back comments and times');
    }
  }
  const folder = await verifiedRunFolder(fs, worktreePath, definition.notesDir);
  const target = path.join(worktreePath, relative);
  const content = ['# Owner feedback', '', ...reviews.flatMap(review => [`## ${review.createdAt}`, '', review.comment, '']), ''].join('\n');
  await replaceFile(fs, folder, path.basename(target), content);
  return relative;
}

/** Where the run's brief is kept: the owner's request and every question answered so far. */
export function briefPath(definition) {
  requireDefinition(definition);
  return definition.notesDir === null ? null : `${definition.notesDir}/brief.md`;
}

/** Fence long enough that submitted backticks cannot close the literal block. */
export function literalInputFence(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(longest + 1);
}

/**
 * Wrap a label so Markdown treats it as inert data (a code span).
 * Uses a fence longer than any backtick run in the text, with padding when the
 * text itself begins or ends with a backtick or space.
 */
export function inertMarkdownLabel(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  // Pad when the label holds backticks or edge spaces so the span cannot be misread.
  const pad = longest > 0 || text.startsWith(' ') || text.endsWith(' ');
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/**
 * Server-generated Attachments section for README and brief.
 * Original names are inert labels; paths are the checkout-relative managed copies.
 */
export function formatAttachmentsSection(attachments) {
  if (attachments === undefined || attachments === null) return null;
  if (!Array.isArray(attachments)) throw new TypeError('attachments must be an array');
  if (attachments.length === 0) return null;
  const lines = [
    '## Attachments',
    '',
    "The owner attached these reference files for this run. Read each file at its checkout-relative path. The original name is a label only.",
    '',
  ];
  for (const entry of attachments) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('attachment entry must be an object');
    if (typeof entry.name !== 'string' || typeof entry.path !== 'string') {
      throw new TypeError('attachment entry must have name and path strings');
    }
    if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      throw new TypeError('attachment entry.sizeBytes must be a non-negative integer');
    }
    lines.push(`- ${inertMarkdownLabel(entry.name)} — ${inertMarkdownLabel(entry.path)} (${entry.sizeBytes} bytes)`);
  }
  lines.push('');
  return lines.join('\n');
}

function requireInputMode(inputMode) {
  if (inputMode !== 'descriptive' && inputMode !== 'path') {
    throw new TypeError('inputMode must be descriptive or path');
  }
  return inputMode;
}

/** Path input stays one plain line; descriptive input is a literal fenced block. */
export function formatRunInputForNotes(input, inputMode = 'path') {
  requireInputMode(inputMode);
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  if (inputMode === 'path' && /[\r\n]/.test(input)) throw new TypeError('input must be a one-line string');
  // Descriptive whitespace is kept as submitted; only a truly empty string is "none".
  if (inputMode === 'descriptive') {
    if (input === '') return null;
    const fence = literalInputFence(input);
    return `${fence}\n${input}\n${fence}`;
  }
  if (!input.trim()) return null;
  return input;
}

/** `entries`: `{ by: 'owner' | 'agent', stepName, pass, questions, answer, createdAt }`, oldest first. */
export function buildBrief(input, entries, { inputMode = 'path', attachments } = {}) {
  const formatted = formatRunInputForNotes(input, inputMode);
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const lines = ['# Brief', '', 'What the owner asked for, and every question answered since. Read this before you start; it is the same for every step.', '', '## Request', '', formatted ?? 'No input was given when this run started.', ''];
  const attachmentSection = formatAttachmentsSection(attachments);
  if (attachmentSection) lines.push(attachmentSection);
  if (entries.length > 0) lines.push('## Questions and answers', '');
  for (const entry of entries) {
    if (!entry || (entry.by !== 'owner' && entry.by !== 'agent')) throw new TypeError('entry.by must be owner or agent');
    if (typeof entry.stepName !== 'string' || !entry.stepName.trim()) throw new TypeError('entry.stepName must be a non-empty string');
    if (!Number.isInteger(entry.pass) || entry.pass < 1) throw new TypeError('entry.pass must be a positive integer');
    if (entry.questions !== null && typeof entry.questions !== 'string') throw new TypeError('entry.questions must be a string or null');
    if (typeof entry.answer !== 'string' || !entry.answer.trim()) throw new TypeError('entry.answer must be a non-empty string');
    if (typeof entry.createdAt !== 'string' || Number.isNaN(Date.parse(entry.createdAt))) throw new TypeError('entry.createdAt must be a time');
    lines.push(`### ${entry.stepName}, pass ${entry.pass} — ${entry.by === 'owner' ? 'answered by the owner' : 'decided by the agent, as the owner allowed'} (${entry.createdAt})`, '',
      entry.questions ?? 'The agent asked without listing its questions.', '', `Answer: ${entry.answer}`, '');
  }
  return lines.join('\n');
}

/** Writes the brief into the run notes folder. Returns its path, or null for a run without notes. */
export async function writeBrief({ worktreePath, definition, input, entries, attachments, fs = defaultFs } = {}) {
  requireWorktree(worktreePath);
  requireFs(fs, ['realpath', 'lstat', 'open', 'writeFile', 'rename', 'rm']);
  const relative = briefPath(definition);
  if (relative === null) return null;
  const inputMode = definition.inputMode ?? 'path';
  const content = buildBrief(input, entries, { inputMode, attachments });
  const folder = await verifiedRunFolder(fs, worktreePath, definition.notesDir);
  await replaceFile(fs, folder, 'brief.md', content);
  return relative;
}

/** `places`: where the run may work and read, as given to the step guidance; left out for a run that has only its worktree. */
export function buildReadme(definition, input, places, attachments) {
  requireDefinition(definition);
  if (places !== undefined && (places === null || typeof places !== 'object' || !Array.isArray(places.worktrees) || !Array.isArray(places.readOnly) || typeof places.current !== 'string')) {
    throw new TypeError('places must hold the worktrees, the read-only repositories and the current repository');
  }
  if (typeof definition.workflowName !== 'string' || !definition.workflowName.trim()) throw new TypeError('definition.workflowName must be a non-empty string');
  const inputMode = definition.inputMode ?? 'path';
  const formatted = formatRunInputForNotes(input, inputMode);
  const inputLines = formatted === null
    ? ['Input: none']
    : inputMode === 'descriptive'
      ? ['Input:', '', formatted]
      : [`Input: ${formatted}`];
  const lines = ['# Run notes', '', `Workflow: ${definition.workflowName}`, ...inputLines, ''];
  const attachmentSection = formatAttachmentsSection(attachments);
  if (attachmentSection) {
    lines.push(attachmentSection);
  }
  lines.push('## Steps');
  definition.steps.forEach((step, index) => {
    const file = notePath(definition, index);
    lines.push(`${String(index).padStart(2, '0')}. ${step.name} — ${step.agent.name} — ${file ?? 'no note'}`);
  });
  if (places !== undefined && (places.worktrees.length > 1 || places.readOnly.length > 0)) {
    lines.push('', '## Repositories', '');
    for (const entry of places.worktrees) lines.push(`- ${entry.repository} — part of this task${entry.repository === places.current ? ', your current directory' : ''} — ${entry.path}`);
    for (const entry of places.readOnly) lines.push(`- ${entry.repository} — not part of this task: read only, never change — ${entry.path}`);
    lines.push('', 'A reference in a document to one of these repositories means the path given here. If a repository that is not part of this task must change, use NEEDS_INPUT.');
  }
  if (places?.worktrees.some(entry => Object.hasOwn(entry, 'baseCommit'))) {
    lines.push('', '## Recorded base commits', '');
    for (const entry of places.worktrees) {
      if (typeof entry.repository !== 'string' || !entry.repository.trim() || typeof entry.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(entry.baseCommit)) {
        throw new TypeError(`Expected a recorded base commit for ${entry.repository}`);
      }
      lines.push(`- ${entry.repository} — ${entry.baseCommit}`);
    }
  }
  lines.push('', '## How notes work', '', `Before starting, read this file, ${definition.notesDir}/brief.md (the owner's request and every question answered so far) and every earlier step note that exists.`, 'Before your final signal, write or replace your own note.', 'Start your note with one line `# <one-line summary>`. Then record what was done, what was decided and why, what is left, and where things are (paths).', `If the work has phases, keep ${definition.notesDir}/plan.md with ## Phase N: <title> sections and - [ ] or - [x] tasks. CodeDeck shows the current phase from it.`, 'This folder is ignored by git, belongs to this run, and is safe to delete once the run is over.', '');
  return lines.join('\n');
}

function requireWorktree(worktreePath) {
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) throw new TypeError('worktreePath must be an absolute path');
}

function requireFs(fs, methods) {
  if (!fs || methods.some(method => typeof fs[method] !== 'function')) throw new TypeError(`fs must support ${methods.join(', ')}`);
}

/**
 * The run's notes folder, each level a real directory inside the worktree. With `missingOk`, a
 * missing level answers null instead of refusing; any other mismatch throws `unsafe_location`.
 */
export async function verifiedRunFolder(fs, worktreePath, notesDir, { create = false, onDotDirectory, missingOk = false } = {}) {
  const realRoot = await fs.realpath(worktreePath);
  const leavesWorktree = () => Object.assign(new Error(`Run notes folder ${notesDir} leaves the worktree`), { code: 'unsafe_location' });
  let folder;
  for (const relative of ['.codedeck', '.codedeck/runs', notesDir]) {
    folder = path.join(worktreePath, relative);
    if (create) {
      try { await fs.mkdir(folder); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    let stat;
    let real;
    try { stat = await fs.lstat(folder); real = await fs.realpath(folder); }
    catch (error) {
      if (missingOk && error?.code === 'ENOENT') return null;
      throw leavesWorktree();
    }
    if (!stat.isDirectory() || real !== path.join(realRoot, relative)) throw leavesWorktree();
    if (relative === '.codedeck' && onDotDirectory) await onDotDirectory(folder, leavesWorktree);
  }
  return folder;
}

async function replaceFile(fs, folder, name, content) {
  const target = path.join(folder, name);
  let current;
  let handle;
  try {
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (stat.isFile() && stat.nlink === 1) current = await handle.readFile('utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ELOOP') throw error;
  } finally {
    await handle?.close();
  }
  if (current === content) return;
  const temporary = path.join(folder, `${name}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Creates the run's notes folder, and a `.codedeck/.gitignore` that ignores it when none exists. */
export async function ensureRunNotesFolder({ worktreePath, notesDir, fs = defaultFs } = {}) {
  return verifiedRunFolder(fs, worktreePath, notesDir, {
    create: true,
    onDotDirectory: async (dotPath, leavesWorktree) => {
      const ignore = path.join(dotPath, '.gitignore');
      try {
        if (!(await fs.lstat(ignore)).isFile()) throw leavesWorktree();
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await fs.writeFile(ignore, '*\n', { flag: 'wx' });
      }
    },
  });
}

export async function prepare({ worktreePath, definition, input, places, attachments, fs = defaultFs, execFile = defaultExecFile } = {}) {
  requireWorktree(worktreePath);
  requireDefinition(definition);
  requireFs(fs, ['mkdir', 'writeFile', 'realpath', 'lstat', 'open', 'rename', 'rm']);
  if (typeof execFile !== 'function') throw new TypeError('execFile must be a function');
  const readme = buildReadme(definition, input, places, attachments);
  if (definition.notesDir === null) return;
  const unignored = () => new Error(`Run notes folder ${definition.notesDir} is not ignored by git in this worktree`);
  const tracked = await runGit(execFile, ['-C', worktreePath, 'ls-files', '--', '.codedeck']);
  if (tracked.stdout.trim()) throw unignored();
  const folder = await ensureRunNotesFolder({ worktreePath, notesDir: definition.notesDir, fs });
  await replaceFile(fs, folder, 'README.md', readme);
  if (definition.steps.some(step => ['Test','Review & Test'].includes(step.name))) {
    const verifier = await defaultFs.readFile(new URL('./gradle-proof.mjs', import.meta.url), 'utf8');
    await replaceFile(fs,folder,'gradle-proof.mjs',verifier);
  }
  try {
    await runGit(execFile, ['-C', worktreePath, 'check-ignore', '-q', `${definition.notesDir}/README.md`]);
  } catch (error) {
    if (error?.code === 1) throw unignored();
    throw error;
  }
}

export async function writeCommitNote(run, content, { fs = defaultFs } = {}) {
  requireWorktree(run.worktreePath);
  const relative = notePath(run.definition, run.currentStepIndex);
  if (!relative || typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > LIMIT) {
    throw new Error('Commit requires a writable final note within the run note size limit');
  }
  const folder = await verifiedRunFolder(fs, run.worktreePath, run.definition.notesDir);
  await replaceFile(fs, folder, path.basename(relative), content);
}

export async function readNote({ worktreePath, definition, stepIndex, fs = defaultFs } = {}) {
  requireWorktree(worktreePath);
  requireDefinition(definition);
  requireFs(fs, ['stat', 'lstat', 'realpath', 'open', 'readFile']);
  const file = notePath(definition, stepIndex);
  if (file === null) return { status: 'missing', content: null };
  return readRunFile(worktreePath,file,fs);
}

async function readRunFile(worktreePath,file,fs) {
  try {
    const target = path.resolve(worktreePath, file);
    const realRoot = await fs.realpath(worktreePath);
    const realParent = await fs.realpath(path.dirname(target));
    const relativeParent = path.relative(realRoot, realParent);
    if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) return { status: 'unreadable', content: null };
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let content;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) return { status: 'unreadable', content: null };
      if (stat.size > LIMIT) return { status: 'too_large', content: null };
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    return { status: 'present', content };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', content: null };
    return { status: 'unreadable', content: null };
  }
}


export async function readGradleReceipts({worktreePath,definition,stepIndex,attempt,fs = defaultFs}) {
  requireWorktree(worktreePath);
  requireDefinition(definition);
  requireStep(definition,stepIndex);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid Gradle receipt attempt');
  const folder = await verifiedRunFolder(fs,worktreePath,definition.notesDir);
  const prefix = `gradle-${stepIndex}-${attempt}-`;
  const files = (await fs.readdir(folder)).filter(name => name.startsWith(prefix) && name.endsWith('.json'));
  if (files.length > 100) throw new Error('Too many Gradle receipts in one attempt');
  const receipts = [];
  for (const name of files) {
    const id = name.slice(prefix.length,-5);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid Gradle receipt filename');
    const result = await readRunFile(worktreePath,path.join(definition.notesDir,name),fs);
    if (result.status !== 'present') throw new Error(`Cannot read Gradle receipt ${id}`);
    const receipt = validateGradleReceipt(JSON.parse(result.content));
    if (receipt.id !== id || receipt.stepIndex !== stepIndex || receipt.attempt !== attempt) throw new Error('Gradle receipt identity mismatch');
    receipts.push(receipt);
  }
  return receipts.sort((a,b) => a.endedAt.localeCompare(b.endedAt));
}
