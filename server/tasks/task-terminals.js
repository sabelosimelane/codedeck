/**
 * Closing the terminals of a task, or of one repository of it, that was merged or closed.
 *
 * A finished worktree's folder is removed, so a terminal left in it has nothing to work in.
 * A worktree's terminals are the ones opened in it and the ones the workflow runs that worked
 * in it used; a task's terminals are those of all its worktrees and of all its runs.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTaskTerminalCloser({ listWorktreeRecords, listRuns, isOpen, deleteSession, warn = console.warn } = {}) {
  for (const [name, value] of Object.entries({ listWorktreeRecords, listRuns, isOpen, deleteSession, warn })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  /** `worktree`: one of the task's, to close only its terminals; left out, the whole task's. */
  return async function closeTaskTerminals(task, worktree) {
    if (typeof task?.id !== 'string' || !UUID.test(task.id)) throw new TypeError('task.id must be a UUID');
    if (!Array.isArray(task.worktrees) || task.worktrees.length === 0
      || task.worktrees.some(entry => typeof entry?.worktreePath !== 'string' || !entry.worktreePath.startsWith('/'))) {
      throw new TypeError('task.worktrees must be a nonempty list of worktrees with absolute paths');
    }
    if (worktree !== undefined && !task.worktrees.some(entry => entry.worktreePath === worktree?.worktreePath)) throw new TypeError('worktree must be one of the task\'s');
    const paths = new Set(worktree === undefined ? task.worktrees.map(entry => entry.worktreePath) : [worktree.worktreePath]);

    const ids = new Set();
    for (const record of listWorktreeRecords()) {
      if (paths.has(record.worktreePath)) ids.add(record.sessionId);
    }
    for (const run of listRuns()) {
      if (run.taskId !== task.id) continue;
      // With one worktree named, only the runs that worked in it; a run works in one worktree.
      if (worktree !== undefined && run.worktreePath !== worktree.worktreePath) continue;
      for (const step of run.steps) {
        if (step.sessionId) ids.add(step.sessionId);
        for (const prior of step.priorSessionIds) ids.add(prior);
      }
    }

    const closed = [];
    const notClosed = [];
    for (const sessionId of [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
      if (!isOpen(sessionId)) continue;
      try {
        await deleteSession(sessionId);
        closed.push(sessionId);
      } catch (error) {
        notClosed.push(sessionId);
        warn(`[tasks] terminal not closed task=${task.id} session=${sessionId} error=${error.message}`);
      }
    }
    return { closed, notClosed };
  };
}
