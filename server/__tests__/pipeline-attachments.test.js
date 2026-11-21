import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  publicAttachments,
  validateAttachmentEntry,
  validateAttachmentManifest,
} from '../pipelines/attachments.js';

const NOTES = '.codedeck/runs/abcdef12';
const DIGEST = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function entry(overrides = {}) {
  return {
    name: 'notes.txt',
    path: `${NOTES}/attachments/01-notes.txt`,
    sizeBytes: 12,
    digest: DIGEST,
    ...overrides,
  };
}

describe('validateAttachmentEntry', () => {
  it('accepts a complete managed entry', () => {
    expect(validateAttachmentEntry(entry(), { notesDir: NOTES, index: 0 })).toEqual(entry());
  });

  it.each([
    ['missing name', { name: undefined }, 'attachments[0].name'],
    ['null name', { name: null }, 'attachments[0].name'],
    ['empty name', { name: '' }, 'attachments[0].name'],
    ['name with slash', { name: 'a/b.txt' }, 'attachments[0].name'],
    ['name with backslash', { name: 'a\\b.txt' }, 'attachments[0].name'],
    ['dot name', { name: '.' }, 'attachments[0].name'],
    ['dotdot name', { name: '..' }, 'attachments[0].name'],
    ['control in name', { name: 'a\nb.txt' }, 'attachments[0].name'],
    ['format char in name', { name: 'a\u200Bb.txt' }, 'attachments[0].name'],
    ['unpaired high surrogate in name', { name: '\uD800notes.txt' }, 'attachments[0].name'],
    ['unpaired low surrogate in name', { name: 'notes\uDC00.txt' }, 'attachments[0].name'],
    ['name over 255 utf-8 bytes', { name: `${'é'.repeat(128)}.txt` }, 'attachments[0].name'],
    ['non-integer size', { sizeBytes: 1.5 }, 'attachments[0].sizeBytes'],
    ['negative size', { sizeBytes: -1 }, 'attachments[0].sizeBytes'],
    ['size over per-file max', { sizeBytes: ATTACHMENT_MAX_BYTES + 1 }, 'attachments[0].sizeBytes'],
    ['uppercase digest', { digest: 'A'.repeat(64) }, 'attachments[0].digest'],
    ['short digest', { digest: 'a'.repeat(63) }, 'attachments[0].digest'],
    ['non-hex digest', { digest: 'g'.repeat(64) }, 'attachments[0].digest'],
    ['absolute path', { path: '/tmp/x' }, 'attachments[0].path'],
    ['traversal path', { path: `${NOTES}/attachments/../secrets` }, 'attachments[0].path'],
    ['path outside attachments', { path: `${NOTES}/brief.md` }, 'attachments[0].path'],
    ['path for another run', { path: '.codedeck/runs/00000000/attachments/01-notes.txt' }, 'attachments[0].path'],
  ])('rejects %s', (_label, patch, field) => {
    expect(() => validateAttachmentEntry(entry(patch), { notesDir: NOTES, index: 0 })).toThrow(field);
  });

  it('accepts a zero-byte file and the exact per-file byte limit', () => {
    expect(validateAttachmentEntry(entry({ sizeBytes: 0 }), { notesDir: NOTES, index: 0 }).sizeBytes).toBe(0);
    expect(validateAttachmentEntry(entry({ sizeBytes: ATTACHMENT_MAX_BYTES }), { notesDir: NOTES, index: 0 }).sizeBytes)
      .toBe(ATTACHMENT_MAX_BYTES);
  });

  it('accepts a name of exactly 255 UTF-8 bytes', () => {
    const name = 'a'.repeat(255);
    expect(Buffer.byteLength(name, 'utf8')).toBe(255);
    expect(validateAttachmentEntry(entry({ name, path: `${NOTES}/attachments/01-${name}` }), { notesDir: NOTES, index: 0 }).name)
      .toBe(name);
  });

  it('accepts a literal U+FFFD and a well-formed supplementary character in the name', () => {
    expect(validateAttachmentEntry(entry({ name: 'notes-\uFFFD.txt', path: `${NOTES}/attachments/01-notes.txt` }), {
      notesDir: NOTES,
      index: 0,
    }).name).toBe('notes-\uFFFD.txt');
    expect(validateAttachmentEntry(entry({ name: 'notes-😀.txt', path: `${NOTES}/attachments/01-notes.txt` }), {
      notesDir: NOTES,
      index: 0,
    }).name).toBe('notes-😀.txt');
  });
});

describe('validateAttachmentManifest', () => {
  it('defaults missing or null to an empty manifest', () => {
    expect(validateAttachmentManifest(undefined, { notesDir: NOTES })).toEqual([]);
    expect(validateAttachmentManifest(null, { notesDir: NOTES })).toEqual([]);
  });

  it('rejects a non-array manifest', () => {
    expect(() => validateAttachmentManifest({}, { notesDir: NOTES })).toThrow('attachments');
  });

  it('rejects more than 20 entries', () => {
    const tooMany = Array.from({ length: ATTACHMENT_MAX_COUNT + 1 }, (_, i) => entry({
      name: `f${i}.txt`,
      path: `${NOTES}/attachments/${String(i).padStart(2, '0')}-f${i}.txt`,
      digest: DIGEST.replace(/a/, 'c'),
      sizeBytes: 1,
    }));
    // Distinct digests so uniqueness of path is the only aggregate issue we care about here.
    const entries = tooMany.map((row, i) => ({
      ...row,
      digest: i.toString(16).padStart(64, '0'),
    }));
    expect(() => validateAttachmentManifest(entries, { notesDir: NOTES })).toThrow('attachments');
  });

  it('accepts exactly 20 entries at the aggregate byte limit', () => {
    const size = ATTACHMENT_MAX_TOTAL_BYTES / ATTACHMENT_MAX_COUNT;
    const entries = Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, i) => entry({
      name: `f${i}.txt`,
      path: `${NOTES}/attachments/${String(i).padStart(2, '0')}-f${i}.txt`,
      digest: i.toString(16).padStart(64, '0'),
      sizeBytes: size,
    }));
    expect(validateAttachmentManifest(entries, { notesDir: NOTES })).toHaveLength(20);
  });

  it('rejects aggregate bytes one over the total limit', () => {
    const entries = [
      entry({ sizeBytes: ATTACHMENT_MAX_TOTAL_BYTES, path: `${NOTES}/attachments/01-a.bin`, digest: DIGEST }),
      entry({ name: 'b.bin', sizeBytes: 1, path: `${NOTES}/attachments/02-b.bin`, digest: DIGEST_B }),
    ];
    expect(() => validateAttachmentManifest(entries, { notesDir: NOTES })).toThrow('attachments');
  });

  it('rejects duplicate managed paths', () => {
    const entries = [
      entry({ digest: DIGEST }),
      entry({ name: 'other.txt', digest: DIGEST_B }),
    ];
    expect(() => validateAttachmentManifest(entries, { notesDir: NOTES })).toThrow('attachments[1].path');
  });

  it('allows duplicate display names with distinct paths', () => {
    const entries = [
      entry({ digest: DIGEST, path: `${NOTES}/attachments/01-notes.txt` }),
      entry({ digest: DIGEST_B, path: `${NOTES}/attachments/02-notes.txt` }),
    ];
    expect(validateAttachmentManifest(entries, { notesDir: NOTES })).toEqual(entries);
  });

  it('refuses non-empty attachments when notesDir is null', () => {
    expect(() => validateAttachmentManifest([entry()], { notesDir: null })).toThrow('attachments');
    expect(validateAttachmentManifest([], { notesDir: null })).toEqual([]);
  });
});

describe('publicAttachments', () => {
  it('projects name, path and sizeBytes in order and omits digest', () => {
    const manifest = [
      entry({ name: 'a.txt', path: `${NOTES}/attachments/01-a.txt`, sizeBytes: 1, digest: DIGEST }),
      entry({ name: 'b.txt', path: `${NOTES}/attachments/02-b.txt`, sizeBytes: 2, digest: DIGEST_B }),
    ];
    expect(publicAttachments(manifest)).toEqual([
      { name: 'a.txt', path: `${NOTES}/attachments/01-a.txt`, sizeBytes: 1 },
      { name: 'b.txt', path: `${NOTES}/attachments/02-b.txt`, sizeBytes: 2 },
    ]);
    expect(JSON.stringify(publicAttachments(manifest))).not.toMatch(/digest|staging/i);
  });

  it('returns an empty array for an empty or missing manifest', () => {
    expect(publicAttachments([])).toEqual([]);
    expect(publicAttachments(undefined)).toEqual([]);
    expect(publicAttachments(null)).toEqual([]);
  });
});
