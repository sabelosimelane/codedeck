const DIRTY_WORKTREE_SUMMARY = 'Worktree kept: it has uncommitted work. Commit or discard the files, then choose Clean up worktree.';

export function describeBlockedCleanup(detail) {
  if (typeof detail !== 'string' || detail.trim() === '') {
    throw new TypeError('worktree.detail must be a non-empty string');
  }

  const [firstLine, ...paths] = detail.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return {
    summary: paths.length > 0 ? DIRTY_WORKTREE_SUMMARY : firstLine,
    paths,
  };
}
