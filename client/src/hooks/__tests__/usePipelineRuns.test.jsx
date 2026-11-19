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
    agentsDecide: false,
    progress: null,
    notesDir: null,
    decisionCount: 0,
    project: 'Demo',
    input: 'build',
    status: 'running',
    stopReason: null,
    error: null,
    currentStepIndex: 1,
    steps: [],
    worktree: { path: '/tmp/wt', branch: 'workflow/feature', baseCommit: 'abc', state: 'present', detail: null },
    inputRequest: null,
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
  it('approves and sends back waiting runs with action feedback', async () => {
    const waiting = runView({ status: 'awaiting_approval' });
    const approved = runView({ status: 'complete' });
    const sentBack = runView({ status: 'running' });
    global.fetch = vi.fn(async (url, options) => {
      const target = String(url);
      if (target.endsWith('/approve')) return okRun(approved);
      if (target.endsWith('/send-back')) {
        expect(JSON.parse(options.body)).toEqual({ comment: 'Add evidence' });
        return okRun(sentBack);
      }
      return okList([waiting]);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    await act(async () => { expect(await result.current.approveRun('r1')).toEqual(approved); });
    await act(async () => { expect(await result.current.sendBackRun('r1', 'Add evidence')).toEqual(sentBack); });
    expect(showToast.mock.calls.map(([toast]) => toast.message)).toContain('Feature approved');
    expect(showToast.mock.calls.map(([toast]) => toast.message)).toContain('Feature sent back');
  });
  it('loads and validates a run notes page', async () => {
    global.fetch = vi.fn(async url => String(url).includes('/notes?')
      ? { ok: true, status: 200, json: async () => ({ data: [], page: { currentPage: 0, size: 50, totalElements: 0, totalPages: 0, hasNextPage: false } }) }
      : okList([]));
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    let loaded;
    await act(async () => { loaded = await result.current.loadRunNotes('r1', 0); });
    expect(loaded).toEqual({ notes: [], hasNextPage: false, total: 0 });
  });
  it('toasts when a run notes page cannot load', async () => {
    global.fetch = vi.fn(async url => String(url).includes('/notes?')
      ? { ok: false, status: 500, json: async () => ({ detail: 'Notes unavailable' }) }
      : okList([]));
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    let loaded;
    await act(async () => { loaded = await result.current.loadRunNotes('r1', 0); });
    expect(loaded).toBeNull();
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Pipelines request failed (500)' });
  });
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

  it('says which fields the backend refused, not only that validation failed', async () => {
    const refusal = {
      status: 400, error: 'Validation Error', message: 'One or more fields failed validation.',
      errors: [{ field: 'input', message: 'This workflow reads its progress from docs/{input}.' }, { field: 'newTask.title', message: 'Use 1–80 characters on one line' }],
    };
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).endsWith('/runs')) return { ok: false, status: 400, json: async () => refusal };
      return okList([]);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    let started;
    await act(async () => {
      started = await result.current.startRun({ requestId: 'req-9', workflowId: '11111111-1111-1111-1111-111111111111', input: '/abs/plan.md' });
    });
    expect(started).toBeNull();
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'This workflow reads its progress from docs/{input}. Use 1–80 characters on one line' });
  });

  it('shows the message of a refusal that names no field', async () => {
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).endsWith('/runs')) return { ok: false, status: 400, json: async () => ({ message: 'One or more fields failed validation.', errors: [{ field: 'input' }, null] }) };
      return okList([]);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await act(async () => { await result.current.startRun({ requestId: 'req-9', workflowId: '11111111-1111-1111-1111-111111111111', input: 'x' }); });
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'One or more fields failed validation.' });
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

  it('reports an action that leaves the run in error as a failure, once', async () => {
    const paused = runView({ status: 'limit_paused', actions: { stop: true, resume: false, continue: true, cleanup: false } });
    const failed = runView({
      status: 'error',
      error: 'Setup left uncommitted changes in the worktree.',
      actions: { stop: false, resume: true, continue: false, cleanup: true },
    });
    let continuedOnServer = false;
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).includes('/continue')) {
        continuedOnServer = true;
        return okRun(failed);
      }
      if (String(url).includes('/runs?')) return okList([continuedOnServer ? failed : paused]);
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    showToast.mockClear();

    await act(async () => {
      await result.current.continueRun('r1');
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });

    expect(result.current.runs[0].status).toBe('error');
    expect(showToast.mock.calls).toEqual([[{ type: 'error', message: 'Setup left uncommitted changes in the worktree.' }]]);
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

  it('passes the chosen existing worktree when starting a run', async () => {
    const created = runView({ id: 'r9', status: 'pending', worktree: { ...runView().worktree, path: '/git/worktrees/demo-feature', state: 'external' } });
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).endsWith('/runs')) return okRun(created, 201);
      return okList([]);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    await act(async () => {
      await result.current.startRun({ requestId: 'req-9', workflowId: 'w1', input: 'x', worktreePath: '/git/worktrees/demo-feature' });
    });

    const post = global.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({
      requestId: 'req-9', workflowId: 'w1', project: 'Demo', input: 'x', worktreePath: '/git/worktrees/demo-feature',
    });
  });

  it('passes on the repository the run starts in', async () => {
    const created = { id: 'r9', workflowName: 'Build', status: 'pending', project: 'Demo' };
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).endsWith('/runs')) return okRun(created, 201);
      return okList([]);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    await act(async () => {
      await result.current.startRun({ requestId: 'req-9', workflowId: 'w1', input: 'x', taskId: '7a000000-0000-4000-8000-000000000001', startIn: 'mobile-app' });
    });

    const post = global.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual({
      requestId: 'req-9', workflowId: 'w1', project: 'Demo', input: 'x', taskId: '7a000000-0000-4000-8000-000000000001', startIn: 'mobile-app',
    });
  });

  it('says the run was closed and how many terminals went with it, not that a worktree was cleaned up, when an existing worktree is released', async () => {
    const stopped = runView({
      status: 'stopped',
      worktree: { ...runView().worktree, state: 'external' },
      actions: { stop: false, resume: true, continue: false, cleanup: true },
    });
    const released = runView({
      status: 'stopped',
      worktree: { ...runView().worktree, state: 'released' },
      actions: { stop: false, resume: false, continue: false, cleanup: false },
    });
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).includes('/cleanup')) return okRun({ ...released, terminalsClosed: ['Demo-3', 'Demo-4'], terminalsNotClosed: [] });
      if (String(url).includes('/runs?')) return okList([stopped]);
      return okList([]);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    let closed;
    await act(async () => {
      closed = await result.current.cleanupRun('r1');
    });

    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Feature run closed; its work is left in place. 2 terminals closed.' });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/cleaned up/i) }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    // The caller takes the closed terminals' tabs away.
    expect(closed.terminalsClosed).toEqual(['Demo-3', 'Demo-4']);
  });

  it.each([
    [[], 'Feature run closed; its work is left in place.'],
    [['Demo-3'], 'Feature run closed; its work is left in place. 1 terminal closed.'],
  ])('counts the terminals closed with the run: %j', async (terminalsClosed, message) => {
    const complete = runView({ status: 'complete', worktree: { ...runView().worktree, state: 'external' }, actions: { stop: false, resume: false, continue: false, cleanup: true } });
    const released = { ...complete, worktree: { ...complete.worktree, state: 'released' }, actions: { stop: false, resume: false, continue: false, cleanup: false } };
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).includes('/cleanup')) return okRun({ ...released, terminalsClosed, terminalsNotClosed: [] });
      if (String(url).includes('/runs?')) return okList([complete]);
      return okList([]);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    await act(async () => { await result.current.cleanupRun('r1'); });
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message });
  });

  it('says which terminals could not be closed with the run, and how to close them', async () => {
    const complete = runView({ status: 'complete', worktree: { ...runView().worktree, state: 'external' }, actions: { stop: false, resume: false, continue: false, cleanup: true } });
    const released = { ...complete, worktree: { ...complete.worktree, state: 'released' }, actions: { stop: false, resume: false, continue: false, cleanup: false } };
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).includes('/cleanup')) return okRun({ ...released, terminalsClosed: ['Demo-3'], terminalsNotClosed: ['Demo-4', 'Demo-5'] });
      if (String(url).includes('/runs?')) return okList([complete]);
      return okList([]);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    await act(async () => { await result.current.cleanupRun('r1'); });
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Feature run closed; its work is left in place. 1 terminal closed.' });
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: '2 terminals could not be closed: Demo-4, Demo-5. Close them from their tabs.' });
  });

  it('reports a Close run the backend refused, and returns nothing to act on', async () => {
    const complete = runView({ status: 'complete', worktree: { ...runView().worktree, state: 'external' }, actions: { stop: false, resume: false, continue: false, cleanup: true } });
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).includes('/cleanup')) return { ok: false, status: 409, json: async () => ({ message: 'Action cleanup is not allowed in status running' }) };
      if (String(url).includes('/runs?')) return okList([complete]);
      return okList([]);
    });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));
    let closed;
    await act(async () => { closed = await result.current.cleanupRun('r1'); });
    expect(closed).toBeNull();
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Action cleanup is not allowed in status running' });
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
      if (options?.method === 'POST' && String(url).includes('/cleanup')) return okRun({ ...blocked, terminalsClosed: [], terminalsNotClosed: [] });
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
      message: 'Worktree kept: it has uncommitted work. Commit or discard the files, then choose Clean up worktree.',
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

describe('usePipelineRuns — answering an agent', () => {
  const ASKED = { questions: '1. Which schema?\nRecommended: the existing one.', truncated: false };
  const waiting = () => runView({ status: 'needs_input', inputRequest: ASKED });

  it('sends the answer, shows the run the backend returns and confirms it', async () => {
    const answered = runView({ status: 'running' });
    let isAnswered = false;
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).endsWith('/runs/r1/answer')) {
        isAnswered = true;
        return okRun(answered);
      }
      if (String(url).includes('/runs?')) return okList([isAnswered ? answered : waiting()]);
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs[0]?.inputRequest).toEqual(ASKED));

    let returned;
    await act(async () => {
      returned = await result.current.answerRun('r1', 'the existing schema');
    });

    const post = global.fetch.mock.calls.find(([url]) => String(url).endsWith('/runs/r1/answer'));
    expect(JSON.parse(post[1].body)).toEqual({ answer: 'the existing schema' });
    expect(returned).toEqual(answered);
    expect(result.current.runs[0]).toMatchObject({ status: 'running', inputRequest: null });
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Answer sent to Feature' });
  });

  it('keeps the run waiting and reports why when the answer is refused', async () => {
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'POST' && String(url).endsWith('/runs/r1/answer')) {
        return { ok: false, status: 409, json: async () => ({ message: 'The agent is no longer waiting for an answer.' }) };
      }
      if (String(url).includes('/runs?')) return okList([waiting()]);
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    let returned;
    await act(async () => {
      returned = await result.current.answerRun('r1', 'yes');
    });

    expect(returned).toBeNull();
    expect(result.current.runs[0].status).toBe('needs_input');
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'The agent is no longer waiting for an answer.' });
  });

  it('refuses a polled run whose input request is malformed instead of showing it', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/runs?')) return okList([runView({ status: 'needs_input', inputRequest: { questions: 7, truncated: false } })]);
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({
      type: 'error', message: expect.stringContaining('inputRequest.questions'),
    }));
    expect(result.current.runs).toEqual([]);
  });
});

describe('usePipelineRuns — decisions agents made', () => {
  const decision = (id) => ({
    id, stepIndex: 1, stepName: 'Test', pass: 1, questions: '1. Run the slow suite?\nRecommended: yes',
    truncated: false, answer: 'Proceed with your recommendations.', createdAt: '2026-11-14T10:00:00.000Z',
  });
  const page = (data, hasNextPage = false) => ({
    ok: true, status: 200,
    json: async () => ({ data, page: { currentPage: 0, size: 50, totalElements: 3, totalPages: 2, hasNextPage } }),
  });
  const withDecisions = (response) => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/decisions?')) return typeof response === 'function' ? response(url) : response;
      if (String(url).includes('/runs?')) return okList([runView({ agentsDecide: true, decisionCount: 3 })]);
      return okList([]);
    });
  };

  it('loads one page of a run\'s decisions', async () => {
    withDecisions(page([decision(1), decision(2)], true));
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    let loaded;
    await act(async () => { loaded = await result.current.loadRunDecisions('r1', 1); });

    expect(loaded).toEqual({ decisions: [decision(1), decision(2)], hasNextPage: true, total: 3 });
    const request = global.fetch.mock.calls.find(([url]) => String(url).includes('/decisions?'));
    expect(String(request[0])).toBe('/api/pipelines/runs/r1/decisions?page=1&size=50&sort=createdAt%2Casc');
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('reports why and returns nothing when the server refuses', async () => {
    withDecisions({ ok: false, status: 404, json: async () => ({ message: 'Run not found' }) });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    let loaded;
    await act(async () => { loaded = await result.current.loadRunDecisions('r1', 0); });

    expect(loaded).toBeNull();
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Run not found' });
  });

  it('refuses a page with a malformed decision instead of showing it', async () => {
    withDecisions(page([{ ...decision(1), pass: 0 }]));
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    let loaded;
    await act(async () => { loaded = await result.current.loadRunDecisions('r1', 0); });

    expect(loaded).toBeNull();
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: expect.stringContaining('pass') });
  });

  it('says the server is unreachable when the request never completes', async () => {
    withDecisions(() => { throw new TypeError('Failed to fetch'); });
    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(result.current.runs).toHaveLength(1));

    let loaded;
    await act(async () => { loaded = await result.current.loadRunDecisions('r1', 0); });

    expect(loaded).toBeNull();
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' });
  });

  it.each([
    ['agentsDecide', { agentsDecide: 'yes' }],
    ['decisionCount', { decisionCount: -1 }],
    ['steps[0].roundsCompleted', { steps: [{ index: 0, name: 'Test', status: 'running', repeat: { mode: 'loop_back', toStepIndex: 0, max: 5 }, roundsCompleted: 5 }] }],
    ['steps[0].repeat.max', { steps: [{ index: 0, name: 'Test', status: 'running', repeat: { mode: 'loop_back', toStepIndex: 0, max: 0 }, roundsCompleted: 0 }] }],
  ])('refuses a polled run whose %s is malformed instead of showing it', async (field, patch) => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/runs?')) return okList([runView(patch)]);
      return okList([]);
    });

    const { result } = renderHook(() => usePipelineRuns({ projectName: 'Demo', showToast }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: expect.stringContaining(field) }));
    expect(result.current.runs).toEqual([]);
  });
});
