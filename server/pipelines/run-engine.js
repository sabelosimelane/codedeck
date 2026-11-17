/**
 * Per-run promise-chain executor (Spec §8.3–§8.9).
 * All I/O (worktree, session, attach, workflow, readiness) is injected.
 * Status transitions go through run-machine.applyEvent — never inside notify.
 */

import { applyEvent, computeActions } from './run-machine.js';
import { applySkillPrefix } from './skill-prefix.js';
import { extractQuestions } from './input-request.js';
import { buildStepGuidance } from './step-guidance.js';
import { prepare as defaultPrepareNotes, readNote as defaultReadNote } from './run-notes.js';
import { ACCEPT_RECOMMENDATIONS_ANSWER } from '../../shared/pipeline-definitions.mjs';

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ENTER_DELAY_MS = 100;
const DEFAULT_DIALOG_POLL_MS = 2000;
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running', 'needs_input', 'limit_paused']);

// A step that loops back does one pass per round; its `max` counts rounds, not passes.
function maxIterationsFor(repeat) {
  if (repeat?.mode === 'until_complete') return repeat.max;
  return 1;
}

function terminalGoneMessage(stepName) {
  return `The terminal of step ${stepName} is no longer available. Resume the run to continue in a new terminal.`;
}

function delay(ms, setTimeoutFn) {
  return new Promise(resolve => {
    setTimeoutFn(resolve, ms);
  });
}

function readinessTimeoutMessage(agentName, state, timeoutMs) {
  const reason = state?.executionReason ?? 'unknown';
  const foreground = state?.foregroundCommand ?? 'unknown';
  const seconds = Math.round(timeoutMs / 1000);
  return `Agent ${agentName} did not become ready within ${seconds} seconds (last reason: ${reason}, foreground: ${foreground}).`;
}

function setupDirtyMessage(paths) {
  const listed = paths.slice(0, 20).join('\n');
  return `Setup left uncommitted changes in the worktree${listed ? `\n${listed}` : ''}`.slice(0, 2000);
}

export function createRunEngine({
  runStore,
  createWorktree,
  startSession,
  attachBackground,
  createWorkflow,
  classifyReadiness,
  readExecutionState,
  readScreen,
  decisionStore,
  noteStore,
  prepareNotes = defaultPrepareNotes,
  readNote = defaultReadNote,
  terminalAvailable,
  removeWorktree = async () => ({ ok: true }),
  listDirtyPaths = async () => [],
  pathExists = async () => true,
  now = () => new Date().toISOString(),
  setTimeout: setTimeoutFn = setTimeout,
  readinessPollMs = DEFAULT_POLL_MS,
  readinessTimeoutMs = DEFAULT_TIMEOUT_MS,
  launchEnterDelayMs = DEFAULT_ENTER_DELAY_MS,
  dialogPollMs = DEFAULT_DIALOG_POLL_MS,
} = {}) {
  if (!runStore) throw new Error('createRunEngine: runStore is required');
  if (typeof createWorktree !== 'function') throw new Error('createRunEngine: createWorktree is required');
  if (typeof startSession !== 'function') throw new Error('createRunEngine: startSession is required');
  if (typeof attachBackground !== 'function') throw new Error('createRunEngine: attachBackground is required');
  if (typeof createWorkflow !== 'function') throw new Error('createRunEngine: createWorkflow is required');
  if (typeof classifyReadiness !== 'function') throw new Error('createRunEngine: classifyReadiness is required');
  if (typeof readExecutionState !== 'function') throw new Error('createRunEngine: readExecutionState is required');
  if (typeof readScreen !== 'function') throw new Error('createRunEngine: readScreen is required');
  if (typeof decisionStore?.add !== 'function') throw new Error('createRunEngine: decisionStore is required');
  if (typeof noteStore?.add !== 'function' || typeof noteStore?.lastContent !== 'function' || typeof noteStore?.hasPass !== 'function') throw new Error('createRunEngine: noteStore is required');
  if (typeof prepareNotes !== 'function') throw new Error('createRunEngine: prepareNotes is required');
  if (typeof readNote !== 'function') throw new Error('createRunEngine: readNote is required');
  if (typeof terminalAvailable !== 'function') throw new Error('createRunEngine: terminalAvailable is required');

  const handles = new Map();
  const noteWarnings = new Set();

  async function recordNote(run, stepIndex, pass, sweep = false) {
    if (run.definition.notesDir === null || run.definition.steps[stepIndex]?.kind !== 'node') return;
    try {
      if (!sweep && noteStore.hasPass(run.id, stepIndex, run.steps[stepIndex].attempt, pass)) return;
      const result = await readNote({ worktreePath: run.worktreePath, definition: run.definition, stepIndex });
      if (!result || !['present', 'missing', 'unreadable', 'too_large'].includes(result.status)) throw new Error('invalid note read result');
      const last = noteStore.lastContent(run.id, stepIndex);
      const changed = result.status === 'present' && result.content !== last;
      if (sweep && !changed) return;
      const status = result.status === 'present' ? changed ? 'written' : 'unchanged' : result.status;
      const summary = changed ? (result.content.split(/\r?\n/).find(line => line.trim()) ?? '').replace(/^\s*#+/, '').trim().slice(0, 200) : null;
      noteStore.add({ runId: run.id, stepIndex, stepName: run.definition.steps[stepIndex].name, attempt: run.steps[stepIndex].attempt, pass, status, summary, content: changed ? result.content : null });
    } catch (error) {
      const key = `${run.id}:${stepIndex}:${String(error?.message || error)}`;
      if (!noteWarnings.has(key)) {
        noteWarnings.add(key);
        console.warn(`[pipeline-notes] run=${run.id} step=${stepIndex} error=${error?.message || error}`);
      }
    }
  }

  async function sweepNotes(run) {
    if (run.definition.notesDir === null) return;
    for (let index = 0; index < run.definition.steps.length; index++) {
      if (run.definition.steps[index].kind === 'node' && run.steps[index].attempt > 0) {
        await recordNote(run, index, Math.max(1, run.steps[index].iteration), true);
      }
    }
  }

  function getHandle(runId) {
    let handle = handles.get(runId);
    if (!handle) {
      // `chain` serialises start/resume work. `transitions` serialises notify-driven
      // status changes and must NOT share `chain` (runStep awaits those transitions).
      handle = {
        chain: Promise.resolve(),
        transitions: Promise.resolve(),
        attachment: null,
        workflow: null,
        settleWorkflow: null,
        stopped: false,
        stopRequested: false,
        // True while the run waits because the agent's CLI shows a dialog during a pass.
        dialogPause: false,
      };
      handles.set(runId, handle);
    }
    return handle;
  }

  function enqueue(runId, task) {
    const handle = getHandle(runId);
    handle.chain = handle.chain.then(task, task);
    return handle.chain;
  }

  function enqueueTransition(runId, task) {
    const handle = getHandle(runId);
    handle.transitions = handle.transitions.then(task, task);
    return handle.transitions;
  }

  function persistTransition(runId, event) {
    const current = runStore.get(runId);
    if (!current) throw new Error(`pipeline run ${runId}: not found`);
    const next = applyEvent(current, event);
    return runStore.update(runId, {
      status: next.status,
      stopReason: next.stopReason,
      error: next.error,
      currentStepIndex: next.currentStepIndex,
      finishedAt: next.finishedAt,
      steps: next.steps,
      inputRequest: next.inputRequest,
    });
  }

  function failRun(runId, message) {
    const current = runStore.get(runId);
    if (!current || !['pending', 'running', 'needs_input', 'limit_paused'].includes(current.status)) {
      return current;
    }
    return persistTransition(runId, { type: 'error', error: String(message).slice(0, 2000), at: now() });
  }

  /** @returns {boolean} true when Setup left a dirty worktree (or status failed) and the run was failed. */
  async function failIfSetupDirty(run) {
    const defStep = run.definition.steps[run.currentStepIndex];
    if (defStep?.kind !== 'setup') return false;
    let dirty;
    try {
      dirty = await listDirtyPaths({ worktreePath: run.worktreePath });
    } catch (err) {
      failRun(run.id, String(err?.message || err || 'git status failed').slice(0, 2000));
      return true;
    }
    if (!Array.isArray(dirty) || dirty.length === 0) return false;
    failRun(run.id, setupDirtyMessage(dirty));
    return true;
  }

  async function cleanupWorktree(runId) {
    const run = runStore.get(runId);
    if (!run) return run;
    if (run.worktreeState === 'not_created') {
      return runStore.update(runId, { worktreeState: 'removed', worktreeDetail: null });
    }
    await sweepNotes(run);
    // A worktree that existed before the run belongs to the owner: the run lets go of it, git is not called.
    if (run.worktreeState === 'external') {
      return runStore.update(runId, { worktreeState: 'released', worktreeDetail: null });
    }
    if (!['present', 'removal_blocked'].includes(run.worktreeState)) {
      return run;
    }
    const result = await removeWorktree(run);
    if (result?.ok) {
      return runStore.update(runId, { worktreeState: 'removed', worktreeDetail: null });
    }
    return runStore.update(runId, {
      worktreeState: 'removal_blocked',
      worktreeDetail: String(result?.detail || 'git worktree remove failed').slice(0, 2000),
    });
  }

  /**
   * `returningStep` names the step when it returns to a terminal it already used (a later
   * round of a loop, or a Resume): nothing was launched. If its agent has exited to the shell
   * there, `launchAgent` starts it again in that terminal, once; `launched` reports that, since
   * a newly started agent has no context to clear.
   */
  async function waitUntilReady(runId, sessionId, agentName, returningStep = null, launchAgent = null) {
    let waitedMs = 0;
    let lastState = null;
    let launched = false;

    while (true) {
      await delay(readinessPollMs, setTimeoutFn);
      if (getHandle(runId).stopped) return { ok: false, reason: 'stopped' };

      lastState = await readExecutionState(sessionId);
      const result = classifyReadiness(lastState);

      if (result === 'ready') {
        const current = runStore.get(runId);
        if (current?.status === 'needs_input') {
          persistTransition(runId, { type: 'input_received' });
        }
        return { ok: true, state: lastState, launched };
      }

      if (result === 'exited') {
        if (returningStep !== null && !launched) {
          // The terminal is still there but its agent is not: start it again in this terminal.
          launched = true;
          waitedMs = 0;
          await launchAgent();
          continue;
        }
        failRun(runId, `The launch command for agent ${agentName} exited.`);
        return { ok: false, reason: 'exited' };
      }

      if (result === 'closed') {
        failRun(runId, returningStep === null || launched
          ? `The terminal closed while launching agent ${agentName}.`
          : terminalGoneMessage(returningStep));
        return { ok: false, reason: 'closed' };
      }

      if (result === 'needs_input') {
        const current = runStore.get(runId);
        if (current?.status === 'running') {
          // A dialog shown while launching is answered in the terminal; the agent signalled nothing.
          persistTransition(runId, { type: 'needs_input', inputRequest: null });
        }
        // Clock pauses while needs_input.
        continue;
      }

      // waiting — resume from needs_input if the dialog cleared
      const current = runStore.get(runId);
      if (current?.status === 'needs_input') {
        persistTransition(runId, { type: 'input_received' });
      }

      waitedMs += readinessPollMs;
      if (waitedMs >= readinessTimeoutMs) {
        failRun(runId, readinessTimeoutMessage(agentName, lastState, readinessTimeoutMs));
        return { ok: false, reason: 'timeout' };
      }
    }
  }

  /**
   * Whether a resumed step can go back to the terminal it had. Only a terminal that no
   * longer exists is replaced; an agent that exited in it is started again there.
   */
  function terminalStillThere(sessionId) {
    const available = terminalAvailable(sessionId);
    if (typeof available !== 'boolean') {
      throw new Error(`pipeline run: terminalAvailable must answer true or false for ${sessionId}`);
    }
    return available;
  }

  /**
   * The terminal in which the agent of this step already runs in this worktree, or null.
   * This run's own steps come first (the nearest earlier step, then later ones), then the
   * runs that ended in the same worktree, most recent first. An agent is the same when its
   * id and its launch command are: an edited agent starts in a terminal of its own.
   */
  function findAgentTerminal(run, stepIndex) {
    const { agent } = run.definition.steps[stepIndex];
    const terminalOf = (candidate, index) => {
      const other = candidate.definition.steps[index].agent;
      const { sessionId } = candidate.steps[index];
      if (sessionId === null || other.id !== agent.id || other.launchCommand !== agent.launchCommand) return null;
      return terminalStillThere(sessionId) ? sessionId : null;
    };

    const own = [];
    for (let index = stepIndex - 1; index >= 0; index -= 1) own.push(index);
    for (let index = stepIndex + 1; index < run.steps.length; index += 1) own.push(index);
    for (const index of own) {
      const sessionId = terminalOf(run, index);
      if (sessionId !== null) return sessionId;
    }

    // runStore.list() is ordered most recent first.
    for (const earlier of runStore.list()) {
      if (earlier.id === run.id) continue;
      if (earlier.project !== run.project || earlier.worktreePath !== run.worktreePath) continue;
      // A run that may still be typing into its terminals keeps them.
      if (ACTIVE_RUN_STATUSES.has(earlier.status)) continue;
      for (let index = earlier.steps.length - 1; index >= 0; index -= 1) {
        const sessionId = terminalOf(earlier, index);
        if (sessionId !== null) return sessionId;
      }
    }
    return null;
  }

  function endDialogPause(runId) {
    const handle = getHandle(runId);
    if (!handle.dialogPause) return;
    handle.dialogPause = false;
    if (runStore.get(runId)?.status === 'needs_input') {
      persistTransition(runId, { type: 'input_received' });
    }
  }

  /**
   * A dialog of the agent's CLI (trust, permission, a question form) blocks a pass without any
   * signal. While one is on screen the run waits for the owner, as it does for a launch dialog;
   * it is answered in the terminal. `isOver` says the step's loop has ended.
   */
  async function watchForDialog(runId, sessionId, workflow, isOver) {
    const handle = getHandle(runId);
    const over = () => isOver() || handle.stopped || handle.workflow !== workflow;
    while (true) {
      await delay(dialogPollMs, setTimeoutFn);
      if (over()) return;
      const showsDialog = classifyReadiness(await readExecutionState(sessionId)) === 'needs_input';
      await enqueueTransition(runId, async () => {
        if (over()) return;
        if (!showsDialog) {
          endDialogPause(runId);
          return;
        }
        // A request the agent signalled, or one being answered for the owner, is left alone.
        if (handle.dialogPause || runStore.get(runId)?.status !== 'running'
          || !['running', 'resetting'].includes(workflow.snapshot().status)) return;
        persistTransition(runId, { type: 'needs_input', inputRequest: null });
        handle.dialogPause = true;
      });
    }
  }

  /** What the agent printed before the NEEDS_INPUT signal of the pass its loop is waiting on. */
  async function readInputRequest(runId, run) {
    const identifier = getHandle(runId).workflow?.signalIdentifier?.();
    if (typeof identifier !== 'string') {
      throw new Error('pipeline run: the loop has no signal identifier while it waits for input');
    }
    const sessionId = run.steps[run.currentStepIndex].sessionId;
    return extractQuestions(await readScreen(sessionId), identifier);
  }

  /**
   * In a workflow whose agents decide, answer a listed request with the agent's own
   * recommendations instead of pausing the run, once per pass, and record what was decided.
   * @returns {Promise<boolean>} false when the request is the owner's to answer
   */
  async function decideForOwner(runId, run, inputRequest, snapshot) {
    const stepIndex = run.currentStepIndex;
    const defStep = run.definition.steps[stepIndex];
    // Setup follows CodeDeck's own rules; a request without a list has no recommendation to accept.
    if (!run.definition.agentsDecide || defStep.kind !== 'node' || inputRequest.questions === null) return false;
    const handle = getHandle(runId);
    const { workflow, attachment } = handle;
    const identifier = workflow.signalIdentifier();
    // An agent that asks again in the same pass was not helped by the first answer.
    if (handle.decidedIdentifier === identifier) return false;

    attachment.write(`\x1b[200~${ACCEPT_RECOMMENDATIONS_ANSWER}\x1b[201~`);
    await delay(launchEnterDelayMs, setTimeoutFn);
    // Stop, a closed terminal or the agent moving on ends the wait; nothing is submitted then.
    if (handle.stopped || handle.workflow !== workflow || workflow.snapshot().status !== 'needs_input'
      || runStore.get(runId)?.status !== 'running') {
      return true;
    }
    // Recorded before it is submitted: an answer is never sent without its record.
    decisionStore.add({
      runId,
      stepIndex,
      stepName: defStep.name,
      pass: snapshot.iteration,
      questions: inputRequest.questions,
      truncated: inputRequest.truncated,
      answer: ACCEPT_RECOMMENDATIONS_ANSWER,
    });
    handle.decidedIdentifier = identifier;
    attachment.write('\r');
    workflow.input(ACCEPT_RECOMMENDATIONS_ANSWER);
    return true;
  }

  async function applyWorkflowSnapshot(runId, snapshot) {
    if (!runStore.get(runId)) return { terminal: true };
    // The loop moved on, so the agent is past any dialog it was showing.
    endDialogPause(runId);
    const current = runStore.get(runId);
    if (['complete', 'error', 'stopped'].includes(current.status)) {
      return { terminal: true };
    }

    if (snapshot.status === 'complete') {
      if (current.definition.steps[current.currentStepIndex]?.kind === 'node') await recordNote(current, current.currentStepIndex, snapshot.iteration);
      if (current.status === 'needs_input') {
        persistTransition(runId, { type: 'input_received' });
      }
      if (await failIfSetupDirty(current)) {
        return { terminal: true };
      }
      persistTransition(runId, { type: 'step_complete', at: now() });
      return { terminal: true };
    }

    if (snapshot.status === 'error') {
      failRun(runId, snapshot.error || 'Workflow error');
      return { terminal: true };
    }

    if (snapshot.status === 'stopped' && snapshot.limitReached) {
      if (current.definition.steps[current.currentStepIndex]?.kind === 'node') await recordNote(current, current.currentStepIndex, snapshot.iteration);
      if (current.status === 'needs_input') {
        persistTransition(runId, { type: 'input_received' });
      }
      const repeat = current.definition.steps[current.currentStepIndex]?.repeat;
      if (repeat?.mode === 'once') {
        persistTransition(runId, { type: 'step_complete', at: now() });
      } else if (repeat?.mode === 'loop_back'
        && current.steps[current.currentStepIndex].roundsCompleted + 1 < repeat.max) {
        // Work is left and another round is allowed: the loop starts again at its first step.
        persistTransition(runId, { type: 'loop_back', toStepIndex: repeat.toStepIndex, at: now() });
      } else {
        persistTransition(runId, { type: 'limit_reached', at: now() });
      }
      return { terminal: true };
    }

    if (snapshot.status === 'stopped') {
      if (getHandle(runId).stopRequested) {
        return { terminal: true };
      }
      if (['pending', 'running', 'needs_input', 'limit_paused', 'interrupted'].includes(current.status)) {
        persistTransition(runId, { type: 'stop', reason: 'terminal', at: now() });
      }
      return { terminal: true };
    }

    if (snapshot.status === 'needs_input') {
      if (current.status === 'running') {
        const inputRequest = await readInputRequest(runId, current);
        // Stop, or the terminal closing, may have ended the run while the screen was read.
        if (runStore.get(runId)?.status !== 'running') return { terminal: false };
        if (await decideForOwner(runId, current, inputRequest, snapshot)) return { terminal: false };
        persistTransition(runId, { type: 'needs_input', inputRequest });
      }
      return { terminal: false };
    }

    if (snapshot.status === 'running' || snapshot.status === 'resetting') {
      if (snapshot.status === 'resetting' && snapshot.iteration >= 1 && current.definition.steps[current.currentStepIndex]?.kind === 'node') await recordNote(current, current.currentStepIndex, snapshot.iteration);
      if (current.status === 'needs_input') {
        persistTransition(runId, { type: 'input_received' });
      }
      // Read again: the transition above changed the step's status.
      const latest = runStore.get(runId);
      const step = latest.steps[latest.currentStepIndex];
      if (typeof snapshot.iteration === 'number' && step && snapshot.iteration !== step.iteration) {
        const steps = latest.steps.map((s, i) => (
          i === latest.currentStepIndex ? { ...s, iteration: snapshot.iteration } : s
        ));
        runStore.update(runId, { steps });
      }
      return { terminal: false };
    }

    return { terminal: false };
  }

  async function runStep(runId) {
    const handle = getHandle(runId);
    let attachment = null;

    try {
      let run = runStore.get(runId);
      if (!run) throw new Error(`pipeline run ${runId}: not found`);
      if (handle.stopped) return;
      if (!['pending', 'running'].includes(run.status)) {
        return;
      }

      if (run.worktreeState === 'not_created') {
        const { baseCommit } = await createWorktree(run);
        // Always record a successful create so Resume/Cleanup can see the path,
        // even if Stop won the race while create was in flight.
        run = runStore.update(runId, {
          baseCommit,
          worktreeState: 'present',
          worktreeDetail: null,
        });
      }

      if (handle.stopped) return;
      run = runStore.get(runId);
      if (!run || !['pending', 'running'].includes(run.status)) return;

      if (run.definition.notesDir !== null) await prepareNotes({ worktreePath: run.worktreePath, definition: run.definition, input: run.input });
      if (handle.stopped) return;

      const stepIndex = run.currentStepIndex;
      const defStep = run.definition.steps[stepIndex];
      const agent = defStep.agent;
      let step = run.steps[stepIndex];

      // First step of a new run, or the next pending step after advance.
      if (run.status === 'pending' || step.status === 'pending') {
        persistTransition(runId, { type: 'start', at: now() });
        run = runStore.get(runId);
        step = run.steps[stepIndex];
      }

      if (handle.stopped) return;

      // A step works in the terminal of its agent: the one it used before (an earlier round of
      // a loop, or the attempt being resumed), else one where the same agent already runs in
      // this worktree. Its agent is cleared there before the prompt is sent. Only a step whose
      // agent has no terminal gets a new one, with the agent launched in it.
      let { sessionId } = step;
      if (sessionId === null) sessionId = findAgentTerminal(run, stepIndex);
      const returning = sessionId !== null;
      if (!returning) {
        sessionId = await startSession({
          project: run.project,
          cwd: run.worktreePath,
        });
        if (handle.stopped) return;
      }
      if (step.sessionId !== sessionId) {
        const stepsWithSession = run.steps.map((s, i) => (
          i === stepIndex ? { ...s, sessionId } : s
        ));
        run = runStore.update(runId, { steps: stepsWithSession });
      }

      try {
        attachment = attachBackground(sessionId, { cwd: run.worktreePath });
      } catch (err) {
        if (!returning) throw err;
        console.warn(`[pipeline-run] returning to ${sessionId} failed for ${runId}: ${err?.message || err}`);
        throw new Error(terminalGoneMessage(defStep.name));
      }
      handle.attachment = attachment;

      if (handle.stopped) return;

      const launchAgent = async () => {
        attachment.write(agent.launchCommand);
        await delay(launchEnterDelayMs, setTimeoutFn);
        if (handle.stopped) return;
        attachment.write('\r');
      };
      if (!returning) {
        await launchAgent();
        if (handle.stopped) return;
      }

      const ready = await waitUntilReady(runId, sessionId, agent.name, returning ? defStep.name : null, launchAgent);
      if (!ready.ok) return;

      let current = runStore.get(runId);
      step = current.steps[stepIndex];
      if (step.status === 'launching') {
        current = persistTransition(runId, { type: 'step_running' });
      }

      const attempt = current.steps[stepIndex].attempt;
      // Snapshot prompts are already composed once at POST /runs (Spec §4.4). The CLI that
      // became ready decides how a leading /skill is written (Codex: $skill).
      const command = applySkillPrefix(defStep.prompt, ready.state.profile?.skillPrefix);
      const maxIterations = maxIterationsFor(defStep.repeat);
      const requestId = `run-${runId}-${stepIndex}-${attempt}`;
      const guidance = buildStepGuidance(current.definition, stepIndex, { worktreePath: current.worktreePath });

      let settled = false;
      const settleWorkflow = () => {
        if (settled) return;
        settled = true;
        handle.settleWorkflow = null;
        resolveWorkflow();
      };
      let resolveWorkflow;
      const workflowFinished = new Promise(resolve => {
        resolveWorkflow = resolve;
      });
      handle.settleWorkflow = settleWorkflow;

      // Never transition inside notify — defer onto the transitions chain.
      const onNotify = (snapshot) => {
        enqueueTransition(runId, async () => {
          try {
            const { terminal } = await applyWorkflowSnapshot(runId, snapshot);
            if (terminal) settleWorkflow();
          } catch (err) {
            const message = String(err?.message || err || 'Run failed').slice(0, 2000);
            try {
              failRun(runId, message);
            } catch (failErr) {
              console.error(`[pipeline-run] failRun after transition error failed for ${runId}:`, failErr);
            }
            settleWorkflow();
          }
        });
      };

      // Real attachBackgroundSession already owns the session's loop engine and
      // feeds PTY output into it. Prefer that engine so signals are observed.
      // Unit tests inject a bare attachment without workflow and use createWorkflow.
      let workflow = attachment.workflow;
      if (workflow) {
        if (typeof attachment.observe !== 'function') {
          throw new Error('pipeline run: attachment.workflow requires observe()');
        }
        attachment.observe(onNotify);
      } else {
        workflow = createWorkflow({
          write: (data) => attachment.write(data),
          notify: onNotify,
        });
      }
      handle.workflow = workflow;

      workflow.start({
        requestId,
        command,
        resetCommand: agent.resetCommand,
        maxIterations,
        // The agent of a returning step still holds its earlier context, unless it had exited
        // and was started again.
        resetFirst: returning && !ready.launched,
        ...(guidance === undefined ? {} : { guidance }),
      });

      watchForDialog(runId, sessionId, workflow, () => settled).catch((err) => {
        try {
          failRun(runId, String(err?.message || err || 'Run failed').slice(0, 2000));
        } catch (failErr) {
          console.error(`[pipeline-run] failRun after dialog watch error failed for ${runId}:`, failErr);
        }
        settleWorkflow();
      });

      await workflowFinished;
      await handle.transitions;
    } catch (err) {
      const message = String(err?.message || err || 'Run failed').slice(0, 2000);
      failRun(runId, message);
    } finally {
      try {
        attachment?.release?.();
      } catch (err) {
        // Release failures must not mask the run outcome, but must not be silent.
        console.error(`[pipeline-run] release failed for ${runId}:`, err);
      }
      handle.attachment = null;
      handle.workflow = null;
      handle.dialogPause = false;
    }

    if (handle.stopped) return;

    const after = runStore.get(runId);
    if (!after) return;

    if (after.status === 'running') {
      const nextStep = after.steps[after.currentStepIndex];
      if (nextStep?.status === 'pending') {
        await runStep(runId);
        return;
      }
    }

    if (after.status === 'complete') {
      await cleanupWorktree(runId);
    }
  }

  function assertActionAllowed(run, action) {
    const actions = computeActions(run);
    if (!actions[action]) {
      const err = new Error(`Action ${action} is not allowed in status ${run.status}`);
      err.code = 'ACTION_REFUSED';
      throw err;
    }
  }

  function loadActionRun(runId, action) {
    const run = runStore.get(runId);
    if (!run) throw new Error(`pipeline run ${runId}: not found`);
    assertActionAllowed(run, action);
    return run;
  }

  return {
    /**
     * Kick off (or continue) a run on its serialised promise chain.
     * Resolves when the current execution attempt finishes (complete/error/stop/pause).
     */
    start(runId) {
      const handle = getHandle(runId);
      handle.stopped = false;
      handle.stopRequested = false;
      return enqueue(runId, () => runStep(runId));
    },

    stop(runId) {
      // Must not enqueue behind runStep — that deadlocks while awaiting the workflow.
      const run = runStore.get(runId);
      if (!run) return Promise.reject(new Error(`pipeline run ${runId}: not found`));
      if (run.status === 'stopped') return Promise.resolve(run);
      try {
        assertActionAllowed(run, 'stop');
      } catch (err) {
        return Promise.reject(err);
      }
      const handle = getHandle(runId);
      handle.stopped = true;
      handle.stopRequested = true;
      try {
        handle.workflow?.stop?.();
      } catch (err) {
        console.error(`[pipeline-run] workflow.stop failed for ${runId}:`, err);
      }
      const updated = persistTransition(runId, { type: 'stop', reason: 'user', at: now() });
      handle.settleWorkflow?.();
      return Promise.resolve(updated);
    },

    async continue(runId) {
      // Refuse invalid requests before waiting behind an active execution.
      loadActionRun(runId, 'continue');
      return enqueue(runId, async () => {
        const run = loadActionRun(runId, 'continue');
        // Setup may reach its pass limit without COMPLETE; still enforce isolation.
        if (await failIfSetupDirty(run)) {
          return runStore.get(runId);
        }
        const handle = getHandle(runId);
        handle.stopped = false;
        handle.stopRequested = false;
        persistTransition(runId, { type: 'continue', at: now() });
        const after = runStore.get(runId);
        if (after.status === 'complete') {
          return cleanupWorktree(runId);
        }
        if (after.status === 'running') {
          // Acknowledge Continue immediately; keep execution on the same chain.
          enqueue(runId, () => runStep(runId)).catch((err) => {
            console.error(`[pipeline-run] continue execution failed for ${runId}:`, err);
          });
        }
        return after;
      });
    },

    async resume(runId) {
      loadActionRun(runId, 'resume');
      return enqueue(runId, async () => {
        const run = loadActionRun(runId, 'resume');
        if (['present', 'external'].includes(run.worktreeState)) {
          const exists = await pathExists(run.worktreePath);
          if (!exists) {
            const err = new Error('The worktree directory is missing');
            err.code = 'WORKTREE_MISSING';
            throw err;
          }
        }
        // The step returns to its own terminal, where its agent is cleared with the reset
        // command before the prompt is sent again. It gets a new one only when there is no
        // terminal to return to.
        const { sessionId } = run.steps[run.currentStepIndex];
        const newTerminal = sessionId === null || !terminalStillThere(sessionId);
        const handle = getHandle(runId);
        handle.stopped = false;
        handle.stopRequested = false;
        persistTransition(runId, { type: 'resume', newTerminal, at: now() });
        const updated = runStore.get(runId);
        // Acknowledge Resume immediately; keep execution on the same chain.
        enqueue(runId, () => runStep(runId)).catch((err) => {
          console.error(`[pipeline-run] resume execution failed for ${runId}:`, err);
        });
        return updated;
      });
    },

    /**
     * Type the owner's answer into the terminal of an agent that signalled NEEDS_INPUT.
     * Never enqueued behind runStep, which is awaiting that same loop.
     */
    async answer(runId, answer) {
      if (typeof answer !== 'string' || !answer.trim()) {
        throw new Error('pipeline run: answer must be a non-empty string');
      }
      loadActionRun(runId, 'answer');
      const handle = getHandle(runId);
      const unavailable = (message) => Object.assign(new Error(message), { code: 'ANSWER_UNAVAILABLE' });
      if (handle.answering) throw unavailable('An answer is already being sent to this agent.');
      const { workflow, attachment } = handle;
      // A run read back after a restart, or one whose loop already moved on, has no one to answer.
      if (!workflow || !attachment || workflow.snapshot().status !== 'needs_input') {
        throw unavailable('The agent is no longer waiting for an answer.');
      }

      handle.answering = true;
      try {
        // One bracketed paste, then a separate Enter, as the loop submits its own prompts.
        attachment.write(`\x1b[200~${answer}\x1b[201~`);
        await delay(launchEnterDelayMs, setTimeoutFn);
        if (handle.workflow !== workflow || workflow.snapshot().status !== 'needs_input') {
          throw unavailable('The agent stopped waiting while the answer was being sent.');
        }
        attachment.write('\r');
        // The loop resumes on an answer; its running snapshot moves the run out of needs_input.
        workflow.input(answer);
        await handle.transitions;
      } finally {
        handle.answering = false;
      }
      return runStore.get(runId);
    },

    async cleanup(runId) {
      loadActionRun(runId, 'cleanup');
      return enqueue(runId, async () => {
        loadActionRun(runId, 'cleanup');
        return cleanupWorktree(runId);
      });
    },

    /**
     * Session delete / GC notification (Spec §8.7).
     */
    notifySessionClosed(sessionId) {
      if (typeof sessionId !== 'string' || !sessionId) return;
      for (const run of runStore.list()) {
        if (!['pending', 'running', 'needs_input'].includes(run.status)) continue;
        const step = run.steps[run.currentStepIndex];
        if (step?.sessionId !== sessionId) continue;
        const name = run.definition.steps[run.currentStepIndex]?.name || 'step';
        const handle = getHandle(run.id);
        handle.stopped = true;
        try {
          handle.workflow?.stop?.();
        } catch (err) {
          console.error(`[pipeline-run] workflow.stop on session close failed for ${run.id}:`, err);
        }
        failRun(run.id, `The terminal for step ${name} was closed.`);
        handle.settleWorkflow?.();
      }
    },
  };
}
