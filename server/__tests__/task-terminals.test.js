import { describe, expect, it, vi } from 'vitest';
import { createTaskTerminalCloser } from '../tasks/task-terminals.js';

const BACKEND = { id: '7b000001-0000-4000-8000-000000000000', repository: 'backend', worktreePath: '/tmp/git/worktrees/replies/backend' };
const MOBILE = { id: '7b000002-0000-4000-8000-000000000000', repository: 'mobile-app', worktreePath: '/tmp/git/worktrees/replies/mobile-app' };
const TASK = { id: '7a000001-0000-4000-8000-000000000000', worktrees: [BACKEND, MOBILE] };
const record = (sessionId, worktreePath) => ({ sessionId, project: 'Demo', worktreePath, createdAt: '2026-11-18T10:00:00.000Z' });
const run = (taskId, worktreePath, steps) => ({ taskId, worktreePath, steps });

function setup({ open = ['Demo-2', 'Demo-3', 'Demo-4', 'Demo-5', 'Demo-6', 'Demo-9'], failing = [] } = {}) {
  const deleteSession = vi.fn(async id => { if (failing.includes(id)) throw new Error('tmux refused'); });
  const warn = vi.fn();
  const close = createTaskTerminalCloser({
    listWorktreeRecords: () => [record('Demo-2', BACKEND.worktreePath), record('Demo-5', MOBILE.worktreePath), record('Demo-9', '/tmp/git/worktrees/demo-other')],
    listRuns: () => [
      run(TASK.id, BACKEND.worktreePath, [{ sessionId: 'Demo-3', priorSessionIds: ['Demo-4', 'Demo-1'] }, { sessionId: null, priorSessionIds: [] }, { sessionId: 'Demo-3', priorSessionIds: [] }]),
      run(TASK.id, MOBILE.worktreePath, [{ sessionId: 'Demo-6', priorSessionIds: [] }]),
      run('7a000002-0000-4000-8000-000000000000', '/tmp/git/worktrees/demo-other', [{ sessionId: 'Demo-9', priorSessionIds: [] }]),
      run(null, '/tmp/git/demo', [{ sessionId: 'Demo-9', priorSessionIds: [] }]),
    ],
    isOpen: id => open.includes(id),
    deleteSession, warn,
  });
  return { close, deleteSession, warn };
}

describe('closing a finished task’s terminals', () => {
  it('closes the open terminals started in any of the task\'s worktrees and those its runs used, each once, and no others', async () => {
    const { close, deleteSession } = setup();
    expect(await close(TASK)).toEqual({ closed: ['Demo-2', 'Demo-3', 'Demo-4', 'Demo-5', 'Demo-6'], notClosed: [] });
    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual(['Demo-2', 'Demo-3', 'Demo-4', 'Demo-5', 'Demo-6']);
  });

  it('closes only the terminals of one worktree when one repository of the task is finished', async () => {
    const { close } = setup();
    expect(await close(TASK, MOBILE)).toEqual({ closed: ['Demo-5', 'Demo-6'], notClosed: [] });
    expect(await close(TASK, BACKEND)).toEqual({ closed: ['Demo-2', 'Demo-3', 'Demo-4'], notClosed: [] });
  });

  it('reports a terminal that could not be closed and still closes the rest', async () => {
    const { close, warn } = setup({ failing: ['Demo-3'] });
    expect(await close(TASK)).toEqual({ closed: ['Demo-2', 'Demo-4', 'Demo-5', 'Demo-6'], notClosed: ['Demo-3'] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Demo-3'));
  });

  it('closes nothing when the task has no open terminal', async () => {
    const { close, deleteSession } = setup({ open: ['Demo-9'] });
    expect(await close(TASK)).toEqual({ closed: [], notClosed: [] });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('requires its dependencies, a task and a worktree of that task', async () => {
    expect(() => createTaskTerminalCloser({})).toThrow('listWorktreeRecords must be a function');
    const { close } = setup();
    await expect(close({ id: 'x', worktrees: [BACKEND] })).rejects.toThrow('task.id');
    await expect(close({ id: TASK.id })).rejects.toThrow('task.worktrees');
    await expect(close({ id: TASK.id, worktrees: [] })).rejects.toThrow('task.worktrees');
    await expect(close({ id: TASK.id, worktrees: [{ worktreePath: 'relative' }] })).rejects.toThrow('task.worktrees');
    await expect(close(TASK, { id: 'other', worktreePath: '/tmp/elsewhere' })).rejects.toThrow('worktree must be one of the task\'s');
  });
});
