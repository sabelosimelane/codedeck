export function shouldResumeFromSessionHandshake(message, resumeInFlight) {
  if (resumeInFlight) return false;
  if (message?.type !== 'session' || message.existing !== true) return false;

  // Snapshot-first reattach paths reseed from tmux directly, so replay must
  // not become the user-visible history authority on those connections.
  if (typeof message.snapshotWindowLines === 'number' && message.snapshotWindowLines > 0) {
    return false;
  }

  return true;
}
