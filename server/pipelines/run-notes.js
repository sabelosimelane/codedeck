import path from 'node:path';
import defaultFs from 'node:fs/promises';
import { execFile as defaultExecFile } from 'node:child_process';
import { inspectProgressFile } from './run-progress.js';
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

export function buildReadme(definition, input) {
  requireDefinition(definition);
  if (typeof definition.workflowName !== 'string' || !definition.workflowName.trim()) throw new TypeError('definition.workflowName must be a non-empty string');
  if (typeof input !== 'string' || /[\r\n]/.test(input)) throw new TypeError('input must be a one-line string');
  const lines = ['# Run notes', '', `Workflow: ${definition.workflowName}`, input ? `Input: ${input}` : 'Input: none', '', '## Steps'];
  definition.steps.forEach((step, index) => {
    const file = notePath(definition, index);
    lines.push(`${String(index).padStart(2, '0')}. ${step.name} — ${step.agent.name} — ${file ?? 'no note'}`);
  });
  lines.push('', '## How notes work', '', 'Before starting, read this file and every earlier step note that exists.', 'Before your final signal, write or replace your own note.', 'Start your note with one line `# <one-line summary>`. Then record what was done, what was decided and why, what is left, and where things are (paths).', 'This folder is ignored by git, belongs to this run, and is safe to delete once the run is over.', '');
  return lines.join('\n');
}

function requireWorktree(worktreePath) {
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) throw new TypeError('worktreePath must be an absolute path');
}

function requireFs(fs, methods) {
  if (!fs || methods.some(method => typeof fs[method] !== 'function')) throw new TypeError(`fs must support ${methods.join(', ')}`);
}

export async function prepare({ worktreePath, definition, input, fs = defaultFs, execFile = defaultExecFile } = {}) {
  requireWorktree(worktreePath);
  requireDefinition(definition);
  requireFs(fs, ['mkdir', 'readFile', 'writeFile', 'realpath', 'lstat']);
  if (typeof execFile !== 'function') throw new TypeError('execFile must be a function');
  const readme = buildReadme(definition, input);
  if (definition.notesDir === null) return;
  const realRoot = await fs.realpath(worktreePath);
  const unignored = () => new Error(`Run notes folder ${definition.notesDir} is not ignored by git in this worktree`);
  const tracked = await runGit(execFile, ['-C', worktreePath, 'ls-files', '--', '.codedeck']);
  if (tracked.stdout.trim()) throw unignored();
  const dotPath = path.join(worktreePath, '.codedeck');
  await fs.mkdir(dotPath, { recursive: true });
  if (await fs.realpath(dotPath) !== path.join(realRoot, '.codedeck')) throw new Error('.codedeck leaves the worktree');
  const ignore = path.join(dotPath, '.gitignore');
  try {
    if (!(await fs.lstat(ignore)).isFile()) throw new Error('.codedeck/.gitignore leaves the worktree');
    await fs.readFile(ignore);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.writeFile(ignore, '*\n', { flag: 'wx' });
  }
  const folder = path.join(worktreePath, definition.notesDir);
  await fs.mkdir(folder, { recursive: true });
  if (await fs.realpath(folder) !== path.join(realRoot, definition.notesDir)) throw new Error('run notes folder leaves the worktree');
  const readmePath = path.join(folder, 'README.md');
  let current;
  try {
    if (!(await fs.lstat(readmePath)).isFile()) throw new Error('run notes README leaves the worktree');
    current = await fs.readFile(readmePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current !== readme) await fs.writeFile(readmePath, readme);
  try {
    await runGit(execFile, ['-C', worktreePath, 'check-ignore', '-q', `${definition.notesDir}/README.md`]);
  } catch (error) {
    if (error?.code === 1) throw unignored();
    throw error;
  }
}

export async function readNote({ worktreePath, definition, stepIndex, fs = defaultFs } = {}) {
  requireWorktree(worktreePath);
  requireDefinition(definition);
  requireFs(fs, ['stat', 'lstat', 'realpath', 'open', 'readFile']);
  const file = notePath(definition, stepIndex);
  if (file === null) return { status: 'missing', content: null };
  try {
    const presence = await inspectProgressFile({ worktreePath, progressFile: file, fs });
    if (presence === 'missing') return { status: 'missing', content: null };
    if (presence !== 'present') return { status: 'unreadable', content: null };
    const target = path.resolve(worktreePath, file);
    if (!(await fs.lstat(target)).isFile()) return { status: 'unreadable', content: null };
    const stat = await fs.stat(target);
    if (stat.size > LIMIT) return { status: 'too_large', content: null };
    const handle = await fs.open(target, 'r');
    let content;
    try {
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    return { status: 'present', content };
  } catch {
    return { status: 'unreadable', content: null };
  }
}
