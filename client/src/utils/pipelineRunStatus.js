const RUN_STATUS = Object.freeze({
  pending: ['Starting', 'neutral', null],
  running: ['Running', 'active', null],
  needs_input: ['Needs your input', 'waiting', 'answer'],
  limit_paused: ['Paused at its limit', 'waiting', 'continue'],
  awaiting_approval: ['Waiting for your approval', 'waiting', 'approve'],
  interrupted: ['Interrupted', 'waiting', 'resume'],
  stopped: ['Stopped', 'neutral', 'resume'],
  error: ['Failed', 'danger', 'resume'],
  complete: ['Complete', 'done', 'cleanup'],
});
const CURRENT_STEP_STATUSES = new Set(['launching', 'running', 'needs_input', 'awaiting_approval', 'limit_reached', 'interrupted']);

export function describeRunStatus(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('run status: run must be an object');
  if (typeof run.status !== 'string' || !Object.hasOwn(RUN_STATUS, run.status)) throw new Error(`run status: status ${String(run.status)} is unknown`);
  if (run.actions !== undefined && (run.actions === null || typeof run.actions !== 'object' || Array.isArray(run.actions))) throw new Error('run status: actions must be an object');
  const [label, tone, action] = run.status === 'stopped' && run.stopReason === 'no_progress'
    ? ['Stopped: no progress', 'waiting', 'resume'] : RUN_STATUS[run.status];
  return { label, tone, primaryAction: action && run.actions?.[action] === true ? action : null };
}

export function describeStepState(step, { isCurrent } = {}) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('step state: step must be an object');
  if (typeof step.status !== 'string' || step.status.trim() === '') throw new Error('step state: status must be a nonempty string');
  if (typeof isCurrent !== 'boolean') throw new Error('step state: isCurrent must be a boolean');
  if (step.status === 'complete' || step.status === 'limit_accepted') return { state: 'done' };
  if (step.status === 'failed') return { state: 'failed' };
  if (step.status === 'stopped') return { state: 'stopped' };
  return { state: isCurrent && CURRENT_STEP_STATUSES.has(step.status) ? 'current' : 'pending' };
}

const STEP_LABEL = Object.freeze({
  pending: 'Not started',
  launching: 'Starting',
  running: 'Running',
  needs_input: 'Needs your input',
  awaiting_approval: 'Waiting for your approval',
  complete: 'Done',
  limit_reached: 'Paused at its limit',
  limit_accepted: 'Stopped at its limit; you continued',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
});
const STEP_OVER = new Set(['complete', 'limit_accepted']);
const count = (number, word) => `${number} ${word}${number === 1 ? '' : (word === 'pass' ? 'es' : 's')}`;

/** How a step stands, in words: a label, and where it is in its passes or loop rounds (or null). */
export function describeStepProgress(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('step progress: step must be an object');
  if (typeof step.status !== 'string' || !Object.hasOwn(STEP_LABEL, step.status)) throw new Error(`step progress: status ${String(step.status)} is unknown`);
  if (!step.repeat || typeof step.repeat !== 'object' || typeof step.repeat.mode !== 'string') throw new Error('step progress: repeat must be an object with a mode');
  if (!Number.isSafeInteger(step.iteration) || step.iteration < 0) throw new Error('step progress: iteration must be a nonnegative integer');
  if (!Number.isSafeInteger(step.roundsCompleted) || step.roundsCompleted < 0) throw new Error('step progress: roundsCompleted must be a nonnegative integer');
  const label = STEP_LABEL[step.status];
  const over = STEP_OVER.has(step.status);
  const { mode, max } = step.repeat;
  if (mode === 'until_complete') {
    if (over) return { label, detail: count(step.iteration, 'pass') };
    return { label, detail: step.iteration >= 1 ? `pass ${step.iteration} of ${max}` : `up to ${count(max, 'pass')}` };
  }
  if (mode === 'loop_back') {
    const rounds = step.roundsCompleted + 1;
    return { label, detail: over ? count(rounds, 'round') : `round ${rounds} of ${max}` };
  }
  return { label, detail: null };
}
