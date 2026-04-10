import path from 'path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'url';
import { buildShellEnv } from '../shell-env.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const expectedZdotdir = path.join(testDir, '..', 'shell', 'zsh');

describe('buildShellEnv', () => {
  it('wraps zsh sessions with the CodeDeck zsh bootstrap directory', () => {
    const env = buildShellEnv('/bin/zsh', {
      HOME: '/Users/tester',
      ZDOTDIR: '/Users/tester/.config/zsh',
      TERM: 'screen-256color',
    });

    expect(env.TERM).toBe('xterm-256color');
    expect(env.USER_ZDOTDIR).toBe('/Users/tester/.config/zsh');
    expect(env.ZDOTDIR).toBe(expectedZdotdir);
  });

  it('leaves non-zsh shells on their normal startup path', () => {
    const env = buildShellEnv('/bin/bash', {
      HOME: '/Users/tester',
      TERM: 'screen-256color',
    });

    expect(env.TERM).toBe('xterm-256color');
    expect(env.ZDOTDIR).toBeUndefined();
    expect(env.USER_ZDOTDIR).toBeUndefined();
  });
});
