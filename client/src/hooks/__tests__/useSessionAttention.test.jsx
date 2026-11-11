import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import { useSessionAttention } from '../useSessionAttention';

const row = (sessionId, extra = {}) => ({ sessionId, finished: false, statusMuted: false, ...extra });
const ok = body => Promise.resolve({ ok: true, json: async () => body });
const problem = (status, message) => Promise.resolve({ ok: false, status, json: async () => ({ message }) });
let showToast;
beforeEach(() => { localStorage.clear(); showToast = vi.fn(); global.fetch = vi.fn(); });
afterEach(cleanup);
const mount = rows => renderHook(({ sessionStatus }) => useSessionAttention(sessionStatus, showToast), { initialProps: { sessionStatus: rows } });

describe('useSessionAttention', () => {
  it('reads finished and muted sessions from the backend status rows', () => {
    const { result } = mount([row('a-1', { finished: true }), row('a-2', { statusMuted: true }), row('a-3')]);
    expect([...result.current.finishedSessionIds]).toEqual(['a-1']);
    expect([...result.current.mutedStatusSessionIds]).toEqual(['a-2']);
  });

  it('acknowledges finished work through the backend and clears it once confirmed', async () => {
    global.fetch.mockReturnValue(ok({ sessionId: 'Equinox Local-1', finished: false, muted: false, waiting: false, lastActivityAt: 1 }));
    const { result } = mount([row('Equinox Local-1', { finished: true })]);
    await act(() => result.current.resetFinishedSession('Equinox Local-1'));
    expect(global.fetch).toHaveBeenCalledWith('/api/session-attention/Equinox%20Local-1', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ acknowledged: true }) }));
    expect(result.current.finishedSessionIds.has('Equinox Local-1')).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does not call the backend for a session that is not finished', async () => {
    const { result } = mount([row('a-1')]);
    await act(() => result.current.resetFinishedSession('a-1'));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps a session finished and says why when the acknowledgement fails', async () => {
    global.fetch.mockReturnValue(problem(404, 'Terminal session not found'));
    const { result } = mount([row('a-1', { finished: true })]);
    await act(() => result.current.resetFinishedSession('a-1'));
    expect(result.current.finishedSessionIds.has('a-1')).toBe(true);
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Terminal session not found' });
  });

  it('toggles mute through the backend with feedback, both ways', async () => {
    global.fetch.mockReturnValueOnce(ok({ sessionId: 'a-1', finished: false, muted: true, waiting: false, lastActivityAt: 1 }))
      .mockReturnValueOnce(ok({ sessionId: 'a-1', finished: false, muted: false, waiting: false, lastActivityAt: 1 }));
    const { result } = mount([row('a-1')]);
    await act(() => result.current.toggleMutedStatusSession('a-1'));
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ muted: true });
    expect(result.current.mutedStatusSessionIds.has('a-1')).toBe(true);
    expect(showToast).toHaveBeenLastCalledWith({ type: 'success', message: 'Status colors muted' });
    await act(() => result.current.toggleMutedStatusSession('a-1'));
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ muted: false });
    expect(result.current.mutedStatusSessionIds.has('a-1')).toBe(false);
  });

  it('reports an unreachable server instead of changing anything', async () => {
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = mount([row('a-1')]);
    await act(() => result.current.toggleMutedStatusSession('a-1'));
    expect(result.current.mutedStatusSessionIds.has('a-1')).toBe(false);
    expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Server unreachable' });
  });

  it('holds a confirmed change over a stale poll, then follows the backend again', async () => {
    global.fetch.mockReturnValue(ok({ sessionId: 'a-1', finished: false, muted: true, waiting: false, lastActivityAt: 1 }));
    const { result, rerender } = mount([row('a-1')]);
    await act(() => result.current.toggleMutedStatusSession('a-1'));
    rerender({ sessionStatus: [row('a-1')] });
    expect(result.current.mutedStatusSessionIds.has('a-1')).toBe(true);
    rerender({ sessionStatus: [row('a-1', { statusMuted: true })] });
    rerender({ sessionStatus: [row('a-1')] });
    expect(result.current.mutedStatusSessionIds.has('a-1')).toBe(false);
  });

  it('moves mutes saved in this browser to the backend once, then forgets the local copy', async () => {
    localStorage.setItem('codedeck-muted-status-sessions', JSON.stringify(['a-1', 'gone-9']));
    global.fetch.mockImplementation(url => (url.endsWith('/gone-9') ? problem(404, 'Terminal session not found') : ok({ sessionId: 'a-1', finished: false, muted: true, waiting: false, lastActivityAt: 1 })));
    const { result, rerender } = mount([]);
    expect(global.fetch).not.toHaveBeenCalled();
    rerender({ sessionStatus: [row('a-1')] });
    await waitFor(() => expect(localStorage.getItem('codedeck-muted-status-sessions')).toBeNull());
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.current.mutedStatusSessionIds.has('a-1')).toBe(true);
    rerender({ sessionStatus: [row('a-1', { statusMuted: true })] });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps the local mutes for the next load when the backend cannot be reached', async () => {
    localStorage.setItem('codedeck-muted-status-sessions', JSON.stringify(['a-1']));
    global.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const { rerender } = mount([]);
    rerender({ sessionStatus: [row('a-1')] });
    await waitFor(() => expect(showToast).toHaveBeenCalledWith({ type: 'error', message: 'Could not move muted terminals to the server' }));
    expect(localStorage.getItem('codedeck-muted-status-sessions')).toBe(JSON.stringify(['a-1']));
  });

  it('discards a corrupted local mute list without calling the backend', async () => {
    localStorage.setItem('codedeck-muted-status-sessions', '{not json');
    const { rerender } = mount([]);
    rerender({ sessionStatus: [row('a-1')] });
    await waitFor(() => expect(localStorage.getItem('codedeck-muted-status-sessions')).toBeNull());
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
