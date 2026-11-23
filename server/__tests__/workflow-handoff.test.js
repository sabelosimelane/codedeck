import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { classifyTerminalExecution } from '../terminal-execution-classifier.js';
import { createTerminalWorkflow } from '../terminal-workflow.js';

const finalScreen = '◆ Pass 2 done.\n  [[CDW;b724d8c0-1:CONTINUE]]\n◆ Worked for 23m 34s · 12:04 AM · 23/Nov\n❯ ctrl+alt(option)+b sends the selected task to the background queue\n  muse-spark-1.3-contributor · high · ~ · YOLO';
const request = { requestId: 'run-incident', command: 'Develop the SOS feature', resetCommand: '/clear', maxIterations: 1 };
function setup() {
  const write = vi.fn();
  const workflow = createTerminalWorkflow({ write, notify: vi.fn() });
  return { workflow, write };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('recognizes the completed Muse incident pane on a versioned executable', () => {
  expect(classifyTerminalExecution({ paneCurrentCommand: 'muse-bin-1.4.25-R9361.1', paneDead: 0, snapshotText: finalScreen, subagentPanes: [], quietSeconds: 50 })).toMatchObject({agentCli:'muse', executionReason:'agent_prompt_idle'});
});

it.each([finalScreen, '◆ Done\n❯ '])('asks once for disposition and never repeats development after observed work', screen => {
  const { workflow, write } = setup();
  workflow.start(request);
  workflow.observeTurn('working', '');
  vi.advanceTimersByTime(120000);
  expect(workflow.snapshot().status).toBe('running');
  workflow.observeTurn('idle', screen);
  workflow.observeTurn('idle', screen);
  expect(write.mock.calls.map(([text]) => text).filter(text => text.includes(request.command))).toHaveLength(1);
  expect(write.mock.calls.map(([text]) => text).filter(text => text.includes('Do not redo'))).toHaveLength(1);
  expect(() => workflow.resubmit()).toThrow(/work/);
  vi.advanceTimersByTime(30000);
  expect(workflow.snapshot()).toMatchObject({status:'error',error:expect.stringMatching(/handoff/i)});
});

it('retains the deadline across restart and accepts a corrected disposition exactly once', () => {
  const first = setup();
  first.workflow.start(request);
  first.workflow.observeTurn('working', '');
  first.workflow.observeTurn('idle', finalScreen);
  const state = first.workflow.exportState();
  first.workflow.stop();
  vi.advanceTimersByTime(20000);
  const second = setup();
  second.workflow.reattach(state);
  second.workflow.observeTurn('idle', finalScreen);
  expect(second.write).not.toHaveBeenCalled();
  second.workflow.output(`[[CDW:${state.identifier}:CONTINUE]]`);
  vi.advanceTimersByTime(30000);
  expect(second.workflow.snapshot()).toMatchObject({status:'stopped',limitReached:true});
});

it('records prompt submission, first work, correction and accepted disposition once each', () => {
  const { workflow } = setup();
  const record = vi.fn();
  workflow.setAudit(record);
  workflow.start(request);
  vi.advanceTimersByTime(100);
  workflow.observeTurn('working','');
  workflow.observeTurn('working','');
  workflow.observeTurn('idle',finalScreen);
  workflow.observeTurn('idle',finalScreen);
  const signal = `[[CDW:${workflow.signalIdentifier()}:CONTINUE]]`;
  workflow.output(signal);
  workflow.output(signal);
  expect(record.mock.calls.map(([kind])=>kind)).toEqual(['prompt_submitted','work_observed','disposition_requested','signal_accepted']);
});

it('recognizes a damaged disposition from a fast pass without a working poll, and ignores an older pass', () => {
  const {workflow, write} = setup();
  workflow.start(request);
  const id = workflow.signalIdentifier();
  const damaged = id.replace(/^./, id[0] === 'a' ? 'b' : 'a');
  expect(workflow.observeTurn('idle', finalScreen.replace('b724d8c0-1','previous-1'))).toBe(false);
  expect(workflow.observeTurn('idle', finalScreen.replace('b724d8c0-1',damaged))).toBe(true);
  expect(write.mock.calls.filter(([text])=>text.includes('Do not redo'))).toHaveLength(1);
});

it('replays a durably accepted result after a crash even if scrollback is gone', () => {
  const first = setup();
  let saved;
  first.workflow.setAudit(kind => { if (kind === 'signal_accepted') saved = first.workflow.exportState(); });
  first.workflow.start(request);
  first.workflow.output(`[[CDW:${first.workflow.signalIdentifier()}:COMPLETE]]`);
  const second = setup();
  const record = vi.fn();
  second.workflow.setAudit(record);
  second.workflow.reattach(saved);
  expect(second.workflow.replayScreen('')).toBe(true);
  expect(second.workflow.snapshot().status).toBe('complete');
  expect(record).not.toHaveBeenCalled();
  expect(second.write).not.toHaveBeenCalled();
});

it('keeps a previous owner question from replaying Develop while its answer is being picked up', () => {
  const {workflow, write} = setup();
  workflow.start(request);
  const original = workflow.signalIdentifier();
  workflow.output(`[[CDW:${original}:NEEDS_INPUT]]`);
  workflow.answerText('Approved');
  workflow.input('Approved\r');
  const resumed = workflow.exportState();
  expect(workflow.observeTurn('idle','❯ ')).toBe(true);
  expect(()=>workflow.resubmit()).toThrow(/work/);
  expect(write.mock.calls.filter(([text])=>text.includes('Do not redo'))).toHaveLength(0);
  const restored = setup();
  restored.workflow.reattach(resumed);
  expect(()=>restored.workflow.resubmit()).toThrow(/work/);
});

it('recovers a missing signal when Muse finished between polls and the footer follows this prompt', () => {
  const {workflow, write} = setup();
  workflow.start(request);
  const prompt = 'Iteration identifier: ' + workflow.signalIdentifier();
  const done = '◆ Worked for 2s · 12:04 AM · 23/Nov';
  expect(workflow.observeTurn('idle', done + '\n' + prompt)).toBe(false);
  expect(workflow.observeTurn('idle', 'Iteration identifier: old-1\n' + done)).toBe(false);
  expect(workflow.observeTurn('idle', prompt + '\n◆ Finished\n' + done + '\n❯ ')).toBe(true);
  expect(write.mock.calls.filter(([text]) => text.includes('Do not redo'))).toHaveLength(1);
});

it('failsHandoff_whenAgentIsStillWorkingOnItsDispositionAt24Seconds', () => {
  // Equinox run 9d814171: Codex's turn was cut off by a provider notice, CodeDeck asked for the
  // disposition, the agent worked 33s more and then printed the right signal, 9s after the deadline.
  const { workflow } = setup();
  workflow.start(request);
  workflow.observeTurn('working', '');
  workflow.observeTurn('idle', 'ⓘ This content can’t be shown\n› Ask Codex to do anything');
  for (let second = 0; second < 33; second += 3) {
    vi.advanceTimersByTime(3000);
    workflow.observeTurn('working', '• Ran rg Tests run');
  }
  expect(workflow.snapshot().status).toBe('running');
  workflow.output(`[[CDW:${workflow.signalIdentifier()}:CONTINUE]]`);
  expect(workflow.snapshot()).toMatchObject({status:'stopped',limitReached:true});
});

it('still times out a disposition 24s after the agent last worked', () => {
  const { workflow } = setup();
  workflow.start(request);
  workflow.observeTurn('working', '');
  workflow.observeTurn('idle', '› ');
  vi.advanceTimersByTime(10000);
  workflow.observeTurn('working', '• Ran');
  vi.advanceTimersByTime(23000);
  expect(workflow.snapshot().status).toBe('running');
  vi.advanceTimersByTime(2000);
  expect(workflow.snapshot()).toMatchObject({status:'error',error:expect.stringMatching(/handoff/i)});
});

it('failsRun_whenTheSameUnrecognisedSignalIsRedrawnBeforeTheAgentCanAnswer', () => {
  // Equinox run 9d814171, Review attempts 6 and 8: the correction was requested and the run failed
  // 4ms and 190ms later, while the agent was still working or had printed the right signal.
  const { workflow } = setup();
  const record = vi.fn();
  workflow.setAudit(record);
  workflow.start(request);
  workflow.observeTurn('working', '');
  workflow.output('[[CDW:deadbeef-9:CONTINUE]]');
  vi.advanceTimersByTime(4);
  workflow.output('[[CDW:deadbeef-9:CONTINUE]]');
  expect(workflow.snapshot().status).toBe('running');
  workflow.output(`[[CDW:${workflow.signalIdentifier()}:COMPLETE]]`);
  expect(workflow.snapshot().status).toBe('complete');
  expect(record.mock.calls.find(([kind]) => kind === 'disposition_requested')?.[1]).toContain('deadbeef-9');
});

it('still fails a pass whose agent never gives the right identifier, naming the one it gave', () => {
  const { workflow } = setup();
  workflow.start(request);
  workflow.observeTurn('working', '');
  workflow.output('[[CDW:deadbeef-9:CONTINUE]]');
  vi.advanceTimersByTime(25000);
  expect(workflow.snapshot()).toMatchObject({status:'error', error: expect.stringContaining('deadbeef-9')});
});
