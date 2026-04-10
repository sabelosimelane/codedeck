import { describe, expect, it } from 'vitest';
import { shouldPersistLayout } from '../../utils/terminalLayout';

describe('TerminalArea layout persistence guard', () => {
  it('skips persistence on the first render after switching to a different project', () => {
    expect(shouldPersistLayout({
      projectName: 'beta',
      prevProjectName: 'alpha',
      tabsLength: 1,
      isRestoring: false,
    })).toBe(false);
  });

  it('allows persistence while staying on the same project', () => {
    expect(shouldPersistLayout({
      projectName: 'alpha',
      prevProjectName: 'alpha',
      tabsLength: 1,
      isRestoring: false,
    })).toBe(true);
  });

  it('skips persistence while a restore is in progress', () => {
    expect(shouldPersistLayout({
      projectName: 'alpha',
      prevProjectName: 'alpha',
      tabsLength: 1,
      isRestoring: true,
    })).toBe(false);
  });
});
