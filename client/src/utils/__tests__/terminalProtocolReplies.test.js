import { describe, expect, it } from 'vitest';
import { isTerminalProtocolReply } from '../terminalProtocolReplies';

describe('isTerminalProtocolReply', () => {
  it('returns true for known terminal protocol replies that must not reach the PTY', () => {
    expect(isTerminalProtocolReply('\x1b[c')).toBe(true);
    expect(isTerminalProtocolReply('\x1b[?64;1;2c')).toBe(true);
    expect(isTerminalProtocolReply('\x1b[>0;276;0c')).toBe(true);
    expect(isTerminalProtocolReply('\x1b[12;34R')).toBe(true);
    expect(isTerminalProtocolReply('\x1b[I')).toBe(true);
    expect(isTerminalProtocolReply('\x1b[O')).toBe(true);
  });

  it('returns false for legitimate user input that the shell must receive', () => {
    expect(isTerminalProtocolReply('hello world')).toBe(false);
    expect(isTerminalProtocolReply('\x7f')).toBe(false);
    expect(isTerminalProtocolReply('\x1b[200~pasted text\x1b[201~')).toBe(false);
    expect(isTerminalProtocolReply('git status\n')).toBe(false);
  });
});
