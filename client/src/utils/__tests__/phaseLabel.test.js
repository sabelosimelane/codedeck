import { describe, expect, it } from 'vitest';
import { formatPhasePosition } from '../phaseLabel';

describe('formatPhasePosition', () => {
  it('says "Phase N of M" when the number is the position', () => {
    expect(formatPhasePosition({ number: 2, position: 2 }, 4)).toBe('Phase 2 of 4');
  });
  it('keeps the todo\'s own number and adds the position when they differ', () => {
    expect(formatPhasePosition({ number: 17, position: 2 }, 4)).toBe('Phase 17 · 2 of 4');
  });
  it.each([
    [null, 4, /phase must be an object/],
    [{ number: 1.5, position: 1 }, 4, /phase.number/],
    [{ number: 1 }, 4, /phase.position/],
    [{ number: 1, position: 5 }, 4, /phase.position/],
    [{ number: 1, position: 1 }, 0, /phaseCount/],
  ])('rejects %p of %p', (phase, phaseCount, message) => {
    expect(() => formatPhasePosition(phase, phaseCount)).toThrow(message);
  });
});
