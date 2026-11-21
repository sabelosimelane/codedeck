import { describe, expect, it, vi } from 'vitest';
import { canReclaimReleasedTaskRun } from '../pipelines/released-task-run.js';

const run = overrides => ({
  id: 'run-1', taskId: '11111111-1111-4111-8111-111111111111', status: 'interrupted', worktreeState: 'released', worktreePath: '/tasks/backend',
  ...overrides,
});
const task = overrides => ({ id: '11111111-1111-4111-8111-111111111111', state: 'active', worktrees: [{ worktreePath: '/tasks/backend', state: 'active' }], ...overrides });

function check({ currentRun = run(), currentTask = task(), others = [] } = {}) {
  return canReclaimReleasedTaskRun({
    run: currentRun,
    taskStore: { get: vi.fn(() => currentTask) },
    runStore: { list: vi.fn(() => [currentRun, ...others]) },
  });
}

describe('canReclaimReleasedTaskRun', () => {
  it('allows a resumable released run when its task still owns the active worktree', () => {
    expect(check()).toBe(true);
  });
  it('refuses a missing or closed task worktree', () => {
    expect(check({ currentTask: null })).toBe(false);
    expect(check({ currentTask: task({ state: 'closed' }) })).toBe(false);
    expect(check({ currentTask: task({ worktrees: [{ worktreePath: '/tasks/backend', state: 'closed' }] }) })).toBe(false);
    expect(check({ currentTask: task({ worktrees: [{ worktreePath: '/tasks/other', state: 'active' }] }) })).toBe(false);
  });
  it('refuses a different task, non-resumable status, or a competing live run', () => {
    expect(check({ currentRun: run({ taskId: null }) })).toBe(false);
    expect(check({ currentRun: run({ status: 'complete' }) })).toBe(false);
    expect(check({ others: [run({ id: 'run-2', status: 'running', worktreeState: 'external' })] })).toBe(false);
  });
});
