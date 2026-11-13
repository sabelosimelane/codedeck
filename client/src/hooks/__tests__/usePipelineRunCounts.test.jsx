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
  await waitFor(() => expect(result.current.get('Alpha')).toBe(2));
  expect(result.current.get('Beta')).toBe(1);
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
  await waitFor(() => expect(result.current.get('Alpha')).toBe(1));
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(showToast).toHaveBeenCalledTimes(1);
  expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Counts unavailable' });
  expect(result.current.get('Alpha')).toBe(1);
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
