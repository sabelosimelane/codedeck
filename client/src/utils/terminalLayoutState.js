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
  return {
    id: `tab-${tabNumber}`,
    label: `Terminal ${tabNumber}`,
    panes: [createPane(projectName, sessionNumber)],
  };
}

function matchesProjectSession(session, projectName, projectPath) {
  return session.alive && (
    session.sessionId.startsWith(`${projectName}-`) ||
    session.cwd === projectPath
  );
}

function getSessionNumber(projectName, sessionId) {
  const match = sessionId.match(new RegExp(`^${projectName}-(\\d+)$`));
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
  return liveSessions.map((session, index) => ({
    id: `tab-${index + 1}`,
    label: `Terminal ${index + 1}`,
    panes: [{
      id: `pane-${session.sessionId}`,
      sessionId: session.sessionId,
      widthFraction: 1,
      isConnected: true,
    }],
  }));
}

export function filterLayoutByLiveSessions(savedLayout, liveSessions) {
  const aliveIds = new Set(liveSessions.filter(s => s.alive).map(s => s.sessionId));
  const filteredTabs = [];

  for (const tab of savedLayout.tabs) {
    const livePanes = tab.panes.filter(p => aliveIds.has(p.sessionId));
    if (livePanes.length > 0) {
      const fraction = 1 / livePanes.length;
      filteredTabs.push({
        ...tab,
        panes: livePanes.map(p => ({
          ...p,
          widthFraction: fraction,
          isConnected: p.isConnected ?? true,
        })),
      });
    }
  }

  if (filteredTabs.length === 0) return null;

  const activeTabId = filteredTabs.find(t => t.id === savedLayout.activeTabId)
    ? savedLayout.activeTabId
    : filteredTabs[filteredTabs.length - 1].id;

  return { tabs: filteredTabs, activeTabId };
}

export function resolveInitialTerminalState({ projectName, projectPath, savedLayout, liveSessions }) {
  if (savedLayout) {
    const restored = filterLayoutByLiveSessions(savedLayout, liveSessions);
    if (restored) {
      return {
        state: restored,
        tabCounter: savedLayout.tabCounter ?? restored.tabs.length,
        sessionCounter: savedLayout.sessionCounter ?? restored.tabs.length,
        shouldClearSavedLayout: false,
      };
    }
  }

  const projectLiveSessions = sortProjectSessions(
    projectName,
    liveSessions.filter(session => matchesProjectSession(session, projectName, projectPath))
  );

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

  const tab = createTab(projectName, 1, 1);
  return {
    state: { tabs: [tab], activeTabId: tab.id },
    tabCounter: 1,
    sessionCounter: 1,
    shouldClearSavedLayout: !!savedLayout,
  };
}
