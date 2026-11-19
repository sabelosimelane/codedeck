/** Sets how the worktree a task started in stands; for a task with one worktree that is the task's state. */
export function setTaskState(taskStore, taskId, change) {
  const task = taskStore.get(taskId);
  if (!task) throw new Error(`test task ${taskId} not found`);
  return taskStore.setWorktreeState(taskId, task.worktrees.find(worktree => worktree.first).id, change);
}

/** What a task store needs to know about the first worktree of a task in the project's own repository. */
export const OWN_REPOSITORY = { folder: null, repository: 'demo', repositoryPath: null };
