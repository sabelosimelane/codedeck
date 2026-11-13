import { describe, expect, it } from 'vitest';
import { buildRunAdoptionSessions, planTerminalAdoption } from '../terminalAdoption';

describe('buildRunAdoptionSessions', () => {
  it('activates only the first live step of a locally started run', () => {
    expect(buildRunAdoptionSessions([
      {
        id: 'local',
        steps: [
          { sessionId: 'S-0' },
          { sessionId: 'S-1' },
          { sessionId: null },
        ],
      },
      {
        id: 'remote',
        steps: [{ sessionId: 'S-9' }],
      },
    ], new Set(['local']), new Set(['S-0', 'S-1', 'S-9']))).toEqual([
      { sessionId: 'S-0', activate: true },
      { sessionId: 'S-1', activate: false },
      { sessionId: 'S-9', activate: false },
    ]);
  });

  it('skips sessions that are not alive without activating a later step', () => {
    expect(buildRunAdoptionSessions([
      { id: 'local', steps: [{ sessionId: 'dead' }, { sessionId: 'live' }] },
    ], new Set(['local']), new Set(['live']))).toEqual([
      { sessionId: 'live', activate: false },
    ]);
  });

  it('activates only the first step index of a locally started run when it is alive', () => {
    expect(buildRunAdoptionSessions([
      {
        id: 'local',
        steps: [
          { index: 0, sessionId: 'S-0' },
          { index: 1, sessionId: 'S-1' },
        ],
      },
    ], new Set(['local']), new Set(['S-0', 'S-1']))).toEqual([
      { sessionId: 'S-0', activate: true },
      { sessionId: 'S-1', activate: false },
    ]);
  });
});


describe('planTerminalAdoption', () => {
  it('adopts a session-search resume with activate true', () => {
    expect(planTerminalAdoption({
      existingSessionIds: new Set(),
      resumeSessionId: 'Demo-1',
      runSessions: [],
    })).toEqual([{ sessionId: 'Demo-1', activate: true }]);
  });

  it('skips sessions that already have a tab', () => {
    expect(planTerminalAdoption({
      existingSessionIds: new Set(['Demo-1', 'Demo-2']),
      resumeSessionId: 'Demo-1',
      runSessions: [{ sessionId: 'Demo-2', activate: true }],
    })).toEqual([]);
  });

  it('adopts open-run step sessions that are alive and missing a tab', () => {
    expect(planTerminalAdoption({
      existingSessionIds: new Set(['Demo-1']),
      resumeSessionId: null,
      runSessions: [
        { sessionId: 'Demo-1', activate: false },
        { sessionId: 'Demo-2', activate: true },
        { sessionId: 'Demo-3', activate: false },
        { sessionId: null, activate: false },
      ],
    })).toEqual([
      { sessionId: 'Demo-2', activate: true },
      { sessionId: 'Demo-3', activate: false },
    ]);
  });

  it('prefers resume activation when the same session also appears in runs', () => {
    expect(planTerminalAdoption({
      existingSessionIds: new Set(),
      resumeSessionId: 'Demo-9',
      runSessions: [{ sessionId: 'Demo-9', activate: false }],
    })).toEqual([{ sessionId: 'Demo-9', activate: true }]);
  });

  it('activates at most one session: resume wins over run activations', () => {
    expect(planTerminalAdoption({
      existingSessionIds: new Set(),
      resumeSessionId: 'Resume-1',
      runSessions: [
        { sessionId: 'Run-1', activate: true },
        { sessionId: 'Run-2', activate: true },
      ],
    })).toEqual([
      { sessionId: 'Resume-1', activate: true },
      { sessionId: 'Run-1', activate: false },
      { sessionId: 'Run-2', activate: false },
    ]);
  });

  it('keeps the first run activation and demotes later ones when there is no resume', () => {
    expect(planTerminalAdoption({
      existingSessionIds: new Set(),
      resumeSessionId: null,
      runSessions: [
        { sessionId: 'Run-1', activate: true },
        { sessionId: 'Run-2', activate: true },
      ],
    })).toEqual([
      { sessionId: 'Run-1', activate: true },
      { sessionId: 'Run-2', activate: false },
    ]);
  });
});
