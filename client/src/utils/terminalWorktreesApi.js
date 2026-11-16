const FALLBACK = 'Something went wrong. Please try again.';

export async function createWorktreeTerminal({ project, branch }) {
  if (typeof project !== 'string' || project.length === 0) throw new TypeError('project must be a nonempty string');
  if (typeof branch !== 'string' || branch.length === 0) throw new TypeError('branch must be a nonempty string');
  let response;
  try {
    response = await fetch('/api/terminal-worktrees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, branch }),
    });
  } catch {
    throw new Error('Server unreachable');
  }
  if (!response.ok) {
    let body;
    try { body = await response.json(); }
    catch { throw new Error(FALLBACK); }
    throw new Error(typeof body?.message === 'string' && body.message.length > 0 ? body.message : FALLBACK);
  }
  const body = await response.json();
  for (const field of ['sessionId', 'project', 'branch', 'worktreePath']) {
    if (typeof body?.[field] !== 'string' || body[field].length === 0) throw new Error(`Invalid terminal worktree response: ${field}`);
  }
  if (typeof body.baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(body.baseCommit)) throw new Error('Invalid terminal worktree response: baseCommit');
  return { sessionId: body.sessionId, project: body.project, branch: body.branch, worktreePath: body.worktreePath, baseCommit: body.baseCommit };
}
