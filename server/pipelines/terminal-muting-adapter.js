/** The attention tracker can only mute a session after its first status observation. */
export function setObservedTerminalMuted(attention, sessionId, muted) {
  if (typeof attention?.knows !== 'function' || typeof attention?.setMuted !== 'function') throw new TypeError('terminal muting: attention tracker is required');
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('terminal muting: sessionId must be nonempty text');
  if (typeof muted !== 'boolean') throw new TypeError('terminal muting: muted must be boolean');
  if (!attention.knows(sessionId)) return false;
  attention.setMuted(sessionId, muted);
  return true;
}
