import { describe, expect, it, vi } from 'vitest';
import { createWorktreeSessionStarter } from '../terminal-session-worktree-start.js';

describe('worktree session starter', () => {
  it('records a pipeline step terminal in its run worktree and leaves a main-checkout run unmapped', async () => {
    const start = vi.fn(async () => ({ id: 'Demo-7' }));
    const store = { set: vi.fn() };
    const begin = createWorktreeSessionStarter({ start, loadProjects: () => [{ name: 'Demo', path: '/repo/demo' }], store, now: () => '2026-11-17T10:00:00.000Z' });
    const startRunStep = async ({ project, cwd }) => (await begin(project, { cwd })).id;
    expect(await startRunStep({ project: 'Demo', cwd: '/repo/worktrees/demo-run' })).toBe('Demo-7');
    expect(store.set).toHaveBeenCalledWith({ sessionId: 'Demo-7', project: 'Demo', worktreePath: '/repo/worktrees/demo-run', createdAt: '2026-11-17T10:00:00.000Z' });
    store.set.mockClear();
    await startRunStep({ project: 'Demo', cwd: '/repo/demo' });
    expect(store.set).not.toHaveBeenCalled();
  });
  it('records a worktree spawn but not a main checkout spawn', async () => {
    const start = vi.fn(async () => ({ id: 'Demo-1' }));
    const store = { set: vi.fn() };
    const begin = createWorktreeSessionStarter({ start, loadProjects: () => [{ name: 'Demo', path: '/repo/demo' }], store, now: () => '2026-11-17T10:00:00.000Z' });
    await begin('Demo', { cwd: '/repo/worktrees/demo-a' });
    expect(store.set).toHaveBeenCalledWith({ sessionId: 'Demo-1', project: 'Demo', worktreePath: '/repo/worktrees/demo-a', createdAt: '2026-11-17T10:00:00.000Z' });
    await begin('Demo', { cwd: '/repo/demo' });
    expect(store.set).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown project or invalid start cwd before starting', async () => {
    const start = vi.fn();
    const begin = createWorktreeSessionStarter({ start, loadProjects: () => [], store: { set: vi.fn() }, now: () => new Date().toISOString() });
    await expect(begin('Demo', { cwd: 'relative' })).rejects.toThrow('project');
    expect(start).not.toHaveBeenCalled();
  });
});
