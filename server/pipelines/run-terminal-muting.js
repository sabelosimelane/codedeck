const RUN_STATUSES = new Set(['pending', 'running', 'needs_input', 'awaiting_approval', 'limit_paused', 'interrupted', 'stopped', 'error', 'complete']);
const LIVE_STATUSES = new Set(['pending', 'running', 'needs_input', 'awaiting_approval', 'limit_paused']);
const WORKTREE_STATES = new Set(['not_created', 'present', 'removed', 'removal_blocked', 'external', 'released']);

/** The status display owned by one run, based only on its stored state. */
export function planRunTerminalMuting(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new TypeError('run terminal muting: run must be an object');
  if (!RUN_STATUSES.has(run.status)) throw new TypeError(`run terminal muting: status is invalid (${String(run.status)})`);
  if (!Array.isArray(run.steps) || run.steps.length === 0) throw new TypeError('run terminal muting: steps must be a nonempty array');
  if (!Number.isInteger(run.currentStepIndex) || run.currentStepIndex < 0 || run.currentStepIndex >= run.steps.length) {
    throw new TypeError(`run terminal muting: currentStepIndex is invalid (${String(run.currentStepIndex)})`);
  }
  if (!WORKTREE_STATES.has(run.worktreeState)) throw new TypeError(`run terminal muting: worktreeState is invalid (${String(run.worktreeState)})`);
  const sessions = new Set();
  for (const [index, step] of run.steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new TypeError(`run terminal muting: step ${index} must be an object`);
    if (step.sessionId !== null && (typeof step.sessionId !== 'string' || !step.sessionId.trim())) {
      throw new TypeError(`run terminal muting: step ${index} sessionId must be null or nonempty text`);
    }
    if (step.sessionId !== null) sessions.add(step.sessionId);
  }
  const closed = run.worktreeState === 'removed' || run.worktreeState === 'released';
  const live = !closed && LIVE_STATUSES.has(run.status) ? run.steps[run.currentStepIndex].sessionId : null;
  return new Map([...sessions].map(sessionId => [sessionId, closed ? false : sessionId !== live]));
}

const WORKING_STATUSES = new Set(['pending', 'running']);

/**
 * Whether a terminal is the current step of a run that is still working on its own. Such a run owns
 * the attention signal: its terminal going idle between turns, or while the run confirms a handoff,
 * is not finished work for the owner. A run waiting on the owner says so itself (needs input,
 * awaiting approval, paused), so its terminal then signals as any other.
 */
export function isLiveRunStepSession(runs, sessionId) {
  if (!Array.isArray(runs)) throw new TypeError('live run step: runs must be an array');
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('live run step: sessionId must be nonempty text');
  return runs.some(run => {
    // Validates the run's shape and states; a run it cannot read is a bug, not a terminal to skip.
    planRunTerminalMuting(run);
    const closed = run.worktreeState === 'removed' || run.worktreeState === 'released';
    return !closed && WORKING_STATUSES.has(run.status) && run.steps[run.currentStepIndex].sessionId === sessionId;
  });
}
