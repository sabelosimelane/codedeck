/**
 * Pure readiness classifier for pipeline launch (Spec §8.4).
 *
 * `exited` — launch process ended and the shell prompt is back:
 * `executionReason === 'shell_prompt'` with a shell `foregroundCommand`.
 * During launch the foreground was the agent; that pair means it exited.
 *
 * `closed` — session entry gone (`entryExists === false`) or not alive
 * (`isAlive === false`).
 */

const SHELLS = new Set(['bash', 'csh', 'dash', 'fish', 'ksh', 'sh', 'tcsh', 'zsh']);

export function classify({ executionReason, foregroundCommand, lines, profile, isAlive, entryExists }) {
  if (entryExists === false || isAlive === false) return 'closed';
  if (executionReason === 'agent_needs_input') return 'needs_input';
  if (executionReason === 'shell_prompt' && SHELLS.has(foregroundCommand)) return 'exited';
  if (executionReason === 'agent_prompt_idle' && profile?.promptVisible?.(lines)) return 'ready';
  return 'waiting';
}
