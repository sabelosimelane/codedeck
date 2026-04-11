export const TERMINAL_ACTIVITY_WINDOW_MS = 45000;

export function getTerminalStatus(session, now = Date.now()) {
  if (!session?.alive) return 'dead';

  const activityTimestamp = session.lastSubstantialOutputAt || session.lastOutputAt;
  if (!activityTimestamp) return 'idle';

  const age = now - new Date(activityTimestamp).getTime();
  return age < TERMINAL_ACTIVITY_WINDOW_MS ? 'busy' : 'idle';
}

export function getAggregateTerminalStatus(sessions, now = Date.now()) {
  if (!sessions || sessions.length === 0) return 'none';

  const statuses = sessions.map(session => getTerminalStatus(session, now));

  if (statuses.includes('busy')) return 'busy';
  if (statuses.every(status => status === 'dead')) return 'dead';
  if (statuses.some(status => status === 'idle')) return 'idle';
  return 'none';
}

export function getTabTerminalStatus(tab, sessionLookup, now = Date.now()) {
  if (!tab?.panes?.length || !sessionLookup) return 'none';

  const sessions = tab.panes
    .map(pane => sessionLookup.get(pane.sessionId))
    .filter(Boolean);

  return getAggregateTerminalStatus(sessions, now);
}
