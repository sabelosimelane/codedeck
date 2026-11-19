import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTaskStore } from '../tasks/task-store.js';
import { createRunStore } from '../pipelines/run-store.js';
import { createTerminalSessionWorktreeStore } from '../terminal-session-worktree-store.js';
import { adoptWorktrees } from '../tasks/task-adoption.js';

const HOME = '/tmp/git/demo';
const RUN_WT = '/tmp/git/worktrees/demo-feature-1111';
const TERM_WT = '/tmp/git/worktrees/demo-spike';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const AGENT = { id: 'c4100000-0000-4000-8000-000000000001', name: 'codex', launchCommand: 'codex', resetCommand: '/clear' };
const databases = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

function setup({ worktrees } = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  const stores = { taskStore: createTaskStore(db), runStore: createRunStore(db), worktreeStore: createTerminalSessionWorktreeStore(db) };
  let created = 0;
  const listWorktrees = vi.fn(async () => worktrees ?? [
    { path: HOME, head: HEAD, branch: 'main', missing: false },
    { path: RUN_WT, head: HEAD, branch: 'workflow/feature-1111', missing: false },
    { path: TERM_WT, head: HEAD, branch: 'spike', missing: false },
  ]);
  const warn = vi.fn();
  const adopt = () => adoptWorktrees({
    ...stores, listWorktrees, warn,
    findProject: name => (name === 'Demo' ? { name: 'Demo', path: HOME } : name === 'Remote' ? { name: 'Remote', path: '/srv/x', host: 'devbox' } : null),
    newId: () => `7a00000${++created}-0000-4000-8000-000000000000`,
  });
  return { ...stores, listWorktrees, warn, adopt };
}

function run(runStore, overrides = {}) {
  const steps = [{ kind: 'node', role: '', askOwner: false, name: 'Develop', readOnly: false, approval: false, prompt: 'Build', repeat: { mode: 'once' }, agent: AGENT }];
  const status = overrides.status ?? 'stopped';
  return runStore.create({
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    workflowId: 'a2d0b1c2-3456-4789-8abc-def012345678',
    project: 'Demo', input: 'docs/todos/replies.md', status,
    stopReason: status === 'stopped' ? 'user' : null, currentStepIndex: 0, error: null,
    definition: { workflowId: 'a2d0b1c2-3456-4789-8abc-def012345678', workflowName: 'Feature build', workflowRevision: 1, agentsDecide: false, progressFile: null, notesDir: null, steps },
    steps: [{ status: status === 'complete' ? 'complete' : 'stopped', sessionId: null, priorSessionIds: [], attempt: 1, iteration: 0, roundsCompleted: 0, detail: null, startedAt: null, finishedAt: null, elapsedMs: 0 }],
    homePath: HOME, worktreePath: RUN_WT, worktreeBranch: 'workflow/feature-1111', baseCommit: BASE,
    worktreeState: 'present', worktreeDetail: null, inputRequest: null, taskId: null,
    finishedAt: ['stopped', 'complete', 'error'].includes(status) ? '2026-11-18T10:00:00.000Z' : null,
    ...overrides,
  });
}

describe('adopting worktrees as tasks', () => {
  it('turns the worktree of an open run into a task and hands the worktree over', async () => {
    const ctx = setup();
    const stored = run(ctx.runStore);
    const adopted = await ctx.adopt();

    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ project: 'Demo', title: 'docs/todos/replies.md', worktreePath: RUN_WT, branch: 'workflow/feature-1111', baseBranch: 'main', baseCommit: BASE, state: 'active' });
    expect(ctx.runStore.get(stored.id)).toMatchObject({ taskId: adopted[0].id, worktreeState: 'external' });
    expect(adopted[0].folder).toBeNull();
    expect(adopted[0].worktrees).toMatchObject([{ repository: 'demo', own: true, first: true, repositoryPath: null, worktreePath: RUN_WT }]);
  });

  it('closes a finished run whose worktree was kept, leaving the work with the task', async () => {
    const ctx = setup();
    const stored = run(ctx.runStore, { status: 'complete', worktreeState: 'removal_blocked', worktreeDetail: 'contains modified files\nsrc/a.js' });
    const [task] = await ctx.adopt();
    expect(ctx.runStore.get(stored.id)).toMatchObject({ taskId: task.id, worktreeState: 'released', worktreeDetail: null, status: 'complete' });
  });

  it('names the task after the workflow when the run had no input', async () => {
    const ctx = setup();
    run(ctx.runStore, { input: '' });
    expect((await ctx.adopt())[0].title).toBe('Feature build');
  });

  it('turns a worktree a terminal was opened in into a task named after its branch', async () => {
    const ctx = setup();
    ctx.worktreeStore.set({ sessionId: 'Demo-4', project: 'Demo', worktreePath: TERM_WT, createdAt: '2026-11-17T10:00:00.000Z' });
    ctx.worktreeStore.set({ sessionId: 'Demo-5', project: 'Demo', worktreePath: TERM_WT, createdAt: '2026-11-17T10:00:00.000Z' });
    const adopted = await ctx.adopt();
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ title: 'spike', worktreePath: TERM_WT, branch: 'spike', baseCommit: HEAD });
  });

  it('puts several runs of one worktree in one task and changes nothing when run again', async () => {
    const ctx = setup();
    const older = run(ctx.runStore, { status: 'complete', worktreeState: 'released', input: 'older' });
    const newer = run(ctx.runStore, { worktreeState: 'external', input: 'newer' });
    const first = await ctx.adopt();
    expect(first).toHaveLength(1);
    expect(ctx.runStore.get(newer.id)).toMatchObject({ taskId: first[0].id, worktreeState: 'external' });
    expect(ctx.runStore.get(older.id).taskId).toBeNull();
    expect(await ctx.adopt()).toEqual([]);
    expect(ctx.taskStore.list()).toHaveLength(1);
  });

  it('leaves the main checkout, finished worktrees and what git no longer lists alone', async () => {
    const ctx = setup({ worktrees: [
      { path: HOME, head: HEAD, branch: 'main', missing: false },
      { path: RUN_WT, head: HEAD, branch: null, missing: false },
      { path: TERM_WT, head: HEAD, branch: 'spike', missing: true },
    ] });
    run(ctx.runStore, { worktreePath: HOME, worktreeState: 'external', requestId: 'main' });
    run(ctx.runStore, { requestId: 'detached' });
    run(ctx.runStore, { requestId: 'removed', worktreePath: '/tmp/git/worktrees/demo-gone', status: 'complete', worktreeState: 'removed' });
    ctx.worktreeStore.set({ sessionId: 'Demo-4', project: 'Demo', worktreePath: TERM_WT, createdAt: '2026-11-17T10:00:00.000Z' });
    ctx.worktreeStore.set({ sessionId: 'Demo-6', project: 'Demo', worktreePath: '/tmp/unlisted', createdAt: '2026-11-17T10:00:00.000Z' });
    expect(await ctx.adopt()).toEqual([]);
    expect(ctx.runStore.list().every(item => item.taskId === null)).toBe(true);
  });

  it('skips unknown and remote projects without calling git, and reports a repository it cannot read', async () => {
    const ctx = setup();
    ctx.worktreeStore.set({ sessionId: 'Gone-1', project: 'Gone', worktreePath: '/tmp/x', createdAt: '2026-11-17T10:00:00.000Z' });
    ctx.worktreeStore.set({ sessionId: 'Remote-1', project: 'Remote', worktreePath: '/srv/worktrees/y', createdAt: '2026-11-17T10:00:00.000Z' });
    expect(await ctx.adopt()).toEqual([]);
    expect(ctx.listWorktrees).not.toHaveBeenCalled();

    run(ctx.runStore);
    ctx.listWorktrees.mockRejectedValueOnce(new Error('not a git repository'));
    expect(await ctx.adopt()).toEqual([]);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining('worktrees of Demo could not be read'));
  });

  it('requires its dependencies', async () => {
    await expect(adoptWorktrees({})).rejects.toThrow('taskStore is required');
  });
});
