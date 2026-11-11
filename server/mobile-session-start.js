import { MobileError } from './mobile-store.js';
import { normalizeProjects } from './project-config.js';

// Same initial geometry the desktop uses before its first resize; the phone
// resizes the pane as soon as it attaches.
const INITIAL_COLS = 120;
const INITIAL_ROWS = 32;

/**
 * Start a terminal from the phone. The session is created detached on the
 * project's host before the phone attaches, so it is an ordinary durable
 * session that the desktop also discovers. A shelved project is restored
 * exactly as the desktop's unshelve does, but only once its session exists.
 */
export function createMobileSessionStarter({ loadProjects, saveProjects, reserveSessionId, releaseReservation, resolveHostRuntime, localRuntime, store, now }) {
  // Wiring faults surface at startup, naming the missing dependency.
  for (const [field, value] of Object.entries({ loadProjects, saveProjects, reserveSessionId, releaseReservation, resolveHostRuntime, now })) {
    if (typeof value !== 'function') throw new Error(`Session starter requires ${field} to be a function`);
  }
  if (typeof localRuntime?.createDetachedSession !== 'function' || typeof localRuntime?.getSessionIncarnationAsync !== 'function') throw new Error('Session starter requires localRuntime with detached session support');
  if (typeof store?.adoptIncarnation !== 'function') throw new Error('Session starter requires store with adoptIncarnation');

  async function startNow(projectId) {
    const projects = normalizeProjects(loadProjects());
    const index = projects.findIndex(project => project.name === projectId);
    if (index === -1) throw new MobileError('Project not found', 404);
    const project = projects[index];
    if (typeof project.path !== 'string' || project.path.trim().length === 0) throw new Error(`Stored project ${project.name} has no path`);
    if (typeof project.shelved !== 'boolean') throw new Error(`Stored project ${project.name} has a non-boolean shelved flag`);

    const reservation = await reserveSessionId(project.name);
    const sessionId = reservation?.sessionId;
    if (typeof sessionId !== 'string' || !new RegExp(`^${project.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(sessionId)) {
      throw new Error(`Reserved sessionId does not belong to project ${project.name}`);
    }

    const route = resolveHostRuntime(sessionId);
    const createdAt = now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Session starter clock must return a nonnegative integer');
    const geometry = { cwd: project.path, cols: INITIAL_COLS, rows: INITIAL_ROWS, sessionId };
    let incarnationId;
    try {
      if (route) await route.hostRuntime.createDetachedSessionAsync(geometry);
      else localRuntime.createDetachedSession(geometry);
      const runtimeIncarnation = await (route ? route.hostRuntime : localRuntime).getSessionIncarnationAsync(sessionId);
      incarnationId = store.adoptIncarnation(sessionId, runtimeIncarnation);
    } finally {
      // Once tmux holds the session, its id is taken; on failure the id is free again.
      releaseReservation(sessionId);
    }

    if (project.shelved) {
      projects[index] = { ...project, shelved: false, shelvedAt: null, waiting: false, waitingAt: null };
      saveProjects(projects);
    }

    return { id: sessionId, incarnationId, projectId: project.name, title: sessionId, status: 'idle', live: true, cwd: project.path, host: route?.host ?? 'local', runtimeType: 'tmux',
      // Brand new: nothing finished, nothing muted or parked, and its activity is its creation.
      finished: false, muted: false, waiting: false, needsInput: false, lastActivityAt: createdAt };
  }

  // Allocation lists hosts asynchronously, so starts run one at a time: two
  // quick taps must never be handed the same `${project}-N`.
  let queue = Promise.resolve();
  return {
    start(projectId) {
      const run = queue.then(() => startNow(projectId));
      // The chain only orders work; each caller receives its own outcome via `run`.
      queue = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
