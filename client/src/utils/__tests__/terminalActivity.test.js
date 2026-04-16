import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS,
  TERMINAL_ACTIVITY_WINDOW_MS,
  TERMINAL_COMPLETION_NOTIFICATION_MS,
  findProjectForSession,
  getAggregateTerminalStatus,
  getTerminalCompletionNotification,
  resolveTerminalCompletionNotificationMs,
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

  it('returns completion notification payload for long-running busy terminals that go idle', () => {
    const session = {
      sessionId: 'BookMe-1',
      cwd: '/tmp/bookme',
      alive: true,
      lastOutputAt: new Date(now - TERMINAL_ACTIVITY_WINDOW_MS - 1000).toISOString(),
      lastOutputLine: 'Tests passed',
    };

    expect(getTerminalCompletionNotification(session, {
      activeProjects: [{ name: 'BookMe', path: '/tmp/bookme' }],
      mutedProjects: [],
      prevStatus: 'busy',
      busyStartedAt: now - TERMINAL_COMPLETION_NOTIFICATION_MS - 1,
      now,
    })).toEqual({
      title: 'CodeDeck — BookMe-1 finished',
      body: 'Tests passed',
      projectName: 'BookMe',
    });
  });

  it('skips completion notification for muted projects', () => {
    const session = {
      sessionId: 'BookMe-1',
      cwd: '/tmp/bookme',
      alive: true,
      lastOutputAt: new Date(now - TERMINAL_ACTIVITY_WINDOW_MS - 1000).toISOString(),
    };

    expect(getTerminalCompletionNotification(session, {
      activeProjects: [{ name: 'BookMe', path: '/tmp/bookme' }],
      mutedProjects: ['BookMe'],
      prevStatus: 'busy',
      busyStartedAt: now - TERMINAL_COMPLETION_NOTIFICATION_MS - 1,
      now,
    })).toBe(null);
  });

  it('skips completion notification for short tasks', () => {
    const session = {
      sessionId: 'BookMe-1',
      cwd: '/tmp/bookme',
      alive: false,
      lastOutputAt: new Date(now - 1000).toISOString(),
    };

    expect(getTerminalCompletionNotification(session, {
      activeProjects: [{ name: 'BookMe', path: '/tmp/bookme' }],
      mutedProjects: [],
      prevStatus: 'busy',
      busyStartedAt: now - TERMINAL_COMPLETION_NOTIFICATION_MS + 1,
      now,
    })).toBe(null);
  });

  it('supports a configured finish cooldown override', () => {
    const session = {
      sessionId: 'BookMe-1',
      cwd: '/tmp/bookme',
      alive: true,
      lastOutputAt: new Date(now - TERMINAL_ACTIVITY_WINDOW_MS - 1000).toISOString(),
    };

    expect(getTerminalCompletionNotification(session, {
      activeProjects: [{ name: 'BookMe', path: '/tmp/bookme' }],
      mutedProjects: [],
      prevStatus: 'busy',
      busyStartedAt: now - 10_000,
      cooldownMs: 5_000,
      now,
    })).toEqual(expect.objectContaining({
      title: 'CodeDeck — BookMe-1 finished',
    }));
  });

  it('does not match a sibling project whose name shares a hyphenated prefix', () => {
    const session = {
      sessionId: 'alpha-suite-config-1',
      cwd: '/tmp/alpha-suite/alpha-suite-config',
      alive: true,
    };

    expect(findProjectForSession(session, [
      { name: 'alpha-suite', path: '/tmp/alpha-suite' },
      { name: 'alpha-suite-config', path: '/tmp/alpha-suite/alpha-suite-config' },
    ])).toEqual({
      name: 'alpha-suite-config',
      path: '/tmp/alpha-suite/alpha-suite-config',
    });
  });

  it('normalizes invalid cooldown settings back to the default', () => {
    expect(resolveTerminalCompletionNotificationMs(undefined)).toBe(DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS);
    expect(resolveTerminalCompletionNotificationMs('')).toBe(DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS);
    expect(resolveTerminalCompletionNotificationMs('abc')).toBe(DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS);
    expect(resolveTerminalCompletionNotificationMs(0)).toBe(DEFAULT_TERMINAL_COMPLETION_NOTIFICATION_MS);
  });
});
