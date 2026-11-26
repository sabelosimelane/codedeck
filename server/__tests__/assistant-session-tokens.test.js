import { describe, expect, it } from 'vitest';
import { createSessionTokens } from '../assistant/session-tokens.js';

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';

describe('assistant session tokens', () => {
  it('issues 64-hex random tokens scoped to a single project and conversation', () => {
    const tokens = createSessionTokens();
    const first = tokens.issue({ project: 'GRS Local', conversationId: CONV_A });
    const second = tokens.issue({ project: 'Other', conversationId: CONV_B });

    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(second.token).toMatch(/^[a-f0-9]{64}$/);
    expect(first.token).not.toBe(second.token);

    expect(tokens.verify(first.token)).toMatchObject({
      token: first.token,
      project: 'GRS Local',
      conversationId: CONV_A,
    });
    expect(tokens.verify(second.token)).toMatchObject({
      token: second.token,
      project: 'Other',
      conversationId: CONV_B,
    });
    expect(tokens.size()).toBe(2);
  });

  it('refuses unknown, malformed, or ended tokens', () => {
    const tokens = createSessionTokens();
    const issued = tokens.issue({ project: 'GRS Local', conversationId: CONV_A });

    expect(tokens.verify('')).toBeNull();
    expect(tokens.verify(null)).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
    expect(tokens.verify('not-a-hex-token')).toBeNull();
    expect(tokens.verify('a'.repeat(64))).toBeNull();

    expect(tokens.end(issued.token)).toBe(true);
    expect(tokens.end(issued.token)).toBe(false);
    expect(tokens.verify(issued.token)).toBeNull();
    expect(tokens.size()).toBe(0);
  });

  it('enforces project scoping when verifying with expectedProject', () => {
    const tokens = createSessionTokens();
    const issued = tokens.issue({ project: 'GRS Local', conversationId: CONV_A });

    expect(tokens.verify(issued.token, { project: 'GRS Local' })).toMatchObject({ project: 'GRS Local' });
    expect(tokens.verify(issued.token, { project: 'Other' })).toBeNull();
  });

  it('can end all tokens for a conversation', () => {
    const tokens = createSessionTokens();
    const a1 = tokens.issue({ project: 'GRS Local', conversationId: CONV_A });
    const a2 = tokens.issue({ project: 'GRS Local', conversationId: CONV_A });
    const b1 = tokens.issue({ project: 'Other', conversationId: CONV_B });

    expect(tokens.endConversation(CONV_A)).toBe(2);
    expect(tokens.verify(a1.token)).toBeNull();
    expect(tokens.verify(a2.token)).toBeNull();
    expect(tokens.verify(b1.token)).toMatchObject({ project: 'Other' });
  });

  it('rejects invalid issue arguments', () => {
    const tokens = createSessionTokens();
    expect(() => tokens.issue({ project: '', conversationId: CONV_A })).toThrow();
    expect(() => tokens.issue({ project: 'GRS Local', conversationId: 'not-a-uuid' })).toThrow();
    expect(() => tokens.issue(null)).toThrow();
  });
});
