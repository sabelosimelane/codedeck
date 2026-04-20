import { getTerminalTabLabel } from './terminalTabLabel';
import { doesSessionBelongToProject, isProjectSessionId } from './terminalProjectMatch';

function createPane(projectName, sessionNumber) {
  const sessionId = `${projectName}-${sessionNumber}`;
  return {
    id: `pane-${sessionId}`,
    sessionId,
    widthFraction: 1,
    isConnected: true,
  };
}

function createTab(projectName, tabNumber, sessionNumber) {
  const pane = createPane(projectName, sessionNumber);
  return {
    id: `tab-${tabNumber}`,
    label: getTerminalTabLabel([pane]),
    panes: [pane],
  };
}

function matchesProjectSession(session, projectName, projectPath) {
  return session.alive && doesSessionBelongToProject(session, {
    name: projectName,
    path: projectPath,
  });
}

function getSessionNumber(projectName, sessionId) {
  if (!isProjectSessionId(sessionId, projectName)) return null;
  const match = sessionId.match(/-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function sortProjectSessions(projectName, sessions) {
  return [...sessions].sort((a, b) => {
    const startedDiff = new Date(a.startedAt || 0) - new Date(b.startedAt || 0);
    if (startedDiff !== 0) return startedDiff;

    const aNumber = getSessionNumber(projectName, a.sessionId);
    const bNumber = getSessionNumber(projectName, b.sessionId);
    if (aNumber !== null && bNumber !== null && aNumber !== bNumber) {
      return aNumber - bNumber;
    }

    return a.sessionId.localeCompare(b.sessionId);
  });
}

function buildTabsFromLiveSessions(projectName, liveSessions) {
  return liveSessions.map((session, index) => {
    const panes = [{
      id: `pane-${session.sessionId}`,
      sessionId: session.sessionId,
      widthFraction: 1,
      isConnected: true,
    }];

    return {
      id: `tab-${index + 1}`,
      label: getTerminalTabLabel(panes),
      panes,
    };
  });
}

function normalizePaneWidths(panes) {
  const fraction = 1 / panes.length;
  return panes.map(pane => ({
    ...pane,
    widthFraction: fraction,
    isConnected: pane.isConnected ?? true,
  }));
}

function shouldPreservePane(pane, aliveIds) {
  if (pane.isConnected === false) return true;
  return aliveIds.has(pane.sessionId);
}

function reconcileSavedTab(tab, aliveIds) {
  const preservedPanes = tab.panes.filter(pane => shouldPreservePane(pane, aliveIds));
  if (preservedPanes.length === 0) return null;

  const panes = preservedPanes.length === tab.panes.length
    ? preservedPanes.map(pane => ({
      ...pane,
      isConnected: pane.isConnected ?? true,
    }))
    : normalizePaneWidths(preservedPanes);

  return {
    ...tab,
    label: getTerminalTabLabel(panes, tab.label),
    panes,
  };
}

function buildTabsForMissingSessions(projectName, startingTabNumber, liveSessions) {
  return liveSessions.map((session, index) => {
    const tabNumber = startingTabNumber + index;
    const panes = [{
      id: `pane-${session.sessionId}`,
      sessionId: session.sessionId,
      widthFraction: 1,
      isConnected: true,
    }];

    return {
      id: `tab-${tabNumber}`,
      label: getTerminalTabLabel(panes),
      panes,
    };
  });
}

function collectRestoredTabs(savedLayout, aliveIds) {
  return savedLayout.tabs
    .map(tab => reconcileSavedTab(tab, aliveIds))
    .filter(Boolean);
}

function collectMissingLiveSessions(restoredTabs, liveSessions) {
  const restoredSessionIds = new Set(
    restoredTabs.flatMap(tab => tab.panes.map(pane => pane.sessionId))
  );
  return liveSessions.filter(
    session => session.alive && !restoredSessionIds.has(session.sessionId)
  );
}

function getNextTabNumber(restoredTabs) {
  return restoredTabs.length > 0
    ? restoredTabs.reduce((max, tab) => {
      const match = tab.id.match(/^tab-(\d+)$/);
      return match ? Math.max(max, Number(match[1]) + 1) : max;
    }, 1)
    : 1;
}

function preserveSavedLayout(savedLayout) {
  const tabs = savedLayout.tabs.map(tab => {
    const panes = tab.panes.map(pane => ({
      ...pane,
      isConnected: pane.isConnected ?? true,
    }));

    return {
      ...tab,
      label: getTerminalTabLabel(panes, tab.label),
      panes,
    };
  });

  const activeTabId = tabs.find(tab => tab.id === savedLayout.activeTabId)
    ? savedLayout.activeTabId
    : tabs[tabs.length - 1]?.id ?? null;

  return { tabs, activeTabId };
}

export function filterLayoutByLiveSessions(savedLayout, liveSessions, projectName) {
  const aliveIds = new Set(liveSessions.filter(s => s.alive).map(session => session.sessionId));
  const restoredTabs = collectRestoredTabs(savedLayout, aliveIds);
  const missingLiveSessions = collectMissingLiveSessions(restoredTabs, liveSessions);
  const nextTabNumber = getNextTabNumber(restoredTabs);
  const mergedTabs = [
    ...restoredTabs,
    ...buildTabsForMissingSessions(projectName, nextTabNumber, missingLiveSessions),
  ];

  if (mergedTabs.length === 0) return null;

  const activeTabId = mergedTabs.find(t => t.id === savedLayout.activeTabId)
    ? savedLayout.activeTabId
    : mergedTabs[mergedTabs.length - 1].id;

  return { tabs: mergedTabs, activeTabId };
}

export function resolveInitialTerminalState({ projectName, projectPath, savedLayout, liveSessions }) {
  const projectLiveSessions = sortProjectSessions(
    projectName,
    liveSessions.filter(session => matchesProjectSession(session, projectName, projectPath))
  );

  if (savedLayout) {
    const restored = filterLayoutByLiveSessions(savedLayout, projectLiveSessions, projectName);
    if (restored) {
      const maxSessionNumber = projectLiveSessions.reduce((max, session) => {
        const sessionNumber = getSessionNumber(projectName, session.sessionId);
        return sessionNumber === null ? max : Math.max(max, sessionNumber);
      }, 0);
      return {
        state: restored,
        tabCounter: Math.max(savedLayout.tabCounter ?? 0, restored.tabs.length),
        sessionCounter: Math.max(savedLayout.sessionCounter ?? 0, maxSessionNumber || projectLiveSessions.length),
        shouldClearSavedLayout: false,
      };
    }

    if (projectLiveSessions.length === 0) {
      return {
        state: preserveSavedLayout(savedLayout),
        tabCounter: savedLayout.tabCounter ?? savedLayout.tabs.length,
        sessionCounter: savedLayout.sessionCounter ?? 0,
        shouldClearSavedLayout: false,
      };
    }
  }

  if (projectLiveSessions.length > 0) {
    const tabs = buildTabsFromLiveSessions(projectName, projectLiveSessions);
    const maxSessionNumber = projectLiveSessions.reduce((max, session) => {
      const sessionNumber = getSessionNumber(projectName, session.sessionId);
      return sessionNumber === null ? max : Math.max(max, sessionNumber);
    }, 0);

    return {
      state: { tabs, activeTabId: tabs[tabs.length - 1].id },
      tabCounter: tabs.length,
      sessionCounter: maxSessionNumber || projectLiveSessions.length,
      shouldClearSavedLayout: false,
    };
  }

  return {
    state: { tabs: [], activeTabId: null },
    tabCounter: savedLayout?.tabCounter ?? 0,
    sessionCounter: savedLayout?.sessionCounter ?? 0,
    shouldClearSavedLayout: false,
  };
}
