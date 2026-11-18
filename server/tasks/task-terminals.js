/**
 * Closing the terminals of a task that was merged or closed.
 *
 * A finished task's folder is removed, so a terminal left in it has nothing to work in. The
 * task's terminals are the ones opened in its worktree and the ones its workflow runs used.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createTaskTerminalCloser({ listWorktreeRecords, listRuns, isOpen, deleteSession, warn = console.warn } = {}) {
  for (const [name, value] of Object.entries({ listWorktreeRecords, listRuns, isOpen, deleteSession, warn })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  return async function closeTaskTerminals(task) {
    if (typeof task?.id !== 'string' || !UUID.test(task.id)) throw new TypeError('task.id must be a UUID');
    if (typeof task.worktreePath !== 'string' || !task.worktreePath.startsWith('/')) throw new TypeError('task.worktreePath must be an absolute path');

    const ids = new Set();
    for (const record of listWorktreeRecords()) {
      if (record.worktreePath === task.worktreePath) ids.add(record.sessionId);
    }
    for (const run of listRuns()) {
      if (run.taskId !== task.id) continue;
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
