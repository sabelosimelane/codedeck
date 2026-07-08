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

    const tree = await readTree({ kind: 'local' }, root);

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

  it('handles deeper directory structures than the previous 3-level limit', async () => {
    const root = await makeTempDir();
    tempDirs.push(root);

    // root/1/2/3/4/file.txt
    let currentDir = root;
    for (let i = 1; i <= 5; i++) {
      currentDir = path.join(currentDir, i.toString());
      await fs.mkdir(currentDir);
    }
    const deepFile = path.join(currentDir, 'file.txt');
    await fs.writeFile(deepFile, 'content');

    const tree = await readTree({ kind: 'local' }, root);

    // level 0: [1]
    // level 1: [2]
    // level 2: [3]
    // level 3: [4]
    // level 4: [5]
    // level 5: [file.txt]

    let node = tree[0];
    for (let i = 1; i <= 5; i++) {
      expect(node.name).toBe(i.toString());
      expect(node.children.length).toBe(1);
      node = node.children[0];
    }
    expect(node.name).toBe('file.txt');
    expect(node.type).toBe('file');
  });

  it('reads directory entries using remote ls command via remote runner', async () => {
    const root = '/var/www';
    const fakeRunner = {
      kind: 'remote',
      run: async (cmd, args) => {
        const fullCmd = `${cmd} ${args.join(' ')}`;
        if (fullCmd === 'ls -1pA /var/www') {
          return { stdout: 'src/\n.gitignore\nREADME.md\n.git/\n' };
        } else if (fullCmd === 'ls -1pA /var/www/src') {
          return { stdout: '.env.example\n' };
        }
        return { stdout: '' };
      }
    };

    const tree = await readTree(fakeRunner, root);

    expect(tree.map(entry => entry.name)).toEqual([
      'src',
      '.gitignore',
      'README.md',
    ]);

    const srcNode = tree.find(entry => entry.name === 'src');
    expect(srcNode?.children).toEqual([
      {
        name: '.env.example',
        path: '/var/www/src/.env.example',
        type: 'file',
      },
    ]);
  });
});
