import { describe, expect, it } from 'vitest';
import { shouldResumeFromSessionHandshake } from '../../utils/terminalResume';

describe('shouldResumeFromSessionHandshake', () => {
  it('requests replay for existing sessions only when no snapshot contract is advertised', () => {
    expect(shouldResumeFromSessionHandshake({
      type: 'session',
      sessionId: 'anvil-1',
      existing: true,
    }, false)).toBe(true);
  });

  it('does not request replay when the server will hydrate from an authoritative snapshot', () => {
    expect(shouldResumeFromSessionHandshake({
      type: 'session',
      sessionId: 'anvil-1',
      existing: true,
      snapshotWindowLines: 10000,
      historyGuaranteed: true,
    }, false)).toBe(false);
  });

  it('does not request replay even when the snapshot-backed reconnect is degraded', () => {
    expect(shouldResumeFromSessionHandshake({
      type: 'session',
      sessionId: 'anvil-1',
      existing: true,
      snapshotWindowLines: 10000,
      historyGuaranteed: false,
    }, false)).toBe(false);
  });

  it('does not request replay for brand new sessions', () => {
    expect(shouldResumeFromSessionHandshake({
      type: 'session',
      sessionId: 'anvil-1',
      existing: false,
      snapshotWindowLines: 10000,
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
