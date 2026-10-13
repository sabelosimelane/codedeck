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
// work lands (or the session dies) the mark clears, so the tab returns to full
// size and the finished styling can do its job.
//
// "Lands" means a transition into idle (or death) observed while parked — not a
// state that was already true. A tab is usually parked right after its previous
// task finished, so its finished flag is still set when the mark arrives;
// treating that flag alone as a completion cleared every fresh mark the instant
// it landed. Unknown status flickers (status_refresh_pending) must not count
// either — App may mark them finished, but that is not work landing.
//
// This watches every parked session, whichever project is on screen. Parked
// sessions have their indicators quieted, so a mark that never cleared would
// swallow the completion entirely.
export function getLandedWaitingSessionIds({
  waitingSessionIds,
  finishedSessionIds,
  previousSessionLookup,
  sessionLookup,
}) {
  if (!waitingSessionIds?.size) return [];

  return Array.from(waitingSessionIds).filter(sessionId => {
    const session = sessionLookup?.get(sessionId);
    if (!session) return false;

    const status = getTerminalStatus(session);
    const previous = previousSessionLookup?.get(sessionId);
    const prevStatus = previous ? getTerminalStatus(previous) : null;

    // Work lands only on a real transition into idle while finished. App may
    // treat busy→unknown (status_refresh_pending) as finished during a project
    // switch refresh; that flicker must not lift the park — otherwise leaving
    // and returning silently undoes waiting. A finish that predates the mark
    // leaves the session already idle across polls, so parking still sticks.
    if (
      status === 'idle'
      && Boolean(finishedSessionIds?.has(sessionId))
      && prevStatus !== 'idle'
    ) {
      return true;
    }

    return status === 'dead'
      && Boolean(previous)
      && prevStatus !== 'dead';
  });
}

// Parked work should stop competing for attention everywhere it is shown, not
// just on its tab. Quieting reuses the path the eye-icon mute already drives,
// but as a separate union: folding parked sessions into the mute set itself
// would make the eye icon claim they are muted.
export function getQuietStatusSessionIds(mutedStatusSessionIds, parkedSessionIds) {
  return new Set([...(mutedStatusSessionIds ?? []), ...(parkedSessionIds ?? [])]);
}

// A parked tab quiets all of its panes, not only the one its mark is keyed on.
export function getParkedPaneSessionIds(tabs, waitingSessionIds) {
  const parked = new Set();
  (tabs ?? [])
    .filter(tab => isTabWaiting(tab, waitingSessionIds))
    .forEach(tab => tab.panes.forEach(pane => parked.add(pane.sessionId)));
  return parked;
}

export function countWaitingSessionsForProject(projectName, waitingSessionIds) {
  if (!projectName || !waitingSessionIds?.size) return 0;
  return Array.from(waitingSessionIds)
    .filter(sessionId => isProjectSessionId(sessionId, projectName))
    .length;
}
