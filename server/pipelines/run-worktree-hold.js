const OPEN_WORKTREE = new Set(['not_created', 'present', 'removal_blocked', 'external']);

/** A run remains open while its worktree is still present or awaiting cleanup. */
export function isOpenRun(run) {
  if (run.status === 'complete') return run.worktreeState === 'removal_blocked' || run.worktreeState === 'external';
  return OPEN_WORKTREE.has(run.worktreeState);
}

/** An unfinished, open run holds its worktree against another start or adoption. */
export function holdsWorktree(run, worktreePath) {
  return run.worktreePath === worktreePath && run.status !== 'complete' && isOpenRun(run);
}
