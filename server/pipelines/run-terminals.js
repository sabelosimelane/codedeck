/**
 * Closing the terminals of a workflow run the owner closed.
 *
 * A run's terminals are the ones its steps used: each step's terminal and the ones it had
 * before (a step gets a new one when its terminal was closed). A terminal the owner opened
 * in the same worktree is not the run's and stays.
 *
 * Two more are left alone. A session id is given out again after a restart, so an id a step
 * recorded can name a terminal opened later somewhere else: only a terminal started in the
 * run's worktree is closed. And a terminal that another run still on screen uses is that
 * run's to keep.
 */

import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isId = value => typeof value === 'string' && value.trim() !== '';

/** The session ids a run's steps recorded; refuses a run it cannot read. */
function sessionIdsOf(run, label) {
  if (typeof run?.id !== 'string' || !UUID.test(run.id)) throw new TypeError(`${label}.id must be a UUID`);
  if (!Array.isArray(run.steps) || run.steps.length === 0) throw new TypeError(`${label}.steps must be a nonempty list`);
  const ids = new Set();
  run.steps.forEach((step, index) => {
    if (step?.sessionId !== null && !isId(step?.sessionId)) throw new TypeError(`${label}.steps[${index}].sessionId must be null or a nonempty string`);
    if (!Array.isArray(step.priorSessionIds) || !step.priorSessionIds.every(isId)) throw new TypeError(`${label}.steps[${index}].priorSessionIds must be a list of nonempty strings`);
    if (step.sessionId !== null) ids.add(step.sessionId);
    for (const prior of step.priorSessionIds) ids.add(prior);
  });
  return ids;
}

/**
 * @param {object} deps
 * @param {(sessionId: string) => boolean} deps.isOpen
 * @param {(sessionId: string, project: string) => string} deps.placeOf the folder a terminal was started in
 * @param {(sessionId: string) => Promise<void>} deps.deleteSession
 */
export function createRunTerminalCloser({ isOpen, placeOf, deleteSession, warn = console.warn } = {}) {
  for (const [name, value] of Object.entries({ isOpen, placeOf, deleteSession, warn })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  /** `otherOpenRuns`: the runs still on screen, without the one being closed. */
  return async function closeRunTerminals(run, otherOpenRuns) {
    const own = sessionIdsOf(run, 'run');
    if (!isId(run.project)) throw new TypeError('run.project must be a nonempty string');
    if (typeof run.worktreePath !== 'string' || !path.isAbsolute(run.worktreePath)) throw new TypeError('run.worktreePath must be an absolute path');
    if (!Array.isArray(otherOpenRuns)) throw new TypeError('otherOpenRuns must be a list of runs');
    const held = new Set();
    otherOpenRuns.forEach((other, index) => {
      for (const sessionId of sessionIdsOf(other, `otherOpenRuns[${index}]`)) held.add(sessionId);
      if (other.id === run.id) throw new TypeError('otherOpenRuns must not include the run being closed');
    });

    // Everything is read before anything is closed.
    const closing = [];
    for (const sessionId of [...own].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
      if (held.has(sessionId) || !isOpen(sessionId)) continue;
      const place = placeOf(sessionId, run.project);
      if (typeof place !== 'string' || !path.isAbsolute(place)) throw new TypeError(`placeOf must answer an absolute path for ${sessionId}`);
      if (place === run.worktreePath) closing.push(sessionId);
    }

    const closed = [];
    const notClosed = [];
    for (const sessionId of closing) {
      try {
        await deleteSession(sessionId);
        closed.push(sessionId);
      } catch (error) {
        notClosed.push(sessionId);
        warn(`[pipeline-run] terminal not closed run=${run.id} session=${sessionId} error=${error.message}`);
      }
    }
    return { closed, notClosed };
  };
}

/**
 * Where a terminal was started: the worktree recorded for it, or its project's own folder
 * (a terminal started there has no record; see terminal-session-worktree-start.js).
 *
 * @param {object} deps
 * @param {(sessionId: string) => { worktreePath: string } | null} deps.readRecord
 * @param {(name: string) => { path: string } | null} deps.findProject
 */
export function createTerminalPlaces({ readRecord, findProject } = {}) {
  for (const [name, value] of Object.entries({ readRecord, findProject })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }
  return function placeOf(sessionId, project) {
    if (!isId(sessionId)) throw new TypeError('sessionId must be a nonempty string');
    if (!isId(project)) throw new TypeError('project must be a nonempty string');
    const record = readRecord(sessionId);
    if (record !== null) {
      if (typeof record?.worktreePath !== 'string' || !path.isAbsolute(record.worktreePath)) throw new TypeError(`terminal ${sessionId}: its recorded worktree must be an absolute path`);
      return record.worktreePath;
    }
    const configured = findProject(project);
    if (typeof configured?.path !== 'string' || !path.isAbsolute(configured.path)) throw new TypeError(`terminal ${sessionId}: project ${project} has no absolute path`);
    return configured.path;
  };
}
