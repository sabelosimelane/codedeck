import { describe, expect, it, vi } from 'vitest';
import { createRunTerminalCloser, createTerminalPlaces } from '../pipelines/run-terminals.js';

const WORKTREE = '/tmp/git/worktrees/tag-pings/frontend';
const MAIN = '/tmp/git/demo';
const step = (sessionId, priorSessionIds = []) => ({ sessionId, priorSessionIds });
const run = (overrides = {}) => ({
  id: '5a000001-0000-4000-8000-000000000000',
  project: 'Demo',
  worktreePath: WORKTREE,
  // Setup in its own terminal, two steps that share an agent's terminal, one that never started.
  steps: [step('Demo-11'), step('Demo-12'), step('Demo-12'), step('Demo-15', ['Demo-13']), step(null)],
  ...overrides,
});
const otherRun = (steps, id = '5a000002-0000-4000-8000-000000000000') => ({ id, project: 'Demo', worktreePath: WORKTREE, steps });

function setup({
  open = ['Demo-7', 'Demo-11', 'Demo-12', 'Demo-13', 'Demo-15'],
  places = { 'Demo-7': WORKTREE, 'Demo-11': WORKTREE, 'Demo-12': WORKTREE, 'Demo-13': WORKTREE, 'Demo-15': WORKTREE },
  failing = [],
} = {}) {
  const deleteSession = vi.fn(async id => { if (failing.includes(id)) throw new Error('tmux refused'); });
  const warn = vi.fn();
  // A terminal with no place of its own was started in the project's own folder.
  const placeOf = vi.fn(sessionId => places[sessionId] ?? MAIN);
  const close = createRunTerminalCloser({ isOpen: id => open.includes(id), placeOf, deleteSession, warn });
  return { close, deleteSession, warn, placeOf };
}

describe('closing the terminals of a run the owner closed', () => {
  it('closes the open terminals the run\'s steps used, each once, and no terminal the owner opened in the same worktree', async () => {
    const { close, deleteSession } = setup();
    // Demo-7 is a terminal the owner opened by hand in the task: open, in the worktree, never a step's.
    expect(await close(run(), [])).toEqual({ closed: ['Demo-11', 'Demo-12', 'Demo-13', 'Demo-15'], notClosed: [] });
    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual(['Demo-11', 'Demo-12', 'Demo-13', 'Demo-15']);
  });

  it('skips a terminal that is dead or that the owner already closed', async () => {
    const { close, deleteSession } = setup({ open: ['Demo-7', 'Demo-12'] });
    expect(await close(run(), [])).toEqual({ closed: ['Demo-12'], notClosed: [] });
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it('leaves a terminal that is no longer in the run\'s worktree: its id was given to another terminal', async () => {
    // Demo-15 was closed and, after a restart, the id went to a terminal in Main.
    const { close, deleteSession, placeOf } = setup({ places: { 'Demo-11': WORKTREE, 'Demo-12': WORKTREE, 'Demo-13': WORKTREE, 'Demo-15': MAIN } });
    expect(await close(run(), [])).toEqual({ closed: ['Demo-11', 'Demo-12', 'Demo-13'], notClosed: [] });
    expect(deleteSession.mock.calls.map(([id]) => id)).not.toContain('Demo-15');
    expect(placeOf).toHaveBeenCalledWith('Demo-15', 'Demo');
  });

  it('closes the terminals of a run in Main, which are in the project\'s own folder', async () => {
    const { close } = setup({ places: {} });
    expect(await close(run({ worktreePath: MAIN }), [])).toEqual({ closed: ['Demo-11', 'Demo-12', 'Demo-13', 'Demo-15'], notClosed: [] });
  });

  it('leaves a terminal that another run still on screen uses', async () => {
    const { close, deleteSession } = setup();
    const result = await close(run(), [otherRun([step('Demo-12'), step('Demo-20', ['Demo-13'])])]);
    expect(result).toEqual({ closed: ['Demo-11', 'Demo-15'], notClosed: [] });
    expect(deleteSession.mock.calls.map(([id]) => id)).toEqual(['Demo-11', 'Demo-15']);
  });

  it('reports a terminal that could not be closed and still closes the rest', async () => {
    const { close, warn } = setup({ failing: ['Demo-12'] });
    expect(await close(run(), [])).toEqual({ closed: ['Demo-11', 'Demo-13', 'Demo-15'], notClosed: ['Demo-12'] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Demo-12'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tmux refused'));
  });

  it('closes nothing for a run whose steps never had a terminal', async () => {
    const { close, deleteSession } = setup();
    expect(await close(run({ steps: [step(null), step(null)] }), [])).toEqual({ closed: [], notClosed: [] });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('requires its dependencies', () => {
    const deps = { isOpen: () => true, placeOf: () => WORKTREE, deleteSession: async () => {}, warn: () => {} };
    for (const name of Object.keys(deps)) {
      expect(() => createRunTerminalCloser({ ...deps, [name]: 'no' })).toThrow(`${name} must be a function`);
    }
    expect(() => createRunTerminalCloser()).toThrow('isOpen must be a function');
  });

  it('refuses a run with a field it cannot read', async () => {
    const { close, deleteSession } = setup();
    await expect(close(run({ id: 'x' }), [])).rejects.toThrow('run.id must be a UUID');
    await expect(close(run({ project: ' ' }), [])).rejects.toThrow('run.project must be a nonempty string');
    await expect(close(run({ worktreePath: 'relative/path' }), [])).rejects.toThrow('run.worktreePath must be an absolute path');
    await expect(close(run({ steps: [] }), [])).rejects.toThrow('run.steps must be a nonempty list');
    await expect(close(run({ steps: [{ sessionId: 7, priorSessionIds: [] }] }), [])).rejects.toThrow('run.steps[0].sessionId must be null or a nonempty string');
    await expect(close(run({ steps: [{ sessionId: null }] }), [])).rejects.toThrow('run.steps[0].priorSessionIds must be a list of nonempty strings');
    await expect(close(run({ steps: [step('Demo-11', [''])] }), [])).rejects.toThrow('run.steps[0].priorSessionIds must be a list of nonempty strings');
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('refuses other runs it cannot read, and the run itself among them', async () => {
    const { close, deleteSession } = setup();
    await expect(close(run())).rejects.toThrow('otherOpenRuns must be a list of runs');
    await expect(close(run(), [run()])).rejects.toThrow('otherOpenRuns must not include the run being closed');
    await expect(close(run(), [otherRun([step('Demo-12')], 'nope')])).rejects.toThrow('otherOpenRuns[0].id must be a UUID');
    await expect(close(run(), [otherRun([{ sessionId: 1, priorSessionIds: [] }])])).rejects.toThrow('otherOpenRuns[0].steps[0].sessionId must be null or a nonempty string');
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('refuses a place that is not an absolute path, before closing anything', async () => {
    const deleteSession = vi.fn(async () => {});
    const close = createRunTerminalCloser({ isOpen: () => true, placeOf: id => (id === 'Demo-15' ? null : WORKTREE), deleteSession, warn: () => {} });
    await expect(close(run(), [])).rejects.toThrow('placeOf must answer an absolute path for Demo-15');
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it('refuses a relative place', async () => {
    const deleteSession = vi.fn(async () => {});
    const close = createRunTerminalCloser({ isOpen: () => true, placeOf: () => 'somewhere', deleteSession, warn: () => {} });
    await expect(close(run(), [])).rejects.toThrow('placeOf must answer an absolute path for Demo-11');
    expect(deleteSession).not.toHaveBeenCalled();
  });
});

describe('where a terminal was started', () => {
  const records = { 'Demo-12': { sessionId: 'Demo-12', project: 'Demo', worktreePath: WORKTREE, createdAt: '2026-11-19T09:42:23.802Z' } };
  const projects = { Demo: { name: 'Demo', path: MAIN } };
  const places = (overrides = {}) => createTerminalPlaces({ readRecord: id => records[id] ?? null, findProject: name => projects[name] ?? null, ...overrides });

  it('is the worktree recorded for it', () => {
    expect(places()('Demo-12', 'Demo')).toBe(WORKTREE);
  });

  it('is the project\'s own folder for a terminal with no recorded worktree', () => {
    expect(places()('Demo-3', 'Demo')).toBe(MAIN);
  });

  it('refuses a terminal of a project that no longer exists', () => {
    expect(() => places()('Gone-3', 'Gone')).toThrow('terminal Gone-3: project Gone has no absolute path');
    expect(() => places({ findProject: () => ({ name: 'Demo', path: 'relative' }) })('Demo-3', 'Demo')).toThrow('terminal Demo-3: project Demo has no absolute path');
  });

  it('refuses a record it cannot read', () => {
    expect(() => places({ readRecord: () => ({ worktreePath: 'relative' }) })('Demo-12', 'Demo')).toThrow('terminal Demo-12: its recorded worktree must be an absolute path');
    expect(() => places({ readRecord: () => undefined })('Demo-12', 'Demo')).toThrow('terminal Demo-12: its recorded worktree must be an absolute path');
  });

  it('requires its dependencies and what it is asked about', () => {
    expect(() => createTerminalPlaces({ findProject: () => null })).toThrow('readRecord must be a function');
    expect(() => createTerminalPlaces({ readRecord: () => null })).toThrow('findProject must be a function');
    expect(() => places()('', 'Demo')).toThrow('sessionId must be a nonempty string');
    expect(() => places()('Demo-3', ' ')).toThrow('project must be a nonempty string');
  });
});
