import { describe, expect, it, vi } from 'vitest';
import { createTaskTerminalCloser } from '../tasks/task-terminals.js';

const TASK = { id: '7a000001-0000-4000-8000-000000000000', worktreePath: '/tmp/git/worktrees/demo-replies' };
const record = (sessionId, worktreePath) => ({ sessionId, project: 'Demo', worktreePath, createdAt: '2026-11-18T10:00:00.000Z' });
const run = (taskId, steps) => ({ taskId, steps });

function setup({ open = ['Demo-2', 'Demo-3', 'Demo-4', 'Demo-9'], failing = [] } = {}) {
  const deleteSession = vi.fn(async id => { if (failing.includes(id)) throw new Error('tmux refused'); });
  const warn = vi.fn();
  const close = createTaskTerminalCloser({
    listWorktreeRecords: () => [record('Demo-2', TASK.worktreePath), record('Demo-9', '/tmp/git/worktrees/demo-other')],
    listRuns: () => [
      run(TASK.id, [{ sessionId: 'Demo-3', priorSessionIds: ['Demo-4', 'Demo-1'] }, { sessionId: null, priorSessionIds: [] }, { sessionId: 'Demo-3', priorSessionIds: [] }]),
      run('7a000002-0000-4000-8000-000000000000', [{ sessionId: 'Demo-9', priorSessionIds: [] }]),
      run(null, [{ sessionId: 'Demo-9', priorSessionIds: [] }]),
    ],
    isOpen: id => open.includes(id),
    deleteSession, warn,
  });
  return { close, deleteSession, warn };
}

describe('closing a finished task’s terminals', () => {
  it('closes the open terminals started in the task and those its runs used, each once, and no others', async () => {
    const { close, deleteSession } = setup();
    expect(await close(TASK)).toEqual({ closed: ['Demo-2', 'Demo-3', 'Demo-4'], notClosed: [] });
    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual(['Demo-2', 'Demo-3', 'Demo-4']);
  });

  it('reports a terminal that could not be closed and still closes the rest', async () => {
    const { close, warn } = setup({ failing: ['Demo-3'] });
    expect(await close(TASK)).toEqual({ closed: ['Demo-2', 'Demo-4'], notClosed: ['Demo-3'] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Demo-3'));
  });

  it('closes nothing when the task has no open terminal', async () => {
    const { close, deleteSession } = setup({ open: ['Demo-9'] });
    expect(await close(TASK)).toEqual({ closed: [], notClosed: [] });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('requires its dependencies and a task', async () => {
    expect(() => createTaskTerminalCloser({})).toThrow('listWorktreeRecords must be a function');
    const { close } = setup();
    await expect(close({ id: 'x', worktreePath: '/tmp/a' })).rejects.toThrow('task.id');
    await expect(close({ id: TASK.id, worktreePath: 'relative' })).rejects.toThrow('task.worktreePath');
  });
});
