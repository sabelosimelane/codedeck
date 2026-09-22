import { isProjectSessionId } from './terminalProjectMatch';
import { getTerminalStatus } from './terminalActivity';

// A tab is marked waiting when work has been delegated to an agent inside it and
// the user wants it to stop competing for attention until it lands. The mark is
// keyed on the tab's first pane session — the same identity tab titles use — so a
// split tab carries one mark, not one per pane.
export function getTabWaitingKey(tab) {
  return tab?.panes?.[0]?.sessionId ?? null;
}

export function isTabWaiting(tab, waitingSessionIds) {
  const key = getTabWaitingKey(tab);
  if (!key || !waitingSessionIds) return false;
  return waitingSessionIds.has(key);
}

// Waiting tabs group to the left so the tabs still being worked in keep full
// width. Relative order inside each group is preserved — a tab that jumps
// position twice costs more attention than the dimming saves.
export function orderTabsForDisplay(tabs, waitingSessionIds) {
  if (!tabs?.length) return [];
  const waiting = tabs.filter(tab => isTabWaiting(tab, waitingSessionIds));
  if (waiting.length === 0) return [...tabs];
  return [...waiting, ...tabs.filter(tab => !isTabWaiting(tab, waitingSessionIds))];
}

// Waiting is a time-boxed quiet, not a permanent mute: the moment the delegated
// work lands (or the session dies) the mark clears so the tab returns to full
// size and the finished styling can do its job.
export function getWaitingKeysToAutoClear({ tabs, waitingSessionIds, finishedSessionIds, sessionLookup }) {
  if (!tabs?.length || !waitingSessionIds?.size) return [];

  return tabs.reduce((keys, tab) => {
    const key = getTabWaitingKey(tab);
    if (!key || !waitingSessionIds.has(key)) return keys;

    const hasLanded = tab.panes.some(pane => {
      const session = sessionLookup?.get(pane.sessionId);
      if (!session) return false;
      return finishedSessionIds?.has(pane.sessionId) || getTerminalStatus(session) === 'dead';
    });

    return hasLanded ? [...keys, key] : keys;
  }, []);
}

export function countWaitingSessionsForProject(projectName, waitingSessionIds) {
  if (!projectName || !waitingSessionIds?.size) return 0;
  return Array.from(waitingSessionIds)
    .filter(sessionId => isProjectSessionId(sessionId, projectName))
    .length;
}
