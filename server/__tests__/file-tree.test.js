import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { readTree } from '../file-tree.js';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'codedeck-file-tree-'));
}

describe('readTree', () => {
  const tempDirs = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map(dir => fs.rm(dir, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  it('includes dotfiles while keeping explicitly ignored entries out of the tree', async () => {
    const root = await makeTempDir();
    tempDirs.push(root);

    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, '.git'));
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules\n');
    await fs.writeFile(path.join(root, 'README.md'), '# test\n');
    await fs.writeFile(path.join(root, 'src', '.env.example'), 'KEY=value\n');

    const tree = await readTree(root);

    expect(tree.map(entry => entry.name)).toEqual([
      'src',
      '.gitignore',
      'README.md',
    ]);

    const srcNode = tree.find(entry => entry.name === 'src');
    expect(srcNode?.children).toEqual([
      {
        name: '.env.example',
        path: path.join(root, 'src', '.env.example'),
        type: 'file',
      },
    ]);
  });
});
