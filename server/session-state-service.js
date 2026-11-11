import { attentionStatus } from './session-attention.js';
// One place that changes a session's shared attention state — waiting, muted,
// acknowledged — for both the desktop and the phone, so their rules cannot drift.

export class SessionStateError extends Error {
  constructor(message, status, errors = []) { super(message); this.status = status; this.errors = errors; }
}


const FIELDS = ['waiting', 'muted', 'acknowledged'];
const validSessionId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);

export function createSessionStateService({ attention, waitingStore, sessionExists, now }) {
  if (typeof attention?.state !== 'function' || typeof attention?.setMuted !== 'function') throw new Error('session state: attention tracker is required');
  if (typeof waitingStore?.mark !== 'function' || typeof waitingStore?.clear !== 'function') throw new Error('session state: waitingStore is required');
  if (typeof sessionExists !== 'function') throw new Error('session state: sessionExists must be a function');
  if (typeof now !== 'function') throw new Error('session state: now must be a clock function');

  function requireId(sessionId) {
    if (!validSessionId(sessionId)) throw new SessionStateError('One or more fields failed validation.', 400, [{ field: 'sessionId', message: 'Use a nonempty session identity of at most 256 characters' }]);
  }
  function describe(sessionId) {
    requireId(sessionId);
    const state = attention.state(sessionId);
    return {
      sessionId,
      finished: state?.finished ?? false,
      muted: state?.muted ?? false,
      waiting: waitingStore.get(sessionId) !== null,
      // null until a status reading exists: nothing is known about its activity yet.
      lastActivityAt: state?.lastActivityAt ?? null,
    };
  }
  function validate(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return [{ field: 'body', message: 'Send a JSON object with waiting, muted or acknowledged' }];
    const errors = [];
    for (const key of Object.keys(patch)) if (!FIELDS.includes(key)) errors.push({ field: key, message: `Unknown field; use ${FIELDS.join(', ')}` });
    if (patch.waiting !== undefined && typeof patch.waiting !== 'boolean') errors.push({ field: 'waiting', message: 'Use true to park the session or false to stop waiting' });
    if (patch.muted !== undefined && typeof patch.muted !== 'boolean') errors.push({ field: 'muted', message: 'Use true to mute status colours or false to show them' });
    if (patch.acknowledged !== undefined && patch.acknowledged !== true) errors.push({ field: 'acknowledged', message: 'Use true to mark finished work as reviewed' });
    if (!errors.length && !FIELDS.some(key => patch[key] !== undefined)) errors.push({ field: 'body', message: `Send at least one of ${FIELDS.join(', ')}` });
    return errors;
  }
  const timeOf = value => (typeof value === 'string' ? Date.parse(value) : NaN);
  /**
   * Feed one desktop status row to the tracker and return it with the shared
   * flags, so the desktop reads finished/muted/waiting from the backend instead
   * of keeping its own copy.
   */
  function annotate(row) {
    requireId(row?.sessionId);
    const status = attentionStatus(row);
    if (attention.knows(row.sessionId)) attention.observe({ sessionId: row.sessionId, status });
    else {
      const hint = timeOf(row.lastSubstantialOutputAt ?? row.lastOutputAt ?? row.startedAt);
      // No usable time means nothing to anchor "last activity" to yet; tracking starts on a later reading.
      if (Number.isSafeInteger(hint) && hint >= 0) attention.observe({ sessionId: row.sessionId, status, activityHint: hint });
    }
    const state = describe(row.sessionId);
    return { ...row, finished: state.finished, statusMuted: state.muted, waiting: state.waiting };
  }
  return {
    describe,
    annotate,
    apply(sessionId, patch) {
      requireId(sessionId);
      const errors = validate(patch);
      if (errors.length) throw new SessionStateError('One or more fields failed validation.', 400, errors);
      if (!sessionExists(sessionId)) throw new SessionStateError('Terminal session not found', 404);
      // Muting and acknowledging act on observed status; a session seconds old has none yet.
      if ((patch.muted !== undefined || patch.acknowledged !== undefined) && !attention.knows(sessionId)) {
        throw new SessionStateError('Session status has not been observed yet. Try again in a few seconds.', 409);
      }
      if (patch.acknowledged === true) attention.acknowledge(sessionId);
      if (patch.muted !== undefined) attention.setMuted(sessionId, patch.muted);
      if (patch.waiting === true) waitingStore.mark(sessionId, new Date(now()).toISOString());
      if (patch.waiting === false) waitingStore.clear(sessionId);
      return describe(sessionId);
    },
  };
}
