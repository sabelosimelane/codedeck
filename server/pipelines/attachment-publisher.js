/**
 * Publishes a start's staged attachment batch into `<checkout>/<notesDir>/attachments/`.
 * The batch is copied into an exclusive run-owned temporary folder beside it, verified, and
 * promoted with one rename, so the managed location holds either nothing or the whole batch.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import defaultFs from 'node:fs/promises';
import path from 'node:path';
import { isManagedAttachmentPath } from './attachments.js';
import { NOTES_DIR, ensureRunNotesFolder, verifiedRunFolder } from './run-notes.js';
import { runGit } from './run-worktree.js';

const ATTACHMENTS = 'attachments';
const TEMP_BATCH = /^\.attachments-[0-9a-f-]{36}\.tmp$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_EXTENSION = /\.([A-Za-z0-9]{1,16})$/;
const STEM_MAX = 48;

export class AttachmentPublishError extends Error {
  constructor(message, { status, code, field } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (field) this.errors = [{ field, message }];
  }
}

const unsafe = message => new AttachmentPublishError(message, { status: 409, code: 'unsafe_location' });

function requireLocation(checkoutPath, notesDir) {
  if (typeof checkoutPath !== 'string' || !path.isAbsolute(checkoutPath)) throw new TypeError('checkoutPath must be an absolute path');
  if (typeof notesDir !== 'string' || !NOTES_DIR.test(notesDir)) throw new TypeError('notesDir must be a run notes path');
}

/** `NN-stem.ext`: the stem and extension keep only portable characters of the submitted name. */
function generatedName(name, index) {
  const prefix = String(index + 1).padStart(2, '0');
  const match = SAFE_EXTENSION.exec(name);
  const hasExtension = match !== null && match.index > 0;
  const extension = hasExtension ? `.${match[1].toLowerCase()}` : '';
  const stem = (hasExtension ? name.slice(0, match.index) : name)
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, STEM_MAX).replace(/-+$/, '');
  return `${prefix}${stem ? `-${stem}` : ''}${extension}`;
}

/** The ordered manifest a batch is published as: server-generated paths, submitted names, sizes and digests. */
export function attachmentManifest({ notesDir, files }) {
  return files.map((file, index) => {
    const entry = { name: file.name, path: `${notesDir}/${ATTACHMENTS}/${generatedName(file.name, index)}`, sizeBytes: file.sizeBytes, digest: file.digest };
    if (!isManagedAttachmentPath(entry.path, notesDir)) throw new Error(`attachments[${index}].path: not a managed path`);
    return entry;
  });
}

const CHUNK = 1024 * 1024;

/** Calls `onChunk` with each successive chunk of an open file. */
async function readChunks(handle, onChunk) {
  const buffer = Buffer.alloc(CHUNK);
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
    if (bytesRead === 0) return;
    await onChunk(buffer.subarray(0, bytesRead));
  }
}

async function hashRegularFile(fs, target) {
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) return null;
    const hash = createHash('sha256');
    let size = 0;
    await readChunks(handle, chunk => { size += chunk.length; hash.update(chunk); });
    return { size, digest: hash.digest('hex'), uid: stat.uid };
  } finally {
    await handle.close();
  }
}

async function copyVerified(fs, source, target, file, field) {
  const fail = (detail, status = 500) => new AttachmentPublishError(`Attachment ${field} could not be copied: ${detail}`, { status, code: 'copy_failed', field });
  let input;
  let output;
  try {
    input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    output = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await readChunks(input, async chunk => {
      let offset = 0;
      while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten;
    });
  } catch (error) {
    throw fail(error?.code ?? 'storage failure');
  } finally {
    await input?.close();
    await output?.close();
  }
  const written = await hashRegularFile(fs, target);
  if (written === null) throw fail('the copy is not a regular file', 409);
  if (written.size !== file.sizeBytes || written.digest !== file.digest) throw fail('the copied bytes do not match the submitted file');
}

async function requireUntracked(execFile, checkoutPath) {
  const tracked = await runGit(execFile, ['-C', checkoutPath, 'ls-files', '--', '.codedeck']);
  if (tracked.stdout.trim()) throw new AttachmentPublishError('The run notes location is tracked by git.', { status: 409, code: 'tracked' });
}

/** Every one of `relatives` (generated paths, one line each) must be untracked and ignored by git. */
async function requireIgnored(execFile, checkoutPath, relatives) {
  await requireUntracked(execFile, checkoutPath);
  let ignored = [];
  try {
    const { stdout } = await runGit(execFile, ['-C', checkoutPath, 'check-ignore', '--', ...relatives]);
    ignored = stdout.split('\n').filter(Boolean);
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  if (relatives.some(relative => !ignored.includes(relative))) {
    throw new AttachmentPublishError('The run notes location is not ignored by git.', { status: 409, code: 'not_ignored' });
  }
}

/** Whether one file in `folder` matches a reserved manifest entry (name, size, digest, owner). */
async function matchesReservedFile(fs, folder, entry) {
  let read;
  try {
    read = await hashRegularFile(fs, path.join(folder, path.posix.basename(entry.path)));
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'ENOENT') return false;
    throw error;
  }
  return read !== null
    && read.size === entry.sizeBytes
    && read.digest === entry.digest
    && read.uid === process.getuid();
}

/** Whether `folder` already holds exactly this batch, written by this user. */
async function matchesPublished(fs, folder, manifest) {
  const entries = (await fs.readdir(folder)).sort();
  const expected = manifest.map(entry => path.posix.basename(entry.path)).sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) return false;
  for (const entry of manifest) {
    if (!(await matchesReservedFile(fs, folder, entry))) return false;
  }
  return true;
}

/**
 * Whether a temporary batch is this start's abandoned write: empty, or every entry is a
 * reserved identity (a partial copy is still ours). Any other file means a foreign batch.
 */
async function isOwnedTemporaryBatch(fs, folder, manifest) {
  const entries = await fs.readdir(folder);
  if (entries.length === 0) return true;
  if (manifest === null) return false;
  const byName = new Map(manifest.map(entry => [path.posix.basename(entry.path), entry]));
  for (const name of entries) {
    const want = byName.get(name);
    if (!want || !(await matchesReservedFile(fs, folder, want))) return false;
  }
  return true;
}

async function lstatOrNull(fs, target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * @param {{ checkoutPath: string, notesDir: string, attemptId: string,
 *   files: Array<{ name: string, sizeBytes: number, digest: string, stagingPath: string }>,
 *   execFile: Function, fs?: typeof defaultFs }} options
 * @returns {Promise<{ attachments: object[], alreadyPublished: boolean }>}
 */
export async function publishAttachmentBatch({ checkoutPath, notesDir, attemptId, files, execFile, fs = defaultFs } = {}) {
  requireLocation(checkoutPath, notesDir);
  if (typeof attemptId !== 'string' || !UUID.test(attemptId)) throw new TypeError('attemptId must be a UUID');
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  if (files.length === 0) return { attachments: [], alreadyPublished: false };
  const manifest = attachmentManifest({ notesDir, files });
  const relatives = manifest.map(entry => entry.path);

  await requireUntracked(execFile, checkoutPath);
  let folder;
  try {
    folder = await ensureRunNotesFolder({ worktreePath: checkoutPath, notesDir, fs });
  } catch (error) {
    if (error?.code === 'unsafe_location') throw unsafe(error.message);
    throw error;
  }
  if ((await fs.lstat(folder)).uid !== process.getuid()) throw unsafe(`Run notes folder ${notesDir} is not owned by CodeDeck.`);

  const published = path.join(folder, ATTACHMENTS);
  const existing = await lstatOrNull(fs, published);
  if (existing !== null && !(existing.isDirectory() && await matchesPublished(fs, published, manifest))) {
    throw new AttachmentPublishError('The attachments folder of this run already holds other content.', { status: 409, code: 'collision' });
  }
  await requireIgnored(execFile, checkoutPath, relatives);
  if (existing !== null) return { attachments: manifest, alreadyPublished: true };

  const temporary = path.join(folder, `.attachments-${attemptId}.tmp`);
  let createdTemp = false;
  let promoted = false;
  try {
    try {
      await fs.mkdir(temporary, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new AttachmentPublishError('The attachments folder of this run already holds other content.', {
          status: 409, code: 'collision',
        });
      }
      throw error;
    }
    createdTemp = true;
    for (let index = 0; index < files.length; index++) {
      await copyVerified(fs, files[index].stagingPath, path.join(temporary, path.posix.basename(manifest[index].path)), files[index], `files[${index}]`);
    }
    if (await lstatOrNull(fs, published) !== null) {
      throw new AttachmentPublishError('The attachments folder of this run already holds other content.', { status: 409, code: 'collision' });
    }
    await fs.rename(temporary, published);
    promoted = true;
    const real = await fs.realpath(published);
    if (real !== path.join(await fs.realpath(folder), ATTACHMENTS)) throw unsafe('The attachments folder left the run notes folder.');
    await requireIgnored(execFile, checkoutPath, relatives);
    return { attachments: manifest, alreadyPublished: false };
  } catch (error) {
    // Only remove what this attempt created. A pre-existing temp or foreign attachments folder stays.
    if (promoted) await fs.rm(published, { recursive: true, force: true });
    else if (createdTemp) await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Removes what an unpublished attempt may have written in the run's notes folder: a promoted
 * batch that matches the reserved identities (manifest never persisted), and temporary batches.
 * A foreign attachments folder that does not match those identities is left alone.
 * @param {{ checkoutPath: string, notesDir: string,
 *   files?: Array<{ name: string, sizeBytes: number, digest: string }>,
 *   fs?: typeof defaultFs }} options
 */
export async function removeUnpublishedAttachments({ checkoutPath, notesDir, files, fs = defaultFs } = {}) {
  requireLocation(checkoutPath, notesDir);
  try {
    await fs.realpath(checkoutPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: [] };
    throw error;
  }
  let folder;
  try {
    folder = await verifiedRunFolder(fs, checkoutPath, notesDir, { missingOk: true });
  } catch (error) {
    if (error?.code === 'unsafe_location') throw unsafe(error.message);
    throw error;
  }
  if (folder === null) return { removed: [] };
  const expected = Array.isArray(files) && files.length > 0 ? attachmentManifest({ notesDir, files }) : null;
  const removed = [];
  for (const name of await fs.readdir(folder)) {
    if (TEMP_BATCH.test(name)) {
      const target = path.join(folder, name);
      // Empty and reserved-identity temps are abandoned writes; foreign content stays.
      if (!(await isOwnedTemporaryBatch(fs, target, expected))) continue;
      await fs.rm(target, { recursive: true, force: true });
      removed.push(`${notesDir}/${name}`);
      continue;
    }
    if (name !== ATTACHMENTS) continue;
    const target = path.join(folder, ATTACHMENTS);
    // Empty folders and batches that match the reserved identities are ours; anything else stays.
    const entries = await fs.readdir(target);
    const ours = entries.length === 0
      || (expected !== null && await matchesPublished(fs, target, expected));
    if (!ours) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed.push(`${notesDir}/${ATTACHMENTS}`);
  }
  return { removed };
}
