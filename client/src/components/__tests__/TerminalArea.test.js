import { describe, expect, it } from 'vitest';
import { shouldPersistLayout } from '../../utils/terminalLayout';
import { resolveInitialTerminalState } from '../../utils/terminalLayoutState';

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

describe('TerminalArea live session hydration', () => {
  it('restores all live project sessions when saved layout is missing', async () => {
    const sessions = [
      { sessionId: 'BookMe-1', cwd: '/tmp/bookme', alive: true },
      { sessionId: 'BookMe-2', cwd: '/tmp/bookme', alive: true },
      { sessionId: 'Other-1', cwd: '/tmp/other', alive: true },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'BookMe',
      projectPath: '/tmp/bookme',
      savedLayout: null,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(2);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('BookMe-1');
    expect(result.state.tabs[1].panes[0].sessionId).toBe('BookMe-2');
    expect(result.state.activeTabId).toBe('tab-2');
    expect(result.sessionCounter).toBe(2);
  });
});
