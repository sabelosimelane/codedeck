import { describe, expect, it } from 'vitest';
import {
  getTabWaitingKey,
  isTabWaiting,
  orderTabsForDisplay,
  getLandedWaitingSessionIds,
  getQuietStatusSessionIds,
  getParkedPaneSessionIds,
  countWaitingSessionsForProject,
} from '../terminalWaiting';

const tab = (id, ...sessionIds) => ({ id, panes: sessionIds.map(sessionId => ({ id: `${sessionId}-pane`, sessionId })) });

describe('tab waiting identity', () => {
  it('keys a tab on its first pane, matching how tab titles work', () => {
    expect(getTabWaitingKey(tab('t1', 'Demo-1', 'Demo-2'))).toBe('Demo-1');
  });

  it('has no key for a tab with no panes', () => {
    expect(getTabWaitingKey({ id: 't1', panes: [] })).toBeNull();
    expect(getTabWaitingKey(null)).toBeNull();
  });

  it('reports waiting only when the tab key is marked', () => {
    const waiting = new Set(['Demo-1']);
    expect(isTabWaiting(tab('t1', 'Demo-1'), waiting)).toBe(true);
    expect(isTabWaiting(tab('t2', 'Demo-2'), waiting)).toBe(false);
    expect(isTabWaiting(tab('t3', 'Demo-1'), new Set())).toBe(false);
    expect(isTabWaiting(null, waiting)).toBe(false);
  });

  it('does not treat a non-first pane mark as making the tab waiting', () => {
    expect(isTabWaiting(tab('t1', 'Demo-1', 'Demo-2'), new Set(['Demo-2']))).toBe(false);
  });
});

describe('tab display order', () => {
  it('groups waiting tabs to the left, keeping relative order within each group', () => {
    const tabs = [tab('t1', 'Demo-1'), tab('t2', 'Demo-2'), tab('t3', 'Demo-3'), tab('t4', 'Demo-4')];
    const ordered = orderTabsForDisplay(tabs, new Set(['Demo-2', 'Demo-4']));
    expect(ordered.map(t => t.id)).toEqual(['t2', 't4', 't1', 't3']);
  });

  it('leaves order untouched when nothing is waiting', () => {
    const tabs = [tab('t1', 'Demo-1'), tab('t2', 'Demo-2')];
    expect(orderTabsForDisplay(tabs, new Set()).map(t => t.id)).toEqual(['t1', 't2']);
  });

  it('never mutates the tabs it is given', () => {
    const tabs = [tab('t1', 'Demo-1'), tab('t2', 'Demo-2')];
    orderTabsForDisplay(tabs, new Set(['Demo-2']));
    expect(tabs.map(t => t.id)).toEqual(['t1', 't2']);
  });

  it('tolerates an empty tab list', () => {
    expect(orderTabsForDisplay([], new Set(['Demo-1']))).toEqual([]);
    expect(orderTabsForDisplay(undefined, new Set())).toEqual([]);
  });
});

describe('auto-clearing waiting when the work lands', () => {
  const lookup = entries => new Map(entries.map(e => [e.sessionId, e]));
  const running = sessionId => ({ sessionId, alive: true, executionStatus: 'running' });
  const idle = sessionId => ({ sessionId, alive: true, executionStatus: 'idle' });
  const dead = sessionId => ({ sessionId, alive: false, executionStatus: 'dead' });
  const observe = overrides => ({
    waitingSessionIds: new Set(['Demo-1']),
    previousFinishedSessionIds: new Set(),
    finishedSessionIds: new Set(),
    previousSessionLookup: lookup([running('Demo-1')]),
    sessionLookup: lookup([running('Demo-1')]),
    ...overrides,
  });

  it('clears a parked session that finishes while it is parked', () => {
    expect(getLandedWaitingSessionIds(observe({
      waitingSessionIds: new Set(['Demo-1', 'Other-1']),
      finishedSessionIds: new Set(['Demo-1']),
      previousSessionLookup: lookup([running('Demo-1'), running('Other-1')]),
      sessionLookup: lookup([idle('Demo-1'), running('Other-1')]),
    }))).toEqual(['Demo-1']);
  });

  it('watches every parked session, not only those of the project on screen', () => {
    expect(getLandedWaitingSessionIds(observe({
      waitingSessionIds: new Set(['Alpha-1', 'Beta-4']),
      finishedSessionIds: new Set(['Beta-4']),
      previousSessionLookup: lookup([running('Alpha-1'), running('Beta-4')]),
      sessionLookup: lookup([running('Alpha-1'), idle('Beta-4')]),
    }))).toEqual(['Beta-4']);
  });

  it('keeps a mark whose finish predates it — only new completions count', () => {
    expect(getLandedWaitingSessionIds(observe({
      previousFinishedSessionIds: new Set(['Demo-1']),
      finishedSessionIds: new Set(['Demo-1']),
      previousSessionLookup: lookup([idle('Demo-1')]),
      sessionLookup: lookup([idle('Demo-1')]),
    }))).toEqual([]);
  });

  it('keeps a parked session quiet while its work is still running', () => {
    expect(getLandedWaitingSessionIds(observe({}))).toEqual([]);
  });

  it('clears a parked session that dies while it is parked', () => {
    expect(getLandedWaitingSessionIds(observe({
      sessionLookup: lookup([dead('Demo-1')]),
    }))).toEqual(['Demo-1']);
  });

  it('keeps a mark on a session that was already dead when it was parked', () => {
    expect(getLandedWaitingSessionIds(observe({
      previousSessionLookup: lookup([dead('Demo-1')]),
      sessionLookup: lookup([dead('Demo-1')]),
    }))).toEqual([]);
  });

  it('leaves a mark alone while its session is not yet known', () => {
    expect(getLandedWaitingSessionIds(observe({
      previousSessionLookup: new Map(),
      sessionLookup: new Map(),
    }))).toEqual([]);
  });

  it('ignores sessions that were never parked', () => {
    expect(getLandedWaitingSessionIds(observe({
      waitingSessionIds: new Set(),
      finishedSessionIds: new Set(['Demo-1']),
      sessionLookup: lookup([idle('Demo-1')]),
    }))).toEqual([]);
  });
});

describe('quieting status indicators for parked work', () => {
  it('quiets both muted and parked sessions without altering either set', () => {
    const muted = new Set(['Demo-1']);
    const parked = new Set(['Demo-2']);
    const quiet = getQuietStatusSessionIds(muted, parked);
    expect([...quiet].sort()).toEqual(['Demo-1', 'Demo-2']);
    expect([...muted]).toEqual(['Demo-1']);
    expect([...parked]).toEqual(['Demo-2']);
  });

  it('treats missing sets as empty', () => {
    expect([...getQuietStatusSessionIds(undefined, new Set(['Demo-2']))]).toEqual(['Demo-2']);
    expect([...getQuietStatusSessionIds(new Set(['Demo-1']), undefined)]).toEqual(['Demo-1']);
  });

  it('parks every pane of a parked split tab, and nothing of an unparked one', () => {
    const tabs = [tab('t1', 'Demo-1', 'Demo-2'), tab('t2', 'Demo-3')];
    expect([...getParkedPaneSessionIds(tabs, new Set(['Demo-1']))].sort()).toEqual(['Demo-1', 'Demo-2']);
    expect([...getParkedPaneSessionIds(tabs, new Set())]).toEqual([]);
  });
});

describe('waiting counts per project', () => {
  it('counts marked sessions belonging to the project', () => {
    const waiting = new Set(['Demo-1', 'Demo-3', 'Other-1']);
    expect(countWaitingSessionsForProject('Demo', waiting)).toBe(2);
    expect(countWaitingSessionsForProject('Other', waiting)).toBe(1);
    expect(countWaitingSessionsForProject('Missing', waiting)).toBe(0);
  });

  it('does not count a project whose name is a prefix of another', () => {
    expect(countWaitingSessionsForProject('Demo', new Set(['Demo-api-1']))).toBe(0);
  });

  it('returns zero for a missing project name or empty mark set', () => {
    expect(countWaitingSessionsForProject('', new Set(['Demo-1']))).toBe(0);
    expect(countWaitingSessionsForProject('Demo', new Set())).toBe(0);
  });
});
