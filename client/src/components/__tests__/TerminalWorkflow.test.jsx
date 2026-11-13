import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalWorkflow from '../TerminalWorkflow';
import { useTerminalWorkflow } from '../../hooks/useTerminalWorkflow';

const stopped = { status: 'stopped', active: false, error: null, requestId: null };
const running = { status: 'running', active: true, error: null, requestId: 'run-1' };
const toast = vi.hoisted(() => vi.fn());
vi.mock('../ToastContext', () => ({ useToast: () => ({ showToast: toast }) }));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('terminal workflow controls', () => {
  it('opens a command box, defaults reset to /clear and submits the supplied command', () => {
    const onStart = vi.fn();
    render(<TerminalWorkflow sessionId="terminal-1" state={stopped} pending={false} connected onStart={onStart} onStop={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    expect(screen.getByText(/Workflows continue when you switch projects or disconnect/)).toBeTruthy();
    expect(screen.getByLabelText('Reset command').value).toBe('/clear');
    expect(screen.getByRole('button', { name: 'Start' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/feature-dev feature.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStart).toHaveBeenCalledWith('/feature-dev feature.md', '/clear');
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    expect(screen.getByLabelText('Command').value).toBe('/feature-dev feature.md');
  });
  it('restores the last edited command after remounting, independently for each terminal', () => {
    const onStart = vi.fn();
    const props = { state: stopped, pending: false, connected: true, onStart, onStop: vi.fn() };
    const open = sessionId => {
      const view = render(<TerminalWorkflow {...props} sessionId={sessionId} />);
      fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
      return view;
    };
    let view = open('terminal-1');
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/feature-dev first.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    view.unmount();
    view = open('terminal-2');
    expect(screen.getByLabelText('Command').value).toBe('');
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/feature-dev second.md' } });
    view.unmount();
    view = open('terminal-1');
    expect(screen.getByLabelText('Command').value).toBe('/feature-dev first.md');
    expect(onStart).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '' } });
    view.unmount();
    view = open('terminal-1');
    expect(screen.getByLabelText('Command').value).toBe('');
    view.unmount();
    open('terminal-2');
    expect(screen.getByLabelText('Command').value).toBe('/feature-dev second.md');
  });
  it.each([undefined, null, '', 42])('rejects invalid terminal identity %s', sessionId => {
    expect(() => render(<TerminalWorkflow sessionId={sessionId} state={stopped} />)).toThrow('Workflow sessionId');
  });
  it.each(['x'.repeat(16385), 'bad\x1bcommand'])('rejects invalid persisted commands %#', command => {
    localStorage.setItem('codedeck.workflow.command:terminal-1', command);
    expect(() => render(<TerminalWorkflow sessionId="terminal-1" state={stopped} />)).toThrow('Workflow saved command');
  });
  it('disables editing while running, exposes Stop and renders backend errors', () => {
    const onStop = vi.fn();
    const props = { pending: false, connected: true, onStart: vi.fn(), onStop };
    const { rerender } = render(<TerminalWorkflow sessionId="terminal-1" {...props} state={running} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    expect(screen.getByLabelText('Command').disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
    rerender(<TerminalWorkflow sessionId="terminal-1" {...props} state={{ ...stopped, status: 'error', error: 'Reset did not settle.' }} />);
    expect(screen.getByRole('alert').textContent).toBe('Reset did not settle.');
    expect(screen.getByLabelText('Command').disabled).toBe(false);
  });
  it('shows Pass limit reached when stopped with limitReached', () => {
    render(
      <TerminalWorkflow
        sessionId="terminal-1"
        state={{ ...stopped, limitReached: true }}
        pending={false}
        connected
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('Pass limit reached');
  });
});

describe('workflow transport', () => {
  function setup() {
    const wsRef = { current: { readyState: 1, send: vi.fn(), close: vi.fn() } };
    const sessionReadyRef = { current: true };
    const hook = renderHook(() => useTerminalWorkflow({ wsRef, sessionReadyRef }));
    return { ...hook, wsRef, sessionReadyRef };
  }
  it('keeps a paused workflow stoppable and typeable, then follows it back to running', () => {
    const { result } = setup();
    const paused = { ...running, status: 'needs_input' };
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: null, state: running }));
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: null, state: paused }));
    expect(result.current.state).toEqual(paused);
    expect(result.current.inputLockedRef.current).toBe(false);
    expect(toast).toHaveBeenLastCalledWith({ type: 'warning', message: 'Workflow needs your input. Answer in the terminal; the workflow resumes when the agent continues.' });
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: null, state: running }));
    expect(result.current.state).toEqual(running);
    render(<TerminalWorkflow sessionId="terminal-1" state={paused} pending={false} connected onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('Needs input');
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });
  it('waits for acknowledgement, applies statuses and releases input on completion', () => {
    const { result, wsRef } = setup();
    act(() => result.current.start('command', '/clear'));
    const request = JSON.parse(wsRef.current.send.mock.calls[0][0]);
    expect(request).toMatchObject({ type: 'workflow_start', command: 'command', resetCommand: '/clear' });
    expect(result.current.lockedRef.current).toBe(true);
    act(() => result.current.start('command', '/clear'));
    expect(wsRef.current.send).toHaveBeenCalledOnce();
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: request.requestId, state: { ...running, requestId: request.requestId } }));
    expect(result.current.pending).toBe(false);
    expect(result.current.state.status).toBe('running');
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: null, state: { ...stopped, status: 'complete', requestId: request.requestId } }));
    expect(result.current.lockedRef.current).toBe(false);
  });
  it('retains the last running state on disconnect and accepts the server state on reconnect without resubmitting', () => {
    const { result, wsRef } = setup();
    act(() => result.current.start('command', '/clear'));
    const request = JSON.parse(wsRef.current.send.mock.calls[0][0]);
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: request.requestId, state: running }));
    act(() => result.current.disconnected());
    expect(result.current.state.status).toBe('running');
    expect(result.current.pending).toBe(false);
    expect(result.current.lockedRef.current).toBe(true);
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: null, state: { ...stopped, status: 'complete' } }));
    expect(result.current.state.status).toBe('complete');
    expect(result.current.lockedRef.current).toBe(false);
    expect(wsRef.current.send).toHaveBeenCalledOnce();
  });
  it('surfaces request errors and unavailable terminals without sending text input', () => {
    const { result, wsRef, sessionReadyRef } = setup();
    sessionReadyRef.current = false;
    act(() => result.current.start('command', '/clear'));
    expect(wsRef.current.send).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    sessionReadyRef.current = true;
    act(() => result.current.start('command', '/clear'));
    const request = JSON.parse(wsRef.current.send.mock.calls[0][0]);
    act(() => result.current.handleMessage({ type: 'workflow_error', requestId: request.requestId, message: 'Invalid command.' }));
    expect(result.current.pending).toBe(false);
    expect(result.current.lockedRef.current).toBe(false);
    expect(toast).toHaveBeenLastCalledWith({ type: 'error', message: 'Invalid command.' });
  });
  it('never reports success when Start is acknowledged with a submission error', () => {
    const { result, wsRef } = setup();
    act(() => result.current.start('command', '/clear'));
    const request = JSON.parse(wsRef.current.send.mock.calls[0][0]);
    const state = { ...stopped, status: 'error', error: 'Terminal submission failed.', requestId: request.requestId };
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: null, state }));
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: request.requestId, state }));
    expect(toast).toHaveBeenLastCalledWith({ type: 'error', message: 'Terminal submission failed.' });
    expect(result.current.pending).toBe(false);
  });
  it('reconnects to resolve a missing acknowledgement without claiming automation has stopped', () => {
    vi.useFakeTimers();
    const { result, wsRef } = setup();
    act(() => result.current.start('command', '/clear'));
    act(() => vi.advanceTimersByTime(10000));
    expect(wsRef.current.close).toHaveBeenCalledOnce();
    expect(result.current.state.status).toBe('error');
    expect(result.current.state.error).toContain('may still be running');
  });
  it.each([
    { ...stopped, status: null }, { ...stopped, active: null },
    { ...stopped, error: 42 }, { ...stopped, requestId: 42 },
    { ...stopped, active: true },
  ])('rejects malformed server state %#', state => {
    const { result } = setup();
    act(() => result.current.handleMessage({ type: 'workflow_state', requestId: null, state }));
    expect(result.current.state.status).toBe('error');
    expect(toast).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
