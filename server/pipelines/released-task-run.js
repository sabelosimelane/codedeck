const RESUMABLE = new Set(['interrupted', 'stopped', 'error']);
const OPEN_TASK_STATES = new Set(['active', 'pr_open']);
const OPEN_WORKTREE_STATES = new Set(['active', 'pr_open']);
const LIVE_RUN_STATES = new Set(['pending', 'running', 'needs_input', 'limit_paused', 'awaiting_approval']);

/** A dismissed run may be resumed only while its task still owns the same open worktree. */
export function canReclaimReleasedTaskRun({ run, taskStore, runStore }) {
  if (!run || typeof run !== 'object') throw new TypeError('released task run is required');
  if (typeof taskStore?.get !== 'function') throw new TypeError('released task run taskStore.get is required');
  if (typeof runStore?.list !== 'function') throw new TypeError('released task run runStore.list is required');
  if (run.worktreeState !== 'released' || !RESUMABLE.has(run.status) || typeof run.taskId !== 'string' || !run.taskId
      || typeof run.worktreePath !== 'string' || !run.worktreePath) return false;

  const task = taskStore.get(run.taskId);
  if (!task || task.id !== run.taskId || !OPEN_TASK_STATES.has(task.state) || !Array.isArray(task.worktrees)) return false;
  const ownedWorktree = task.worktrees.find(entry => entry.worktreePath === run.worktreePath);
  if (!ownedWorktree || !OPEN_WORKTREE_STATES.has(ownedWorktree.state)) return false;

  return !runStore.list().some(other => other.id !== run.id && other.taskId === run.taskId && LIVE_RUN_STATES.has(other.status));
}
