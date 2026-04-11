import { describe, expect, it } from 'vitest';
import { shouldResumeFromSessionHandshake } from '../../utils/terminalResume';

describe('shouldResumeFromSessionHandshake', () => {
  it('requests replay for existing sessions even on a fresh mount', () => {
    expect(shouldResumeFromSessionHandshake({
      type: 'session',
      sessionId: 'anvil-1',
      existing: true,
    }, false)).toBe(true);
  });

  it('does not request replay for brand new sessions', () => {
    expect(shouldResumeFromSessionHandshake({
      type: 'session',
      sessionId: 'anvil-1',
      existing: false,
    }, false)).toBe(false);
  });

  it('does not request replay when one is already in flight', () => {
    expect(shouldResumeFromSessionHandshake({
      type: 'session',
      sessionId: 'anvil-1',
      existing: true,
    }, true)).toBe(false);
  });
});
