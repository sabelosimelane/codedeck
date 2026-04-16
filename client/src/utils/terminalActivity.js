import { doesSessionBelongToProject } from './terminalProjectMatch';

export const TERMINAL_ACTIVITY_WINDOW_MS = 45000;
export const TERMINAL_COMPLETION_NOTIFICATION_MS = 30000;
export const DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS = TERMINAL_COMPLETION_NOTIFICATION_MS;

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

export function resolveTerminalCompletionNotificationMs(value) {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS;
  }

  const numericValue = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS;
  }

  return Math.round(numericValue * 1000);
}

export function findProjectForSession(session, projects = []) {
  if (!session || !Array.isArray(projects) || projects.length === 0) return null;

  return projects.find(project => doesSessionBelongToProject(session, project)) || null;
}

export function getTerminalCompletionNotification(session, {
  activeProjects = [],
  mutedProjects = [],
  prevStatus,
  busyStartedAt,
  cooldownMs = TERMINAL_COMPLETION_NOTIFICATION_MS,
  now = Date.now(),
} = {}) {
  if (!session || prevStatus !== 'busy' || !busyStartedAt) return null;

  const status = getTerminalStatus(session, now);
  if (status === 'busy') return null;
  if (now - busyStartedAt < cooldownMs) return null;

  const project = findProjectForSession(session, activeProjects);
  if (!project || mutedProjects.includes(project.name)) return null;

  return {
    title: `CodeDeck — ${session.sessionId} finished`,
    body: session.lastOutputLine || `${session.sessionId} is idle`,
    projectName: project.name,
  };
}
