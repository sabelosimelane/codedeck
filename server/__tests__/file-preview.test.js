import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { readFilePreview } from '../file-preview.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-file-preview-'));
}

describe('readFilePreview', () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('returns UTF-8 text content for previewable files', async () => {
    const root = await makeTempDir();
    tempDirs.push(root);

    const filePath = path.join(root, 'notes.md');
    await fs.writeFile(filePath, '# Preview\nhello world\n');

    const preview = await readFilePreview(filePath);

    expect(preview).toEqual({
      kind: 'text',
      format: 'markdown',
      truncated: false,
      size: 22,
      content: '# Preview\nhello world\n',
    });
  });

  it('marks previews as truncated when the file exceeds the byte budget', async () => {
    const root = await makeTempDir();
    tempDirs.push(root);

    const filePath = path.join(root, 'large.txt');
    await fs.writeFile(filePath, 'abcdefghij');

    const preview = await readFilePreview(filePath, { maxBytes: 5 });

    expect(preview.kind).toBe('text');
    expect(preview.format).toBe('text');
    expect(preview.truncated).toBe(true);
    expect(preview.content).toBe('abcde');
    expect(preview.size).toBe(10);
  });

  it('returns a binary sentinel when null bytes are present', async () => {
    const root = await makeTempDir();
    tempDirs.push(root);

    const filePath = path.join(root, 'image.bin');
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x00, 0x4e]));

    const preview = await readFilePreview(filePath);

    expect(preview).toEqual({
      kind: 'binary',
      format: 'binary',
      truncated: false,
      size: 4,
      content: null,
    });
  });
});
