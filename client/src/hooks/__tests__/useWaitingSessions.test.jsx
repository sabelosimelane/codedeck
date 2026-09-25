import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useWaitingSessions } from '../useWaitingSessions';

const page = (records, hasNextPage = false) => ({
  ok: true,
  json: async () => ({
    data: records,
    page: { currentPage: 0, size: 100, totalElements: records.length, totalPages: 1, hasNextPage },
  }),
});

const showToast = vi.fn();
let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
  showToast.mockReset();
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useWaitingSessions', () => {
  it('loads the persisted waiting marks on mount', async () => {
    global.fetch = vi.fn(async () => page([
      { sessionId: 'Demo-1', waiting: true, waitingAt: '2026-09-22T10:00:00.000Z' },
      { sessionId: 'Demo-2', waiting: true, waitingAt: '2026-09-22T11:00:00.000Z' },
    ]));

    const { result } = renderHook(() => useWaitingSessions(showToast));

    await waitFor(() => expect(result.current.waitingSessionIds.size).toBe(2));
    expect(result.current.waitingSessionIds.has('Demo-1')).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith('/api/terminal-waiting?page=0&size=100', expect.anything());
    expect(showToast).not.toHaveBeenCalled();
  });

  it('marks a session waiting through the backend before trusting local state', async () => {
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'PUT') {
        return { ok: true, json: async () => ({ sessionId: 'Demo-1', waiting: true, waitingAt: '2026-09-22T10:00:00.000Z' }) };
      }
      return page([]);
    });

    const { result } = renderHook(() => useWaitingSessions(showToast));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    await act(async () => { await result.current.toggleWaiting('Demo-1'); });

    expect(global.fetch).toHaveBeenCalledWith('/api/terminal-waiting/Demo-1', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ waiting: true }),
    }));
    expect(result.current.waitingSessionIds.has('Demo-1')).toBe(true);
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Tab moved to waiting' });
  });

  it('clears a mark that is already set', async () => {
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'PUT') return { ok: true, json: async () => ({ sessionId: 'Demo-1', waiting: false, waitingAt: null }) };
      return page([{ sessionId: 'Demo-1', waiting: true, waitingAt: '2026-09-22T10:00:00.000Z' }]);
    });

    const { result } = renderHook(() => useWaitingSessions(showToast));
    await waitFor(() => expect(result.current.waitingSessionIds.has('Demo-1')).toBe(true));

    await act(async () => { await result.current.toggleWaiting('Demo-1'); });

    expect(global.fetch).toHaveBeenCalledWith('/api/terminal-waiting/Demo-1', expect.objectContaining({
      body: JSON.stringify({ waiting: false }),
    }));
    expect(result.current.waitingSessionIds.has('Demo-1')).toBe(false);
    expect(showToast).toHaveBeenCalledWith({ type: 'success', message: 'Tab is no longer waiting' });
  });

  it('surfaces a backend rejection and leaves local state untouched', async () => {
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'PUT') return { ok: false, json: async () => ({ message: 'Terminal session not found' }) };
      return page([]);
    });

    const { result } = renderHook(() => useWaitingSessions(showToast));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    await act(async () => { await result.current.toggleWaiting('Ghost-1'); });

    expect(result.current.waitingSessionIds.has('Ghost-1')).toBe(false);
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Terminal session not found' });
  });

  it('surfaces an unreachable server', async () => {
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'PUT') throw new Error('network down');
      return page([]);
    });

    const { result } = renderHook(() => useWaitingSessions(showToast));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());

    await act(async () => { await result.current.toggleWaiting('Demo-1'); });

    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' });
  });

  it('clears finished marks without a toast, so completion is not noisy', async () => {
    global.fetch = vi.fn(async (url, options) => {
      if (options?.method === 'PUT') return { ok: true, json: async () => ({ sessionId: 'Demo-1', waiting: false, waitingAt: null }) };
      return page([
        { sessionId: 'Demo-1', waiting: true, waitingAt: '2026-09-22T10:00:00.000Z' },
        { sessionId: 'Demo-2', waiting: true, waitingAt: '2026-09-22T11:00:00.000Z' },
      ]);
    });

    const { result } = renderHook(() => useWaitingSessions(showToast));
    await waitFor(() => expect(result.current.waitingSessionIds.size).toBe(2));

    await act(async () => { await result.current.clearWaiting(['Demo-1']); });

    expect(result.current.waitingSessionIds.has('Demo-1')).toBe(false);
    expect(result.current.waitingSessionIds.has('Demo-2')).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('ignores an empty auto-clear batch', async () => {
    global.fetch = vi.fn(async () => page([]));
    const { result } = renderHook(() => useWaitingSessions(showToast));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    await act(async () => { await result.current.clearWaiting([]); });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  describe('auto-clearing when parked work lands', () => {
    const running = sessionId => ({ sessionId, alive: true, executionStatus: 'running' });
    const idle = sessionId => ({ sessionId, alive: true, executionStatus: 'idle' });
    const mockMarked = () => {
      global.fetch = vi.fn(async (url, options) => {
        if (options?.method === 'PUT') return { ok: true, json: async () => ({ sessionId: 'Beta-4', waiting: false, waitingAt: null }) };
        return page([{ sessionId: 'Beta-4', waiting: true, waitingAt: '2026-09-25T09:00:00.000Z' }]);
      });
    };
    const clearCalls = () => global.fetch.mock.calls.filter(([, options]) => options?.body === JSON.stringify({ waiting: false }));

    it('clears a mark as soon as its session finishes, in any project, without a toast', async () => {
      mockMarked();
      const { result, rerender } = renderHook(
        ({ sessionStatus, finishedSessionIds }) => useWaitingSessions(showToast, { sessionStatus, finishedSessionIds }),
        { initialProps: { sessionStatus: [running('Beta-4')], finishedSessionIds: new Set() } },
      );
      await waitFor(() => expect(result.current.waitingSessionIds.has('Beta-4')).toBe(true));

      rerender({ sessionStatus: [idle('Beta-4')], finishedSessionIds: new Set(['Beta-4']) });

      await waitFor(() => expect(result.current.waitingSessionIds.has('Beta-4')).toBe(false));
      expect(clearCalls().map(([url]) => url)).toEqual(['/api/terminal-waiting/Beta-4']);
      expect(showToast).not.toHaveBeenCalled();
    });

    it('keeps a mark whose session had already finished before it was parked', async () => {
      mockMarked();
      const earlierFinish = new Set(['Beta-4']);
      const { result, rerender } = renderHook(
        ({ sessionStatus, finishedSessionIds }) => useWaitingSessions(showToast, { sessionStatus, finishedSessionIds }),
        { initialProps: { sessionStatus: [idle('Beta-4')], finishedSessionIds: earlierFinish } },
      );
      await waitFor(() => expect(result.current.waitingSessionIds.has('Beta-4')).toBe(true));

      rerender({ sessionStatus: [idle('Beta-4')], finishedSessionIds: earlierFinish });

      expect(result.current.waitingSessionIds.has('Beta-4')).toBe(true);
      expect(clearCalls()).toEqual([]);
    });
  });

  it('reports a failed initial load with the message the API gave', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({ message: 'Terminal waiting request failed' }) }));
    renderHook(() => useWaitingSessions(showToast));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Terminal waiting request failed' }));
  });

  it('falls back to a generic message when the API gives none', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    renderHook(() => useWaitingSessions(showToast));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Failed to load waiting tabs' }));
  });
});
