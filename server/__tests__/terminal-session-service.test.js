import { describe, expect, it } from 'vitest';
import { allocateTerminalSessionId } from '../terminal-session-service.js';

describe('allocateTerminalSessionId', () => {
  it('returns a validation error when projectName is missing', () => {
    expect(allocateTerminalSessionId({})).toEqual({
      error: 'projectName required',
      status: 400,
    });
  });

  it('allocates the next session id after the highest active, deleted, reserved, or recoverable id', () => {
    const result = allocateTerminalSessionId({
      projectName: 'marketing',
      activeSessionIds: ['marketing-1'],
      deletedSessionIds: ['marketing-2'],
      recoverableSessionIds: ['marketing-3'],
      reservedSessionIds: ['marketing-4'],
    });

    expect(result).toEqual({
      data: { sessionId: 'marketing-5' },
    });
  });

  it('ignores sibling projects with hyphen-prefixed names', () => {
    const result = allocateTerminalSessionId({
      projectName: 'alpha-suite',
      activeSessionIds: ['alpha-suite-config-9'],
      recoverableSessionIds: ['alpha-suite-3'],
    });

    expect(result).toEqual({
      data: { sessionId: 'alpha-suite-4' },
    });
  });

  it('starts numbering at 1 when no sessions exist yet', () => {
    const result = allocateTerminalSessionId({
      projectName: 'BookMe',
      activeSessionIds: [],
      deletedSessionIds: [],
      recoverableSessionIds: [],
      reservedSessionIds: [],
    });

    expect(result).toEqual({
      data: { sessionId: 'BookMe-1' },
    });
  });
});
