import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWsConnection } from '../ws-handler.js';

function fixture(runtimeType = 'pty') {
  const output = []; const exits = [];
  const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: fn => output.push(fn), onExit: fn => exits.push(fn) };
  function socket() {
    const events = {};
    return { readyState: 1, send: vi.fn(), close: vi.fn(), on: (name, fn) => { events[name] = fn; }, emit: (name, value) => events[name]?.(value) };
  }
  const ws = socket(); const sessions = new Map(); const onInput = vi.fn();
  const runtime = { type: runtimeType, spawn: () => pty, isAvailable: () => true, isSessionRecoverable: () => false };
  const req = { url: '/ws/terminal?sessionId=demo-1&cwd=/tmp&cols=100&rows=30' };
  const attach = target => handleWsConnection(target, req, sessions, runtime, new Set(), new Set(), { onInput });
  attach(ws);
  return { ws, sessions, pty, socket, attach, onInput, output: text => output.forEach(fn => fn(text)), exit: () => exits.forEach(fn => fn({ exitCode: 0 })) };
}
const start = { type: 'workflow_start', requestId: 'start-1', command: '/feature-dev demo.md', resetCommand: '/clear' };
const send = (ws, value) => ws.emit('message', JSON.stringify(value));
const messages = ws => ws.send.mock.calls.map(([data]) => JSON.parse(data));
const marker = (pty, status) => `[[CDW:${pty.write.mock.calls[0][0].match(/Iteration identifier: ([\w-]+)/)[1]}:${status}]]`;

describe('workflow over terminal WebSocket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('reports stopped state on a fresh backend session so stale browser state is cleared', () => {
    const f = fixture();
    expect(messages(f.ws)[0]).toMatchObject({ type: 'workflow_state', state: { status: 'stopped', active: false } });
  });
  it('acknowledges Start, observes automatic input, completes from live output and restores typing', async () => {
    const f = fixture();
    send(f.ws, start);
    expect(f.pty.write).toHaveBeenCalledTimes(1);
    expect(messages(f.ws)).toContainEqual(expect.objectContaining({ type: 'workflow_state', requestId: 'start-1', state: expect.objectContaining({ active: true }) }));
    await Promise.resolve();
    expect(f.onInput).toHaveBeenCalledWith('demo-1', f.pty.write.mock.calls[0][0]);
    send(f.ws, { type: 'input', data: 'y' });
    expect(f.pty.write).toHaveBeenLastCalledWith('y');
    f.output(marker(f.pty, 'COMPLETE'));
    expect(messages(f.ws).at(-2)).toMatchObject({ type: 'workflow_state', state: { status: 'complete' } });
    send(f.ws, { type: 'input', data: 'manual input' });
    expect(f.pty.write).toHaveBeenLastCalledWith('manual input');
  });
  it.each(['y', '\r', '\x1b[<0;10;20M', '\x1b[<0;10;20m'])('delivers approval input %j while running but blocks it during reset', data => {
    const f = fixture();
    send(f.ws, start);
    send(f.ws, { type: 'input', data });
    expect(f.pty.write).toHaveBeenLastCalledWith(data);
    expect(f.sessions.get('demo-1').workflow.snapshot().status).toBe('running');
    f.output(marker(f.pty, 'CONTINUE'));
    f.pty.write.mockClear();
    send(f.ws, { type: 'input', data });
    expect(f.pty.write).not.toHaveBeenCalled();
  });
  it('deduplicates Start and acknowledges Stop without sending an interrupt', () => {
    const f = fixture();
    send(f.ws, start); send(f.ws, start);
    expect(f.pty.write).toHaveBeenCalledTimes(1);
    send(f.ws, { type: 'workflow_stop', requestId: 'stop-1' });
    expect(messages(f.ws).at(-1)).toMatchObject({ type: 'workflow_state', requestId: 'stop-1', state: { status: 'stopped', active: false } });
    expect(f.pty.write).toHaveBeenCalledTimes(1);
  });
  it.each(['exit', 'delete'])('cancels a queued reset on %s', reason => {
    const f = fixture(); send(f.ws, start);
    f.output(marker(f.pty, 'CONTINUE'));
    if (reason === 'exit') f.exit();
    if (reason === 'delete') f.sessions.delete('demo-1');
    vi.advanceTimersByTime(2000);
    expect(f.pty.write).toHaveBeenCalledTimes(1);
  });
  it('continues the next pass while the browser is disconnected, then releases the attachment on completion', async () => {
    const f = fixture('tmux'); send(f.ws, start);
    vi.advanceTimersByTime(100);
    f.ws.readyState = 3;
    f.ws.emit('close');
    expect(f.pty.kill).not.toHaveBeenCalled();
    f.output(marker(f.pty, 'CONTINUE'));
    vi.advanceTimersByTime(1100);
    expect(f.pty.write.mock.calls.map(([data]) => data)).toContain('\x1b[200~/clear\x1b[201~');
    f.output('fresh prompt');
    vi.advanceTimersByTime(1100);
    const prompts = f.pty.write.mock.calls.filter(([data]) => data.includes('Iteration identifier:'));
    expect(prompts).toHaveLength(2);
    const id = prompts[1][0].match(/Iteration identifier: ([\w-]+)/)[1];
    f.output(`[[CDW:${id}:COMPLETE]]`);
    await Promise.resolve();
    expect(f.pty.kill).toHaveBeenCalledOnce();
    f.exit();
    expect(f.sessions.get('demo-1').workflow.snapshot().status).toBe('complete');
    const reconnected = f.socket(); f.attach(reconnected);
    expect(messages(reconnected)).toContainEqual(expect.objectContaining({ type: 'workflow_state', state: expect.objectContaining({ status: 'complete' }) }));
  });
  it.each(['disconnect', 'takeover'])('reattaches to the same workflow after %s without duplicate submissions, and Stop still cancels reset', reason => {
    const f = fixture('tmux'); send(f.ws, start);
    vi.advanceTimersByTime(100);
    const workflow = f.sessions.get('demo-1').workflow;
    f.output(marker(f.pty, 'CONTINUE'));
    if (reason === 'disconnect') { f.ws.readyState = 3; f.ws.emit('close'); }
    const next = f.socket(); f.attach(next);
    // A late close from the old socket cannot stop the shared workflow.
    f.ws.emit('close');
    expect(f.sessions.get('demo-1').workflow).toBe(workflow);
    expect(messages(next)[0]).toMatchObject({ type: 'workflow_state', state: { status: 'resetting', active: true } });
    send(next, start);
    expect(f.pty.write).toHaveBeenCalledTimes(2);
    send(next, { type: 'workflow_stop', requestId: 'stop-after-reconnect' });
    vi.advanceTimersByTime(10000);
    expect(f.pty.write).toHaveBeenCalledTimes(2);
    expect(workflow.snapshot().status).toBe('stopped');
  });
  it('consumes live completion during snapshot buffering so reconnect cannot lose the signal', () => {
    const f = fixture('tmux'); send(f.ws, start);
    const entry = f.sessions.get('demo-1');
    entry.attachState = { mode: 'buffer_live_output', bufferedChunks: [] };
    f.output(marker(f.pty, 'COMPLETE'));
    expect(entry.workflow.snapshot().status).toBe('complete');
  });
  it.each([
    { ...start, command: null }, { ...start, requestId: null },
    { ...start, surprise: true }, { type: 'workflow_stop', requestId: 'stop', surprise: true },
    { type: 'workflow_other', requestId: 'other' },
  ])('reports invalid controls without injecting them into the terminal %#', input => {
    const f = fixture(); send(f.ws, input);
    expect(messages(f.ws).at(-1)).toMatchObject({ type: 'workflow_error', message: expect.any(String) });
    expect(f.pty.write).not.toHaveBeenCalled();
  });
  it('does not accept replayed terminal history as a new workflow result', () => {
    const f = fixture(); send(f.ws, start);
    const entry = f.sessions.get('demo-1');
    entry.replayBuffer.push({ seq: 1, data: marker(f.pty, 'COMPLETE') });
    send(f.ws, { type: 'resume', lastSeq: 0 });
    expect(entry.workflow.snapshot().active).toBe(true);
  });
});
