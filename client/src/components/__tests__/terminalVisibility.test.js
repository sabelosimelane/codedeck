import { describe, expect, it } from 'vitest';
import { shouldSyncVisibleTerminal } from '../../utils/terminalVisibility';

describe('shouldSyncVisibleTerminal', () => {
  it('allows sync for visible terminals with real dimensions', () => {
    expect(shouldSyncVisibleTerminal({
      isVisible: true,
      width: 800,
      height: 600,
    })).toBe(true);
  });

  it('blocks sync for hidden terminals', () => {
    expect(shouldSyncVisibleTerminal({
      isVisible: false,
      width: 800,
      height: 600,
    })).toBe(false);
  });

  it('blocks sync for zero-sized terminals', () => {
    expect(shouldSyncVisibleTerminal({
      isVisible: true,
      width: 0,
      height: 600,
    })).toBe(false);
  });
});
