import { describe, expect, it } from 'vitest';
import {
  TERMINAL_ACTIVITY_WINDOW_MS,
  getAggregateTerminalStatus,
  getTabTerminalStatus,
  getTerminalStatus,
} from '../terminalActivity';

describe('terminalActivity', () => {
  const now = new Date('2026-04-11T10:00:00.000Z').getTime();

  it('marks recent live output as busy', () => {
    const session = {
      alive: true,
      lastOutputAt: new Date(now - 5000).toISOString(),
    };

    expect(getTerminalStatus(session, now)).toBe('busy');
  });

  it('marks stale live output as idle', () => {
    const session = {
      alive: true,
      lastSubstantialOutputAt: new Date(now - TERMINAL_ACTIVITY_WINDOW_MS - 1).toISOString(),
      lastOutputAt: new Date(now - 1000).toISOString(),
    };

    expect(getTerminalStatus(session, now)).toBe('idle');
  });

  it('marks non-live sessions as dead', () => {
    expect(getTerminalStatus({ alive: false }, now)).toBe('dead');
  });

  it('aggregates busy over idle and dead', () => {
    const sessions = [
      { alive: true, lastOutputAt: new Date(now - 2000).toISOString() },
      { alive: true, lastOutputAt: new Date(now - TERMINAL_ACTIVITY_WINDOW_MS - 1).toISOString() },
      { alive: false },
    ];

    expect(getAggregateTerminalStatus(sessions, now)).toBe('busy');
  });

  it('aggregates all-dead tabs as dead', () => {
    expect(getAggregateTerminalStatus([{ alive: false }, { alive: false }], now)).toBe('dead');
  });

  it('derives tab status from its pane session ids', () => {
    const tab = {
      panes: [
        { sessionId: 'BookMe-1' },
        { sessionId: 'BookMe-2' },
      ],
    };
    const sessionLookup = new Map([
      ['BookMe-1', { alive: true, lastOutputAt: new Date(now - 1000).toISOString() }],
      ['BookMe-2', { alive: false }],
    ]);

    expect(getTabTerminalStatus(tab, sessionLookup, now)).toBe('busy');
  });
});
