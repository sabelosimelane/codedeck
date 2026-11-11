import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const BASE = '/api/session-attention';
const LEGACY_MUTES = 'codedeck-muted-status-sessions';

class AttentionProblem extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function putState(sessionId, body) {
  const response = await fetch(`${BASE}/${encodeURIComponent(sessionId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let message = 'Something went wrong. Please try again.';
    try {
      const problem = await response.json();
      if (typeof problem?.message === 'string' && problem.message) message = problem.message;
    } catch (parseFailure) {
      console.warn(`[attention] unreadable error response status=${response.status} error=${parseFailure.message}`);
    }
    throw new AttentionProblem(message, response.status);
  }
  return response.json();
}

const failureMessage = failure => (failure instanceof AttentionProblem ? failure.message : 'Server unreachable');

// The backend owns which terminals are "finished" and which have their status
// colours muted, so the phone and every browser tab agree. The poll rows carry
// both flags; a change this tab made is held (once the backend confirmed it)
// until a poll reports the same value, so a poll fetched just before the write
// cannot flick it back.
export function useSessionAttention(sessionStatus, showToast) {
  const [confirmed, setConfirmed] = useState(() => new Map());

  useEffect(() => {
    setConfirmed(prev => {
      if (prev.size === 0) return prev;
      const rows = new Map(sessionStatus.map(session => [session.sessionId, session]));
      let next = null;
      for (const [sessionId, held] of prev) {
        const row = rows.get(sessionId);
        const caughtUp = !row || (
          (held.finished === undefined || row.finished === held.finished)
          && (held.muted === undefined || row.statusMuted === held.muted)
        );
        if (caughtUp) { next ??= new Map(prev); next.delete(sessionId); }
      }
      return next ?? prev;
    });
  }, [sessionStatus]);

  const { finishedSessionIds, mutedStatusSessionIds } = useMemo(() => {
    const finished = new Set();
    const muted = new Set();
    for (const session of sessionStatus) {
      const held = confirmed.get(session.sessionId);
      if ((held?.finished ?? session.finished) === true) finished.add(session.sessionId);
      if ((held?.muted ?? session.statusMuted) === true) muted.add(session.sessionId);
    }
    return { finishedSessionIds: finished, mutedStatusSessionIds: muted };
  }, [sessionStatus, confirmed]);

  const hold = useCallback((sessionId, fields) => {
    setConfirmed(prev => new Map(prev).set(sessionId, { ...prev.get(sessionId), ...fields }));
  }, []);

  // Looking at a finished terminal is the acknowledgement; the amber clearing is
  // its feedback, so success stays silent. Failure is always reported.
  const resetFinishedSession = useCallback(async (sessionId) => {
    if (!finishedSessionIds.has(sessionId)) return;
    try {
      const state = await putState(sessionId, { acknowledged: true });
      hold(sessionId, { finished: state.finished === true });
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    }
  }, [finishedSessionIds, hold, showToast]);

  const toggleMutedStatusSession = useCallback(async (sessionId) => {
    try {
      const state = await putState(sessionId, { muted: !mutedStatusSessionIds.has(sessionId) });
      hold(sessionId, { muted: state.muted === true });
      showToast({ type: 'success', message: state.muted === true ? 'Status colors muted' : 'Status colors shown' });
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
    }
  }, [mutedStatusSessionIds, hold, showToast]);

  // Mutes used to live in this browser's localStorage. Move them to the backend
  // once the first status rows are in (the backend only mutes sessions it has
  // seen), then drop the local copy. Sessions that no longer exist are skipped.
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current || sessionStatus.length === 0) return;
    migrated.current = true;
    const stored = localStorage.getItem(LEGACY_MUTES);
    if (stored === null) return;
    let sessionIds;
    try {
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) throw new Error('not a list');
      sessionIds = parsed.filter(value => typeof value === 'string' && value.trim() !== '');
    } catch (parseFailure) {
      console.warn(`[attention] discarding unreadable local mute list error=${parseFailure.message}`);
      localStorage.removeItem(LEGACY_MUTES);
      return;
    }
    (async () => {
      try {
        for (const sessionId of sessionIds) {
          try {
            const state = await putState(sessionId, { muted: true });
            hold(sessionId, { muted: state.muted === true });
          } catch (failure) {
            // 404/409: the terminal is gone or not known to the backend — nothing to carry over.
            if (!(failure instanceof AttentionProblem) || ![404, 409].includes(failure.status)) throw failure;
            console.warn(`[attention] skipped stale local mute session=${sessionId} status=${failure.status}`);
          }
        }
        localStorage.removeItem(LEGACY_MUTES);
      } catch (failure) {
        console.warn(`[attention] mute migration failed error=${failure.message}`);
        showToast({ type: 'error', message: 'Could not move muted terminals to the server' });
      }
    })();
  }, [sessionStatus, hold, showToast]);

  return { finishedSessionIds, mutedStatusSessionIds, resetFinishedSession, toggleMutedStatusSession };
}
