/**
 * Pure reducer for pipeline run / step statuses (Spec §5) and owner-action
 * flags (Spec §8.8).
 */

const STOPPABLE = new Set(['pending', 'running', 'needs_input', 'limit_paused', 'interrupted']);
const RESUMABLE = new Set(['interrupted', 'stopped', 'error']);
const RESUME_WORKTREE = new Set(['not_created', 'present']);
const CLEANUP_STATUS = new Set(['complete', 'stopped', 'error', 'interrupted']);
const CLEANUP_WORKTREE = new Set(['not_created', 'present', 'removal_blocked']);
const ACTIVE_STEP = new Set(['pending', 'launching', 'running', 'needs_input', 'interrupted', 'stopped', 'failed']);

function clone(run) {
  return {
    ...run,
    steps: run.steps.map(s => ({
      ...s,
      priorSessionIds: Array.isArray(s.priorSessionIds) ? [...s.priorSessionIds] : [],
    })),
  };
}

function currentStep(run) {
  return run.steps[run.currentStepIndex];
}

function illegal(from, type) {
  throw new Error(`illegal transition: ${from} + ${type}`);
}

function finishStep(step, at) {
  step.finishedAt = at ?? step.finishedAt ?? null;
}

function applyStart(run, event) {
  const step = currentStep(run);
  if (run.status === 'pending') {
    if (step.status !== 'pending') illegal(`step:${step.status}`, event.type);
    run.status = 'running';
  } else if (run.status === 'running') {
    if (step.status !== 'pending') illegal(`step:${step.status}`, event.type);
  } else {
    illegal(run.status, event.type);
  }
  step.status = 'launching';
  step.attempt = (step.attempt ?? 0) + 1;
  if (event.at) step.startedAt = event.at;
  step.finishedAt = null;
  return run;
}

function applyStepRunning(run, event) {
  if (run.status !== 'running') illegal(run.status, event.type);
  const step = currentStep(run);
  if (step.status !== 'launching') illegal(`step:${step.status}`, event.type);
  step.status = 'running';
  return run;
}

function applyNeedsInput(run, event) {
  if (run.status !== 'running') illegal(run.status, event.type);
  const step = currentStep(run);
  if (step.status !== 'running' && step.status !== 'launching') {
    illegal(`step:${step.status}`, event.type);
  }
  run.status = 'needs_input';
  step.status = 'needs_input';
  return run;
}

function applyInputReceived(run, event) {
  if (run.status !== 'needs_input') illegal(run.status, event.type);
  const step = currentStep(run);
  if (step.status !== 'needs_input') illegal(`step:${step.status}`, event.type);
  run.status = 'running';
  step.status = 'running';
  return run;
}

function applyStepComplete(run, event) {
  if (run.status !== 'running') illegal(run.status, event.type);
  const step = currentStep(run);
  if (step.status !== 'running') illegal(`step:${step.status}`, event.type);
  step.status = 'complete';
  finishStep(step, event.at);
  const last = run.currentStepIndex >= run.steps.length - 1;
  if (last) {
    run.status = 'complete';
    run.finishedAt = event.at ?? run.finishedAt ?? null;
    run.error = null;
  } else {
    run.currentStepIndex += 1;
  }
  return run;
}

function applyLimitReached(run, event) {
  if (run.status !== 'running') illegal(run.status, event.type);
  const step = currentStep(run);
  if (step.status !== 'running') illegal(`step:${step.status}`, event.type);
  step.status = 'limit_reached';
  finishStep(step, event.at);
  run.status = 'limit_paused';
  return run;
}

function applyError(run, event) {
  if (!['pending', 'running', 'needs_input', 'limit_paused'].includes(run.status)) {
    illegal(run.status, event.type);
  }
  const message = typeof event.error === 'string' ? event.error : '';
  const step = currentStep(run);
  if (['launching', 'running', 'needs_input', 'limit_reached'].includes(step.status)) {
    step.status = 'failed';
    finishStep(step, event.at);
  }
  run.status = 'error';
  run.error = message;
  run.finishedAt = event.at ?? run.finishedAt ?? null;
  run.stopReason = null;
  return run;
}

function applyStop(run, event) {
  if (!STOPPABLE.has(run.status)) illegal(run.status, event.type);
  const reason = event.reason === 'terminal' ? 'terminal' : 'user';
  const step = currentStep(run);
  // Spec §8.6: paused step stays limit_reached either way.
  if (step.status !== 'limit_reached' && ACTIVE_STEP.has(step.status)) {
    step.status = 'stopped';
    finishStep(step, event.at);
  }
  run.status = 'stopped';
  run.stopReason = reason;
  run.error = null;
  run.finishedAt = event.at ?? run.finishedAt ?? null;
  return run;
}

function applyContinue(run, event) {
  if (run.status !== 'limit_paused') illegal(run.status, event.type);
  const step = currentStep(run);
  if (step.status !== 'limit_reached') illegal(`step:${step.status}`, event.type);
  const last = run.currentStepIndex >= run.steps.length - 1;
  if (last) {
    run.status = 'complete';
    run.finishedAt = event.at ?? run.finishedAt ?? null;
    run.error = null;
  } else {
    run.currentStepIndex += 1;
    run.status = 'running';
  }
  return run;
}

function applyResume(run, event) {
  if (!RESUMABLE.has(run.status)) illegal(run.status, event.type);
  if (!RESUME_WORKTREE.has(run.worktreeState)) illegal(`worktree:${run.worktreeState}`, event.type);
  const step = currentStep(run);
  if (step.sessionId) {
    step.priorSessionIds = [...(step.priorSessionIds || []), step.sessionId];
    step.sessionId = null;
  }
  step.status = 'launching';
  step.attempt = (step.attempt ?? 0) + 1;
  step.iteration = 0;
  step.finishedAt = null;
  if (event.at) step.startedAt = event.at;
  run.status = 'running';
  run.stopReason = null;
  run.error = null;
  run.finishedAt = null;
  return run;
}

const HANDLERS = {
  start: applyStart,
  step_running: applyStepRunning,
  needs_input: applyNeedsInput,
  input_received: applyInputReceived,
  step_complete: applyStepComplete,
  limit_reached: applyLimitReached,
  error: applyError,
  stop: applyStop,
  continue: applyContinue,
  resume: applyResume,
};

/**
 * @param {object} state — run-shaped object (status, steps, currentStepIndex, …)
 * @param {{ type: string, at?: string|null, error?: string, reason?: string }} event
 * @returns {object} new state (never mutates `state`)
 */
export function applyEvent(state, event) {
  const handler = HANDLERS[event?.type];
  if (!handler) throw new Error(`unknown event: ${event?.type}`);
  return handler(clone(state), event);
}

/**
 * Owner-action flags for a run view (Spec §8.8).
 * @returns {{ stop: boolean, resume: boolean, continue: boolean, cleanup: boolean }}
 */
export function computeActions(run) {
  const status = run.status;
  const worktree = run.worktreeState;
  return {
    stop: STOPPABLE.has(status),
    resume: RESUMABLE.has(status) && RESUME_WORKTREE.has(worktree),
    continue: status === 'limit_paused',
    cleanup: CLEANUP_STATUS.has(status) && CLEANUP_WORKTREE.has(worktree),
  };
}
