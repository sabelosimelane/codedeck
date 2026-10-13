import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalWorkflow } from '../terminal-workflow.js';

const request = { requestId: 'request-1', command: '/feature-dev docs/todos/demo.md', resetCommand: '/clear' };
function setup() {
  const write = vi.fn();
  const notify = vi.fn();
  const workflow = createTerminalWorkflow({ write, notify });
  return { workflow, write, notify };
}
function token(write) {
  return write.mock.calls.at(-1)[0].match(/Iteration identifier: ([\w-]+)/)[1];
}
const signal = (id, status) => `[[CDW:${id}:${status}]]`;

describe('terminal workflow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends Enter separately after the agent has received its pasted command', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    expect(write.mock.calls[0][0]).toMatch(/\x1b\[201~$/);
    vi.advanceTimersByTime(99);
    expect(write).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(write).toHaveBeenLastCalledWith('\r');
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('Stop cancels a pending Enter so pasted text is never submitted later', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    workflow.stop();
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatch(/\x1b\[201~$/);
  });

  it('submits one bracketed paste, preserving the command and excluding complete signal examples', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatch(/^\x1b\[200~\/feature-dev docs\/todos\/demo.md\n/);
    expect(write.mock.calls[0][0]).toMatch(/\x1b\[201~$/);
    const id = token(write);
    for (const status of ['CONTINUE', 'COMPLETE', 'NEEDS_INPUT']) {
      expect(write.mock.calls[0][0].replace(/\s/g, '')).not.toContain(signal(id, status));
    }
    workflow.output(write.mock.calls[0][0]);
    vi.advanceTimersByTime(60000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(workflow.snapshot()).toMatchObject({ status: 'running', active: true });
  });

  it('resets once after quiet, then requires reset output and quiet before the next fresh iteration', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    const first = token(write);
    workflow.output(signal(first, 'CONTINUE'));
    workflow.output(signal(first, 'CONTINUE'));
    vi.advanceTimersByTime(999);
    expect(write).toHaveBeenCalledTimes(1);
    workflow.output('finishing output');
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenLastCalledWith('\x1b[200~/clear\x1b[201~');
    vi.advanceTimersByTime(5000);
    expect(write).toHaveBeenLastCalledWith('\r');
    expect(write).toHaveBeenCalledTimes(3);
    workflow.output('new conversation\r\n> ');
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenCalledTimes(4);
    const second = token(write);
    expect(second).not.toBe(first);
    workflow.output(signal(first, 'COMPLETE'));
    expect(workflow.snapshot().active).toBe(true);
    workflow.output(signal(second, 'COMPLETE'));
    expect(workflow.snapshot()).toMatchObject({ status: 'complete', active: false });
    vi.advanceTimersByTime(60000);
    expect(write).toHaveBeenCalledTimes(4);
  });

  it.each(['COMPLETE', 'NEEDS_INPUT'])('recognises fragmented, ANSI-formatted and wrapped %s signals', status => {
    const { workflow, write } = setup();
    workflow.start(request);
    const value = signal(token(write), status);
    workflow.output('\x1b[');
    workflow.output(`32m${value.slice(0, 16)}\r\n`);
    workflow.output(`${value.slice(16)}\x1b[0m`);
    expect(workflow.snapshot()).toMatchObject({ active: false, status: status === 'COMPLETE' ? 'complete' : 'needs_input' });
    vi.advanceTimersByTime(10000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each(['before-reset', 'after-reset'])('Stop cancels pending actions %s without interrupting the agent', when => {
    const { workflow, write } = setup();
    workflow.start(request);
    workflow.output(signal(token(write), 'CONTINUE'));
    if (when === 'after-reset') {
      vi.advanceTimersByTime(1000);
      workflow.output('reset output');
    }
    const count = write.mock.calls.length;
    workflow.stop();
    vi.advanceTimersByTime(60000);
    expect(write).toHaveBeenCalledTimes(count);
    expect(workflow.snapshot()).toMatchObject({ status: 'stopped', active: false });
  });

  it('stops with an error if reset never settles', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    workflow.output(signal(token(write), 'CONTINUE'));
    vi.advanceTimersByTime(16000);
    expect(workflow.snapshot()).toMatchObject({ status: 'error', active: false, error: 'Reset did not settle within 15 seconds. Check the terminal before starting again.' });
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('acknowledges duplicate starts without resubmitting, including after Stop', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    workflow.start(request);
    workflow.stop();
    workflow.start(request);
    expect(write).toHaveBeenCalledTimes(1);
    expect(workflow.snapshot().status).toBe('stopped');
  });

  it('rejects a conflicting start without disturbing the active workflow', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    expect(() => workflow.start({ ...request, requestId: 'another' })).toThrow(/already running/);
    expect(() => workflow.start({ ...request, command: 'different' })).toThrow(/requestId/);
    expect(workflow.snapshot().active).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('surfaces write failures and cancels automation', () => {
    const { workflow, write } = setup();
    write.mockImplementation(() => { throw new Error('private transport detail'); });
    workflow.start(request);
    expect(workflow.snapshot()).toMatchObject({ status: 'error', active: false, error: 'Terminal submission failed. Check the terminal before starting again.' });
    vi.advanceTimersByTime(60000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    null, {}, { ...request, requestId: null }, { ...request, requestId: '' },
    { ...request, requestId: 'x'.repeat(129) }, { ...request, command: null },
    { ...request, command: '' }, { ...request, command: '   ' },
    { ...request, command: 'x'.repeat(16385) }, { ...request, command: '\x1b[201~evil' },
    { ...request, resetCommand: null }, { ...request, resetCommand: '' },
    { ...request, resetCommand: '/clear\nsecond command' }, { ...request, resetCommand: 'x'.repeat(257) },
    { ...request, unexpected: true },
  ])('rejects invalid start fields before writing: %#', input => {
    const { workflow, write } = setup();
    expect(() => workflow.start(input)).toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it.each([{ write: null, notify: vi.fn() }, { write: vi.fn(), notify: null }])('validates dependencies %#', dependencies => {
    expect(() => createTerminalWorkflow(dependencies)).toThrow();
  });
  it.each([null, 1, undefined])('validates output data %#', data => {
    const { workflow } = setup();
    expect(() => workflow.output(data)).toThrow(/output/);
  });
});
