import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePhaseProgress, createRunProgressReader, resolveRunProgressFile, readRunProgress, isProgressFileInWorktree, createCachedProgressReader } from '../pipelines/run-progress.js';

describe('isProgressFileInWorktree preconditions', () => {
  it.each([undefined, '', 'relative', 7])('rejects worktreePath %s', async worktreePath => {
    await expect(isProgressFileInWorktree({ worktreePath, progressFile: 'todo.md' })).rejects.toThrow('worktreePath must be a non-empty absolute path');
  });
  it.each([undefined, '', 7])('rejects progressFile %s', async progressFile => {
    await expect(isProgressFileInWorktree({ worktreePath: '/tmp/worktree', progressFile })).rejects.toThrow('progressFile must be a non-empty string');
  });
  it('rejects an invalid fs implementation', async () => {
    await expect(isProgressFileInWorktree({ worktreePath: '/tmp/worktree', progressFile: 'todo.md', fs: {} })).rejects.toThrow('fs must support stat and realpath');
  });
});

describe('resolveRunProgressFile', () => {
  const resolve = (definitionProgressFile, workflowProgressFile, input = 'todo.md', notesDir = null) =>
    resolveRunProgressFile({ definitionProgressFile, workflowProgressFile, input, notesDir });

  it('keeps the run snapshot over a changed workflow setting', () => {
    expect(resolve('docs/original.md', 'docs/{input}', 'todo.md', '.codedeck/runs/12345678')).toEqual({ file: 'docs/original.md', optional: false });
  });
  it('composes the current workflow template once when the snapshot is null', () => {
    expect(resolve(null, 'docs/{input}', 'tasks/todo.md')).toEqual({ file: 'docs/tasks/todo.md', optional: false });
    expect(resolve(null, 'docs/{input}', '$&.md')).toEqual({ file: 'docs/$&.md', optional: false });
    expect(resolve(null, 'docs/todo.md')).toEqual({ file: 'docs/todo.md', optional: false });
  });
  it('uses the run notes plan only when no configured file applies', () => {
    expect(resolve(null, null, 'task', '.codedeck/runs/12345678')).toEqual({ file: '.codedeck/runs/12345678/plan.md', optional: true });
    expect(resolve(null, 'docs/{input}', 'invalid task', '.codedeck/runs/12345678')).toBeNull();
  });
  it('returns null without a workflow setting or when the composed path is invalid', () => {
    expect(resolve(null, null)).toBeNull();
    for (const input of ['fix the login bug', '', '../todo.md', 'x'.repeat(510)]) {
      expect(resolve(null, 'docs/{input}', input)).toBeNull();
    }
  });
  it('checks every argument', () => {
    expect(() => resolve(1, null)).toThrow(TypeError);
    expect(() => resolve(1, null)).toThrow(/definitionProgressFile/);
    expect(() => resolve(null, 1)).toThrow(TypeError);
    expect(() => resolve(null, 1)).toThrow(/workflowProgressFile/);
    expect(() => resolve(null, null, null)).toThrow(TypeError);
    expect(() => resolve(null, null, null)).toThrow(/input/);
    for (const notesDir of [undefined, 1, '', '/tmp/notes', '.codedeck/runs/bad', '../escape']) {
      expect(() => resolveRunProgressFile({ definitionProgressFile: null, workflowProgressFile: null, input: '', notesDir })).toThrow(/notesDir/);
    }
  });
});

describe('parsePhaseProgress', () => {
  it('selects the first phase with unticked tasks and counts all phases', () => {
    expect(parsePhaseProgress('## Phase 1: Done\n- [x] a\n## Session notes\n- [ ] ignore\n## Phase 2 — Review\n### Room\n- [X] a\n- [ ] b\n## Phase 3\n')).toEqual({ phaseCount: 3, phase: { number: 2, title: 'Review', tasksDone: 1, tasksTotal: 2 }, tasksDone: 2, tasksTotal: 3 });
  });
  it('ignores fenced sections and tasks', () => {
    expect(parsePhaseProgress('```md\n## Phase 1: Fake\n- [ ] fake\n```\n## Phase 2 - Real\n~~~\n- [ ] fake\n~~~\n- [ ] real')).toEqual({ phaseCount: 1, phase: { number: 2, title: 'Real', tasksDone: 0, tasksTotal: 1 }, tasksDone: 0, tasksTotal: 1 });
  });
  it('toggles a fence on either marker and accepts tabs between heading tokens', () => {
    expect(parsePhaseProgress('```\n## Phase 1: Hidden\n~~~\n##\tPhase\t2: Visible\n- [ ] task')).toEqual({ phaseCount: 1, phase: { number: 2, title: 'Visible', tasksDone: 0, tasksTotal: 1 }, tasksDone: 0, tasksTotal: 1 });
  });
  it('handles all ticked, no phases, separators and long titles', () => {
    expect(parsePhaseProgress('## Phase 1. Done\n- [x] yes')).toEqual({ phaseCount: 1, phase: null, tasksDone: 1, tasksTotal: 1 });
    expect(parsePhaseProgress('## Session notes\n- [ ] no')).toEqual({ phaseCount: 0, phase: null, tasksDone: 0, tasksTotal: 0 });
    expect(parsePhaseProgress(`## Phase 9: ${'a'.repeat(125)} ###\n+ [ ] task`).phase.title).toHaveLength(120);
    expect(parsePhaseProgress('## Phase 4\n* [ ] task').phase.title).toBe('');
  });
  it('rejects non-string input', () => expect(() => parsePhaseProgress(null)).toThrow(TypeError));
});

describe('readRunProgress', () => {
  const dirs = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
  async function run(progressFile = null, notesDir = null) {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-progress-run-'));
    dirs.push(worktreePath);
    return { definition: { progressFile, notesDir }, workflowId: 'workflow', input: 'todo.md', worktreePath, worktreeState: 'present' };
  }
  it('reads a configured source with totals and keeps the API fields separate', async () => {
    const item = await run('todo.md');
    await fs.writeFile(path.join(item.worktreePath, 'todo.md'), '## Phase 1\n- [x] done\n- [ ] todo\n## Phase 2\n- [x] done');
    expect(await readRunProgress({ run: item, workflowProgressFile: null, progressReader: createRunProgressReader() }))
      .toMatchObject({ file: 'todo.md', status: 'in_progress', tasksDone: 2, tasksTotal: 3 });
  });
  it('reads the run plan, and returns null without a source', async () => {
    const item = await run(null, '.codedeck/runs/12345678');
    await fs.mkdir(path.join(item.worktreePath, item.definition.notesDir), { recursive: true });
    await fs.writeFile(path.join(item.worktreePath, item.definition.notesDir, 'plan.md'), '## Phase 1\n- [x] done');
    expect((await readRunProgress({ run: item, workflowProgressFile: null, progressReader: createRunProgressReader() })).tasksDone).toBe(1);
    item.definition.notesDir = null;
    expect(await readRunProgress({ run: item, workflowProgressFile: null, progressReader: createRunProgressReader() })).toBeNull();
  });
  it('reports a configured missing source and an unreadable source', async () => {
    const item = await run('todo.md');
    const reader = createRunProgressReader();
    expect((await readRunProgress({ run: item, workflowProgressFile: null, progressReader: reader })).status).toBe('missing');
    await fs.mkdir(path.join(item.worktreePath, 'todo.md'));
    expect((await readRunProgress({ run: item, workflowProgressFile: null, progressReader: reader })).status).toBe('unreadable');
  });
  it('returns null when the run worktree is not on disk', async () => {
    const item = await run('todo.md');
    await fs.rm(item.worktreePath, { recursive: true });
    expect(await readRunProgress({ run: item, workflowProgressFile: null, progressReader: createRunProgressReader() })).toBeNull();
  });
  it('rejects malformed arguments at the edge', async () => {
    const item = await run();
    await expect(readRunProgress({ run: null, workflowProgressFile: null, progressReader: createRunProgressReader() })).rejects.toThrow(/run/);
    await expect(readRunProgress({ run: item, workflowProgressFile: undefined, progressReader: createRunProgressReader() })).rejects.toThrow(/workflowProgressFile/);
    await expect(readRunProgress({ run: item, workflowProgressFile: null, progressReader: null })).rejects.toThrow(/progressReader/);
  });
});

describe('createRunProgressReader', () => {
  const dirs = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
  async function fixture(content) {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-progress-'));
    dirs.push(worktreePath);
    if (content !== null) await fs.writeFile(path.join(worktreePath, 'todo.md'), content);
    return { worktreePath, progressFile: 'todo.md' };
  }
  it.each([
    ['## Phase 1: Review\n- [ ] task', 'in_progress', 1],
    ['## Phase 1: Review\n- [x] task', 'all_done', 1],
    ['## Notes\n- [ ] task', 'no_phases', null],
    [null, 'missing', null],
  ])('reads %s as %s', async (content, status, phaseCount) => {
    const args = await fixture(content);
    expect(await createRunProgressReader({ fs }).read(args)).toMatchObject({ file: 'todo.md', status, phaseCount });
  });
  it('rejects directories, escapes, symlinks and oversize files', async () => {
    const args = await fixture(null);
    await fs.mkdir(path.join(args.worktreePath, 'folder.md'));
    expect((await createRunProgressReader({ fs }).read({ ...args, progressFile: 'folder.md' })).status).toBe('unreadable');
    expect((await createRunProgressReader({ fs }).read({ ...args, progressFile: '../escape.md' })).status).toBe('unreadable');
    const outside = await fixture('## Phase 1\n- [ ] task');
    await fs.symlink(path.join(outside.worktreePath, 'todo.md'), path.join(args.worktreePath, 'link.md'));
    expect((await createRunProgressReader({ fs }).read({ ...args, progressFile: 'link.md' })).status).toBe('unreadable');
    await fs.writeFile(path.join(args.worktreePath, 'big.md'), 'x'.repeat(1048577));
    expect((await createRunProgressReader({ fs }).read({ ...args, progressFile: 'big.md' })).status).toBe('unreadable');
    await fs.writeFile(path.join(args.worktreePath, 'big.md'), 'x'.repeat(1048576));
    expect((await createRunProgressReader({ fs }).read({ ...args, progressFile: 'big.md' })).status).toBe('no_phases');
  });
  it('caches by mtime and size then refreshes', async () => {
    const args = await fixture('## Phase 1\n- [ ] task');
    const injected = { ...fs, open: vi.fn(fs.open) };
    const reader = createRunProgressReader({ fs: injected });
    await reader.read(args);
    await reader.read(args);
    expect(injected.open).toHaveBeenCalledTimes(1);
    await fs.writeFile(path.join(args.worktreePath, 'todo.md'), '## Phase 1\n- [x] task\n');
    expect((await reader.read(args)).status).toBe('all_done');
    expect(injected.open).toHaveBeenCalledTimes(2);
  });
  it('checks arguments', async () => {
    const reader = createRunProgressReader({ fs });
    await expect(reader.read({ worktreePath: 'relative', progressFile: 'x.md' })).rejects.toThrow();
    await expect(reader.read({ worktreePath: '/tmp', progressFile: '' })).rejects.toThrow();
  });
});

describe('createCachedProgressReader', () => {
  const PROGRESS = { file: 'docs/todo.md', status: 'in_progress', phaseCount: 2, phase: { number: 1, title: 'One', tasksDone: 0, tasksTotal: 1 }, tasksDone: 0, tasksTotal: 2 };
  function setup() {
    let clock = 1_000;
    const inner = { worktreeExists: vi.fn(async () => true), read: vi.fn(async () => PROGRESS) };
    const reader = createCachedProgressReader(inner, { ttlMs: 5_000, now: () => clock });
    return { inner, reader, advance: ms => { clock += ms; } };
  }
  const ask = { worktreePath: '/srv/wt', progressFile: 'docs/todo.md' };

  it('answers a repeated read from the last answer while it is fresh, and asks again once it is not', async () => {
    const { inner, reader, advance } = setup();
    expect(await reader.read(ask)).toEqual(PROGRESS);
    expect(await reader.worktreeExists('/srv/wt')).toBe(true);
    advance(4_999);
    await reader.read(ask); await reader.worktreeExists('/srv/wt');
    expect(inner.read).toHaveBeenCalledTimes(1);
    expect(inner.worktreeExists).toHaveBeenCalledTimes(1);
    advance(2);
    await reader.read(ask); await reader.worktreeExists('/srv/wt');
    expect(inner.read).toHaveBeenCalledTimes(2);
    expect(inner.worktreeExists).toHaveBeenCalledTimes(2);
  });
  it('keeps answers apart per worktree and file, and shares one read between concurrent askers', async () => {
    const { inner, reader } = setup();
    await Promise.all([reader.read(ask), reader.read(ask), reader.read({ ...ask, progressFile: 'docs/other.md' }), reader.read({ ...ask, worktreePath: '/srv/other' })]);
    expect(inner.read).toHaveBeenCalledTimes(3);
  });
  it('does not keep a failure', async () => {
    const { inner, reader } = setup();
    inner.read.mockRejectedValueOnce(new Error('ssh: connection lost'));
    await expect(reader.read(ask)).rejects.toThrow('ssh: connection lost');
    expect(await reader.read(ask)).toEqual(PROGRESS);
    expect(inner.read).toHaveBeenCalledTimes(2);
  });
  it('requires a reader, a positive freshness and a clock', () => {
    expect(() => createCachedProgressReader({}, { ttlMs: 1, now: () => 0 })).toThrow('reader');
    expect(() => createCachedProgressReader({ read() {}, worktreeExists() {} }, { ttlMs: 0, now: () => 0 })).toThrow('ttlMs');
    expect(() => createCachedProgressReader({ read() {}, worktreeExists() {} }, { ttlMs: 1, now: 'x' })).toThrow('now');
  });
});
