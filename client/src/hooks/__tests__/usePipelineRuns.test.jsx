import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { usePipelineRuns } from '../usePipelineRuns';

const showToast = vi.fn();
let originalFetch;

function runView(overrides = {}) {
  return {
    id: 'r1',
    requestId: 'req-1',
    workflowId: 'w1',
    workflowName: 'Feature',
    project: 'Demo',
    input: 'build',
    status: 'running',
    stopReason: null,
    error: null,
    currentStepIndex: 1,
    steps: [],
    worktree: { path: '/tmp/wt', branch: 'workflow/feature', baseCommit: 'abc', state: 'present', detail: null },
    actions: { stop: true, resume: false, continue: false, cleanup: false },
    createdAt: '2026-11-13T10:00:00.000Z',
    updatedAt: '2026-11-13T10:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

function okList(runs) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: runs,
      page: { currentPage: 0, size: 100, totalElements: runs.length, totalPages: 1, hasNextPage: false },
    }),
  };
}

function okRun(run, status = 200) {
  return { ok: true, status, json: async () => run };
}

beforeEach(() => {
  originalFetch = global.fetch;
  showToast.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usePipelineRuns', () => {
  it('polls open runs every 2s for the active project', async () => {
    const first = runView({ id: 'r1', status: 'running' });
    const second = runView({ id: 'r1', status: 'complete', worktree: { ...runView().worktree, state: 'removal_blocked' } });
    let calls = 0;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/runs?')) {
        calls += 1;
        return okList(calls === 1 ? [first] : [second]);
      }
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));

    await waitFor(() => expect(result.current.runs).toEqual([first]));
    expect(String(global.fetch.mock.calls[0][0])).toContain('open=true');
    expect(String(global.fetch.mock.calls[0][0])).toContain('project=Demo');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(result.current.runs[0].status).toBe('complete'));
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: expect.stringMatching(/complete/i) });
  });

  it('does not start overlapping poll requests', async () => {
    let resolveFirst;
    const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });
    let listCalls = 0;
    global.fetch = vi.fn(async (url) => {
      if (!String(url).includes('/runs?')) return okList([]);
      listCalls += 1;
      if (listCalls === 1) {
        await firstPromise;
        return okList([runView()]);
      }
      return okList([runView({ status: 'stopped' })]);
    });

    renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(listCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.resolve();
    });
    expect(listCalls).toBe(1);

    resolveFirst();
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(listCalls).toBe(2));
  });

  it('toasts poll failures without clearing known runs', async () => {
    let listCalls = 0;
    global.fetch = vi.fn(async (url) => {
      if (!String(url).includes('/runs?')) return okList([]);
      listCalls += 1;
      if (listCalls === 1) return okList([runView()]);
      return { ok: false, status: 500, json: async () => ({ message: 'Pipelines Error' }) };
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Pipelines Error' }));
    expect(result.current.runs).toHaveLength(1);
  });

  it('starts a run only after the backend confirms and refetches', async () => {
    const created = runView({ id: 'r9', status: 'pending' });
    const listed = runView({ id: 'r9', status: 'running' });
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).endsWith('/runs')) return okRun(created, 201);
      if (String(url).includes('/runs?')) return okList([listed]);
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    let started;
    await act(async () => {
      started = await result.current.startRun({
        requestId: 'req-9',
        workflowId: '11111111-1111-1111-1111-111111111111',
        input: 'ship it',
      });
    });

    expect(started).toEqual(created);
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: expect.stringMatching(/started/i) });
    await waitFor(() => expect(result.current.runs.some((run) => run.id === 'r9')).toBe(true));
    expect(result.current.locallyStartedRunIds.has('r9')).toBe(true);
  });

  it('does not optimistically mutate runs on a failed stop', async () => {
    const running = runView({ status: 'running' });
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).includes('/stop')) {
        return { ok: false, status: 409, json: async () => ({ message: 'Stop is not allowed in this state.' }) };
      }
      if (String(url).includes('/runs?')) return okList([running]);
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    await act(async () => {
      await result.current.stopRun('r1');
    });

    expect(result.current.runs[0].status).toBe('running');
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Stop is not allowed in this state.' });
  });

  it('queues a trailing refresh when an action finishes during an in-flight poll', async () => {
    const running = runView({ status: 'running' });
    const stopped = runView({ status: 'stopped', actions: { stop: false, resume: true, continue: false, cleanup: true } });
    let resolvePoll;
    let listCalls = 0;
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).includes('/stop')) return okRun(stopped);
      if (String(url).includes('/runs?')) {
        listCalls += 1;
        if (listCalls === 1) {
          await new Promise((resolve) => { resolvePoll = resolve; });
          return okList([running]);
        }
        return okList([stopped]);
      }
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await act(async () => { await Promise.resolve(); });

    await act(async () => {
      const stopPromise = result.current.stopRun('r1');
      resolvePoll();
      await stopPromise;
    });

    await waitFor(() => expect(result.current.runs[0].status).toBe('stopped'));
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  });

  it('applies backend-confirmed owner actions and toasts success', async () => {
    const running = runView({ status: 'running' });
    const stopped = runView({ status: 'stopped', actions: { stop: false, resume: true, continue: false, cleanup: true } });
    let stoppedOnServer = false;
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).includes('/stop')) {
        stoppedOnServer = true;
        return okRun(stopped);
      }
      if (String(url).includes('/runs?')) return okList([stoppedOnServer ? stopped : running]);
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    await act(async () => {
      await result.current.stopRun('r1');
    });

    expect(result.current.runs[0].status).toBe('stopped');
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: expect.stringMatching(/stopped/i) });
  });

  it('does not merge a Start response into a different active project', async () => {
    let resolveStart;
    const startPromise = new Promise((resolve) => { resolveStart = resolve; });
    const createdA = runView({ id: 'r-a', project: 'Alpha', status: 'pending' });
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).endsWith('/runs')) {
        await startPromise;
        return okRun(createdA, 201);
      }
      if (String(url).includes('project=Alpha')) return okList([]);
      if (String(url).includes('project=Beta')) return okList([]);
      return okList([]);
    });

    const { result, rerender } = renderHook(
      ({ projectName }) => usePipelineRuns({ projectName, showToast }),
      { initialProps: { projectName: 'Alpha' } },
    );
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    let startResult;
    await act(async () => {
      const pending = result.current.startRun({
        requestId: 'req-a',
        workflowId: '11111111-1111-1111-1111-111111111111',
        input: 'ship',
      });
      rerender({ projectName: 'Beta' });
      resolveStart();
      startResult = await pending;
    });

    expect(startResult).toEqual(createdA);
    expect(result.current.runs.some((run) => run.id === 'r-a')).toBe(false);
    expect(result.current.locallyStartedRunIds.has('r-a')).toBe(false);
  });

  it('toasts cleanup failure when worktree removal is blocked', async () => {
    const complete = runView({
      status: 'complete',
      worktree: { ...runView().worktree, state: 'present' },
      actions: { stop: false, resume: false, continue: false, cleanup: true },
    });
    const blocked = runView({
      status: 'complete',
      worktree: {
        ...runView().worktree,
        state: 'removal_blocked',
        detail: 'contains modified or untracked files\ntmp.out',
      },
      actions: { stop: false, resume: false, continue: false, cleanup: true },
    });
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).includes('/cleanup')) return okRun(blocked);
      if (String(url).includes('/runs?')) return okList([complete]);
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    await act(async () => {
      await result.current.cleanupRun('r1');
    });

    expect(showToast).toHaveBeenCalledWith({
      type: 'error',
      message: 'contains modified or untracked files\ntmp.out',
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: expect.stringMatching(/cleaned up/i),
    }));
  });

  it('retries failed final-state fetches and reports completion exactly once', async () => {
    let listCalls = 0;
    let finalCalls = 0;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/runs?')) {
        return okList(++listCalls === 1 ? [runView()] : []);
      }
      if (String(url).endsWith('/runs/r1')) {
        if (++finalCalls <= 2) throw new TypeError('temporary outage');
        return okRun(runView({ status: 'complete' }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    for (let i = 0; i < 4; i += 1) {
      await act(async () => { await result.current.refresh(); });
    }

    expect(finalCalls).toBe(3);
    expect(result.current.runs).toEqual([]);
    expect(showToast.mock.calls.map(([toast]) => toast)).toEqual([
      { type: 'error', message: 'Server unreachable' },
      { type: 'success', message: 'Feature completed' },
    ]);
  });

  it('fetches finals for runs that leave the open list so completion toasts fire', async () => {
    const running = runView({ id: 'r1', status: 'running' });
    const completed = runView({
      id: 'r1',
      status: 'complete',
      worktree: { ...runView().worktree, state: 'removed' },
      actions: { stop: false, resume: false, continue: false, cleanup: false },
    });
    let listCalls = 0;
    global.fetch = vi.fn(async (url) => {
      const path = String(url);
      if (path.includes('/runs?')) {
        listCalls += 1;
        return okList(listCalls === 1 ? [running] : []);
      }
      if (path.endsWith('/runs/r1') || path.includes('/runs/r1?')) return okRun(completed);
      return okList([]);
    });

    renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(listCalls).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    await waitFor(() => expect(showToast).toHaveBeenCalledWith({
      type: 'success',
      message: expect.stringMatching(/complete/i),
    }));
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('/runs/r1'))).toBe(true);
  });
});
