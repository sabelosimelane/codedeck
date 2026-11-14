/**
 * Pure reducer for pipeline run / step statuses (Spec §5) and owner-action
 * flags (Spec §8.8).
 */

const STOPPABLE = new Set(['pending', 'running', 'needs_input', 'limit_paused', 'interrupted']);
const RESUMABLE = new Set(['interrupted', 'stopped', 'error']);
const RESUME_WORKTREE = new Set(['not_created', 'present', 'external']);
const CLEANUP_STATUS = new Set(['complete', 'stopped', 'error', 'interrupted']);
// Cleanup of an `external` worktree only releases it from the run; see run-engine cleanupWorktree.
const CLEANUP_WORKTREE = new Set(['not_created', 'present', 'removal_blocked', 'external']);
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
  // What the agent asked: an object when it signalled NEEDS_INPUT, null for a launch dialog.
  if (event.inputRequest === undefined) throw new Error('needs_input event: inputRequest is required');
  run.status = 'needs_input';
  step.status = 'needs_input';
  run.inputRequest = event.inputRequest;
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

/**
 * The current step finished a pass with work left and sends the run back to an earlier
 * step: one round of the loop is done. Every step of the loop becomes pending again and
 * keeps its terminal; the caller decides whether another round is allowed.
 */
function applyLoopBack(run, event) {
  if (run.status !== 'running') illegal(run.status, event.type);
  const step = currentStep(run);
  if (step.status !== 'running') illegal(`step:${step.status}`, event.type);
  const { toStepIndex } = event;
  if (!Number.isInteger(toStepIndex) || toStepIndex < 0 || toStepIndex >= run.currentStepIndex) {
    throw new Error('loop_back event: toStepIndex must be the index of an earlier step');
  }
  step.roundsCompleted += 1;
  for (let index = toStepIndex; index <= run.currentStepIndex; index += 1) {
    const looped = run.steps[index];
    looped.status = 'pending';
    looped.iteration = 0;
    looped.finishedAt = null;
  }
  run.currentStepIndex = toStepIndex;
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
  if (typeof event.newTerminal !== 'boolean') {
    throw new Error('resume event: newTerminal must be true or false');
  }
  const step = currentStep(run);
  // The step goes back to its own terminal, where its agent is cleared before the prompt is
  // sent again. It gets a new terminal only when the caller found that one unusable.
  if (event.newTerminal) {
    if (step.sessionId) {
      step.priorSessionIds = [...(step.priorSessionIds || []), step.sessionId];
      step.sessionId = null;
    }
  } else if (!step.sessionId) {
    throw new Error('resume event: a step without a terminal needs a new one');
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
  loop_back: applyLoopBack,
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
  const next = handler(clone(state), event);
  // A request belongs to the wait it was made in.
  if (next.status !== 'needs_input') next.inputRequest = null;
  return next;
}

/**
 * Owner-action flags for a run view (Spec §8.8).
 * @returns {{ stop: boolean, resume: boolean, continue: boolean, cleanup: boolean, answer: boolean }}
 */
export function computeActions(run) {
  const status = run.status;
  const worktree = run.worktreeState;
  return {
    stop: STOPPABLE.has(status),
    resume: RESUMABLE.has(status) && RESUME_WORKTREE.has(worktree),
    continue: status === 'limit_paused',
    cleanup: CLEANUP_STATUS.has(status) && CLEANUP_WORKTREE.has(worktree),
    // Only a request the agent signalled can be answered by typing into its terminal.
    answer: status === 'needs_input' && run.inputRequest !== null,
  };
}
