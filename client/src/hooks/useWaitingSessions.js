import { useCallback, useEffect, useRef, useState } from 'react';
import { getLandedWaitingSessionIds } from '../utils/terminalWaiting';

const BASE = '/api/terminal-waiting';

async function readProblem(response, fallback) {
  try {
    const body = await response.json();
    return body.message || body.error || fallback;
  } catch {
    return fallback;
  }
}

async function loadWaitingPages(signal) {
  const records = [];
  for (let page = 0; ; page++) {
    const response = await fetch(`${BASE}?page=${page}&size=100`, { signal });
    if (!response.ok) throw new Error(await readProblem(response, 'Failed to load waiting tabs'));
    const body = await response.json();
    if (!Array.isArray(body.data) || typeof body.page?.hasNextPage !== 'boolean') {
      throw new Error('Failed to load waiting tabs');
    }
    records.push(...body.data);
    if (!body.page.hasNextPage) return records;
  }
}

// SQLite owns which tabs are waiting. Local state is a mirror that is only
// updated after the backend confirms the write — an optimistic dim that the
// server rejected would quietly hide a tab the user still needs.
export function useWaitingSessions(showToast, { sessionStatus = [], finishedSessionIds = new Set() } = {}) {
  const [waitingSessionIds, setWaitingSessionIds] = useState(() => new Set());
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const request = new AbortController();

    (async () => {
      try {
        const records = await loadWaitingPages(request.signal);
        if (mounted.current) setWaitingSessionIds(new Set(records.map(record => record.sessionId)));
      } catch (failure) {
        if (request.signal.aborted || !mounted.current) return;
        showToast({ type: 'error', message: failure.message || 'Failed to load waiting tabs' });
      }
    })();

    return () => { mounted.current = false; request.abort(); };
  }, [showToast]);

  const write = useCallback(async (sessionId, waiting) => {
    const response = await fetch(`${BASE}/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waiting }),
    });
    if (!response.ok) throw new Error(await readProblem(response, 'Failed to update waiting tab'));

    setWaitingSessionIds(prev => {
      const next = new Set(prev);
      if (waiting) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
  }, []);

  const toggleWaiting = useCallback(async (sessionId) => {
    const waiting = !waitingSessionIds.has(sessionId);
    try {
      await write(sessionId, waiting);
      showToast({ type: 'success', message: waiting ? 'Tab moved to waiting' : 'Tab is no longer waiting' });
    } catch (failure) {
      showToast({
        type: 'error',
        message: failure instanceof TypeError || failure.message === 'network down'
          ? 'Server unreachable'
          : failure.message,
      });
    }
  }, [waitingSessionIds, write, showToast]);

  // Auto-clear is the payoff, not an action the user took — it lands alongside
  // the finished styling and the completion notification, so it stays silent.
  const clearWaiting = useCallback(async (sessionIds) => {
    if (!sessionIds?.length) return;
    for (const sessionId of sessionIds) {
      try {
        await write(sessionId, false);
      } catch (failure) {
        console.warn(`[waiting] auto-clear failed session=${sessionId} error=${failure.message}`);
      }
    }
  }, [write]);

  // Auto-clear lives here, over every session the app polls, rather than in
  // the terminal area — that only sees the project on screen, so a tab parked
  // elsewhere never cleared, and with its indicators quieted its completion
  // would never have surfaced at all. Seeded on first run so loading never
  // reads as a transition.
  const lastObservedActivityRef = useRef(null);
  useEffect(() => {
    const sessionLookup = new Map(sessionStatus.map(session => [session.sessionId, session]));
    const previous = lastObservedActivityRef.current ?? { finishedSessionIds, sessionLookup };
    lastObservedActivityRef.current = { finishedSessionIds, sessionLookup };

    const landed = getLandedWaitingSessionIds({
      waitingSessionIds,
      previousFinishedSessionIds: previous.finishedSessionIds,
      finishedSessionIds,
      previousSessionLookup: previous.sessionLookup,
      sessionLookup,
    });
    if (landed.length > 0) clearWaiting(landed);
  }, [sessionStatus, finishedSessionIds, waitingSessionIds, clearWaiting]);

  return { waitingSessionIds, toggleWaiting, clearWaiting };
}
