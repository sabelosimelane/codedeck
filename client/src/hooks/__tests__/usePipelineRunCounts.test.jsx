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
it('counts interrupted and failed runs as awaiting the owner, and leaves a finished run out of the count', async () => {
  const interrupted = validRun(); interrupted.status = 'interrupted'; interrupted.steps[0].status = 'interrupted'; interrupted.actions.resume = true;
  const failed = validRun(); failed.id = '11111111-1111-4111-8111-111111111116'; failed.status = 'error'; failed.error = 'Agent exited'; failed.steps[0].status = 'failed'; failed.actions.resume = true; failed.finishedAt = '2026-11-13T12:00:00.000Z';
  const finished = validRun(); finished.id = '11111111-1111-4111-8111-111111111117'; finished.status = 'complete'; finished.steps[0].status = 'complete'; finished.actions.stop = false; finished.actions.cleanup = true; finished.finishedAt = '2026-11-13T12:00:00.000Z';
  const onlyFinished = validRun('Beta'); onlyFinished.id = '11111111-1111-4111-8111-111111111118'; onlyFinished.status = 'complete'; onlyFinished.steps[0].status = 'complete'; onlyFinished.actions.stop = false; onlyFinished.actions.cleanup = true; onlyFinished.finishedAt = '2026-11-13T12:00:00.000Z';
  mocks.listOpenRuns.mockResolvedValue([interrupted, failed, finished, onlyFinished]);
  const { result } = renderHook(() => usePipelineRunCounts(showToast));
  await waitFor(() => expect(result.current.get('Alpha')).toEqual({ open: 2, awaitingOwner: 2 }));
  // A project whose only run is finished has nothing open, but the run is still there for its task.
  expect(result.current.has('Beta')).toBe(false);
  expect(result.current.runsByProject.get('Beta').map(run => run.status)).toEqual(['complete']);
});
it('counts only a no-progress stopped run as awaiting the owner', async () => {
  const stalled = validRun(); stalled.status = 'stopped'; stalled.stopReason = 'no_progress'; stalled.steps[0].status = 'stopped'; stalled.actions.resume = true; stalled.finishedAt = '2026-11-13T12:00:00.000Z';
  const userStopped = validRun(); userStopped.id = '11111111-1111-4111-8111-111111111115'; userStopped.status = 'stopped'; userStopped.stopReason = 'user'; userStopped.steps[0].status = 'stopped'; userStopped.actions.resume = true; userStopped.finishedAt = '2026-11-13T12:00:00.000Z';
  mocks.listOpenRuns.mockResolvedValue([stalled, userStopped]);
  const { result } = renderHook(() => usePipelineRunCounts(showToast));
  await waitFor(() => expect(result.current.get('Alpha')).toEqual({ open: 2, awaitingOwner: 1 }));
});
