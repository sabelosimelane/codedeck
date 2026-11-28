// What the owner is asked before an action on a run, shared by the desktop's task view and the phone.

/** What Resume says it will do. */
export function resumeConfirmation(run, step) {
  if (!step?.sessionId) return `Resume ${run.workflowName}? ${step.name} starts in a new terminal.`;
  return `Resume ${run.workflowName}? The agent in ${step.sessionId} is cleared and ${step.name} starts again there. `
    + 'If its agent has exited, it is started again there. A new terminal is opened only if that one was closed.';
}

/** What Close run (or cleaning up a run's own worktree) says it will do. */
export function cleanupConfirmation(run) {
  if (run.worktree?.state === 'external') {
    return `Close ${run.workflowName}? Its terminals are closed and the run leaves the screen. The task and its files remain available.`;
  }
  return `Clean up the worktree for ${run.workflowName}? This removes the run's worktree and closes its terminals.`;
}
