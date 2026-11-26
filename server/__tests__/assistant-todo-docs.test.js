import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as callbackExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readTodoDocs } from '../assistant/todo-docs.js';

const execFile = promisify(callbackExecFile);
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-docs-'));
  roots.push(root);
  await execFile('git', ['init', '-q', root]);
  await fs.mkdir(path.join(root, 'docs/todos'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs/specifications'), { recursive: true });
  return root;
}

describe('readTodoDocs', () => {
  it('reads working-copy headers, dependencies, phases, repository roles and Git status', async () => {
    const root = await repo();
    const rel = 'docs/todos/2026-11-25-work.md';
    await fs.writeFile(path.join(root, rel), '# Work\n**Spec**: `docs/specifications/work.md`\n**Status**: In Progress\n**Repositories**: backend (this todo), frontend (minor)\n> Wait for docs/todos/other.md before this.\n## Phase 1: Setup\n- [x] yes\n- [ ] no');
    await fs.writeFile(path.join(root, 'docs/specifications/work.md'), '# Specification');
    const result = await readTodoDocs({ root, location: 'main:backend', execFile });
    expect(result.todos).toMatchObject([{ path: rel, location: 'main:backend', title: 'Work', spec: 'docs/specifications/work.md', status: 'In Progress', dependsOn: ['docs/todos/other.md'], phases: [{ number: 1, title: 'Setup', done: 1, total: 2 }], committed: false }]);
    expect(result.todos[0].repositories.entries).toHaveLength(2);
    expect(result.specifications).toEqual([{ path: 'docs/specifications/work.md', location: 'main:backend', committed: false }]);
  });
  it('keeps newest 50 names, skips oversized files, and reports bounds', async () => {
    const root = await repo();
    for (let i = 0; i < 52; i++) await fs.writeFile(path.join(root, 'docs/todos', `${String(i).padStart(2, '0')}.md`), `# Todo ${i}`);
    await fs.writeFile(path.join(root, 'docs/specifications', 'large.md'), 'x'.repeat(512 * 1024 + 1));
    const result = await readTodoDocs({ root, location: 'main:backend', execFile });
    expect(result.todos).toHaveLength(50);
    expect(result.todos.map(todo => todo.path)).not.toContain('docs/todos/00.md');
    expect(result.truncated).toMatchObject({ todos: true, specifications: false });
    expect(result.skipped).toEqual([{ path: 'docs/specifications/large.md', size: 512 * 1024 + 1, reason: 'too_large' }]);
  });
  it('skips a todo without a title, a folder and a broken link instead of failing the whole read', async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, 'docs/todos/notes.md'), 'Just a paragraph.\n');
    await fs.mkdir(path.join(root, 'docs/todos/folder.md'));
    await fs.symlink(path.join(root, 'nowhere.md'), path.join(root, 'docs/todos/broken.md'));
    await fs.writeFile(path.join(root, 'docs/todos/good.md'), '# Good\n');
    const result = await readTodoDocs({ root, location: 'main:backend', execFile });
    expect(result.todos.map(todo => todo.path)).toEqual(['docs/todos/good.md']);
    expect(result.skipped).toEqual([
      { path: 'docs/todos/notes.md', size: 18, reason: 'no_title' },
      { path: 'docs/todos/folder.md', size: null, reason: 'not_a_file' },
      { path: 'docs/todos/broken.md', size: null, reason: 'missing' },
    ]);
  });
  it('reports a missing location without running Git', async () => {
    const result = await readTodoDocs({ root: '/definitely/missing/assistant', location: 'task:t/w', execFile: () => { throw new Error('Git was called'); } });
    expect(result).toEqual({ missing: true });
  });
  it('rejects a malformed dirty path collection with the location named', async () => {
    const root = await repo();
    await expect(readTodoDocs({ root, location: 'main:backend', dirtyPaths: 'bad', execFile })).rejects.toThrow(root);
  });
});
