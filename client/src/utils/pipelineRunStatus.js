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
  const [label, tone, action] = run.status === 'stopped' && run.stopReason === 'no_progress' ? ['Stopped: no progress', 'waiting', 'resume']
    : run.status === 'stopped' && run.stopReason === 'terminal' ? ['Stopped: terminal closed', 'waiting', 'resume']
      : RUN_STATUS[run.status];
  // A run that finished in a task or in Main leaves its work there: the next thing to do is land
  // the task, so closing the run is offered but not highlighted.
  const landed = run.status === 'complete' && run.worktree?.state === 'external';
  return {
    label, tone,
    primaryAction: !landed && action && run.actions?.[action] === true ? action : null,
    // The run cannot go on by itself: it waits for an answer, an approval, a decision or a Resume.
    needsOwner: tone === 'waiting' || tone === 'danger',
  };
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
const WORKING_STEP = new Set(['launching', 'running', 'needs_input']);
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

/** A length of time in words: seconds under a minute, minutes and seconds under an hour, hours and minutes beyond. */
function durationWords(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 1) return 'under 1s';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

const isStamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

/**
 * How long a step has worked, in words, or null when it has not worked and has no time kept. The
 * backend adds up every finished start of the step in `elapsedMs` (each round of a loop, and each
 * attempt after Resume or Send back). While the step is working (`launching`, `running`,
 * `needs_input`), the current stretch from `startedAt` to `now` is added live; once it stops,
 * fails, pauses, loops back or finishes, the accumulated `elapsedMs` is shown as settled.
 */
export function describeStepDuration(step, now) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('step duration: step must be an object');
  if (typeof step.status !== 'string' || !Object.hasOwn(STEP_LABEL, step.status)) throw new Error(`step duration: status ${String(step.status)} is unknown`);
  if (!Number.isSafeInteger(step.elapsedMs) || step.elapsedMs < 0) throw new Error('step duration: elapsedMs must be an integer ≥ 0');
  if (step.startedAt !== undefined && step.startedAt !== null && !isStamp(step.startedAt)) {
    throw new Error('step duration: startedAt must be a timestamp or null');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new Error('step duration: now must be a time in milliseconds');
  if (WORKING_STEP.has(step.status) && isStamp(step.startedAt)) {
    const currentStretch = Math.max(0, now - Date.parse(step.startedAt));
    return { words: durationWords(step.elapsedMs + currentStretch), live: true };
  }
  // No step works for no time at all: zero means the step has not worked yet or finished before working time was kept.
  return step.elapsedMs > 0 ? { words: durationWords(step.elapsedMs), live: false } : null;
}

/**
 * How long a whole run has taken, from when it was started: to its end when it is over, to its
 * last change when it is interrupted (nothing is working in it), and otherwise to `now`, in which
 * case `live` says the count is still going. Time spent waiting for the owner is part of it.
 */
export function describeRunDuration(run, now) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('run duration: run must be an object');
  if (typeof run.status !== 'string' || run.status.trim() === '') throw new Error('run duration: status must be a nonempty string');
  if (!isStamp(run.createdAt)) throw new Error('run duration: createdAt must be a timestamp');
  if (!isStamp(run.updatedAt)) throw new Error('run duration: updatedAt must be a timestamp');
  if (run.finishedAt !== null && !isStamp(run.finishedAt)) throw new Error('run duration: finishedAt must be a timestamp or null');
  if (typeof now !== 'number' || !Number.isFinite(now)) throw new Error('run duration: now must be a time in milliseconds');
  const start = Date.parse(run.createdAt);
  const end = run.finishedAt !== null ? run.finishedAt : run.status === 'interrupted' ? run.updatedAt : null;
  if (end !== null) {
    if (Date.parse(end) < start) throw new Error('run duration: the run ends before it starts');
    return { words: durationWords(Date.parse(end) - start), live: false };
  }
  // The start is the backend's time and `now` this device's: a clock that is behind must not show a negative time.
  return { words: durationWords(Math.max(0, now - start)), live: true };
}
