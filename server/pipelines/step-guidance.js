/**
 * What a step's agent is told beyond the loop engine's standard instruction, built from the
 * run's definition snapshot. One line; the loop engine adds it to the prompt of every pass.
 */
import path from 'node:path';
import { notePath, feedbackPath, NOTES_DIR } from './run-notes.js';

const DECIDE = 'The owner is not available during this run. Do not stop for a decision you can make yourself: choose the option you would recommend, write down the decision and your reason where this project keeps such notes, and continue. Use NEEDS_INPUT only when you cannot continue at all.';

/**
 * Where a run may work and read: `worktrees` are the worktrees of its task (or the one checkout
 * it runs in), `current` names the repository of its working directory, and `readOnly` are the
 * project's other repositories at their own checkouts. Left out for a run that has only its worktree.
 */
function requirePlaces(places, worktreePath) {
  if (places === undefined) return null;
  const fail = message => { throw new TypeError(`step guidance: places ${message}`); };
  if (places === null || typeof places !== 'object' || Array.isArray(places)) fail('must be an object');
  const entries = (list, field) => {
    if (!Array.isArray(list)) fail(`${field} must be a list`);
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object' || typeof entry.repository !== 'string' || !entry.repository.trim() || /[\x00-\x1f\x7f]/.test(entry.repository)) fail(`${field} must name each repository`);
      if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || /[\x00-\x1f\x7f]/.test(entry.path)) fail(`${field} must give each repository an absolute path`);
    }
    return list;
  };
  const worktrees = entries(places.worktrees, 'worktrees');
  const readOnly = entries(places.readOnly, 'readOnly');
  if (worktrees.length === 0) fail('worktrees must hold the worktree the run works in');
  if (typeof places.current !== 'string' || !places.current) fail('current must name the repository of the working directory');
  if (worktrees.find(entry => entry.repository === places.current)?.path !== worktreePath) fail('current must be the repository of the working directory');
  return { current: places.current, worktrees, readOnly };
}

/**
 * @param {object} definition — a run's definition snapshot
 * @param {number} stepIndex — the step about to run
 * @returns {string|undefined} guidance for that step, or undefined when it needs none
 */
export function buildStepGuidance(definition, stepIndex, options) {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new Error('step guidance: definition must be an object');
  }
  if (!Array.isArray(definition.steps)) throw new Error('step guidance: definition.steps must be an array');
  if (typeof definition.agentsDecide !== 'boolean') throw new Error('step guidance: definition.agentsDecide must be true or false');
  if (definition.notesDir !== null && (typeof definition.notesDir !== 'string' || !NOTES_DIR.test(definition.notesDir))) throw new TypeError('step guidance: definition.notesDir must be null or a run notes path');
  const step = Number.isInteger(stepIndex) ? definition.steps[stepIndex] : undefined;
  if (!step) throw new Error(`step guidance: stepIndex ${stepIndex} is not a step of the definition`);
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || typeof options.worktreePath !== 'string' || !options.worktreePath || !path.isAbsolute(options.worktreePath)) {
    throw new TypeError('step guidance: worktreePath must be a non-empty absolute path');
  }
  if (options.feedbackPath !== undefined && options.feedbackPath !== feedbackPath(definition, stepIndex)) throw new TypeError('step guidance: feedbackPath must be the step feedback path');
  const places = requirePlaces(options.places, options.worktreePath);
  // More than one worktree to work in, or other repositories of the project to read: the run is told about each.
  const several = places !== null && places.worktrees.length > 1;
  const named = places !== null && (several || places.readOnly.length > 0);

  const parts = [];
  if (step.kind === 'node' && !named) parts.push(`Work only inside this run's worktree, ${options.worktreePath}, which is your current directory. Do not create, change or delete files outside it. You may read files outside it that your instructions, your skills or the project's documents refer to. If the files of the task itself are not in the worktree, do not look for them in other repositories: use NEEDS_INPUT and say what is missing.`);
  if (step.kind === 'node' && named) {
    const list = entries => entries.map(entry => `${entry.repository} at ${entry.path}`).join(', ');
    const scope = several ? 'task' : 'run';
    parts.push(several
      ? `Work only inside this task's worktrees: ${list(places.worktrees)}. Your current directory is the ${places.current} one. Each is a separate Git repository on its own branch: run Git inside the worktree it concerns, commit each separately and switch no branch. Do not create, change or delete files anywhere else.`
      : `Work only inside this run's worktree, ${options.worktreePath}, which is your current directory and the ${places.current} repository. Do not create, change or delete files outside it.`);
    if (places.readOnly.length > 0) parts.push(`These repositories of the project are not part of this ${scope}: ${list(places.readOnly)}. Read them there when a document refers to them and never change them.`);
    parts.push(`If a repository that is not part of this ${scope} must change, or the files of the task are in none of these places, use NEEDS_INPUT and say what is missing.`);
  }
  if (step.kind === 'node' && definition.notesDir !== null) parts.push(`Run notes: read ${definition.notesDir}/README.md before you start, and before your final signal write your note to ${notePath(definition, stepIndex)}.`);
  if (step.kind === 'node' && options.feedbackPath !== undefined) parts.push(`The owner sent this step back: read ${options.feedbackPath} before you start.`);
  const untouched = several ? "any of the task's worktrees" : 'the worktree';
  if (step.kind === 'node' && step.readOnly === true) parts.push(definition.notesDir === null
    ? `This step is read-only: change nothing in ${untouched}.`
    : `This step is read-only: change nothing in ${untouched} except files in the run notes folder, ${definition.notesDir}.`);
  if (step.repeat?.mode === 'loop_back') {
    // The agent of this step alone decides whether the loop runs again, so it is told what the loop is.
    const { toStepIndex } = step.repeat;
    const first = Number.isInteger(toStepIndex) && toStepIndex >= 0 && toStepIndex < stepIndex
      ? definition.steps[toStepIndex]
      : undefined;
    if (!first) throw new Error(`step guidance: step ${stepIndex} loops back to step ${toStepIndex}, which is not an earlier step`);
    parts.push(`This step closes a loop: CodeDeck repeats the steps from "${first.name}" to "${step.name}" in order, round after round. Use COMPLETE only when the whole task is finished and no step of the loop has work left; use CONTINUE when another round is needed.`);
  }
  // Setup follows CodeDeck's own rules for what it may copy and change; it keeps asking.
  // A step marked to always ask the owner is not told to decide for them.
  if (definition.agentsDecide && step.kind === 'node' && step.askOwner !== true) parts.push(DECIDE);
  return parts.length > 0 ? parts.join(' ') : undefined;
}
