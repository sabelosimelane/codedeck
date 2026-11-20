import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { listAttachmentCopiesAtRisk, verifyAttachmentCopies } from '../pipelines/attachment-verify.js';

const runCommand = promisify(execFile);
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function checkout() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.attachment-verify-'));
  roots.push(root);
  return root;
}

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeCopy(root, relative, content) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return { path: relative, sizeBytes: Buffer.byteLength(content), digest: digestOf(content) };
}

describe('verifyAttachmentCopies', () => {
  const NOTES = '.codedeck/runs/abcdef12';

  it('accepts readable regular files that match size and digest', async () => {
    const root = await checkout();
    const first = await writeCopy(root, `${NOTES}/attachments/01-a.txt`, 'alpha');
    const second = await writeCopy(root, `${NOTES}/attachments/02-b.txt`, '');
    await expect(verifyAttachmentCopies({
      worktreePath: root,
      attachments: [
        { name: 'a.txt', ...first },
        { name: 'b.txt', ...second },
      ],
    })).resolves.toBeUndefined();
  });

  it.each([
    ['missing', async (root, entry) => {
      await fs.rm(path.join(root, entry.path));
      return /missing|not found|could not be read/i;
    }],
    ['changed bytes', async (root, entry) => {
      await fs.writeFile(path.join(root, entry.path), 'changed');
      return /changed|digest|size|does not match/i;
    }],
    ['symlinked', async (root, entry) => {
      const outside = path.join(root, 'outside.txt');
      await fs.writeFile(outside, 'alpha');
      await fs.rm(path.join(root, entry.path));
      await fs.symlink(outside, path.join(root, entry.path));
      return /symlink|unsafe|regular file/i;
    }],
  ])('reports a file-specific error when a copy is %s', async (_label, mutate) => {
    const root = await checkout();
    const first = await writeCopy(root, `${NOTES}/attachments/01-a.txt`, 'alpha');
    const second = await writeCopy(root, `${NOTES}/attachments/02-b.txt`, 'beta');
    const pattern = await mutate(root, first);
    await expect(verifyAttachmentCopies({
      worktreePath: root,
      attachments: [
        { name: 'a.txt', ...first },
        { name: 'b.txt', ...second },
      ],
    })).rejects.toMatchObject({
      message: expect.stringMatching(pattern),
      field: 'attachments[0]',
    });
  });

  it('reports a file-specific error when a copy is unreadable', async () => {
    const root = await checkout();
    const first = await writeCopy(root, `${NOTES}/attachments/01-a.txt`, 'alpha');
    const target = path.join(root, first.path);
    await fs.chmod(target, 0o000);
    try {
      await expect(verifyAttachmentCopies({
        worktreePath: root,
        attachments: [{ name: 'a.txt', ...first }],
      })).rejects.toMatchObject({
        message: expect.stringMatching(/a\.txt.*could not be read: EACCES/),
        field: 'attachments[0]',
      });
    } finally {
      await fs.chmod(target, 0o600);
    }
  });

  it('reports a file-specific error without waiting for a writer when a copy is a FIFO', async () => {
    const root = await checkout();
    const entry = await writeCopy(root, `${NOTES}/attachments/01-a.txt`, 'alpha');
    const target = path.join(root, entry.path);
    await fs.unlink(target);
    await runCommand('mkfifo', [target]);
    const verification = { worktreePath: root, notesDir: NOTES, attachments: [{ name: 'a.txt', ...entry }] };
    const verifierUrl = new URL('../pipelines/attachment-verify.js', import.meta.url).href;
    // Bound the subprocess so an open waiting for a FIFO writer cannot hang the test runner.
    const { stdout } = await runCommand(process.execPath, ['--input-type=module', '-e', `
      const { verifyAttachmentCopies } = await import(process.argv[1]);
      try {
        await verifyAttachmentCopies(JSON.parse(process.argv[2]));
      } catch (error) {
        console.log(JSON.stringify({ field: error.field, message: error.message }));
      }
    `, verifierUrl, JSON.stringify(verification)], { timeout: 1500 });
    expect(JSON.parse(stdout)).toEqual({
      field: 'attachments[0]',
      message: expect.stringMatching(/a\.txt.*regular file/),
    });
  });

  it('refuses copies whose attachments folder is a symlink to another place', async () => {
    const root = await checkout();
    const first = await writeCopy(root, `elsewhere/01-a.txt`, 'alpha');
    await fs.mkdir(path.join(root, NOTES), { recursive: true });
    await fs.symlink(path.join(root, 'elsewhere'), path.join(root, NOTES, 'attachments'));
    await expect(verifyAttachmentCopies({
      worktreePath: root,
      attachments: [{ name: 'a.txt', ...first, path: `${NOTES}/attachments/01-a.txt` }],
    })).rejects.toMatchObject({
      message: expect.stringMatching(/a\.txt.*left the managed attachments folder/),
      field: 'attachments[0]',
    });
  });

  it('skips verification when the manifest is empty', async () => {
    await expect(verifyAttachmentCopies({ worktreePath: '/tmp', attachments: [] })).resolves.toBeUndefined();
    await expect(verifyAttachmentCopies({ worktreePath: '/tmp', attachments: undefined })).resolves.toBeUndefined();
  });

  it('refuses a path that leaves the managed attachments folder', async () => {
    const root = await checkout();
    await expect(verifyAttachmentCopies({
      worktreePath: root,
      attachments: [{
        name: 'a.txt',
        path: 'docs/a.txt',
        sizeBytes: 1,
        digest: 'a'.repeat(64),
      }],
      notesDir: NOTES,
    })).rejects.toThrow(/path|managed|attachments/i);
  });
});

describe('listAttachmentCopiesAtRisk (removal of a run-owned checkout)', () => {
  const NOTES = '.codedeck/runs/abcdef12';

  it('is empty when every copy matches and nothing else is in the attachments folder', async () => {
    const root = await checkout();
    const first = await writeCopy(root, `${NOTES}/attachments/01-a.txt`, 'alpha');
    await expect(listAttachmentCopiesAtRisk({ worktreePath: root, notesDir: NOTES, attachments: [{ name: 'a.txt', ...first }] })).resolves.toEqual([]);
  });

  it('is empty when the run has no attachments folder', async () => {
    const root = await checkout();
    await expect(listAttachmentCopiesAtRisk({ worktreePath: root, notesDir: NOTES, attachments: [] })).resolves.toEqual([]);
    await expect(listAttachmentCopiesAtRisk({ worktreePath: root, notesDir: null, attachments: [] })).resolves.toEqual([]);
  });

  it('names changed, missing-from-manifest and non-file entries', async () => {
    const root = await checkout();
    const first = await writeCopy(root, `${NOTES}/attachments/01-a.txt`, 'alpha');
    const second = await writeCopy(root, `${NOTES}/attachments/02-b.txt`, 'beta');
    await fs.writeFile(path.join(root, first.path), 'ALPHA');
    await writeCopy(root, `${NOTES}/attachments/03-unknown.txt`, 'who');
    await fs.mkdir(path.join(root, NOTES, 'attachments', 'folder'));
    const atRisk = await listAttachmentCopiesAtRisk({
      worktreePath: root,
      notesDir: NOTES,
      attachments: [{ name: 'a.txt', ...first }, { name: 'b.txt', ...second }],
    });
    expect(atRisk.sort()).toEqual([
      `${NOTES}/attachments/01-a.txt`,
      `${NOTES}/attachments/03-unknown.txt`,
      `${NOTES}/attachments/folder`,
    ]);
  });

  it('names an unknown copy in a run that recorded no attachments', async () => {
    const root = await checkout();
    await writeCopy(root, `${NOTES}/attachments/01-x.txt`, 'x');
    await expect(listAttachmentCopiesAtRisk({ worktreePath: root, notesDir: NOTES, attachments: [] })).resolves.toEqual([`${NOTES}/attachments/01-x.txt`]);
  });
});
