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

/**
 * The capped pause a run waits on, for the recovery panel: which step hit its configured
 * maximum, how many extra rounds the owner already granted, and what the grant button says.
 * Returns null unless the run is paused at a capped repeat.
 */
export function describeLimitPause(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run) || run.status !== 'limit_paused') return null;
  if (!Array.isArray(run.steps) || !Number.isInteger(run.currentStepIndex)) return null;
  const step = run.steps.find(item => item?.index === run.currentStepIndex) ?? run.steps[run.currentStepIndex];
  if (!step || step.status !== 'limit_reached') return null;
  if (!step.repeat || (step.repeat.mode !== 'loop_back' && step.repeat.mode !== 'until_complete')) return null;
  if (!Number.isInteger(step.repeat.max) || step.repeat.max < 1) return null;
  return {
    stepIndex: run.currentStepIndex,
    stepName: step.name,
    repeatMode: step.repeat.mode,
    maxRounds: step.repeat.max,
    extraRounds: step.extraRounds ?? run.limitPause?.extraRounds ?? 0,
    roundsCompleted: step.roundsCompleted ?? 0,
    actionLabel: step.repeat.mode === 'loop_back' ? 'Run one more round' : 'Run one more pass',
  };
}

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
  const primaryAction = !landed && action && run.actions?.[action] === true ? action : null;
  if (describeRunCompletion({ status: run.status, steps: Array.isArray(run.steps) ? run.steps : [] }).endedAtLimit) {
    // A run closed by accepting the limit is not verified: it reads Ended at limit in
    // neutral words, never the green completion. Its audit and notes stay where they are.
    return { label: 'Ended at limit', tone: 'neutral', primaryAction, needsOwner: false };
  }
  return {
    label, tone,
    primaryAction,
    // The run cannot go on by itself: it waits for an answer, an approval, a decision or a Resume.
    needsOwner: tone === 'waiting' || tone === 'danger',
  };
}

// A finished run counts only verified steps as successful: a step accepted at its limit
// is preserved in the audit and the rail, but excluded from the done count. The green
// completion banner stays available for a run with no accepted step.
export function describeRunCompletion(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('run completion: run must be an object');
  if (!Array.isArray(run.steps)) throw new Error('run completion: steps must be an array');
  const successfulSteps = run.steps.filter(step => step?.status === 'complete').length;
  return {
    endedAtLimit: run.status === 'complete' && run.steps.some(step => step?.status === 'limit_accepted'),
    successfulSteps,
    totalSteps: run.steps.length,
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
const WORKING_STEP = new Set(['launching', 'running']);
const count = (number, word) => `${number} ${word}${number === 1 ? '' : (word === 'pass' ? 'es' : 's')}`;

/** How a step stands, in words: a label, and where it is in its passes or loop rounds (or null). */
export function describeStepProgress(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error('step progress: step must be an object');
  if (typeof step.status !== 'string' || !Object.hasOwn(STEP_LABEL, step.status)) throw new Error(`step progress: status ${String(step.status)} is unknown`);
  if (!step.repeat || typeof step.repeat !== 'object' || typeof step.repeat.mode !== 'string') throw new Error('step progress: repeat must be an object with a mode');
  if (!Number.isSafeInteger(step.iteration) || step.iteration < 0) throw new Error('step progress: iteration must be a nonnegative integer');
  if (!Number.isSafeInteger(step.roundsCompleted) || step.roundsCompleted < 0) throw new Error('step progress: roundsCompleted must be a nonnegative integer');
  const label = step.status === 'pending' && (step.roundsCompleted > 0 || step.elapsedMs > 0) ? 'Awaiting next round' : STEP_LABEL[step.status];
  const over = STEP_OVER.has(step.status);
  const { mode, max } = step.repeat;
  if (mode === 'until_complete') {
    if (over) return { label, detail: count(step.iteration, 'pass') };
    // A granted pass extends the limit: the rail counts the pass against the raised total.
    const allowed = max + (step.extraRounds ?? 0);
    return { label, detail: step.iteration >= 1 ? `pass ${step.iteration} of ${allowed}` : `up to ${count(allowed, 'pass')}` };
  }
  if (mode === 'loop_back') {
    const rounds = step.roundsCompleted + 1;
    // A granted round extends the cap: the rail counts the round against the raised total.
    const effective = max + (step.extraRounds ?? 0);
    return { label, detail: over ? count(rounds, 'round') : `round ${rounds} of ${effective}` };
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

// Only charge intervals with two recorded boundaries in the same attempt.
// A restored observer needs fresh evidence before attributing work again.
const auditBuckets = {
  start: 'Launch', resume: 'Launch', agent_restarted: 'Launch', step_running: 'Launch',
  prompt_submitted: 'Unclassified', observation_unavailable: 'Unclassified', observation_restored: 'Unclassified',
  input_received: 'Unclassified', work_observed: 'Work observed', disposition_requested: 'Handoff',
  signal_accepted: 'Handoff', needs_input: 'Owner wait', approval_requested: 'Owner wait',
  step_complete: null, loop_back: null, approved: null, approve: null, stop: null, error: null, interrupted: null,
  limit_reached: 'Owner wait', continue: null, send_back: null,
};
export function describeAuditIntervals(events) {
  const attempts = new Map();
  for (const event of events) {
    if (!event.attempt) continue;
    const time = Date.parse(event.createdAt);
    let entry = attempts.get(event.attempt);
    if (!entry) {
      entry = { bucket: null, time, totals: new Map() };
      attempts.set(event.attempt, entry);
    }
    if (entry.bucket && time > entry.time) {
      entry.totals.set(entry.bucket, (entry.totals.get(entry.bucket) ?? 0) + time - entry.time);
    }
    if (Object.hasOwn(auditBuckets,event.kind)) entry.bucket = auditBuckets[event.kind];
    entry.time = time;
  }
  return Array.from(attempts, ([attempt, {totals}]) => ({
    attempt, words: ['Launch','Work observed','Owner wait','Handoff','Unclassified']
      .filter(bucket => totals.has(bucket)).map(bucket => bucket + ' ' + durationWords(totals.get(bucket))).join(' · ') || 'No closed interval yet',
  }));
}
