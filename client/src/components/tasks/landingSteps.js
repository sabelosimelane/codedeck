/**
 * What a task's landing bar puts in front of the owner for one copy of a repository: its one next
 * step, one line on where its work stands, and what stands in the way of a merge. The backend
 * decides what is allowed (`blockers`); this only chooses what to show first.
 */
import { closeRefusals } from './ignoredFiles.js';

export const FINISH_TASK_LABEL = 'Finish task…';

const branchSwitched = entry => entry.blockers.close.some(reason => reason.code === 'branch_switched');

const plural = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;

/** `commit`, `merge`, `close` or null: the one action worth a button on the bar. */
export function nextLandingStep(entry) {
  if (!entry.filesPresent || branchSwitched(entry)) return null;
  if (entry.uncommittedCount > 0) return entry.blockers.commit.length === 0 ? 'commit' : null;
  if (entry.baseBranch !== null && entry.commitsAhead > 0) return entry.blockers.merge.length === 0 ? 'merge' : null;
  if (entry.alreadyInBase) return closeRefusals(entry).length === 0 ? 'close' : null;
  return null;
}

/** One line on where the work stands. `tone`: warning, ready, muted or danger. */
export function landingStatus(entry) {
  if (!entry.filesPresent) return { tone: 'danger', text: 'Files no longer on disk' };
  if (branchSwitched(entry)) return { tone: 'danger', text: 'Checkout on a different branch' };
  if (entry.uncommittedCount > 0) return { tone: 'warning', text: plural(entry.uncommittedCount, 'uncommitted file') };
  if (entry.commitsAhead > 0) {
    return { tone: 'ready', text: entry.baseBranch === null ? `${plural(entry.commitsAhead, 'commit')} on this branch` : `${plural(entry.commitsAhead, 'commit')} ready for ${entry.baseBranch}` };
  }
  if (entry.alreadyInBase) return { tone: 'ready', text: `Already in ${entry.baseBranch}` };
  return { tone: 'muted', text: 'No changes yet' };
}

// Told already by the status line or by the run itself.
const SAID_ELSEWHERE = new Set(['uncommitted', 'nothing_to_land', 'already_in_base', 'run_active', 'branch_switched']);

/** Why committed work cannot be merged yet; empty when there is nothing to say. */
export function waitingReasons(entry) {
  if (entry.runActive || (entry.uncommittedCount === 0 && entry.commitsAhead === 0)) return [];
  return entry.blockers.merge.filter(item => !SAID_ELSEWHERE.has(item.code)).map(item => item.message);
}
