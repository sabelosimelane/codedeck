import { describe, expect, it } from 'vitest';
import { normalizeProject, normalizeProjects } from '../project-config.js';

describe('project config normalization', () => {
  it('defaults missing shelf and waiting fields to active work-area values', () => {
    expect(normalizeProject({ name: 'Alpha', path: '/tmp/alpha' })).toEqual({
      name: 'Alpha',
      path: '/tmp/alpha',
      shelved: false,
      shelvedAt: null,
      waiting: false,
      waitingAt: null,
    });
  });

  it('preserves existing waiting metadata', () => {
    expect(normalizeProjects([{
      name: 'Beta',
      path: '/tmp/beta',
      waiting: true,
      waitingAt: '2026-05-11T10:00:00.000Z',
    }])).toEqual([{
      name: 'Beta',
      path: '/tmp/beta',
      shelved: false,
      shelvedAt: null,
      waiting: true,
      waitingAt: '2026-05-11T10:00:00.000Z',
    }]);
  });
});
