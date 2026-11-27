import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildWorktreeGroups, sidebarSessionsForGroup } from '../../utils/worktreeGroups';
import { validRun } from '../../utils/__tests__/pipelineRunFixture';
import { usePipelineRunCounts } from '../usePipelineRunCounts';

const mocks = vi.hoisted(() => ({ listOpenRuns: vi.fn() }));
vi.mock('../../utils/pipelinesApi', async importOriginal => ({ ...await importOriginal(), ...mocks }));

const showToast = vi.fn();
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); mocks.listOpenRuns.mockReset(); showToast.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

// The hook projection feeds group.run (App.jsx -> buildWorktreeGroups), and the
// sidebar folds a run's own terminals into its single entry via
// sidebarSessionsForGroup. A retried step's prior terminal must fold too.
it.each(['/tmp/worktree', null])('folds a retried step prior terminal with worktree path %s', async priorPath => {
  const run = validRun();
  run.steps[0].sessionId = 'Alpha-2';
  run.steps[0].priorSessionIds = ['Alpha-1'];
  mocks.listOpenRuns.mockResolvedValue([run]);

  const { result } = renderHook(() => usePipelineRunCounts(showToast));
  await waitFor(() => expect(result.current.runsByProject?.get('Alpha')).toHaveLength(1));
  const [projected] = result.current.runsByProject.get('Alpha');

  const sessions = [
    { sessionId: 'Alpha-1', worktreePath: priorPath, startedAt: null },
    { sessionId: 'Alpha-2', worktreePath: '/tmp/worktree', startedAt: null },
    { sessionId: 'Alpha-3', worktreePath: null, startedAt: null },
  ];
  const groups = buildWorktreeGroups({
    project: { name: 'Alpha', path: '/tmp/home', repositories: [] },
    sessions,
    runs: [projected],
  });
  const visible = groups.flatMap(group => sidebarSessionsForGroup(group, sessions, () => 'idle'));
  expect(visible.map(session => session.sessionId)).toEqual(['Alpha-3']);
});
