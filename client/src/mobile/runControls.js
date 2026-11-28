// What the phone's run controls offer for a run, in the order and words the desktop's task view
// uses. The backend decides what is allowed (`run.actions`); this only chooses what to show and
// how to ask first.
import { describeLimitPause, describeRunStatus } from '../utils/pipelineRunStatus';
import { cleanupConfirmation, resumeConfirmation } from '../utils/runConfirmations';

const NOT_WORKING = new Set(['interrupted', 'stopped', 'error', 'complete']);

export const stopConfirmation = run => `Stop ${run.workflowName}? Automation stops; the agent in its terminal may still be working.`;

/**
 * The controls for one run: `actions` in the order they are shown, each with its label, whether it
 * is the highlighted next step, and the question asked before it is sent (null: sent at once).
 * A capped pause keeps its own panel, so its Continue and Stop are not listed here.
 */
export function describeRunControls(run) {
  if (!run || typeof run !== 'object' || !Array.isArray(run.steps)) throw new Error('run controls: run is required');
  const { primaryAction } = describeRunStatus(run);
  const capped = describeLimitPause(run) !== null && run.actions?.continue === true;
  const current = run.steps.find(step => step.index === run.currentStepIndex) ?? run.steps[run.currentStepIndex];
  const actions = [];
  const add = (action, label, confirm) => actions.push({ action, label, primary: primaryAction === action, confirm });
  if (!capped && run.actions?.continue) add('continue', 'Continue', null);
  if (run.actions?.resume) add('resume', 'Resume', resumeConfirmation(run, current));
  if (run.actions?.cleanup) add('cleanup', run.worktree?.state === 'external' ? 'Close run' : 'Clean up worktree', cleanupConfirmation(run));
  if (!capped && run.actions?.stop && !NOT_WORKING.has(run.status)) add('stop', 'Stop', stopConfirmation(run));
  return { actions: [...actions.filter(item => item.primary), ...actions.filter(item => !item.primary)], current };
}
