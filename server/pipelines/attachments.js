/**
 * Run-start attachment identity and manifest validation.
 * Internal records keep digests; public API views project name/path/size only.
 */

import { ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_TOTAL_BYTES, isSafeAttachmentName } from '../../shared/workflow-attachments.mjs';
export { ATTACHMENT_MAX_COUNT, ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_TOTAL_BYTES, ATTACHMENT_NAME_MAX_BYTES, isSafeAttachmentName } from '../../shared/workflow-attachments.mjs';

const DIGEST_RE = /^[0-9a-f]{64}$/;
const NOTES_DIR_RE = /^\.codedeck\/runs\/[0-9a-f]{8}$/;

function fail(field, message = 'invalid') {
  throw new Error(`${field}: ${message}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Checkout-relative managed path under the run's notes attachments folder.
 * Rejects absolute paths, traversal and any location outside that directory.
 */
export function isManagedAttachmentPath(path, notesDir) {
  if (typeof path !== 'string' || typeof notesDir !== 'string' || !NOTES_DIR_RE.test(notesDir)) return false;
  if (path.includes('\0') || path.includes('\\') || path.startsWith('/') || path.includes('//')) return false;
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) return false;
  const prefix = `${notesDir}/attachments/`;
  if (!path.startsWith(prefix)) return false;
  const leaf = path.slice(prefix.length);
  if (!leaf || leaf.includes('/')) return false;
  // Generated leaf: keep portable filesystem characters only.
  if (!/^[A-Za-z0-9._-]+$/.test(leaf)) return false;
  return true;
}

export function validateAttachmentEntry(entry, { notesDir, index }) {
  const field = name => `attachments[${index}].${name}`;
  if (!isPlainObject(entry)) fail(`attachments[${index}]`, 'must be an object');
  for (const key of Object.keys(entry)) {
    if (!['name', 'path', 'sizeBytes', 'digest'].includes(key)) fail(field(key), 'unknown field');
  }
  if (!isSafeAttachmentName(entry.name)) fail(field('name'));
  if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > ATTACHMENT_MAX_BYTES) {
    fail(field('sizeBytes'));
  }
  if (typeof entry.digest !== 'string' || !DIGEST_RE.test(entry.digest)) fail(field('digest'));
  if (!isManagedAttachmentPath(entry.path, notesDir)) fail(field('path'));
  return {
    name: entry.name,
    path: entry.path,
    sizeBytes: entry.sizeBytes,
    digest: entry.digest,
  };
}

/**
 * Validate an ordered attachment manifest for a run with the given notesDir.
 * Missing/null becomes []. Non-empty manifests require a notes directory.
 */
export function validateAttachmentManifest(attachments, { notesDir } = {}) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) fail('attachments', 'must be an array');
  if (attachments.length > ATTACHMENT_MAX_COUNT) fail('attachments', `at most ${ATTACHMENT_MAX_COUNT} files`);
  if (attachments.length === 0) return [];
  if (notesDir === null || notesDir === undefined) fail('attachments', 'require a notes directory');
  if (typeof notesDir !== 'string' || !NOTES_DIR_RE.test(notesDir)) fail('attachments', 'require a notes directory');

  const seenPaths = new Set();
  let total = 0;
  const validated = attachments.map((entry, index) => {
    const row = validateAttachmentEntry(entry, { notesDir, index });
    if (seenPaths.has(row.path)) fail(`attachments[${index}].path`, 'must be unique');
    seenPaths.add(row.path);
    total += row.sizeBytes;
    if (total > ATTACHMENT_MAX_TOTAL_BYTES) fail('attachments', 'aggregate size exceeds the limit');
    return row;
  });
  return validated;
}

/** Public run view: ordered name/path/size only — never digest or staging locations. */
export function publicAttachments(attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) return [];
  return attachments.map(({ name, path, sizeBytes }) => ({ name, path, sizeBytes }));
}
