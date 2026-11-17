import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { validRun } from '../../utils/__tests__/pipelineRunFixture';
import { usePipelineRunCounts } from '../usePipelineRunCounts';
const mocks = vi.hoisted(() => ({ listOpenRuns: vi.fn() }));
vi.mock('../../utils/pipelinesApi', async importOriginal => ({ ...await importOriginal(), ...mocks }));
const showToast = vi.fn();
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); mocks.listOpenRuns.mockReset(); showToast.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('counts all projects and replaces counts when runs close', async () => {
  mocks.listOpenRuns.mockResolvedValueOnce([validRun(), validRun(), validRun('Beta')]).mockResolvedValue([]);
  const { result } = renderHook(() => usePipelineRunCounts(showToast));
  await waitFor(() => expect(result.current.get('Alpha')).toEqual({ open: 2, awaitingOwner: 0 }));
  expect(result.current.get('Beta')).toEqual({ open: 1, awaitingOwner: 0 });
  expect(result.current.runsByProject.get('Alpha')).toHaveLength(2);
  expect(result.current.runsByProject.get('Alpha')[0]).toMatchObject({ id: validRun().id, status: validRun().status, workflowName: validRun().workflowName, worktree: { path: validRun().worktree.path, branch: validRun().worktree.branch } });
  expect(mocks.listOpenRuns).toHaveBeenCalledWith();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(result.current.size).toBe(0);
});
it('does not overlap polls or update after unmount', async () => {
  let resolve;
  mocks.listOpenRuns.mockReturnValue(new Promise(r => { resolve = r; }));
  const { unmount } = renderHook(() => usePipelineRunCounts(showToast));
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(mocks.listOpenRuns).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => { resolve([]); });
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(mocks.listOpenRuns).toHaveBeenCalledTimes(1);
});
it('reports failures once until a successful poll and retains last counts', async () => {
  mocks.listOpenRuns.mockResolvedValueOnce([validRun()]).mockRejectedValue(new Error('Counts unavailable'));
  const { result } = renderHook(() => usePipelineRunCounts(showToast));
  await waitFor(() => expect(result.current.get('Alpha')).toEqual({ open: 1, awaitingOwner: 0 }));
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(showToast).toHaveBeenCalledTimes(1);
  expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Counts unavailable' });
  expect(result.current.get('Alpha')).toEqual({ open: 1, awaitingOwner: 0 });
  mocks.listOpenRuns.mockResolvedValueOnce([]);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(showToast).toHaveBeenCalledTimes(2);
});
it.each([null, {}, { project: null }, { project: '' }, { project: 42 }])('rejects an invalid project projection %j', async row => {
  mocks.listOpenRuns.mockResolvedValue([row]);
  renderHook(() => usePipelineRunCounts(showToast));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: expect.stringMatching(/project|run/) }));
});

it('counts the runs of a project that are waiting for the owner: input, pass limit, or approval', async () => {
  const asking = validRun();
  asking.id = '11111111-1111-4111-8111-111111111112';
  asking.status = 'needs_input'; asking.steps[0].status = 'needs_input';
  asking.inputRequest = { questions: '1. Which schema?', truncated: false }; asking.actions.answer = true;
  const paused = validRun();
  paused.id = '11111111-1111-4111-8111-111111111113';
  paused.status = 'limit_paused'; paused.steps[0].status = 'limit_reached'; paused.actions.continue = true;
  const approval = validRun();
  approval.id = '11111111-1111-4111-8111-111111111114';
  approval.status = 'awaiting_approval'; approval.steps[0].status = 'awaiting_approval';
  approval.approvalRequest = { stepIndex: 0, stepName: approval.steps[0].name, note: null };
  approval.actions.approve = true; approval.actions.sendBack = true;
  mocks.listOpenRuns.mockResolvedValue([validRun(), asking, paused, approval, validRun('Beta')]);
  const { result } = renderHook(() => usePipelineRunCounts(showToast));
  await waitFor(() => expect(result.current.get('Alpha')).toEqual({ open: 4, awaitingOwner: 3 }));
  expect(result.current.get('Beta')).toEqual({ open: 1, awaitingOwner: 0 });
});
