import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachmentManifest,
  publishAttachmentBatch,
  removeUnpublishedAttachments,
} from '../pipelines/attachment-publisher.js';

const NOTES_DIR = '.codedeck/runs/1a2b3c4d';
const cleanup = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });

function tempDir(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => {
    try { chmodSync(dir, 0o700); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeCheckout() {
  const repo = tempDir('cd-attach-repo-');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Attach Test');
  git('config', 'user.email', 'attach@test.local');
  writeFileSync(path.join(repo, 'README.md'), '# repo\n');
  git('add', 'README.md');
  git('commit', '-m', 'init');
  return { repo, git };
}

function stage(contents) {
  const staging = tempDir('cd-attach-stage-');
  return contents.map(([name, body], index) => {
    const bytes = Buffer.from(body);
    const stagingPath = path.join(staging, `${String(index).padStart(2, '0')}-${randomUUID()}`);
    writeFileSync(stagingPath, bytes);
    return { name, sizeBytes: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), stagingPath };
  });
}

const publish = (checkoutPath, files, extra = {}) => publishAttachmentBatch({
  checkoutPath, notesDir: NOTES_DIR, attemptId: randomUUID(), files, execFile, ...extra,
});

describe('attachment manifest names', () => {
  it('generates distinct portable names that keep a safe extension', () => {
    const files = [
      { name: 'report.PDF', sizeBytes: 1, digest: 'a'.repeat(64) },
      { name: 'report.PDF', sizeBytes: 1, digest: 'a'.repeat(64) },
      { name: 'evil name; rm -rf *.md', sizeBytes: 2, digest: 'b'.repeat(64) },
      { name: 'no-extension', sizeBytes: 3, digest: 'c'.repeat(64) },
      { name: 'Ünïcødé ✓.weird-ext!', sizeBytes: 4, digest: 'd'.repeat(64) },
      { name: '.env', sizeBytes: 5, digest: 'e'.repeat(64) },
    ];
    const manifest = attachmentManifest({ notesDir: NOTES_DIR, files });
    expect(manifest.map(entry => entry.path)).toEqual([
      `${NOTES_DIR}/attachments/01-report.pdf`,
      `${NOTES_DIR}/attachments/02-report.pdf`,
      `${NOTES_DIR}/attachments/03-evil-name-rm-rf.md`,
      `${NOTES_DIR}/attachments/04-no-extension`,
      `${NOTES_DIR}/attachments/05-n-c-d-weird-ext`,
      `${NOTES_DIR}/attachments/06-env`,
    ]);
    expect(manifest.map(({ name, sizeBytes, digest }) => ({ name, sizeBytes, digest })))
      .toEqual(files.map(({ name, sizeBytes, digest }) => ({ name, sizeBytes, digest })));
  });
});

describe('publishAttachmentBatch', () => {
  it('publishes an ordered batch with exact bytes, ignored by git and owned by the run', async () => {
    const { repo, git } = makeCheckout();
    const files = stage([['a.txt', 'alpha'], ['a.txt', 'different bytes'], ['empty.bin', '']]);
    const { attachments, alreadyPublished } = await publish(repo, files);
    expect(alreadyPublished).toBe(false);
    expect(attachments.map(entry => entry.name)).toEqual(['a.txt', 'a.txt', 'empty.bin']);
    expect(attachments.map(entry => readFileSync(path.join(repo, entry.path), 'utf8'))).toEqual(['alpha', 'different bytes', '']);
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('');
    // Only the promoted batch remains: no temporary batch is left beside it.
    expect(readdirSync(path.join(repo, NOTES_DIR)).sort()).toEqual(['attachments']);
    expect(statSync(path.join(repo, NOTES_DIR, 'attachments')).uid).toBe(process.getuid());
  });

  it('keeps a repeated selection of the same file as two distinct copies', async () => {
    const { repo } = makeCheckout();
    const files = stage([['same.txt', 'same'], ['same.txt', 'same']]);
    const { attachments } = await publish(repo, files);
    expect(new Set(attachments.map(entry => entry.path)).size).toBe(2);
    expect(attachments.map(entry => readFileSync(path.join(repo, entry.path), 'utf8'))).toEqual(['same', 'same']);
  });

  it('creates nothing for an attachment-free run', async () => {
    const { repo } = makeCheckout();
    const result = await publish(repo, []);
    expect(result).toEqual({ attachments: [], alreadyPublished: false });
    expect(existsSync(path.join(repo, '.codedeck'))).toBe(false);
  });

  it('removes the partial batch when a later copy fails and reports the file', async () => {
    const { repo } = makeCheckout();
    const files = stage([['a.txt', 'alpha'], ['b.txt', 'beta']]);
    rmSync(files[1].stagingPath);
    await expect(publish(repo, files)).rejects.toMatchObject({ status: 500, errors: [{ field: 'files[1]' }] });
    expect(readdirSync(path.join(repo, NOTES_DIR))).toEqual([]);
  });

  it('refuses bytes that do not match the recorded digest and size', async () => {
    const { repo } = makeCheckout();
    const files = stage([['a.txt', 'alpha']]);
    writeFileSync(files[0].stagingPath, 'ALPHA');
    await expect(publish(repo, files)).rejects.toMatchObject({ status: 500, errors: [{ field: 'files[0]' }] });
    writeFileSync(files[0].stagingPath, 'alphabet');
    await expect(publish(repo, files)).rejects.toMatchObject({ errors: [{ field: 'files[0]' }] });
    expect(readdirSync(path.join(repo, NOTES_DIR))).toEqual([]);
  });

  it('refuses a symlinked parent and writes nothing outside the checkout', async () => {
    const { repo } = makeCheckout();
    const outside = tempDir('cd-attach-outside-');
    symlinkSync(outside, path.join(repo, '.codedeck'));
    await expect(publish(repo, stage([['a.txt', 'alpha']]))).rejects.toMatchObject({ status: 409, code: 'unsafe_location' });
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a symlinked attachments target and preserves what it points to', async () => {
    const { repo } = makeCheckout();
    const outside = tempDir('cd-attach-outside-');
    writeFileSync(path.join(outside, 'keep.txt'), 'keep');
    mkdirSync(path.join(repo, NOTES_DIR), { recursive: true });
    writeFileSync(path.join(repo, '.codedeck', '.gitignore'), '*\n');
    symlinkSync(outside, path.join(repo, NOTES_DIR, 'attachments'));
    await expect(publish(repo, stage([['a.txt', 'alpha']]))).rejects.toMatchObject({ status: 409 });
    expect(readdirSync(outside)).toEqual(['keep.txt']);
    expect(lstatSync(path.join(repo, NOTES_DIR, 'attachments')).isSymbolicLink()).toBe(true);
  });

  it('refuses a tracked run notes location', async () => {
    const { repo, git } = makeCheckout();
    mkdirSync(path.join(repo, '.codedeck'));
    writeFileSync(path.join(repo, '.codedeck', 'keep.md'), 'tracked\n');
    git('add', '.codedeck/keep.md');
    git('commit', '-m', 'track codedeck');
    await expect(publish(repo, stage([['a.txt', 'alpha']]))).rejects.toMatchObject({ status: 409, code: 'tracked' });
    expect(existsSync(path.join(repo, NOTES_DIR))).toBe(false);
  });

  it('refuses a location git does not ignore', async () => {
    const { repo, git } = makeCheckout();
    mkdirSync(path.join(repo, '.codedeck'));
    writeFileSync(path.join(repo, '.codedeck', '.gitignore'), 'README.md\n');
    await expect(publish(repo, stage([['a.txt', 'alpha']]))).rejects.toMatchObject({ status: 409, code: 'not_ignored' });
    expect(existsSync(path.join(repo, NOTES_DIR, 'attachments'))).toBe(false);
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('?? .codedeck/.gitignore\n');
  });

  it('refuses an unexpected existing batch and preserves its content', async () => {
    const { repo } = makeCheckout();
    mkdirSync(path.join(repo, NOTES_DIR, 'attachments'), { recursive: true });
    writeFileSync(path.join(repo, '.codedeck', '.gitignore'), '*\n');
    writeFileSync(path.join(repo, NOTES_DIR, 'attachments', '01-a.txt'), 'someone else');
    await expect(publish(repo, stage([['a.txt', 'alpha']]))).rejects.toMatchObject({ status: 409, code: 'collision' });
    expect(readFileSync(path.join(repo, NOTES_DIR, 'attachments', '01-a.txt'), 'utf8')).toBe('someone else');
  });

  it('reports a placement conflict and keeps the temporary directory when exclusive creation fails', async () => {
    const { repo } = makeCheckout();
    const attemptId = randomUUID();
    const temporary = path.join(repo, NOTES_DIR, `.attachments-${attemptId}.tmp`);
    mkdirSync(temporary, { recursive: true });
    writeFileSync(path.join(repo, '.codedeck', '.gitignore'), '*\n');
    const existing = path.join(temporary, 'keep.txt');
    writeFileSync(existing, 'existing content');

    const error = await publish(repo, stage([['a.txt', 'alpha']]), { attemptId }).catch(cause => cause);

    expect(existsSync(existing)).toBe(true);
    expect(readFileSync(existing, 'utf8')).toBe('existing content');
    expect(error).toMatchObject({ status: 409, code: 'collision' });
  });

  it('recognises its own complete batch on retry and never overwrites it', async () => {
    const { repo } = makeCheckout();
    const files = stage([['a.txt', 'alpha'], ['b.txt', 'beta']]);
    const first = await publish(repo, files);
    const inode = statSync(path.join(repo, first.attachments[0].path)).ino;
    const again = await publish(repo, files);
    expect(again).toEqual({ attachments: first.attachments, alreadyPublished: true });
    expect(statSync(path.join(repo, first.attachments[0].path)).ino).toBe(inode);
  });

  it('refuses a checkout path that is not absolute and a malformed notes folder', async () => {
    const files = stage([['a.txt', 'alpha']]);
    await expect(publishAttachmentBatch({ checkoutPath: 'relative', notesDir: NOTES_DIR, attemptId: randomUUID(), files, execFile }))
      .rejects.toThrow(/checkoutPath/);
    const { repo } = makeCheckout();
    await expect(publishAttachmentBatch({ checkoutPath: repo, notesDir: '../escape', attemptId: randomUUID(), files, execFile }))
      .rejects.toThrow(/notesDir/);
  });
});

describe('removeUnpublishedAttachments', () => {
  it('removes a promoted batch and temporary batches, and keeps other run notes', async () => {
    const { repo } = makeCheckout();
    const files = stage([['a.txt', 'alpha']]);
    await publish(repo, files);
    mkdirSync(path.join(repo, NOTES_DIR, `.attachments-${randomUUID()}.tmp`));
    writeFileSync(path.join(repo, NOTES_DIR, 'README.md'), 'notes');
    const result = await removeUnpublishedAttachments({ checkoutPath: repo, notesDir: NOTES_DIR, files });
    expect(result.removed).toHaveLength(2);
    expect(readdirSync(path.join(repo, NOTES_DIR))).toEqual(['README.md']);
  });

  it('preserves a foreign attachments folder that does not match the reserved identities', async () => {
    const { repo } = makeCheckout();
    const files = stage([['a.txt', 'alpha']]);
    mkdirSync(path.join(repo, NOTES_DIR, 'attachments'), { recursive: true });
    writeFileSync(path.join(repo, NOTES_DIR, 'attachments', 'keep.txt'), 'owner content');
    mkdirSync(path.join(repo, NOTES_DIR, `.attachments-${randomUUID()}.tmp`));
    const result = await removeUnpublishedAttachments({ checkoutPath: repo, notesDir: NOTES_DIR, files });
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toMatch(/\.attachments-.*\.tmp$/);
    expect(readFileSync(path.join(repo, NOTES_DIR, 'attachments', 'keep.txt'), 'utf8')).toBe('owner content');
  });

  it('removes an empty attachments folder left behind by an unpublished attempt', async () => {
    const { repo } = makeCheckout();
    mkdirSync(path.join(repo, NOTES_DIR, 'attachments'), { recursive: true });
    writeFileSync(path.join(repo, NOTES_DIR, 'keep.md'), 'not managed');
    const result = await removeUnpublishedAttachments({
      checkoutPath: repo, notesDir: NOTES_DIR, files: stage([['a.txt', 'alpha']]),
    });
    expect(result.removed).toEqual([`${NOTES_DIR}/attachments`]);
    expect(readdirSync(path.join(repo, NOTES_DIR))).toEqual(['keep.md']);
  });

  it('does nothing when the checkout or run folder is gone', async () => {
    const { repo } = makeCheckout();
    expect(await removeUnpublishedAttachments({ checkoutPath: repo, notesDir: NOTES_DIR })).toEqual({ removed: [] });
    expect(await removeUnpublishedAttachments({ checkoutPath: path.join(repo, 'missing'), notesDir: NOTES_DIR })).toEqual({ removed: [] });
  });

  it('refuses to follow a symlinked parent and leaves the target alone', async () => {
    const { repo } = makeCheckout();
    const outside = tempDir('cd-attach-outside-');
    mkdirSync(path.join(outside, 'runs', '1a2b3c4d', 'attachments'), { recursive: true });
    writeFileSync(path.join(outside, 'runs', '1a2b3c4d', 'attachments', 'keep'), 'keep');
    symlinkSync(outside, path.join(repo, '.codedeck'));
    await expect(removeUnpublishedAttachments({ checkoutPath: repo, notesDir: NOTES_DIR })).rejects.toMatchObject({ code: 'unsafe_location' });
    expect(readFileSync(path.join(outside, 'runs', '1a2b3c4d', 'attachments', 'keep'), 'utf8')).toBe('keep');
  });
});
