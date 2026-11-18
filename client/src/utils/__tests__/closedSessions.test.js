import { describe, expect, it } from 'vitest';
import { removeSessionsFromLayout } from '../closedSessions.js';

const pane = (id, sessionId, widthFraction = 1) => ({ id, sessionId, widthFraction });
const layout = () => ({
  activeTabId: 't2',
  tabs: [
    { id: 't1', label: 'one', panes: [pane('p1', 'Demo-1')] },
    { id: 't2', label: 'two', panes: [pane('p2', 'Demo-2', 0.5), pane('p3', 'Demo-3', 0.5)] },
    { id: 't3', label: 'three', panes: [pane('p4', 'Demo-4')] },
  ],
});

describe('removing terminals the backend closed', () => {
  it('drops their panes, widens what is left of a split, and drops a tab left empty', () => {
    const next = removeSessionsFromLayout(layout(), ['Demo-2', 'Demo-4']);
    expect(next.tabs.map(tab => [tab.id, tab.panes.map(item => [item.sessionId, item.widthFraction])])).toEqual([
      ['t1', [['Demo-1', 1]]],
      ['t2', [['Demo-3', 1]]],
    ]);
    expect(next.activeTabId).toBe('t2');
  });

  it('leaves no tab active when the active one is gone', () => {
    expect(removeSessionsFromLayout(layout(), ['Demo-2', 'Demo-3']).activeTabId).toBeNull();
  });

  it('returns the same layout when nothing matches', () => {
    const before = layout();
    expect(removeSessionsFromLayout(before, ['Demo-9'])).toBe(before);
    expect(removeSessionsFromLayout(before, [])).toBe(before);
  });

  it('refuses malformed input', () => {
    expect(() => removeSessionsFromLayout({ tabs: null, activeTabId: null }, [])).toThrow('layout.tabs');
    expect(() => removeSessionsFromLayout(layout(), 'Demo-1')).toThrow('sessionIds');
    expect(() => removeSessionsFromLayout(layout(), [''])).toThrow('sessionIds');
  });
});
