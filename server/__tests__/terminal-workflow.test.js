import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTerminalWorkflow, findPassSignal } from '../terminal-workflow.js';

const request = { requestId: 'request-1', command: '/feature-dev docs/todos/demo.md', resetCommand: '/clear' };
function setup() {
  const write = vi.fn();
  const notify = vi.fn();
  const workflow = createTerminalWorkflow({ write, notify, resetTimeoutMs: 15000, handoffIdleMs: 24000 });
  return { workflow, write, notify };
}
function token(write) {
  return write.mock.calls.at(-1)[0].match(/Iteration identifier: ([\w-]+)/)[1];
}
const signal = (id, status) => `[[CDW:${id}:${status}]]`;

describe('terminal workflow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('requires positive integer timeout options', () => {
    const write = vi.fn();
    const notify = vi.fn();
    for (const resetTimeoutMs of [undefined, 0, 1.5]) {
      expect(() => createTerminalWorkflow({ write, notify, resetTimeoutMs, handoffIdleMs: 24000 })).toThrow(/resetTimeoutMs/);
    }
    for (const handoffIdleMs of [undefined, 0, 1.5]) {
      expect(() => createTerminalWorkflow({ write, notify, resetTimeoutMs: 15000, handoffIdleMs })).toThrow(/handoffIdleMs/);
    }
  });
  it('uses the configured reset deadline and names its seconds', () => {
    const write = vi.fn();
    const workflow = createTerminalWorkflow({ write, notify: vi.fn(), resetTimeoutMs: 5000, handoffIdleMs: 24000 });
    workflow.start({ ...request, resetFirst: true });
    vi.advanceTimersByTime(4999);
    expect(workflow.snapshot().status).toBe('resetting');
    vi.advanceTimersByTime(1);
    expect(workflow.snapshot().error).toBe('Reset did not settle within 5 seconds. Check the terminal before starting again.');
  });

  it('reads its timeouts when it sets each timer, so a change reaches the next pass of the same step', () => {
    const { workflow, write } = setup();
    let current = { resetTimeoutMs: 15000, handoffIdleMs: 24000 };
    workflow.readTimeoutsFrom(() => current);
    workflow.start(request);
    current = { resetTimeoutMs: 40000, handoffIdleMs: 24000 };
    workflow.output(signal(token(write), 'CONTINUE'));
    vi.advanceTimersByTime(16000);
    expect(workflow.snapshot().status).toBe('resetting');
    vi.advanceTimersByTime(25000);
    expect(workflow.snapshot().error).toBe('Reset did not settle within 40 seconds. Check the terminal before starting again.');
  });
  it('rejects a timeout source that is not a function, and invalid timeouts when it reads them', () => {
    const { workflow } = setup();
    expect(() => workflow.readTimeoutsFrom({ resetTimeoutMs: 15000, handoffIdleMs: 24000 })).toThrow(/function/);
    workflow.readTimeoutsFrom(() => ({ resetTimeoutMs: 0, handoffIdleMs: 24000 }));
    expect(() => workflow.start({ ...request, resetFirst: true })).toThrow(/resetTimeoutMs/);
    const other = setup().workflow;
    other.readTimeoutsFrom(() => ({ resetTimeoutMs: 15000, handoffIdleMs: 24000, extra: 1 }));
    expect(() => other.start({ ...request, resetFirst: true })).toThrow(/unknown/i);
  });

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

  it('exposes the quota-observation pass only after submission and before an accepted signal', () => {
    const { workflow } = setup();
    workflow.start(request);
    expect(workflow.submittedPass()).toBeNull();
    vi.advanceTimersByTime(100);
    const id = workflow.signalIdentifier();
    expect(workflow.submittedPass()).toBe(id);
    const restored = setup().workflow;
    restored.reattach(workflow.exportState());
    expect(restored.submittedPass()).toBe(id);
    workflow.output(signal(id, 'COMPLETE'));
    expect(workflow.submittedPass()).toBeNull();
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

  it('pastes a multiline command as one submission and keeps the same text on the next pass', () => {
    const { workflow, write } = setup();
    const command = 'Implement First paragraph.\n\nSecond paragraph with trailing.  \n';
    workflow.start({ ...request, command, maxIterations: 2 });
    expect(write).toHaveBeenCalledTimes(1);
    const firstPaste = write.mock.calls[0][0];
    expect(firstPaste.startsWith(`\x1b[200~${command}\n`)).toBe(true);
    expect(firstPaste.endsWith('\x1b[201~')).toBe(true);
    const first = token(write);
    workflow.output(signal(first, 'CONTINUE'));
    workflow.output('finishing');
    vi.advanceTimersByTime(1000);
    expect(write).toHaveBeenLastCalledWith('\x1b[200~/clear\x1b[201~');
    vi.advanceTimersByTime(5000);
    expect(write).toHaveBeenLastCalledWith('\r');
    workflow.output('new conversation\r\n> ');
    vi.advanceTimersByTime(1000);
    const secondPaste = write.mock.calls.at(-1)[0];
    expect(secondPaste.startsWith(`\x1b[200~${command}\n`)).toBe(true);
    expect(secondPaste.endsWith('\x1b[201~')).toBe(true);
    expect(token(write)).not.toBe(first);
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

  it('ignores split terminal color replies while waiting and preserves a real answer', () => {
    const { workflow } = setup();
    workflow.start(request);
    const id = workflow.signalIdentifier();
    workflow.output(`[[CDW:${id}:QUESTIONS]]\n1. One?\nRecommended: A\n2. Two?\nRecommended: B\n3. Three?\nRecommended: C\n4. Four?\nRecommended: D\n${signal(id, 'NEEDS_INPUT')}`);
    expect(workflow.snapshot().status).toBe('needs_input');
    workflow.input('\x1b]11;rgb:12/34/56');
    expect(workflow.snapshot().status).toBe('needs_input');
    workflow.input('/78\x07');
    expect(workflow.snapshot().status).toBe('needs_input');
    workflow.output(signal(id, 'NEEDS_INPUT'));
    expect(workflow.snapshot().status).toBe('needs_input');
    const answer = workflow.answerText('edited answer');
    workflow.input('edited answer\r');
    expect(workflow.snapshot().status).toBe('running');
    expect(answer).toContain('edited answer');
  });

  it('keeps direct terminal answers alongside a complete OSC reply', () => {
    const { workflow } = setup();
    workflow.start(request);
    const id = workflow.signalIdentifier();
    workflow.output(signal(id, 'NEEDS_INPUT'));
    workflow.input('\x1b]11;rgb:12/34/56\x07yes\r');
    expect(workflow.snapshot().status).toBe('running');
  });

  it.each(['CONTINUE', 'COMPLETE'])('accepts %s straight from a paused iteration', status => {
    const { workflow, write } = setup();
    workflow.start(request);
    const id = token(write);
    workflow.output(signal(id, 'NEEDS_INPUT'));
    workflow.output(signal(id, status));
    expect(workflow.snapshot().status).toBe(status === 'COMPLETE' ? 'complete' : 'resetting');
  });

  it('gives the agent a new identifier with an answer, so the answered request redrawn by the terminal is not a new one', () => {
    const { workflow, write, notify } = setup();
    workflow.start(request);
    const id = token(write);
    workflow.output(signal(id, 'NEEDS_INPUT'));
    const typed = workflow.answerText('Use the existing schema');
    const next = /identifier (\S+) in/.exec(typed)[1];
    expect(typed.startsWith('Use the existing schema\n\n')).toBe(true);
    expect(next).not.toBe(id);
    // Composing the answer changes nothing until it is submitted.
    expect(workflow.signalIdentifier()).toBe(id);
    workflow.input(typed);
    expect(workflow.snapshot().status).toBe('running');
    expect(workflow.signalIdentifier()).toBe(next);

    // A browser pane attaching or resizing makes tmux send the old lines again.
    const published = notify.mock.calls.length;
    workflow.output(`${signal(id, 'QUESTIONS')}\n1. Which schema?\n${signal(id, 'NEEDS_INPUT')}`);
    expect(workflow.snapshot().status).toBe('running');
    expect(notify.mock.calls.length).toBe(published);

    // Asking again uses the new identifier.
    workflow.output(signal(next, 'NEEDS_INPUT'));
    expect(workflow.snapshot().status).toBe('needs_input');
  });

  it.each(['CONTINUE', 'COMPLETE'])('accepts %s under the identifier the pass started with after an answer', status => {
    const { workflow, write } = setup();
    workflow.start(request);
    const id = token(write);
    workflow.output(signal(id, 'NEEDS_INPUT'));
    workflow.input(workflow.answerText('yes'));
    workflow.output(signal(id, status));
    expect(workflow.snapshot().status).toBe(status === 'COMPLETE' ? 'complete' : 'resetting');
  });

  it('composes an answer only while the agent waits, and only from text', () => {
    const { workflow, write } = setup();
    expect(() => workflow.answerText('yes')).toThrow('not waiting for an answer');
    workflow.start(request);
    expect(() => workflow.answerText('yes')).toThrow('not waiting for an answer');
    workflow.output(signal(token(write), 'NEEDS_INPUT'));
    expect(() => workflow.answerText('  ')).toThrow('non-empty string');
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

  it.each(['CONTINUE', 'COMPLETE', 'NEEDS_INPUT'])('asks the agent once to re-emit a mistyped identifier in a fragmented %s signal, then accepts the corrected signal', status => {
    const { workflow, write } = setup();
    workflow.start(request);
    const id = token(write);
    vi.advanceTimersByTime(100);
    const wrongId = `${id[0] === '1' ? '7' : '1'}${id.slice(1)}`;
    const value = signal(wrongId, status);
    workflow.output(`\x1b[32m${value.slice(0, 20)}`);
    expect(workflow.snapshot().status).toBe('running');
    workflow.output(`${value.slice(20)}\x1b[0m`);
    expect(workflow.snapshot()).toMatchObject({ status: 'running', active: true, error: null });
    vi.advanceTimersByTime(100);
    // First write + enter = initial prompt; next write + enter = correction reminder.
    expect(write).toHaveBeenCalledTimes(4);
    const reminder = write.mock.calls[2][0];
    expect(reminder).toContain(id);
    expect(reminder).not.toContain(`[[CDW:${id}:`);
    expect(write.mock.calls[3][0]).toBe('\r');

    workflow.output(signal(id, status));
    if (status === 'COMPLETE') expect(workflow.snapshot()).toMatchObject({ status: 'complete', active: false });
    else if (status === 'NEEDS_INPUT') expect(workflow.snapshot()).toMatchObject({ status: 'needs_input', active: true });
    else expect(workflow.snapshot()).toMatchObject({ status: 'resetting', active: true });
  });

  it.each(['CONTINUE', 'COMPLETE', 'NEEDS_INPUT'])('fails without submitting more commands if the agent mistypes the identifier a second time in a %s signal', status => {
    const { workflow, write, notify } = setup();
    workflow.start(request);
    const id = token(write);
    const wrongId = `${id[0] === '1' ? '7' : '1'}${id.slice(1)}`;
    const secondWrongId = `${id[0] === '2' ? '8' : '2'}${id.slice(1)}`;
    vi.advanceTimersByTime(100);
    workflow.output(signal(wrongId, status));
    vi.advanceTimersByTime(100);
    expect(workflow.snapshot().status).toBe('running');
    const writesAfterRetry = write.mock.calls.length;

    workflow.output(signal(secondWrongId, status));
    expect(workflow.snapshot()).toMatchObject({
      status: 'error', active: false,
      error: `Workflow signal identifier ${secondWrongId} does not match the current iteration. The agent may have copied it incorrectly. Check the terminal, then start the workflow again.`,
    });
    expect(notify).toHaveBeenLastCalledWith(workflow.snapshot());
    workflow.output(signal(id, 'CONTINUE'));
    vi.advanceTimersByTime(60000);
    expect(write).toHaveBeenCalledTimes(writesAfterRetry);
  });

  it('ignores a signal left on screen by a pass it no longer knows of, and still submits its own prompt', () => {
    // The backend restarted since that pass, so its identifier is not among those this workflow issued.
    const { workflow, write } = setup();
    workflow.start(request);
    const id = token(write);
    const leftover = signal('dd7af735-1', 'CONTINUE');
    // The agent's screen is redrawn with the earlier pass's signal before Enter is pressed.
    workflow.output(leftover);
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toBe('\r');
    expect(workflow.snapshot()).toMatchObject({ status: 'running', error: null });
    // Redrawn again while the agent works: still a leftover, not a mistyped identifier.
    workflow.output(leftover);
    vi.advanceTimersByTime(60000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(workflow.snapshot()).toMatchObject({ status: 'running', error: null });
    workflow.output(signal(id, 'COMPLETE'));
    expect(workflow.snapshot()).toMatchObject({ status: 'complete', active: false });
  });

  it('still asks for a correction when an unknown identifier first appears after the prompt was submitted', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    const id = token(write);
    workflow.output(signal('dd7af735-1', 'CONTINUE'));
    vi.advanceTimersByTime(100);
    workflow.output(signal('0bad0bad-1', 'CONTINUE'));
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenCalledTimes(4);
    expect(write.mock.calls[2][0]).toContain(`emit your final signal again using the exact iteration identifier ${id}`);
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
    expect(() => createTerminalWorkflow({ resetTimeoutMs: 15000, handoffIdleMs: 24000, ...dependencies })).toThrow();
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

describe('terminal workflow — stating what the agent needs', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('tells the agent to list its questions with a recommendation each before a NEEDS_INPUT signal', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    const prompt = write.mock.calls[0][0];
    expect(prompt).toContain('Before a NEEDS_INPUT signal');
    expect(prompt).toContain('numbered list');
    expect(prompt).toContain('Recommended:');
    expect(prompt).toContain('each choice on its own line');
    expect(prompt).toContain('a)');
    expect(prompt).toContain('b)');
    expect(prompt).toContain('at most 6');
    expect(prompt).toContain('chosen letter in parentheses, like (b), followed by why');
    expect(prompt).toContain('QUESTIONS');
    // An assembled marker in the instruction would be echoed and read back as the agent's own.
    expect(prompt.replace(/\s/g, '')).not.toContain(signal(token(write), 'QUESTIONS'));
  });

  it('does not take a questions marker for a signal', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    workflow.output(`${signal(token(write), 'QUESTIONS')}\n1. Which schema?\n`);
    expect(workflow.snapshot().status).toBe('running');
  });

  it('exposes the identifier of the iteration it is waiting on, and none once the loop has ended', () => {
    const { workflow, write } = setup();
    expect(workflow.signalIdentifier()).toBeNull();
    workflow.start(request);
    const id = token(write);
    expect(workflow.signalIdentifier()).toBe(id);
    workflow.output(signal(id, 'NEEDS_INPUT'));
    expect(workflow.signalIdentifier()).toBe(id);
    workflow.stop();
    expect(workflow.signalIdentifier()).toBeNull();
  });
});

describe('terminal workflow — starting in a terminal whose agent already worked', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resets the agent before the first pass when asked to', () => {
    const { workflow, write, notify } = setup();
    workflow.start({ ...request, resetFirst: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith('\x1b[200~/clear\x1b[201~');
    expect(workflow.snapshot()).toMatchObject({ status: 'resetting', active: true, iteration: 0 });
    expect(workflow.signalIdentifier()).toBeNull();
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'resetting' }));

    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenLastCalledWith('\r');
    workflow.output('new conversation\r\n> ');
    vi.advanceTimersByTime(999);
    expect(write).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);

    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls[2][0]).toMatch(/^\x1b\[200~\/feature-dev docs\/todos\/demo.md\n/);
    expect(workflow.snapshot()).toMatchObject({ status: 'running', iteration: 1 });
    workflow.output(signal(token(write), 'COMPLETE'));
    expect(workflow.snapshot().status).toBe('complete');
  });

  it('fails when that first reset never settles', () => {
    const { workflow, write } = setup();
    workflow.start({ ...request, resetFirst: true });
    vi.advanceTimersByTime(16000);
    expect(workflow.snapshot()).toMatchObject({ status: 'error', error: 'Reset did not settle within 15 seconds. Check the terminal before starting again.' });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('counts the pass limit from the first pass after the reset', () => {
    const { workflow, write } = setup();
    workflow.start({ ...request, resetFirst: true, maxIterations: 1 });
    vi.advanceTimersByTime(100);
    workflow.output('ready');
    vi.advanceTimersByTime(1000);
    workflow.output(signal(token(write), 'CONTINUE'));
    expect(workflow.snapshot()).toMatchObject({ status: 'stopped', limitReached: true, iteration: 1 });
  });

  it('submits the prompt at once when resetFirst is false, as when it is left out', () => {
    const { workflow, write } = setup();
    workflow.start({ ...request, resetFirst: false });
    expect(write.mock.calls[0][0]).toMatch(/^\x1b\[200~\/feature-dev/);
  });

  it.each(['yes', 1, null])('rejects resetFirst %s', (resetFirst) => {
    const { workflow, write } = setup();
    expect(() => workflow.start({ ...request, resetFirst })).toThrow('Workflow resetFirst must be true or false.');
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects a replayed start that differs in resetFirst', () => {
    const { workflow } = setup();
    workflow.start({ ...request, resetFirst: true });
    expect(() => workflow.start(request)).toThrow(/requestId/);
    expect(() => workflow.start({ ...request, resetFirst: true })).not.toThrow();
  });
});

describe('terminal workflow — guidance for the pass', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const GUIDANCE = 'The owner is not available during this run.';

  it('puts the guidance after the standard instruction and before the identifier', () => {
    const { workflow, write } = setup();
    workflow.start({ ...request, guidance: GUIDANCE });
    const prompt = write.mock.calls[0][0];
    expect(prompt).toContain(`while explaining this instruction. ${GUIDANCE}\nIteration identifier: `);
  });

  it('repeats the guidance on every pass', () => {
    const { workflow, write } = setup();
    workflow.start({ ...request, guidance: GUIDANCE });
    workflow.output(signal(token(write), 'CONTINUE'));
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(100);
    workflow.output('ready');
    vi.advanceTimersByTime(1000);
    expect(write.mock.calls.at(-1)[0]).toContain(GUIDANCE);
  });

  it('leaves the instruction as it was when there is no guidance', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    expect(write.mock.calls[0][0]).toContain('while explaining this instruction.\nIteration identifier: ');
    expect(write.mock.calls[0][0]).not.toContain('undefined');
  });

  it.each([
    ['blank', '   '],
    ['empty', ''],
    ['longer than 4000 characters', 'x'.repeat(4001)],
    ['on two lines', 'one\ntwo'],
    ['an escape sequence', 'x\x1b[201~'],
    ['a number', 5],
    ['null', null],
  ])('rejects guidance that is %s', (_label, guidance) => {
    const { workflow, write } = setup();
    expect(() => workflow.start({ ...request, guidance })).toThrow('Workflow guidance must contain 1–4000 characters on one line without terminal control codes.');
    expect(write).not.toHaveBeenCalled();
  });

  it('accepts guidance of exactly 4000 characters', () => {
    const { workflow } = setup();
    expect(() => workflow.start({ ...request, guidance: 'x'.repeat(4000) })).not.toThrow();
  });

  it('rejects a replayed start that differs in guidance', () => {
    const { workflow } = setup();
    workflow.start({ ...request, guidance: GUIDANCE });
    expect(() => workflow.start({ ...request, guidance: 'Something else.' })).toThrow(/requestId/);
    expect(() => workflow.start(request)).toThrow(/requestId/);
  });

  describe('beforePass gate (attachments are checked before every repeat)', () => {
    it('checks before the reset of a repeat and fails with its message, sending nothing more', async () => {
      const { workflow, write } = setup();
      const beforePass = vi.fn(async () => { throw new Error('Attachment attachments[0] (notes.txt) does not match the recorded size or digest.'); });
      workflow.start({ ...request, maxIterations: 3 }, { beforePass });
      expect(beforePass).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(write).toHaveBeenCalledTimes(2);
      workflow.output(signal(token({ mock: { calls: [write.mock.calls[0]] } }), 'CONTINUE'));
      await vi.advanceTimersByTimeAsync(0);
      expect(beforePass).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10000);
      expect(workflow.snapshot()).toMatchObject({
        status: 'error',
        active: false,
        error: 'Attachment attachments[0] (notes.txt) does not match the recorded size or digest.',
      });
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('resets and starts the next pass once the check passes', async () => {
      const { workflow, write } = setup();
      const beforePass = vi.fn(async () => {});
      workflow.start(request, { beforePass });
      const first = token(write);
      workflow.output(signal(first, 'CONTINUE'));
      await vi.advanceTimersByTimeAsync(1000);
      expect(write).toHaveBeenLastCalledWith('\x1b[200~/clear\x1b[201~');
      await vi.advanceTimersByTimeAsync(100);
      workflow.output('new conversation\r\n> ');
      await vi.advanceTimersByTimeAsync(1000);
      expect(token(write)).not.toBe(first);
      expect(beforePass).toHaveBeenCalledOnce();
    });

    it('does nothing after a Stop that arrives while the check is pending', async () => {
      const { workflow, write } = setup();
      let release;
      const beforePass = vi.fn(() => new Promise(resolve => { release = resolve; }));
      workflow.start(request, { beforePass });
      vi.advanceTimersByTime(100);
      workflow.output(signal(token({ mock: { calls: [write.mock.calls[0]] } }), 'CONTINUE'));
      await vi.advanceTimersByTimeAsync(0);
      workflow.stop();
      release();
      await vi.advanceTimersByTimeAsync(10000);
      expect(workflow.snapshot().status).toBe('stopped');
      expect(write).toHaveBeenCalledTimes(2);
    });

    it('rejects a beforePass that is not a function', () => {
      const { workflow } = setup();
      expect(() => workflow.start(request, { beforePass: 'yes' })).toThrow(/beforePass/);
      expect(() => workflow.start(request, { other: true })).toThrow(/unknown option/);
    });
  });

  it('pastes the prompt of the pass in progress again, with its identifier, and submits it', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    vi.advanceTimersByTime(100);
    const first = write.mock.calls[0][0];
    write.mockClear();
    workflow.resubmit();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe(first);
    vi.advanceTimersByTime(100);
    expect(write).toHaveBeenLastCalledWith('\r');
    expect(workflow.snapshot()).toMatchObject({ status: 'running', iteration: 1 });
  });

  it('presses Enter on a prompt left unsent, without pasting it again', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    vi.advanceTimersByTime(100);
    write.mockClear();
    workflow.submitDraft();
    expect(write.mock.calls).toEqual([['\r']]);
    expect(workflow.snapshot()).toMatchObject({ status: 'running', iteration: 1 });
  });

  it('says the prompt is untaken only while a pass runs and no work was seen', () => {
    const { workflow } = setup();
    expect(workflow.promptUntaken()).toBe(false);
    workflow.start(request);
    vi.advanceTimersByTime(100);
    expect(workflow.promptUntaken()).toBe(true);
    workflow.observeTurn('working', 'busy');
    expect(workflow.promptUntaken()).toBe(false);
  });

  it('refuses to press Enter on a draft when no pass is running', () => {
    const { workflow, write } = setup();
    expect(() => workflow.submitDraft()).toThrow('A draft can be submitted only while a pass is running.');
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses to send the prompt again when no pass is running', () => {
    const { workflow, write } = setup();
    expect(() => workflow.resubmit()).toThrow('The prompt can be sent again only while a pass is running.');
    workflow.start({ ...request, resetFirst: true });
    expect(() => workflow.resubmit()).toThrow('The prompt can be sent again only while a pass is running.');
    workflow.stop();
    expect(() => workflow.resubmit()).toThrow('The prompt can be sent again only while a pass is running.');
    expect(write.mock.calls.every(([text]) => !text.includes('Iteration identifier'))).toBe(true);
  });

  describe('restart recovery (exportState, reattach, replayScreen)', () => {
    it('exports active pass state and reattaches in a fresh workflow without re-sending the prompt', () => {
      const first = setup();
      expect(first.workflow.exportState()).toBeNull();
      first.workflow.start({ ...request, maxIterations: 3 });
      const id = token(first.write);
      const saved = first.workflow.exportState();
      expect(saved).toMatchObject({
        request: { ...request, maxIterations: 3 },
        status: 'running',
        phase: 'waiting',
        pass: 1,
        identifier: id,
        passIdentifiers: [id],
        issuedIdentifiers: [id],
      });

      const restored = setup();
      restored.workflow.reattach(saved);
      expect(restored.write).not.toHaveBeenCalled();
      expect(restored.workflow.snapshot()).toMatchObject({ status: 'running', active: true, iteration: 1, requestId: request.requestId });
      expect(restored.workflow.signalIdentifier()).toBe(id);

      restored.workflow.output(signal(id, 'COMPLETE'));
      expect(restored.workflow.snapshot()).toMatchObject({ status: 'complete', active: false, iteration: 1 });
      expect(restored.workflow.exportState()).toBeNull();
    });

    it('replays a matching pass signal from captured scrollback and ignores signals from earlier runs or passes', () => {
      const first = setup();
      first.workflow.start({ ...request, maxIterations: 3 });
      const pass1Id = token(first.write);
      first.workflow.output(signal(pass1Id, 'CONTINUE'));
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(100);
      first.workflow.output('cleared\r\n> ');
      vi.advanceTimersByTime(1000);
      const pass2Id = token(first.write);
      const saved = first.workflow.exportState();

      const restored = setup();
      restored.workflow.reattach(saved);
      // Scrollback contains an unrelated earlier step's signal and pass 1's signal: neither should error or complete pass 2.
      expect(restored.workflow.replayScreen(`old output ${signal('deadbeef-1', 'COMPLETE')}\n${signal(pass1Id, 'CONTINUE')}`)).toBe(false);
      expect(restored.workflow.snapshot()).toMatchObject({ status: 'running', iteration: 2 });

      // When pass 2's signal is on screen (even after an earlier NEEDS_INPUT in the same pass), replayScreen takes the latest matching signal.
      expect(restored.workflow.replayScreen(`${signal('deadbeef-1', 'COMPLETE')}\n${signal(pass2Id, 'NEEDS_INPUT')}\nanswer\n${signal(pass2Id, 'COMPLETE')}`)).toBe(true);
      expect(restored.workflow.snapshot()).toMatchObject({ status: 'complete', active: false, iteration: 2 });
    });

    it('resumes resetting timers when reattached during reset_output', () => {
      const first = setup();
      first.workflow.start({ ...request, maxIterations: 3 });
      const pass1Id = token(first.write);
      first.workflow.output(signal(pass1Id, 'CONTINUE'));
      vi.advanceTimersByTime(1000);
      const saved = first.workflow.exportState();
      expect(saved).toMatchObject({ status: 'resetting', phase: 'reset_output', pass: 1 });

      const restored = setup();
      restored.workflow.reattach(saved);
      expect(restored.write).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(restored.workflow.snapshot()).toMatchObject({ status: 'running', iteration: 2 });
      expect(restored.write).toHaveBeenCalledTimes(1);
    });

    it('doesNotFabricateMismatchedIdentifier_whenTuiDiffRenderJumpsCursorInsideSignalAndResetsRetriesOnAnswer', () => {
      const { workflow, write } = setup();
      workflow.start(request);
      const firstId = token(write);
      vi.advanceTimersByTime(100);

      // Full-screen TUI (e.g. Codex/Ratatui) diff-renders a frame where one cell inside the
      // identifier already matched the previous buffer and was skipped with a cursor jump (\x1b[18;15H),
      // or where a status timer update (\x1b[25;12H34s\x1b[18;14H) was interleaved between chunks.
      workflow.output(`[[CDW:${firstId.slice(0, 3)}\x1b[18;15H${firstId.slice(4)}:NEEDS_INPUT]]`);
      // Must NOT have treated the skipped-cell diff frame as a mistyped identifier or sent a reminder.
      expect(workflow.snapshot()).toMatchObject({ status: 'running', error: null });
      vi.advanceTimersByTime(100);
      expect(write).toHaveBeenCalledTimes(2);

      // When the rendered tmux screen is replayed (or full signal arrives), it transitions cleanly to needs_input.
      expect(workflow.replayScreen(`• [[CDW:${firstId}:QUESTIONS]]\n1. Defer iOS?\nRecommended: Yes\n[[CDW:${firstId}:NEEDS_INPUT]]`)).toBe(true);
      expect(workflow.snapshot()).toMatchObject({ status: 'needs_input', error: null });

      // Owner answers -> new identifier is issued for the rest of the pass.
      const answer = workflow.answerText('Proceed with your recommendations.');
      const nextId = answer.match(/iteration identifier ([\w-]+)/)[1];
      workflow.input('Proceed with your recommendations.\r');
      expect(workflow.snapshot()).toMatchObject({ status: 'running', error: null });

      // Even if a genuine bad-identifier retry had been used before the answer, the new identifier after an answer gets a clean retry budget,
      // and a diff-rendered frame on the new identifier must not fail the workflow.
      workflow.output(`[[CDW:${nextId.slice(0, 2)}\x1b[1C${nextId.slice(3)}:NEEDS_INPUT]]`);
      expect(workflow.snapshot()).toMatchObject({ status: 'running', error: null });
      expect(workflow.replayScreen(`• [[CDW:${nextId}:QUESTIONS]]\n1. Defer iOS?\nRecommended: Yes\n[[CDW:${nextId}:NEEDS_INPUT]]`)).toBe(true);
      expect(workflow.snapshot()).toMatchObject({ status: 'needs_input', error: null });
    });
  });

});

describe('signals a markdown renderer changed', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  // OpenCode renders [[x]] as a link: one pair of brackets is dropped and the inside is underlined.
  const rendered = (id, status) => `[\x1b[4m\x1b[38;5;73mCDW:${id}:${status}\x1b[0m\x1b[38;5;255m]`;

  it('ends the pass on a signal OpenCode showed with single brackets', () => {
    const { workflow, write } = setup();
    workflow.start(request);
    workflow.output(rendered(token(write), 'COMPLETE'));
    expect(workflow.snapshot()).toMatchObject({ status: 'complete', active: false });
  });

  it('finds a single-bracket signal on a captured screen', () => {
    const screen = `Note written.\n${rendered('74be6d45-3', 'CONTINUE')}\n`;
    expect(findPassSignal(screen, { status: 'running', phase: 'waiting', identifier: '74be6d45-3', passIdentifiers: ['74be6d45-3'] }))
      .toEqual({ id: '74be6d45-3', signal: 'CONTINUE' });
  });
});
