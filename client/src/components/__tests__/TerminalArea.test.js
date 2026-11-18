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

  it('skips persistence while the last restore lacked live backend truth', () => {
    expect(shouldPersistLayout({
      projectName: 'alpha',
      prevProjectName: 'alpha',
      tabsLength: 0,
      isRestoring: false,
      isPersistenceSuspended: true,
    })).toBe(false);
  });
});

describe('TerminalArea project-switch render guard', () => {
  it('suppresses stale panes on the first render after switching projects', () => {
    expect(shouldRenderProjectTerminals({
      projectName: 'whatsapp',
      prevProjectName: 'Gamma',
    })).toBe(false);
  });

  it('renders terminals on first mount and while staying on the same project', () => {
    expect(shouldRenderProjectTerminals({
      projectName: 'Gamma',
      prevProjectName: null,
    })).toBe(true);

    expect(shouldRenderProjectTerminals({
      projectName: 'Gamma',
      prevProjectName: 'Gamma',
    })).toBe(true);
  });
});

describe('TerminalArea live session hydration', () => {
  const session = number => ({ sessionId: `Gamma-${number}`, cwd: '/tmp/gamma', alive: true });
  const savedTab = (id, number) => ({
    id,
    label: `Gamma-${number}`,
    panes: [{ id: `pane-Gamma-${number}`, sessionId: `Gamma-${number}`, widthFraction: 1, isConnected: true }],
  });
  const restore = (savedLayout, liveSessions) => resolveInitialTerminalState({
    projectName: 'Gamma', projectPath: '/tmp/gamma', savedLayout, liveSessions,
  });
  const corruptLayout = {
    tabs: [
      savedTab('tab-134', 22), savedTab('tab-135', 23), savedTab('tab-136', 24),
      savedTab('tab-137', 25), savedTab('tab-138', 26), savedTab('tab-139', 27),
      savedTab('tab-137', 29),
    ],
    activeTabId: 'tab-137', tabCounter: 137, sessionCounter: 29,
  };

  it('raises the counter for a tab added for a missing live session', () => {
    const savedLayout = {
      tabs: [savedTab('tab-134', 22), savedTab('tab-135', 23), savedTab('tab-136', 24)],
      activeTabId: 'tab-136', tabCounter: 136, sessionCounter: 24,
    };
    const result = restore(savedLayout, [22, 23, 24, 25].map(session));
    expect(result.state.tabs.map(tab => tab.id)).toEqual(['tab-134', 'tab-135', 'tab-136', 'tab-137']);
    expect(result.tabCounter).toBe(137);
  });

  it('raises a saved counter that is below a saved tab id', () => {
    const result = restore({
      tabs: [savedTab('tab-136', 24)], activeTabId: 'tab-136', tabCounter: 135, sessionCounter: 24,
    }, [session(24)]);
    expect(result.tabCounter).toBe(136);
  });

  it('repairs later duplicate ids and keeps the first duplicate active', () => {
    const result = restore(corruptLayout, [22, 23, 24, 25, 26, 27, 29].map(session));
    expect(result.state.tabs.map(tab => tab.id)).toEqual([
      'tab-134', 'tab-135', 'tab-136', 'tab-137', 'tab-138', 'tab-139', 'tab-140',
    ]);
    expect(result.state.tabs.map(tab => tab.panes[0].sessionId)).toEqual(corruptLayout.tabs.map(tab => tab.panes[0].sessionId));
    expect(result.state.tabs[3].panes[0].sessionId).toBe('Gamma-25');
    expect(result.state.tabs[6].panes[0].sessionId).toBe('Gamma-29');
    expect(result.state.activeTabId).toBe('tab-137');
    expect(result.tabCounter).toBe(140);
  });

  it('numbers missing live sessions after repaired ids', () => {
    const result = restore(corruptLayout, [22, 23, 24, 25, 26, 27, 29, 30].map(session));
    expect(result.state.tabs.at(-1).id).toBe('tab-141');
    expect(result.tabCounter).toBe(141);
  });

  it('repairs duplicate saved ids when there are no live sessions', () => {
    const result = restore(corruptLayout, []);
    expect(result.state.tabs.map(tab => tab.id)).toEqual([
      'tab-134', 'tab-135', 'tab-136', 'tab-137', 'tab-138', 'tab-139', 'tab-140',
    ]);
    expect(result.state.activeTabId).toBe('tab-137');
    expect(result.tabCounter).toBe(140);
  });

  it('leaves an already unique saved layout unchanged', () => {
    const savedLayout = {
      tabs: [savedTab('tab-136', 24), savedTab('tab-137', 25)],
      activeTabId: 'tab-136', tabCounter: 137, sessionCounter: 25,
    };
    const result = restore(savedLayout, [session(24), session(25)]);
    expect(result.state.tabs.map(tab => tab.id)).toEqual(['tab-136', 'tab-137']);
    expect(result.state.activeTabId).toBe('tab-136');
    expect(result.tabCounter).toBe(137);
  });

  it('sets the counter to the highest tab number when building from live sessions alone', () => {
    const result = restore(null, [session(22), session(23), session(24)]);
    expect(result.state.tabs.map(tab => tab.id)).toEqual(['tab-1', 'tab-2', 'tab-3']);
    expect(result.tabCounter).toBe(3);
  });

  it('restores all live project sessions when saved layout is missing', async () => {
    const sessions = [
      { sessionId: 'Gamma-1', cwd: '/tmp/gamma', alive: true, wsAttached: false },
      { sessionId: 'Gamma-2', cwd: '/tmp/gamma', alive: true, wsAttached: true },
      { sessionId: 'Other-1', cwd: '/tmp/other', alive: true, wsAttached: false },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'Gamma',
      projectPath: '/tmp/gamma',
      savedLayout: null,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(2);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('Gamma-1');
    expect(result.state.tabs[0].label).toBe('Gamma-1');
    expect(result.state.tabs[1].panes[0].sessionId).toBe('Gamma-2');
    expect(result.state.tabs[1].label).toBe('Gamma-2');
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
            id: 'pane-Gamma-1',
            sessionId: 'Gamma-1',
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
      { sessionId: 'Gamma-1', cwd: '/tmp/gamma', alive: true, wsAttached: true },
      { sessionId: 'Gamma-2', cwd: '/tmp/gamma', alive: true, wsAttached: false },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'Gamma',
      projectPath: '/tmp/gamma',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(2);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('Gamma-1');
    expect(result.state.tabs[0].label).toBe('Gamma-1');
    expect(result.state.tabs[1].panes[0].sessionId).toBe('Gamma-2');
    expect(result.state.tabs[1].label).toBe('Gamma-2');
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
              id: 'pane-Gamma-1',
              sessionId: 'Gamma-1',
              widthFraction: 0.7,
              isConnected: true,
            },
            {
              id: 'pane-Gamma-2',
              sessionId: 'Gamma-2',
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
      { sessionId: 'Gamma-1', cwd: '/tmp/gamma', alive: true, wsAttached: true },
      { sessionId: 'Gamma-2', cwd: '/tmp/gamma', alive: true, wsAttached: false },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'Gamma',
      projectPath: '/tmp/gamma',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(1);
    expect(result.state.tabs[0].panes).toHaveLength(2);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('Gamma-1');
    expect(result.state.tabs[0].panes[0].widthFraction).toBe(0.7);
    expect(result.state.tabs[0].panes[1].sessionId).toBe('Gamma-2');
    expect(result.state.tabs[0].panes[1].widthFraction).toBe(0.3);
    expect(result.state.tabs[0].label).toBe('Gamma-1');
  });

  it('renormalizes widths only when some panes from a saved split are gone', async () => {
    const savedLayout = {
      tabs: [
        {
          id: 'tab-1',
          label: 'Terminal 1',
          panes: [
            {
              id: 'pane-Gamma-1',
              sessionId: 'Gamma-1',
              widthFraction: 0.7,
              isConnected: true,
            },
            {
              id: 'pane-Gamma-2',
              sessionId: 'Gamma-2',
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
      { sessionId: 'Gamma-1', cwd: '/tmp/gamma', alive: true, wsAttached: true },
      { sessionId: 'Gamma-2', cwd: '/tmp/gamma', alive: false, wsAttached: false },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'Gamma',
      projectPath: '/tmp/gamma',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(1);
    expect(result.state.tabs[0].panes).toHaveLength(1);
    expect(result.state.tabs[0].panes[0].sessionId).toBe('Gamma-1');
    expect(result.state.tabs[0].panes[0].widthFraction).toBe(1);
    expect(result.state.tabs[0].label).toBe('Gamma-1');
  });

  it('preserves intentionally disconnected panes when restoring layout', async () => {
    const savedLayout = {
      tabs: [
        {
          id: 'tab-1',
          label: 'Terminal 1',
          panes: [
            {
              id: 'pane-Gamma-1',
              sessionId: 'Gamma-1',
              widthFraction: 0.65,
              isConnected: false,
            },
            {
              id: 'pane-Gamma-2',
              sessionId: 'Gamma-2',
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
      { sessionId: 'Gamma-1', cwd: '/tmp/gamma', alive: false, wsAttached: false },
      { sessionId: 'Gamma-2', cwd: '/tmp/gamma', alive: true, wsAttached: true },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'Gamma',
      projectPath: '/tmp/gamma',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs).toHaveLength(1);
    expect(result.state.tabs[0].panes).toHaveLength(2);
    expect(result.state.tabs[0].panes[0]).toMatchObject({
      sessionId: 'Gamma-1',
      isConnected: false,
      widthFraction: 0.65,
    });
    expect(result.state.tabs[0].panes[1]).toMatchObject({
      sessionId: 'Gamma-2',
      isConnected: true,
      widthFraction: 0.35,
    });
    expect(result.state.tabs[0].label).toBe('Gamma-1');
  });

  it('migrates saved Terminal N labels to session-based tab names', async () => {
    const savedLayout = {
      tabs: [
        {
          id: 'tab-1',
          label: 'Terminal 1',
          panes: [{
            id: 'pane-Gamma-9',
            sessionId: 'Gamma-9',
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
      { sessionId: 'Gamma-9', cwd: '/tmp/gamma', alive: true, wsAttached: true },
    ];

    const result = resolveInitialTerminalState({
      projectName: 'Gamma',
      projectPath: '/tmp/gamma',
      savedLayout,
      liveSessions: sessions,
    });

    expect(result.state.tabs[0].label).toBe('Gamma-9');
  });

  it('preserves saved tabs when the live session snapshot is empty so durable sessions can reconnect after server restart', async () => {
    const savedLayout = {
      tabs: [
        {
          id: 'tab-4',
          label: 'Gamma-9',
          panes: [{
            id: 'pane-Gamma-9',
            sessionId: 'Gamma-9',
            widthFraction: 1,
            isConnected: true,
          }],
        },
      ],
      activeTabId: 'tab-4',
      tabCounter: 4,
      sessionCounter: 9,
    };

    const result = resolveInitialTerminalState({
      projectName: 'Gamma',
      projectPath: '/tmp/gamma',
      savedLayout,
      liveSessions: [],
    });

    expect(result.state).toEqual({
      tabs: savedLayout.tabs,
      activeTabId: 'tab-4',
    });
    expect(result.tabCounter).toBe(4);
    expect(result.sessionCounter).toBe(9);
    expect(result.shouldClearSavedLayout).toBe(false);
  });

  it('preserves an intentional zero-terminal saved layout when no live sessions remain', async () => {
    const savedLayout = {
      tabs: [],
      activeTabId: null,
      tabCounter: 4,
      sessionCounter: 9,
    };

    const result = resolveInitialTerminalState({
      projectName: 'Gamma',
      projectPath: '/tmp/gamma',
      savedLayout,
      liveSessions: [],
    });

    expect(result.state).toEqual({ tabs: [], activeTabId: null });
    expect(result.tabCounter).toBe(4);
    expect(result.sessionCounter).toBe(9);
    expect(result.shouldClearSavedLayout).toBe(false);
  });
});
