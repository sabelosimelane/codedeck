import { createHash } from 'node:crypto';
import path from 'node:path';
import { runGit } from './run-worktree.js';

export const MAX_REPAIR_PATH = 1024;
export const MAX_REPAIR_REASON = 1000;

// Control characters are checked before trimming, so one at a field's edge is not trimmed away.
function checkField(id, field, raw, max) {
  if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error(`Repair finding ${id} ${field} contains a control character`);
  const value = raw.trim();
  if (value.length > max) throw new Error(`Repair finding ${id} ${field} is ${value.length} characters; the limit is ${max}`);
  return value;
}

// No total limit: each field is bounded here and the whole note by the note store (256 KiB).
export function repairFindings(note, attempt) {
  if (typeof note !== 'string') throw new Error('Repair evidence requires a Test note');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Repair evidence requires a positive attempt');
  const prefix = `REPAIR ${attempt} `;
  const lines = note.split(/\r?\n/).filter(line => line.startsWith(prefix));
  // No lines: this round's phase passed and only later phases remain. The source fingerprint
  // and the progress guard still stop a loop that makes no progress.
  const findings = lines.map(line => {
    // Only the first two pipes separate fields; a pipe inside the reason is part of it.
    const [rawId, rawLocation = '', ...rest] = line.slice(prefix.length).split('|');
    const rawReason = rest.join('|');
    const id = rawId.trim();
    if (!/^[\w.-]{1,64}$/.test(id)) throw new Error('Repair finding requires a check id');
    const location = checkField(id, 'path', rawLocation, MAX_REPAIR_PATH);
    if (!location) throw new Error(`Repair finding ${id} requires a file path`);
    const reason = checkField(id, 'reason', rawReason, MAX_REPAIR_REASON);
    if (!/[^|\s]/.test(reason)) throw new Error(`Repair finding ${id} requires a failure or outstanding task`);
    return `${id} | ${location} | ${reason}`;
  });
  return [...new Set(findings)].sort();
}

// Git's no-index diff hashes the symlink itself, never its external target.
export async function sourceFingerprint(trees, execFile) {
  if (!Array.isArray(trees) || !trees.length) throw new Error('Repair fingerprint requires a worktree');
  const digest = createHash('sha256');
  const add = value => digest.update(JSON.stringify(value)).update('\n');
  for (const tree of trees) {
    if (typeof tree?.path !== 'string' || !path.isAbsolute(tree.path)) throw new Error('Repair worktree needs an absolute path');
    if (typeof tree.repository !== 'string' || !tree.repository.trim()) throw new Error('Repair worktree needs a repository');
    const git = async args => (await runGit(execFile,['-C',tree.path,...args])).stdout;
    add([tree.repository,tree.path,await git(['rev-parse','HEAD'])]);
    const diff = ['--no-ext-diff','--no-textconv','--binary'];
    add(await git(['diff',...diff,'HEAD','--']));
    const others = await git(['ls-files','--others','--exclude-standard','-z']);
    for (const name of others.split('\0').filter(Boolean).sort()) {
      if (path.isAbsolute(name) || name.split('/').includes('..')) throw new Error('Git returned an invalid worktree path');
      add(name);
      try {
        add(await git(['diff','--no-index',...diff,'--','/dev/null',name]));
      } catch (error) {
        if (Number(error.code) !== 1 || !error.stdout?.startsWith('diff --git ')) throw error;
        add(error.stdout);
      }
    }
  }
  return digest.digest('hex');
}
