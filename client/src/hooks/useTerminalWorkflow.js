import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../components/ToastContext';

const STOPPED = { status: 'stopped', active: false, error: null, requestId: null };
const STATUSES = new Set(['stopped', 'running', 'resetting', 'complete', 'needs_input', 'error']);
const validId = id => id === null || (typeof id === 'string' && /^[\w-]{1,128}$/.test(id));

function validateMessage(message) {
  if (!validId(message.requestId)) throw new Error('Invalid workflow response requestId.');
  if (message.type === 'workflow_error') {
    if (typeof message.message !== 'string' || !message.message.trim()) throw new Error('Invalid workflow error message.');
    return;
  }
  const state = message.state;
  if (!state || !STATUSES.has(state.status) || typeof state.active !== 'boolean'
      || state.active !== ['running', 'resetting'].includes(state.status)
      || !validId(state.requestId)
      || !(state.error === null || (typeof state.error === 'string' && state.error.trim()))
      || (state.status === 'error' && state.error === null)) {
    throw new Error('Invalid workflow state received. Reconnect before starting again.');
  }
}

export function useTerminalWorkflow({ wsRef, sessionReadyRef }) {
  const [state, setState] = useState(STOPPED);
  const [pending, setPending] = useState(false);
  const stateRef = useRef(STOPPED);
  const pendingRef = useRef(null);
  const lockedRef = useRef(false);
  const inputLockedRef = useRef(false);
  const timerRef = useRef(null);
  const { showToast } = useToast();
  const toastRef = useRef(showToast);
  toastRef.current = showToast;

  const applyState = useCallback(next => {
    stateRef.current = next;
    lockedRef.current = next.active || pendingRef.current !== null;
    inputLockedRef.current = next.status === 'resetting' || pendingRef.current !== null;
    setState(next);
  }, []);
  const clearPending = useCallback(() => {
    clearTimeout(timerRef.current);
    pendingRef.current = null;
    setPending(false);
    lockedRef.current = stateRef.current.active;
    inputLockedRef.current = stateRef.current.status === 'resetting';
  }, []);
  const fail = useCallback(message => {
    clearPending();
    applyState({ ...STOPPED, status: 'error', error: message });
    toastRef.current({ type: 'error', message });
  }, [applyState, clearPending]);

  const send = useCallback((type, fields = {}) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1 || !sessionReadyRef.current) {
      toastRef.current({ type: 'error', message: 'Wait for the terminal to connect before starting a workflow.' });
      return;
    }
    if (pendingRef.current) return;
    const requestId = crypto.randomUUID();
    pendingRef.current = requestId;
    setPending(true);
    lockedRef.current = true;
    inputLockedRef.current = true;
    try {
      ws.send(JSON.stringify({ type, requestId, ...fields }));
      timerRef.current = setTimeout(() => {
        fail('Workflow acknowledgement timed out. Automation may still be running; reconnecting to check its state.');
        ws.close();
      }, 10000);
    } catch {
      fail('Could not send workflow control. Automation may still be running; reconnecting to check its state.');
      ws.close();
    }
  }, [fail, sessionReadyRef, wsRef]);

  const start = useCallback((command, resetCommand) => {
    if (lockedRef.current) return;
    send('workflow_start', { command, resetCommand });
  }, [send]);
  const stop = useCallback(() => send('workflow_stop'), [send]);
  const disconnected = useCallback(() => {
    clearPending();
  }, [clearPending]);
  const handleMessage = useCallback(message => {
    try { validateMessage(message); }
    catch (err) {
      fail(err.message);
      wsRef.current?.close();
      return;
    }
    if (message.type === 'workflow_error') {
      if (message.requestId === pendingRef.current) clearPending();
      toastRef.current({ type: 'error', message: message.message });
      return;
    }
    const previous = stateRef.current.status;
    const acknowledged = message.requestId !== null && message.requestId === pendingRef.current;
    if (acknowledged) clearPending();
    applyState(message.state);
    if (message.state.status === 'error') {
      if (previous !== 'error') toastRef.current({ type: 'error', message: message.state.error });
    } else if (acknowledged) toastRef.current({ type: 'success', message: message.state.active ? 'Workflow started' : 'Workflow stopped' });
    else if (previous !== message.state.status && ['complete', 'needs_input'].includes(message.state.status)) {
      toastRef.current({ type: message.state.status === 'complete' ? 'success' : 'warning', message: message.state.status === 'complete' ? 'Workflow complete' : 'Workflow needs your input. Answer in the terminal, then start again when ready.' });
    }
  }, [applyState, clearPending, fail, wsRef]);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  return { state, pending, lockedRef, inputLockedRef, start, stop, disconnected, handleMessage };
}
