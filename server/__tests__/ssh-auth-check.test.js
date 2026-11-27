import { describe, expect, it } from 'vitest';
import { pendingSshAuthCheck } from '../ssh-auth-check.js';

const BANNER = '# Tailscale SSH requires an additional check.\r\n# To authenticate, visit: https://login.tailscale.com/a/0123456789abcd\r\n';

describe('pendingSshAuthCheck', () => {
  it('returns the authentication link while the connection waits at a Tailscale SSH check', () => {
    expect(pendingSshAuthCheck(['', BANNER, '^[[200~You are preparing a fresh git worktree']))
      .toBe('https://login.tailscale.com/a/0123456789abcd');
  });

  it('returns the link when the banner arrives split across chunks', () => {
    expect(pendingSshAuthCheck([BANNER.slice(0, 30), BANNER.slice(30, 90), BANNER.slice(90)]))
      .toBe('https://login.tailscale.com/a/0123456789abcd');
  });

  it('returns null once the check was approved', () => {
    expect(pendingSshAuthCheck([BANNER, '# Authentication checked with Tailscale SSH.\r\n', 'tmux output'])).toBeNull();
  });

  it('returns null for an attachment that never showed a check', () => {
    expect(pendingSshAuthCheck(['❯ ', 'Muse Code 1.4.25'])).toBeNull();
    expect(pendingSshAuthCheck([])).toBeNull();
  });

  it('rejects output that is not a list of strings', () => {
    expect(() => pendingSshAuthCheck(null)).toThrow('pendingSshAuthCheck: chunks must be an array of strings');
    expect(() => pendingSshAuthCheck([1])).toThrow('pendingSshAuthCheck: chunks must be an array of strings');
  });
});
