import { describe, expect, it, vi } from 'vitest';
import { reportDesktopActivity, shouldSendDesktopActivity } from '../desktopActivity';

describe('desktop activity throttle', () => {
  it('allows one report every 15 seconds and does not consume time for an unsent report', () => {
    expect(shouldSendDesktopActivity({ lastSentAt: null, now: 1000, visible: true, socketOpen: true })).toBe(true);
    expect(shouldSendDesktopActivity({ lastSentAt: 1000, now: 15999, visible: true, socketOpen: true })).toBe(false);
    expect(shouldSendDesktopActivity({ lastSentAt: 1000, now: 16000, visible: true, socketOpen: true })).toBe(true);
    expect(shouldSendDesktopActivity({ lastSentAt: null, now: 1000, visible: true, socketOpen: false })).toBe(false);
    const closed = { readyState: 3, send: vi.fn() };
    const open = { readyState: 1, send: vi.fn() };
    reportDesktopActivity(closed, 'visible', 1000);
    reportDesktopActivity(open, 'visible', 1000);
    reportDesktopActivity(open, 'visible', 15999);
    reportDesktopActivity(open, 'visible', 16000);
    expect(open.send.mock.calls).toEqual([[JSON.stringify({ type: 'user_activity' })], [JSON.stringify({ type: 'user_activity' })]]);
  });
});
