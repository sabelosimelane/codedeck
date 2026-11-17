/**
 * What a step's agent is told beyond the loop engine's standard instruction, built from the
 * run's definition snapshot. One line; the loop engine adds it to the prompt of every pass.
 */
import path from 'node:path';
import { notePath, NOTES_DIR } from './run-notes.js';

const DECIDE = 'The owner is not available during this run. Do not stop for a decision you can make yourself: choose the option you would recommend, write down the decision and your reason where this project keeps such notes, and continue. Use NEEDS_INPUT only when you cannot continue at all.';

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

  const parts = [];
  if (step.kind === 'node') parts.push(`Work only inside this run's worktree, ${options.worktreePath}, which is your current directory. Do not create, change or delete files outside it. If something you need is not in the worktree, do not look for it elsewhere: use NEEDS_INPUT and say what is missing.`);
  if (step.kind === 'node' && definition.notesDir !== null) parts.push(`Run notes: read ${definition.notesDir}/README.md before you start, and before your final signal write your note to ${notePath(definition, stepIndex)}.`);
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
  if (definition.agentsDecide && step.kind === 'node') parts.push(DECIDE);
  return parts.length > 0 ? parts.join(' ') : undefined;
}
