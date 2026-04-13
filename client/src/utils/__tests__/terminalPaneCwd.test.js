import { describe, expect, it } from 'vitest';
import { getTerminalPaneCwd } from '../terminalPaneCwd';

describe('getTerminalPaneCwd', () => {
  it('prefers the live session cwd when available', () => {
    const sessionLookup = new Map([
      ['myapp-5', { sessionId: 'myapp-5', cwd: '/home/user/projects/myapp/frontend' }],
    ]);

    expect(getTerminalPaneCwd({
      sessionId: 'myapp-5',
      projectPath: '/home/user/projects/myapp',
      sessionLookup,
    })).toBe('/home/user/projects/myapp/frontend');
  });

  it('falls back to the project path when there is no live session cwd', () => {
    expect(getTerminalPaneCwd({
      sessionId: 'myapp-5',
      projectPath: '/home/user/projects/myapp',
      sessionLookup: new Map(),
    })).toBe('/home/user/projects/myapp');
  });
});
