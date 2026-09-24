import { describe, expect, it } from 'vitest';
import {
  getTabWaitingKey,
  isTabWaiting,
  orderTabsForDisplay,
  getWaitingKeysToAutoClear,
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

  it('clears a waiting tab when one of its panes finishes while it is parked', () => {
    const cleared = getWaitingKeysToAutoClear({
      tabs: [tab('t1', 'Demo-1', 'Demo-2'), tab('t2', 'Demo-3')],
      waitingSessionIds: new Set(['Demo-1', 'Demo-3']),
      previousFinishedSessionIds: new Set(),
      finishedSessionIds: new Set(['Demo-2']),
      previousSessionLookup: lookup([running('Demo-1'), running('Demo-2'), running('Demo-3')]),
      sessionLookup: lookup([running('Demo-1'), idle('Demo-2'), running('Demo-3')]),
    });
    expect(cleared).toEqual(['Demo-1']);
  });

  it('keeps a mark whose finish predates it — only new completions count', () => {
    const cleared = getWaitingKeysToAutoClear({
      tabs: [tab('t1', 'Demo-1')],
      waitingSessionIds: new Set(['Demo-1']),
      previousFinishedSessionIds: new Set(['Demo-1']),
      finishedSessionIds: new Set(['Demo-1']),
      previousSessionLookup: lookup([idle('Demo-1')]),
      sessionLookup: lookup([idle('Demo-1')]),
    });
    expect(cleared).toEqual([]);
  });

  it('keeps a waiting tab quiet while its work is still running', () => {
    const cleared = getWaitingKeysToAutoClear({
      tabs: [tab('t1', 'Demo-1')],
      waitingSessionIds: new Set(['Demo-1']),
      previousFinishedSessionIds: new Set(),
      finishedSessionIds: new Set(),
      previousSessionLookup: lookup([running('Demo-1')]),
      sessionLookup: lookup([running('Demo-1')]),
    });
    expect(cleared).toEqual([]);
  });

  it('clears a waiting tab whose session dies while it is parked', () => {
    const cleared = getWaitingKeysToAutoClear({
      tabs: [tab('t1', 'Demo-1')],
      waitingSessionIds: new Set(['Demo-1']),
      previousFinishedSessionIds: new Set(),
      finishedSessionIds: new Set(),
      previousSessionLookup: lookup([running('Demo-1')]),
      sessionLookup: lookup([dead('Demo-1')]),
    });
    expect(cleared).toEqual(['Demo-1']);
  });

  it('keeps a mark on a session that was already dead when it was parked', () => {
    const cleared = getWaitingKeysToAutoClear({
      tabs: [tab('t1', 'Demo-1')],
      waitingSessionIds: new Set(['Demo-1']),
      previousFinishedSessionIds: new Set(),
      finishedSessionIds: new Set(),
      previousSessionLookup: lookup([dead('Demo-1')]),
      sessionLookup: lookup([dead('Demo-1')]),
    });
    expect(cleared).toEqual([]);
  });

  it('leaves a waiting mark alone while its session is not yet known', () => {
    const cleared = getWaitingKeysToAutoClear({
      tabs: [tab('t1', 'Demo-1')],
      waitingSessionIds: new Set(['Demo-1']),
      previousFinishedSessionIds: new Set(),
      finishedSessionIds: new Set(),
      previousSessionLookup: new Map(),
      sessionLookup: new Map(),
    });
    expect(cleared).toEqual([]);
  });

  it('ignores tabs that were never marked waiting', () => {
    const cleared = getWaitingKeysToAutoClear({
      tabs: [tab('t1', 'Demo-1')],
      waitingSessionIds: new Set(),
      previousFinishedSessionIds: new Set(),
      finishedSessionIds: new Set(['Demo-1']),
      previousSessionLookup: lookup([running('Demo-1')]),
      sessionLookup: lookup([idle('Demo-1')]),
    });
    expect(cleared).toEqual([]);
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
