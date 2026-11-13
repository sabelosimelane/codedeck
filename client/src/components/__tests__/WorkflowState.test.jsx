import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalWorkflow } from '../../hooks/useTerminalWorkflow';

const stopped = { status: 'stopped', active: false, error: null, requestId: null };
const running = { status: 'running', active: true, error: null, requestId: 'run-1' };
const toast = vi.hoisted(() => vi.fn());
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
beforeEach(() => toast.mockClear());
afterEach(cleanup);

function setup() {
  const wsRef = { current: { readyState: 1, send: vi.fn(), close: vi.fn() } };
  const hook = renderHook(() => useTerminalWorkflow({ wsRef }));
  const receive = state => act(() => hook.result.current.handleMessage({ type: 'workflow_state', requestId: null, state }));
  return { ...hook, wsRef, receive };
}

describe('receive-only workflow state', () => {
  it('exposes state and locks without browser control actions', () => {
    const { result } = setup();
    expect(Object.keys(result.current).sort()).toEqual(['disconnected', 'handleMessage', 'inputLockedRef', 'lockedRef', 'state']);
  });
  it('tracks pipeline locks through running, pause, reset and completion without bar toasts', () => {
    const { result, receive, wsRef } = setup();
    for (const status of ['running', 'needs_input', 'running', 'resetting', 'complete', 'stopped']) {
      const active = ['running', 'needs_input', 'resetting'].includes(status);
      receive({ ...running, status, active });
      expect(result.current.state.status).toBe(status);
      expect(result.current.lockedRef.current).toBe(active);
      expect(result.current.inputLockedRef.current).toBe(status === 'resetting');
    }
    expect(toast).not.toHaveBeenCalled();
    expect(wsRef.current.send).not.toHaveBeenCalled();
  });
  it('retains running state and locks on disconnect, then accepts restored completion', () => {
    const { result, receive, wsRef } = setup();
    receive(running);
    act(() => result.current.disconnected());
    expect(result.current.state).toEqual(running);
    expect(result.current.lockedRef.current).toBe(true);
    expect(result.current.inputLockedRef.current).toBe(false);
    receive({ ...stopped, status: 'complete' });
    expect(result.current.lockedRef.current).toBe(false);
    expect(wsRef.current.send).not.toHaveBeenCalled();
  });
  it('surfaces engine errors once and releases locks', () => {
    const { result, receive } = setup();
    receive(running);
    const error = { ...stopped, status: 'error', error: 'Terminal submission failed.' };
    receive(error);
    receive(error);
    expect(toast).toHaveBeenCalledExactlyOnceWith({ type: 'error', message: error.error });
    expect(result.current.lockedRef.current).toBe(false);
    expect(result.current.inputLockedRef.current).toBe(false);
  });
  it.each([
    null, { ...stopped, status: null }, { ...stopped, active: null },
    { ...stopped, error: 42 }, { ...stopped, requestId: 42 },
    { ...stopped, active: true }, { ...stopped, status: 'error' },
    { ...stopped, error: '' },
  ])('rejects malformed state loudly %#', state => {
    const { result, wsRef, receive } = setup();
    receive(state);
    expect(result.current.state.status).toBe('error');
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }));
    expect(wsRef.current.close).toHaveBeenCalledOnce();
  });
  it.each([undefined, 42, '', 'bad id'])('rejects malformed response requestId %#', requestId => {
    const { result, wsRef } = setup();
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId, state: stopped }));
    expect(toast).toHaveBeenLastCalledWith({ type: 'error', message: 'Invalid workflow response requestId.' });
    expect(wsRef.current.close).toHaveBeenCalledOnce();
  });
});
