const wholeNumber = value => Number.isInteger(value) && value >= 0;

/**
 * "Phase 2 of 4", or "Phase 17 · 2 of 4" when a todo numbers its phases on from an earlier one:
 * the todo's own number names the phase, the position says how far through this todo the run is.
 */
export function formatPhasePosition(phase, phaseCount) {
  if (!phase || typeof phase !== 'object' || Array.isArray(phase)) throw new TypeError('phase label: phase must be an object');
  if (!Number.isInteger(phaseCount) || phaseCount < 1) throw new TypeError(`phase label: phaseCount must be a positive integer, got ${String(phaseCount)}`);
  if (!wholeNumber(phase.number)) throw new TypeError(`phase label: phase.number must be a nonnegative integer, got ${String(phase.number)}`);
  if (!Number.isInteger(phase.position) || phase.position < 1 || phase.position > phaseCount) {
    throw new TypeError(`phase label: phase.position must be between 1 and ${phaseCount}, got ${String(phase.position)}`);
  }
  return phase.number === phase.position
    ? `Phase ${phase.number} of ${phaseCount}`
    : `Phase ${phase.number} · ${phase.position} of ${phaseCount}`;
}
