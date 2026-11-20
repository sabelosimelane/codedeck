/**
 * Verify published attachment copies still match the run manifest before an agent is opened
 * or driven for an attempt (including resume).
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import defaultFs from 'node:fs/promises';
import path from 'node:path';
import { isManagedAttachmentPath, validateAttachmentManifest } from './attachments.js';

export class AttachmentVerifyError extends Error {
  constructor(message, { field } = {}) {
    super(message);
    this.field = field;
    this.code = 'attachment_verify_failed';
  }
}

const CHUNK = 1024 * 1024;

async function hashRegularFile(fs, target) {
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) return null;
    const hash = createHash('sha256');
    let size = 0;
    const buffer = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return { size, digest: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/**
 * Confirm every recorded attachment is a readable regular file inside the checkout that still
 * matches its recorded size and digest. Empty manifests are a no-op.
 *
 * @throws {AttachmentVerifyError} with `field` naming the affected `attachments[n]` entry
 */
export async function verifyAttachmentCopies({
  worktreePath,
  attachments,
  notesDir,
  fs = defaultFs,
} = {}) {
  if (attachments === undefined || attachments === null || (Array.isArray(attachments) && attachments.length === 0)) {
    return;
  }
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) {
    throw new TypeError('worktreePath must be an absolute path');
  }
  const inferredNotesDir = notesDir
    ?? (typeof attachments[0]?.path === 'string' ? attachments[0].path.split('/').slice(0, 3).join('/') : null);
  const manifest = validateAttachmentManifest(attachments, { notesDir: inferredNotesDir });
  const realRoot = await fs.realpath(worktreePath);

  for (let index = 0; index < manifest.length; index++) {
    const entry = manifest[index];
    const field = `attachments[${index}]`;
    if (!isManagedAttachmentPath(entry.path, inferredNotesDir)) {
      throw new AttachmentVerifyError(`Attachment ${field} (${entry.name}) is not a managed attachment path.`, { field });
    }
    const target = path.join(worktreePath, entry.path);
    let realParent;
    try {
      realParent = await fs.realpath(path.dirname(target));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new AttachmentVerifyError(`Attachment ${field} (${entry.name}) is missing and could not be read.`, { field });
      }
      throw new AttachmentVerifyError(`Attachment ${field} (${entry.name}) could not be read: ${error?.code ?? error.message}`, { field });
    }
    const expectedParent = path.join(realRoot, path.dirname(entry.path));
    if (realParent !== expectedParent) {
      throw new AttachmentVerifyError(`Attachment ${field} (${entry.name}) left the managed attachments folder.`, { field });
    }

    let hashed;
    try {
      hashed = await hashRegularFile(fs, target);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new AttachmentVerifyError(`Attachment ${field} (${entry.name}) is missing and could not be read.`, { field });
      }
      if (error?.code === 'ELOOP') {
        throw new AttachmentVerifyError(`Attachment ${field} (${entry.name}) is a symlink, not a regular file.`, { field });
      }
      throw new AttachmentVerifyError(`Attachment ${field} (${entry.name}) could not be read: ${error?.code ?? error.message}`, { field });
    }
    if (hashed === null) {
      throw new AttachmentVerifyError(`Attachment ${field} (${entry.name}) is not a safe regular file.`, { field });
    }
    if (hashed.size !== entry.sizeBytes || hashed.digest !== entry.digest) {
      throw new AttachmentVerifyError(
        `Attachment ${field} (${entry.name}) does not match the recorded size or digest.`,
        { field },
      );
    }
  }
}

/**
 * Attachment content that removing a run-owned checkout would lose for good: recorded copies that
 * no longer verify, and anything in the run's attachments folder that its manifest does not list.
 * Only verified run-owned copies are disposable. Returns checkout-relative paths.
 */
export async function listAttachmentCopiesAtRisk({
  worktreePath,
  attachments,
  notesDir,
  fs = defaultFs,
} = {}) {
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) {
    throw new TypeError('worktreePath must be an absolute path');
  }
  if (!Array.isArray(attachments)) throw new TypeError('attachments must be an array');
  if (notesDir === null || notesDir === undefined) return [];
  if (typeof notesDir !== 'string' || notesDir === '' || path.isAbsolute(notesDir)) {
    throw new TypeError('notesDir must be a checkout-relative path or null');
  }
  const folder = `${notesDir}/attachments`;
  const target = path.join(worktreePath, folder);
  let entries;
  try {
    const stat = await fs.lstat(target);
    if (!stat.isDirectory()) return [folder];
    const realRoot = await fs.realpath(worktreePath);
    if (await fs.realpath(target) !== path.join(realRoot, folder)) return [folder];
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const manifest = attachments.length === 0 ? [] : validateAttachmentManifest(attachments, { notesDir });
  const atRisk = [];
  for (const entry of entries) {
    const relative = `${folder}/${entry.name}`;
    const index = manifest.findIndex(item => item.path === relative);
    if (index === -1 || !entry.isFile()) {
      atRisk.push(relative);
      continue;
    }
    try {
      await verifyAttachmentCopies({ worktreePath, attachments: [manifest[index]], notesDir, fs });
    } catch (error) {
      if (!(error instanceof AttachmentVerifyError)) throw error;
      atRisk.push(relative);
    }
  }
  return atRisk;
}
