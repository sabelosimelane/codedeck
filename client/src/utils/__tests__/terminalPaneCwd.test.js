import { describe, expect, it } from 'vitest';
import { getTerminalPaneCwd } from '../terminalPaneCwd';

describe('getTerminalPaneCwd', () => {
  it('prefers the live session cwd when available', () => {
    const sessionLookup = new Map([
      ['BookMe-5', { sessionId: 'BookMe-5', cwd: '/Users/sabside/git/bookme/frontend' }],
    ]);

    expect(getTerminalPaneCwd({
      sessionId: 'BookMe-5',
      projectPath: '/Users/sabside/git/bookme',
      sessionLookup,
    })).toBe('/Users/sabside/git/bookme/frontend');
  });

  it('falls back to the project path when there is no live session cwd', () => {
    expect(getTerminalPaneCwd({
      sessionId: 'BookMe-5',
      projectPath: '/Users/sabside/git/bookme',
      sessionLookup: new Map(),
    })).toBe('/Users/sabside/git/bookme');
  });
});
