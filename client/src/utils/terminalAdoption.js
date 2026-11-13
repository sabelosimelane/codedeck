/**
 * Maps open-run steps to adoption intents. Only the first step (index 0) of a
 * run started in this browser activates when that session is alive; later
 * steps always open in the background.
 */
export function buildRunAdoptionSessions(runs, locallyStartedRunIds, aliveSessionIds = null) {
  const localIds = locallyStartedRunIds instanceof Set
    ? locallyStartedRunIds
    : new Set(locallyStartedRunIds || []);
  const alive = aliveSessionIds == null
    ? null
    : (aliveSessionIds instanceof Set ? aliveSessionIds : new Set(aliveSessionIds));
  const result = [];
  for (const run of runs || []) {
    const activateLocal = localIds.has(run.id);
    const steps = run.steps || [];
    for (let stepOffset = 0; stepOffset < steps.length; stepOffset += 1) {
      const step = steps[stepOffset];
      const sessionId = step?.sessionId;
      if (!sessionId) continue;
      if (alive && !alive.has(sessionId)) continue;
      const isFirstStep = typeof step.index === 'number' ? step.index === 0 : stepOffset === 0;
      result.push({
        sessionId,
        activate: activateLocal && isFirstStep,
      });
    }
  }
  return result;
}

/**
 * Pure planner: which backend sessions need a local tab, and which one (if any)
 * should become active. Resume from session search always activates; for open
 * runs only the first flagged session activates so later steps open in the
 * background.
 */
export function planTerminalAdoption({ existingSessionIds, resumeSessionId, runSessions }) {
  const existing = existingSessionIds instanceof Set ? existingSessionIds : new Set(existingSessionIds || []);
  const planned = new Map();

  if (resumeSessionId && !existing.has(resumeSessionId)) {
    planned.set(resumeSessionId, { sessionId: resumeSessionId, activate: true });
  }

  for (const entry of runSessions || []) {
    const sessionId = entry?.sessionId;
    if (!sessionId || existing.has(sessionId)) continue;
    const previous = planned.get(sessionId);
    if (previous) {
      previous.activate = previous.activate || entry.activate === true;
      continue;
    }
    planned.set(sessionId, { sessionId, activate: entry.activate === true });
  }

  const items = [...planned.values()];
  let activated = false;
  for (const item of items) {
    if (!item.activate) continue;
    if (activated) {
      item.activate = false;
      continue;
    }
    activated = true;
  }
  return items;
}
