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

  it('uses a short copyable token and advances its counter across workflow restarts', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    expect(token(write)).toMatch(/^[a-f0-9]{8}-1$/);
    expect(write.mock.calls[0][0]).toContain('Copy the iteration identifier verbatim; do not reconstruct or invent it.');
    workflow.stop();
    workflow.start({ ...request, requestId: 'request-2' });
    expect(token(write)).toMatch(/^[a-f0-9]{8}-2$/);
    workflow.stop();
  });

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
    expect(workflow.snapshot()).toMatchObject(status === 'COMPLETE' ? { active: false, status: 'complete' } : { active: true, status: 'needs_input' });
    vi.advanceTimersByTime(10000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('pauses on NEEDS_INPUT, resumes on the user answer and continues the loop from the same iteration', () => {
    const { workflow, write, notify } = setup();
    workflow.start(request);
    const id = token(write);
    workflow.output(signal(id, 'NEEDS_INPUT'));
    expect(workflow.snapshot()).toMatchObject({ status: 'needs_input', active: true, error: null });
    expect(notify).toHaveBeenLastCalledWith(workflow.snapshot());
    workflow.output(signal(id, 'NEEDS_INPUT'));
    vi.advanceTimersByTime(60000);
    expect(write).toHaveBeenCalledTimes(1);
    workflow.input('yes, use the existing schema\r');
    expect(workflow.snapshot()).toMatchObject({ status: 'running', active: true });
    expect(notify).toHaveBeenLastCalledWith(workflow.snapshot());
    workflow.output(signal(id, 'CONTINUE'));
    expect(workflow.snapshot().status).toBe('resetting');
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenLastCalledWith('\x1b[200~/clear\x1b[201~');
    workflow.output('cleared');
    vi.advanceTimersByTime(1000);
    expect(workflow.snapshot().status).toBe('running');
    expect(token(write)).not.toBe(id);
  });

  it.each(['CONTINUE', 'COMPLETE'])('accepts %s straight from a paused iteration', status => {
    const { workflow, write } = setup();
    workflow.start(request);
    const id = token(write);
    workflow.output(signal(id, 'NEEDS_INPUT'));
    workflow.output(signal(id, status));
    expect(workflow.snapshot().status).toBe(status === 'COMPLETE' ? 'complete' : 'resetting');
  });

  it('can pause again after resuming when the agent needs another answer', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    const id = token(write);
    workflow.output(signal(id, 'NEEDS_INPUT'));
    workflow.input('1');
    workflow.output(signal(id, 'NEEDS_INPUT'));
    expect(workflow.snapshot().status).toBe('needs_input');
  });

  it.each(['\x1b[I', '\x1b[O', '\x1b[<0;10;20M'])('stays paused for terminal control input %j that is not an answer', data => {
    const { workflow, write } = setup();
    workflow.start(request);
    workflow.output(signal(token(write), 'NEEDS_INPUT'));
    workflow.input(data);
    expect(workflow.snapshot().status).toBe('needs_input');
  });

  it('ignores user input while running and Stop releases a paused workflow', () => {
    const { workflow, write, notify } = setup();
    workflow.start(request);
    const calls = notify.mock.calls.length;
    workflow.input('y');
    expect(notify).toHaveBeenCalledTimes(calls);
    workflow.output(signal(token(write), 'NEEDS_INPUT'));
    workflow.stop();
    expect(workflow.snapshot()).toMatchObject({ status: 'stopped', active: false });
  });

  it('rejects non-string input', () => {
    const { workflow } = setup();
    expect(() => workflow.input(42)).toThrow('Workflow input must be a string.');
  });

  it.each(['CONTINUE', 'COMPLETE', 'NEEDS_INPUT'])('reports a mistyped identifier in a fragmented %s signal without submitting more commands', status => {
    const { workflow, write, notify } = setup();
    workflow.start(request);
    const id = token(write);
    const wrongId = `${id[0] === '1' ? '7' : '1'}${id.slice(1)}`;
    const value = signal(wrongId, status);
    workflow.output(`\x1b[32m${value.slice(0, 20)}`);
    expect(workflow.snapshot().status).toBe('running');
    workflow.output(`${value.slice(20)}\x1b[0m`);
    expect(workflow.snapshot()).toMatchObject({
      status: 'error', active: false,
      error: 'Workflow signal identifier does not match the current iteration. The agent may have copied it incorrectly. Check the terminal, then start the workflow again.',
    });
    expect(notify).toHaveBeenLastCalledWith(workflow.snapshot());
    workflow.output(signal(id, 'CONTINUE'));
    vi.advanceTimersByTime(60000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('ignores known older signals after Stop and a new Start', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    const oldId = token(write);
    workflow.stop();
    workflow.start({ ...request, requestId: 'request-2' });
    const currentId = token(write);
    workflow.output(signal(oldId, 'CONTINUE'));
    expect(workflow.snapshot()).toMatchObject({ status: 'running', error: null });
    workflow.output(signal(currentId, 'COMPLETE'));
    expect(workflow.snapshot().status).toBe('complete');
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

  describe('maxIterations pass limit', () => {
    it('stops with limitReached on the Nth CONTINUE without arming a reset', () => {
      const { workflow, write } = setup();
      workflow.start({ ...request, maxIterations: 2 });
      expect(workflow.snapshot()).toMatchObject({ iteration: 1, limitReached: false, status: 'running' });
      workflow.output(signal(token(write), 'CONTINUE'));
      expect(workflow.snapshot().status).toBe('resetting');
      vi.advanceTimersByTime(1000);
      workflow.output('cleared');
      vi.advanceTimersByTime(1000);
      expect(workflow.snapshot()).toMatchObject({ iteration: 2, status: 'running', limitReached: false });
      const writesBeforeLimit = write.mock.calls.length;
      workflow.output(signal(token(write), 'CONTINUE'));
      expect(workflow.snapshot()).toMatchObject({ status: 'stopped', active: false, limitReached: true, iteration: 2 });
      vi.advanceTimersByTime(60000);
      expect(write).toHaveBeenCalledTimes(writesBeforeLimit);
    });

    it('stops on the first CONTINUE when maxIterations is 1', () => {
      const { workflow, write } = setup();
      workflow.start({ ...request, maxIterations: 1 });
      const writes = write.mock.calls.length;
      workflow.output(signal(token(write), 'CONTINUE'));
      expect(workflow.snapshot()).toMatchObject({ status: 'stopped', limitReached: true, iteration: 1 });
      vi.advanceTimersByTime(60000);
      expect(write).toHaveBeenCalledTimes(writes);
    });

    it('completes normally before the pass limit', () => {
      const { workflow, write } = setup();
      workflow.start({ ...request, maxIterations: 3 });
      workflow.output(signal(token(write), 'COMPLETE'));
      expect(workflow.snapshot()).toMatchObject({ status: 'complete', limitReached: false, iteration: 1 });
    });

    it('keeps unlimited CONTINUE behaviour when maxIterations is absent', () => {
      const { workflow, write } = setup();
      workflow.start(request);
      expect(workflow.snapshot()).toMatchObject({ iteration: 1, limitReached: false });
      workflow.output(signal(token(write), 'CONTINUE'));
      expect(workflow.snapshot()).toMatchObject({ status: 'resetting', limitReached: false });
      vi.advanceTimersByTime(1000);
      expect(write).toHaveBeenLastCalledWith('\x1b[200~/clear\x1b[201~');
    });

    it('user Stop does not set limitReached', () => {
      const { workflow, write } = setup();
      workflow.start({ ...request, maxIterations: 5 });
      workflow.stop();
      expect(workflow.snapshot()).toMatchObject({ status: 'stopped', limitReached: false });
    });

    it.each([0, 101, 1.5, '2', null, true])('rejects invalid maxIterations %j before writing', maxIterations => {
      const { workflow, write } = setup();
      expect(() => workflow.start({ ...request, maxIterations })).toThrow();
      expect(write).not.toHaveBeenCalled();
    });

    it.each([1, 100])('accepts boundary maxIterations %j', maxIterations => {
      const { workflow, write } = setup();
      workflow.start({ ...request, maxIterations });
      expect(write).toHaveBeenCalledTimes(1);
      expect(workflow.snapshot().status).toBe('running');
      workflow.stop();
    });

    it('rejects replay with a different maxIterations without disturbing the active workflow', () => {
      const { workflow, write } = setup();
      workflow.start({ ...request, maxIterations: 3 });
      expect(() => workflow.start({ ...request, maxIterations: 4 })).toThrow(/requestId/);
      expect(workflow.snapshot().active).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
    });

    it('acknowledges duplicate starts that share the same maxIterations', () => {
      const { workflow, write } = setup();
      workflow.start({ ...request, maxIterations: 2 });
      workflow.start({ ...request, maxIterations: 2 });
      expect(write).toHaveBeenCalledTimes(1);
    });
  });
});
