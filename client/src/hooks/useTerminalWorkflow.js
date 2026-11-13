import { useCallback, useRef, useState } from 'react';
import { useToast } from '../components/ToastContext';

const STOPPED = { status: 'stopped', active: false, error: null, requestId: null };
const STATUSES = new Set(['stopped', 'running', 'resetting', 'complete', 'needs_input', 'error']);
const validId = id => id === null || (typeof id === 'string' && /^[\w-]{1,128}$/.test(id));

function validateMessage(message) {
  if (!validId(message.requestId)) throw new Error('Invalid workflow response requestId.');
  const state = message.state;
  if (!state || !STATUSES.has(state.status) || typeof state.active !== 'boolean'
      || state.active !== ['running', 'resetting', 'needs_input'].includes(state.status)
      || !validId(state.requestId)
      || !(state.error === null || (typeof state.error === 'string' && state.error.trim()))
      || (state.status === 'error' && state.error === null)) {
    throw new Error('Invalid workflow state received. Reconnect before starting again.');
  }
}

export function useTerminalWorkflow({ wsRef }) {
  const [state, setState] = useState(STOPPED);
  const stateRef = useRef(STOPPED);
  const lockedRef = useRef(false);
  const inputLockedRef = useRef(false);
  const { showToast } = useToast();
  const toastRef = useRef(showToast);
  toastRef.current = showToast;

  const applyState = useCallback(next => {
    stateRef.current = next;
    lockedRef.current = next.active;
    inputLockedRef.current = next.status === 'resetting';
    setState(next);
  }, []);
  const fail = useCallback(message => {
    applyState({ ...STOPPED, status: 'error', error: message });
    toastRef.current({ type: 'error', message });
  }, [applyState]);
  // Preserve locks until the backend restores its current state on reconnect.
  const disconnected = useCallback(() => {}, []);
  const handleMessage = useCallback(message => {
    try { validateMessage(message); }
    catch (err) {
      fail(err.message);
      wsRef.current?.close();
      return;
    }
    const previous = stateRef.current.status;
    applyState(message.state);
    if (message.state.status === 'error') {
      if (previous !== 'error') toastRef.current({ type: 'error', message: message.state.error });
    }
  }, [applyState, fail, wsRef]);
  return { state, lockedRef, inputLockedRef, disconnected, handleMessage };
}
