import { describe, expect, it } from 'vitest';
import {
  shouldPersistLayout,
  shouldRenderProjectTerminals,
} from '../../utils/terminalLayout';
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

  it('allows persisting an intentional zero-terminal state', () => {
    expect(shouldPersistLayout({
      projectName: 'alpha',
      prevProjectName: 'alpha',
      tabsLength: 0,
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

describe('TerminalArea project-switch render guard', () => {
  it('suppresses stale panes on the first render after switching projects', () => {
    expect(shouldRenderProjectTerminals({
      projectName: 'whatsapp',
      prevProjectName: 'BookMe',
    })).toBe(false);
  });

  it('renders terminals on first mount and while staying on the same project', () => {
    expect(shouldRenderProjectTerminals({
      projectName: 'BookMe',
      prevProjectName: null,
    })).toBe(true);

    expect(shouldRenderProjectTerminals({
      projectName: 'BookMe',
      prevProjectName: 'BookMe',
    })).toBe(true);
  });
});

describe('TerminalArea live session hydration', () => {
  it('restores all live project sessions when saved layout is missing', async () => {
    const sessions = [
      { sessionId: 'BookMe-1', cwd: '/tmp/bookme', alive: true, wsAttached: false },
      { sessionId: 'BookMe-2', cwd: '/tmp/bookme', alive: true, wsAttached: true },
      { sessionId: 'Other-1', cwd: '/tmp/other', alive: true, wsAttached: false },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'BookMe',
      projectPath: '/tmp/bookme',
      savedLayout: null,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(2);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('BookMe-1');
    expect(result.state.tabs[0].label).toBe('BookMe-1');
    expect(result.state.tabs[1].panes[0].sessionId).toBe('BookMe-2');
    expect(result.state.tabs[1].label).toBe('BookMe-2');
    expect(result.state.activeTabId).toBe('tab-2');
    expect(result.sessionCounter).toBe(2);
  });

  it('does not treat sessions from hyphen-prefixed sibling projects as belonging to the selected project', async () => {
    const sessions = [
      {
        sessionId: 'alpha-suite-config-1',
        cwd: '/tmp/alpha-suite/alpha-suite-config',
        alive: true,
        wsAttached: true,
      },
      {
        sessionId: 'alpha-suite-3',
        cwd: '/tmp/alpha-suite/backend',
        alive: true,
        wsAttached: true,
      },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'alpha-suite',
      projectPath: '/tmp/alpha-suite',
      savedLayout: null,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(1);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('alpha-suite-3');
    expect(result.state.tabs[0].label).toBe('alpha-suite-3');
    expect(result.sessionCounter).toBe(3);
  });

  it('merges live sessions that are missing from the saved layout', async () => {
    const savedLayout = {
      tabs: [
        {
          id: 'tab-1',
          label: 'Terminal 1',
          panes: [{
            id: 'pane-BookMe-1',
            sessionId: 'BookMe-1',
            widthFraction: 1,
            isConnected: true,
          }],
        },
      ],
      activeTabId: 'tab-1',
      tabCounter: 1,
      sessionCounter: 1,
    };

    const sessions = [
      { sessionId: 'BookMe-1', cwd: '/tmp/bookme', alive: true, wsAttached: true },
      { sessionId: 'BookMe-2', cwd: '/tmp/bookme', alive: true, wsAttached: false },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'BookMe',
      projectPath: '/tmp/bookme',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(2);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('BookMe-1');
    expect(result.state.tabs[0].label).toBe('BookMe-1');
    expect(result.state.tabs[1].panes[0].sessionId).toBe('BookMe-2');
    expect(result.state.tabs[1].label).toBe('BookMe-2');
    expect(result.state.activeTabId).toBe('tab-1');
    expect(result.tabCounter).toBe(2);
    expect(result.sessionCounter).toBe(2);
  });

  it('preserves saved split-pane widths when all pane sessions are still live', async () => {
    const savedLayout = {
      tabs: [
        {
          id: 'tab-1',
          label: 'Terminal 1',
          panes: [
            {
              id: 'pane-BookMe-1',
              sessionId: 'BookMe-1',
              widthFraction: 0.7,
              isConnected: true,
            },
            {
              id: 'pane-BookMe-2',
              sessionId: 'BookMe-2',
              widthFraction: 0.3,
              isConnected: true,
            },
          ],
        },
      ],
      activeTabId: 'tab-1',
      tabCounter: 1,
      sessionCounter: 2,
    };

    const sessions = [
      { sessionId: 'BookMe-1', cwd: '/tmp/bookme', alive: true, wsAttached: true },
      { sessionId: 'BookMe-2', cwd: '/tmp/bookme', alive: true, wsAttached: false },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'BookMe',
      projectPath: '/tmp/bookme',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(1);
    expect(result.state.tabs[0].panes).toHaveLength(2);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('BookMe-1');
    expect(result.state.tabs[0].panes[0].widthFraction).toBe(0.7);
    expect(result.state.tabs[0].panes[1].sessionId).toBe('BookMe-2');
    expect(result.state.tabs[0].panes[1].widthFraction).toBe(0.3);
    expect(result.state.tabs[0].label).toBe('BookMe-1');
  });

  it('renormalizes widths only when some panes from a saved split are gone', async () => {
    const savedLayout = {
      tabs: [
        {
          id: 'tab-1',
          label: 'Terminal 1',
          panes: [
            {
              id: 'pane-BookMe-1',
              sessionId: 'BookMe-1',
              widthFraction: 0.7,
              isConnected: true,
            },
            {
              id: 'pane-BookMe-2',
              sessionId: 'BookMe-2',
              widthFraction: 0.3,
              isConnected: true,
            },
          ],
        },
      ],
      activeTabId: 'tab-1',
      tabCounter: 1,
      sessionCounter: 2,
    };

    const sessions = [
      { sessionId: 'BookMe-1', cwd: '/tmp/bookme', alive: true, wsAttached: true },
      { sessionId: 'BookMe-2', cwd: '/tmp/bookme', alive: false, wsAttached: false },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'BookMe',
      projectPath: '/tmp/bookme',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(1);
    expect(result.state.tabs[0].panes).toHaveLength(1);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('BookMe-1');
    expect(result.state.tabs[0].panes[0].widthFraction).toBe(1);
    expect(result.state.tabs[0].label).toBe('BookMe-1');
  });

  it('preserves intentionally disconnected panes when restoring layout', async () => {
    const savedLayout = {
      tabs: [
        {
          id: 'tab-1',
          label: 'Terminal 1',
          panes: [
            {
              id: 'pane-BookMe-1',
              sessionId: 'BookMe-1',
              widthFraction: 0.65,
              isConnected: false,
            },
            {
              id: 'pane-BookMe-2',
              sessionId: 'BookMe-2',
              widthFraction: 0.35,
              isConnected: true,
            },
          ],
        },
      ],
      activeTabId: 'tab-1',
      tabCounter: 1,
      sessionCounter: 2,
    };

    const sessions = [
      { sessionId: 'BookMe-1', cwd: '/tmp/bookme', alive: false, wsAttached: false },
      { sessionId: 'BookMe-2', cwd: '/tmp/bookme', alive: true, wsAttached: true },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'BookMe',
      projectPath: '/tmp/bookme',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(1);
    expect(result.state.tabs[0].panes).toHaveLength(2);
    expect(result.state.tabs[0].panes[0]).toMatchObject({
      sessionId: 'BookMe-1',
      isConnected: false,
      widthFraction: 0.65,
    });
    expect(result.state.tabs[0].panes[1]).toMatchObject({
      sessionId: 'BookMe-2',
      isConnected: true,
      widthFraction: 0.35,
    });
    expect(result.state.tabs[0].label).toBe('BookMe-1');
  });

  it('migrates saved Terminal N labels to session-based tab names', async () => {
    const savedLayout = {
      tabs: [
        {
          id: 'tab-1',
          label: 'Terminal 1',
          panes: [{
            id: 'pane-BookMe-9',
            sessionId: 'BookMe-9',
            widthFraction: 1,
            isConnected: true,
          }],
        },
      ],
      activeTabId: 'tab-1',
      tabCounter: 1,
      sessionCounter: 9,
    };

    const sessions = [
      { sessionId: 'BookMe-9', cwd: '/tmp/bookme', alive: true, wsAttached: true },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'BookMe',
      projectPath: '/tmp/bookme',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs[0].label).toBe('BookMe-9');
  });

  it('preserves an intentional zero-terminal saved layout when no live sessions remain', async () => {
    const savedLayout = {
      tabs: [],
      activeTabId: null,
      tabCounter: 4,
      sessionCounter: 9,
    };

    const result = resolveInitialTerminalState({
      projectName: 'BookMe',
      projectPath: '/tmp/bookme',
      savedLayout,
      liveSessions: [],
    });

    expect(result.state).toEqual({ tabs: [], activeTabId: null });
    expect(result.tabCounter).toBe(4);
    expect(result.sessionCounter).toBe(9);
    expect(result.shouldClearSavedLayout).toBe(false);
  });
});
