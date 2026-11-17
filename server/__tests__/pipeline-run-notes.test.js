import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { noteFileName, notePath, buildReadme, prepare, readNote } from '../pipelines/run-notes.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function repo() {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.run-notes-test-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  await fs.writeFile(path.join(root, 'tracked'), 'x');
  execFileSync('git', ['-C', root, 'add', 'tracked']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base']);
  return root;
}

const definition = {
  workflowName: 'General workflow',
  notesDir: '.codedeck/runs/abcdef12',
  steps: [
    { kind: 'setup', name: 'Setup', agent: { name: 'Claude' } },
    { kind: 'node', name: 'Build things', agent: { name: 'Codex' } },
  ],
};

describe('run notes', () => {
  it('makes bounded, deterministic file names', () => {
    expect(noteFileName(1, 'Build things')).toBe('01-build-things.md');
    expect(noteFileName(2, 'É #')).toBe('02-step.md');
    expect(noteFileName(3, 'A'.repeat(64))).toBe(`03-${'a'.repeat(32)}.md`);
  });
  it('only gives node steps a note path', () => {
    expect(notePath(definition, 0)).toBeNull();
    expect(notePath(definition, 1)).toBe('.codedeck/runs/abcdef12/01-build-things.md');
    expect(notePath({ ...definition, notesDir: null }, 1)).toBeNull();
  });
  it('describes every step and its handoff', () => {
    const readme = buildReadme(definition, 'do a thing');
    expect(readme).toContain('do a thing');
    expect(readme).toContain('01-build-things.md');
    expect(readme).toContain('Setup');
    expect(readme).toBe(buildReadme(definition, 'do a thing'));
  });
  it('rejects bad arguments', () => {
    expect(() => noteFileName(-1, 'Build')).toThrow(/stepIndex/);
    expect(() => noteFileName(1, null)).toThrow(/stepName/);
    expect(() => notePath({ ...definition, notesDir: '../bad' }, 1)).toThrow(/notesDir/);
    expect(() => buildReadme(definition, null)).toThrow(/input/);
  });
  it('requires the file reader at the read edge', async () => {
    await expect(readNote({ worktreePath: process.cwd(), definition, stepIndex: 1, fs: { stat() {}, realpath() {}, open() {} } })).rejects.toThrow(/fs/);
  });
  it('prepares an ignored README without making the worktree dirty', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: 'do a thing' });
    expect(await fs.readFile(path.join(root, '.codedeck/.gitignore'), 'utf8')).toBe('*\n');
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
    await prepare({ worktreePath: root, definition, input: 'second input' });
    expect(await fs.readFile(path.join(root, definition.notesDir, 'README.md'), 'utf8')).toContain('second input');
  });
  it('preserves an existing ignore file and refuses tracked .codedeck content', async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, '.codedeck'));
    await fs.writeFile(path.join(root, '.codedeck/.gitignore'), '*\n# keep\n');
    await prepare({ worktreePath: root, definition, input: '' });
    expect(await fs.readFile(path.join(root, '.codedeck/.gitignore'), 'utf8')).toBe('*\n# keep\n');
    await fs.writeFile(path.join(root, '.codedeck/tracked'), 'keep');
    execFileSync('git', ['-C', root, 'add', '-f', '.codedeck/tracked']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'track notes']);
    await expect(prepare({ worktreePath: root, definition, input: '' })).rejects.toThrow(`Run notes folder ${definition.notesDir} is not ignored by git in this worktree`);
  });
  it('rejects an existing ignore file that does not ignore notes without changing it or tracking notes', async () => {
    const root = await repo();
    const dotPath = path.join(root, '.codedeck');
    const ignorePath = path.join(dotPath, '.gitignore');
    const original = Buffer.from('# keep this comment\n');
    await fs.mkdir(dotPath);
    await fs.writeFile(ignorePath, original);
    await expect(prepare({ worktreePath: root, definition, input: '' }))
      .rejects.toThrow(`Run notes folder ${definition.notesDir} is not ignored by git in this worktree`);
    expect(await fs.readFile(ignorePath)).toEqual(original);
    expect(execFileSync('git', ['-C', root, 'ls-files', '--', '.codedeck'], { encoding: 'utf8' })).toBe('');
  });
  it('surfaces a git check-ignore failure other than exit 1', async () => {
    const root = await repo();
    const failingGit = (command, args, options, callback) => {
      if (args.includes('check-ignore')) {
        const error = new Error('git check-ignore failed: repository unavailable');
        error.code = 128;
        callback(error, '', 'repository unavailable');
      } else import('node:child_process').then(({ execFile }) => execFile(command, args, options, callback));
    };
    await expect(prepare({ worktreePath: root, definition, input: '', execFile: failingGit })).rejects.toThrow(/repository unavailable/);
  });
  it('reads notes only inside the worktree and enforces the size boundary', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    const target = path.join(root, notePath(definition, 1));
    expect(await readNote({ worktreePath: root, definition, stepIndex: 1 })).toEqual({ status: 'missing', content: null });
    await fs.writeFile(target, 'x'.repeat(262_144));
    expect((await readNote({ worktreePath: root, definition, stepIndex: 1 })).status).toBe('present');
    await fs.appendFile(target, 'x');
    expect((await readNote({ worktreePath: root, definition, stepIndex: 1 })).status).toBe('too_large');
    await fs.rm(target);
    await fs.symlink(path.join(process.cwd(), 'package.json'), target);
    expect((await readNote({ worktreePath: root, definition, stepIndex: 1 })).status).toBe('unreadable');
  });
  it('refuses a note symlink even when it points inside the worktree', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    const ordinary = path.join(root, definition.notesDir, 'ordinary.md');
    await fs.writeFile(ordinary, '# Ordinary');
    await fs.symlink(ordinary, path.join(root, notePath(definition, 1)));
    expect((await readNote({ worktreePath: root, definition, stepIndex: 1 })).status).toBe('unreadable');
  });
  it('does not rewrite a README symlink that leaves the worktree', async () => {
    const root = await repo();
    const outside = path.join(process.cwd(), '.run-notes-outside-test');
    roots.push(outside);
    await fs.writeFile(outside, 'outside');
    await fs.mkdir(path.join(root, definition.notesDir), { recursive: true });
    await fs.symlink(outside, path.join(root, definition.notesDir, 'README.md'));
    await expect(prepare({ worktreePath: root, definition, input: '' })).rejects.toThrow(/leaves the worktree/);
    expect(await fs.readFile(outside, 'utf8')).toBe('outside');
  });
  it('never reads more than the measured file size', async () => {
    const root = await repo();
    await prepare({ worktreePath: root, definition, input: '' });
    await fs.writeFile(path.join(root, notePath(definition, 1)), 'x');
    const fakeFs = { ...fs, readFile: async () => 'x'.repeat(262_145) };
    expect(await readNote({ worktreePath: root, definition, stepIndex: 1, fs: fakeFs })).toEqual({ status: 'present', content: 'x' });
  });
});
