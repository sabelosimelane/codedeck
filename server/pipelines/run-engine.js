import { execFile } from 'node:child_process';
import { inspectCommitWorktree as inspectGitWorktree } from './run-worktree.js';
import { WORKFLOW_TEMPLATES } from '../../shared/workflow-templates.mjs';
/**
 * Per-run promise-chain executor (Spec §8.3–§8.9).
 * All I/O (worktree, session, attach, workflow, readiness) is injected.
 * Status transitions go through run-machine.applyEvent — never inside notify.
 */

import { applyEvent, computeActions } from './run-machine.js';
import { findPassSignal } from '../terminal-workflow.js';
import { applySkillPrefix } from './skill-prefix.js';
import { extractQuestions } from './input-request.js';
import { buildStepGuidance } from './step-guidance.js';
import { planRunTerminalMuting } from './run-terminal-muting.js';
import { writeCommitNote, prepare as defaultPrepareNotes, readNote as defaultReadNote, writeFeedback as defaultWriteFeedback, writeBrief as defaultWriteBrief } from './run-notes.js';
import { listAttachmentCopiesAtRisk as defaultListAttachmentsAtRisk, verifyAttachmentCopies as defaultVerifyAttachments } from './attachment-verify.js';
import { ACCEPT_RECOMMENDATIONS_ANSWER, NO_PROGRESS_ROUNDS } from '../../shared/pipeline-definitions.mjs';

const verificationPrompts = new Set(WORKFLOW_TEMPLATES.filter(t => ['bugfix', 'troubleshoot'].includes(t.kind)).map(t => t.nodes.at(-2).prompt));
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ENTER_DELAY_MS = 100;
const DEFAULT_DIALOG_POLL_MS = 2000;
// How long an agent may sit idle at an unchanged prompt while its pass runs before the prompt
// is taken to be lost: it is sent once more, and then the run fails.
const DEFAULT_PROMPT_PICKUP_MS = 30_000;
// Readings of an unchanged shell, after a launch, that mean the launch command never arrived.
const LAUNCH_LOST_READINGS = 3;
// Consecutive dialog readings required before pausing a running step, preventing transient TUI redraw flaps.
const DIALOG_DEBOUNCE_READINGS = 2;
// Consecutive exited/closed readings required before failing a running step mid-pass.
const EXIT_DEBOUNCE_READINGS = 2;
// Log a stall warning if a running step's screen stays unchanged for 15 minutes while not idle at prompt.
const SILENT_STALL_WARN_MS = 15 * 60 * 1000;
const INTERRUPTIBLE_RUN_STATUSES = new Set(['pending', 'running', 'needs_input']);

/**
 * Whether a launch command written into a terminal never reached its shell: the screen is the
 * one it showed before the launch, or the command appears nowhere on it (it would be echoed).
 * Whitespace is ignored, since a long command wraps across lines.
 */
function launchNeverArrived(state, before, launchCommand) {
  const screen = Array.isArray(state?.lines) ? state.lines.join('\n') : '';
  if (before !== null && screen === before) return true;
  const flat = text => text.replace(/\s/g, '');
  return !flat(screen).includes(flat(launchCommand));
}
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running', 'needs_input', 'limit_paused', 'awaiting_approval']);
// Execution reasons that say the agent, or a sub-agent it started, is in the middle of a turn.
const AGENT_AT_WORK = new Set(['agent_working', 'agent_delegated']);

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

/** `repository` is named when the run's task has more than one worktree to tell apart. */
function setupDirtyMessage(paths, repository) {
  const listed = paths.slice(0, 20).join('\n');
  return `Setup left uncommitted changes in the worktree${repository ? ` of ${repository}` : ''}${listed ? `\n${listed}` : ''}`.slice(0, 2000);
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
  readProgressCount,
  decisionStore,
  noteStore,
  reviewStore,
  prepareNotes = defaultPrepareNotes,
  readNote = defaultReadNote,
  writeFeedback = defaultWriteFeedback,
  writeBrief = defaultWriteBrief,
  verifyAttachments = defaultVerifyAttachments,
  listAttachmentsAtRisk = defaultListAttachmentsAtRisk,
  answerStore,
  terminalAvailable,
  setTerminalMuted,
  // Starts the terminal of an agent that takes no input again with a fresh shell, ending the agent.
  restartAgentTerminal,
  // Types a line into a terminal's pane directly, not through an attachment, and presses Enter.
  typeIntoTerminal,
  // What a terminal's pane and its attachments are doing, for the log.
  inspectTerminal,
  // Whether a terminal's pane is inside a folder: a step returns only to a terminal in its worktree.
  terminalInFolder,
  // Told what a step wrote once its note is stored; nothing it does can affect the run.
  onNoteWritten = () => {},
  removeWorktree = async () => ({ ok: true }),
  listDirtyPaths = async () => [],
  inspectCommitWorktree = entry => inspectGitWorktree(entry, execFile),
  // Where a run may work and read: the worktrees of its task and the project's other repositories.
  // Left out, a run has only its own worktree.
  listRunPlaces = async () => undefined,
  pathExists = async () => true,
  canReclaimReleasedTaskWorktree = () => false,
  now = () => new Date().toISOString(),
  setTimeout: setTimeoutFn = setTimeout,
  readinessPollMs = DEFAULT_POLL_MS,
  readinessTimeoutMs = DEFAULT_TIMEOUT_MS,
  launchEnterDelayMs = DEFAULT_ENTER_DELAY_MS,
  dialogPollMs = DEFAULT_DIALOG_POLL_MS,
  promptPickupMs = DEFAULT_PROMPT_PICKUP_MS,
} = {}) {
  if (!runStore) throw new Error('createRunEngine: runStore is required');
  if (typeof createWorktree !== 'function') throw new Error('createRunEngine: createWorktree is required');
  if (typeof startSession !== 'function') throw new Error('createRunEngine: startSession is required');
  if (typeof attachBackground !== 'function') throw new Error('createRunEngine: attachBackground is required');
  if (typeof createWorkflow !== 'function') throw new Error('createRunEngine: createWorkflow is required');
  if (typeof classifyReadiness !== 'function') throw new Error('createRunEngine: classifyReadiness is required');
  if (typeof readExecutionState !== 'function') throw new Error('createRunEngine: readExecutionState is required');
  if (typeof canReclaimReleasedTaskWorktree !== 'function') throw new TypeError('createRunEngine: canReclaimReleasedTaskWorktree must be a function');
  if (typeof readScreen !== 'function') throw new Error('createRunEngine: readScreen is required');
  if (typeof inspectCommitWorktree !== 'function') throw new TypeError('createRunEngine: inspectCommitWorktree must be a function');
  if (typeof readProgressCount !== 'function') throw new Error('createRunEngine: readProgressCount is required');
  if (typeof decisionStore?.add !== 'function') throw new Error('createRunEngine: decisionStore is required');
  if (typeof noteStore?.add !== 'function' || typeof noteStore?.lastContent !== 'function' || typeof noteStore?.hasPass !== 'function' || typeof noteStore?.latestByStep !== 'function') throw new Error('createRunEngine: noteStore is required');
  if (typeof reviewStore?.add !== 'function' || typeof reviewStore?.listSentBack !== 'function') throw new Error('createRunEngine: reviewStore is required');
  if (typeof prepareNotes !== 'function') throw new Error('createRunEngine: prepareNotes is required');
  if (typeof readNote !== 'function') throw new Error('createRunEngine: readNote is required');
  if (typeof writeFeedback !== 'function') throw new Error('createRunEngine: writeFeedback is required');
  if (typeof writeBrief !== 'function') throw new Error('createRunEngine: writeBrief is required');
  if (typeof verifyAttachments !== 'function') throw new Error('createRunEngine: verifyAttachments is required');
  if (typeof listAttachmentsAtRisk !== 'function') throw new Error('createRunEngine: listAttachmentsAtRisk is required');
  if (typeof answerStore?.add !== 'function' || typeof answerStore?.list !== 'function') throw new Error('createRunEngine: answerStore is required');
  if (typeof terminalAvailable !== 'function') throw new Error('createRunEngine: terminalAvailable is required');
  if (typeof setTerminalMuted !== 'function') throw new Error('createRunEngine: setTerminalMuted is required');
  if (typeof restartAgentTerminal !== 'function') throw new Error('createRunEngine: restartAgentTerminal must be a function');
  if (typeof typeIntoTerminal !== 'function') throw new Error('createRunEngine: typeIntoTerminal must be a function');
  if (typeof inspectTerminal !== 'function') throw new Error('createRunEngine: inspectTerminal must be a function');
  if (typeof terminalInFolder !== 'function') throw new Error('createRunEngine: terminalInFolder must be a function');
  if (!Number.isInteger(promptPickupMs) || promptPickupMs <= 0) throw new Error(`createRunEngine: promptPickupMs must be a positive integer, got ${promptPickupMs}`);

  const handles = new Map();
  const noteWarnings = new Set();
  const progressWarnings = new Set();
  const mutingWarnings = new Set();

  function syncTerminalMuting(runId, stored) {
    for (const [sessionId, muted] of planRunTerminalMuting(stored)) {
      try {
        setTerminalMuted(sessionId, muted);
      } catch (error) {
        const key = JSON.stringify([runId, sessionId]);
        if (!mutingWarnings.has(key)) {
          mutingWarnings.add(key);
          console.warn(`[pipeline-terminal-muting] run=${runId} session=${sessionId} error=${error?.message || error}`);
        }
      }
    }
  }

  function updateRun(runId, patch) {
    const stored = runStore.update(runId, patch);
    syncTerminalMuting(runId, stored);
    return stored;
  }

  function persistWorkflowState(runId, workflow) {
    const current = runStore.get(runId);
    if (!current || !['running', 'needs_input'].includes(current.status)) return;
    const exported = typeof workflow?.exportState === 'function' ? workflow.exportState() : null;
    updateRun(runId, { workflowState: exported });
  }

  function markRunInterrupted(runId) {
    const stored = runStore.markInterrupted(runId);
    syncTerminalMuting(runId, stored);
    return stored;
  }

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
      if (status === 'written') onNoteWritten({ runId: run.id, taskId: run.taskId, input: run.input, stepIndex, content: result.content });
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
        lastTasksDone: null,
        roundsWithoutProgress: 0,
        // Set when an agent that takes no input is to be started again: its terminal and folder.
        agentRestart: null,
        // `${stepIndex}:${attempt}` of the attempt that relaunched an agent after a restart.
        restartedAttempt: null,
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
    return updateRun(runId, {
      ...(next.definition !== current.definition && { definition: next.definition }),
      status: next.status,
      stopReason: next.stopReason,
      error: next.error,
      currentStepIndex: next.currentStepIndex,
      finishedAt: next.finishedAt,
      steps: next.steps,
      inputRequest: next.inputRequest,
      ...(!['running', 'needs_input'].includes(next.status) ? { workflowState: null } : {}),
    });
  }

  function failRun(runId, message) {
    const current = runStore.get(runId);
    if (!current || !['pending', 'running', 'needs_input', 'limit_paused'].includes(current.status)) {
      return current;
    }
    return persistTransition(runId, { type: 'error', error: String(message).slice(0, 2000), at: now() });
  }

  /**
   * Rewrites the run's brief: its input and every question answered so far, by the owner
   * or by an agent allowed to decide. A brief that cannot be written is reported; the
   * run goes on, because the answer itself has already reached the agent.
   */
  async function refreshBrief(runId) {
    const run = runStore.get(runId);
    if (!run || run.definition.notesDir === null) return;
    try {
      const entries = [
        ...decisionStore.list(run.id, { offset: 0, limit: 100, direction: 'asc' }).map(item => ({ ...item, by: 'agent' })),
        ...answerStore.list(run.id).map(item => ({ ...item, by: 'owner' })),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await writeBrief({
        worktreePath: run.worktreePath,
        definition: run.definition,
        input: run.input,
        entries,
        attachments: run.attachments,
      });
    } catch (err) {
      console.error(`[pipeline-run] brief could not be written for ${runId}:`, err);
    }
  }

  /** @returns {boolean} true when Setup left a dirty worktree (or status failed) and the run was failed. */
  async function failIfSetupDirty(run) {
    const defStep = run.definition.steps[run.currentStepIndex];
    if (defStep?.kind !== 'setup') return false;
    // Setup prepares every worktree of the run's task, so each must be left clean.
    let checked;
    try {
      const places = await listRunPlaces(run);
      checked = places === undefined ? [{ repository: null, path: run.worktreePath }]
        : places.worktrees.map(entry => ({ repository: places.worktrees.length > 1 ? entry.repository : null, path: entry.path }));
      for (const entry of checked) entry.dirty = await listDirtyPaths({ worktreePath: entry.path });
    } catch (err) {
      failRun(run.id, String(err?.message || err || 'git status failed').slice(0, 2000));
      return true;
    }
    const left = checked.find(entry => Array.isArray(entry.dirty) && entry.dirty.length > 0);
    if (!left) return false;
    failRun(run.id, setupDirtyMessage(left.dirty, left.repository));
    return true;
  }

  /**
   * A run that completed. In a worktree that existed before it (a task's, or Main) it stays open,
   * so the owner sees that it finished and what it left, until they close it, start another run
   * there or finish the task. A worktree the run created for itself is removed as before.
   */
  async function finishComplete(runId) {
    const run = runStore.get(runId);
    if (run?.worktreeState !== 'external') return cleanupWorktree(runId);
    await sweepNotes(run);
    return runStore.get(runId);
  }

  async function cleanupWorktree(runId) {
    const run = runStore.get(runId);
    if (!run) return run;
    if (run.worktreeState === 'not_created') {
      return updateRun(runId, { worktreeState: 'removed', worktreeDetail: null });
    }
    await sweepNotes(run);
    // A worktree that existed before the run belongs to the owner: the run lets go of it, git is not called.
    if (run.worktreeState === 'external') {
      return updateRun(runId, { worktreeState: 'released', worktreeDetail: null });
    }
    if (!['present', 'removal_blocked'].includes(run.worktreeState)) {
      return run;
    }
    // git worktree remove drops ignored files, and attachments are ignored: only verified run-owned copies may go with it.
    const atRisk = await listAttachmentsAtRisk({
      worktreePath: run.worktreePath,
      attachments: run.attachments,
      notesDir: run.definition.notesDir,
    });
    if (atRisk.length > 0) {
      return updateRun(runId, {
        worktreeState: 'removal_blocked',
        worktreeDetail: ['Attachment copies that do not match the run manifest would be lost:', ...atRisk.slice(0, 20)].join('\n').slice(0, 2000),
      });
    }
    const result = await removeWorktree(run);
    if (result?.ok) {
      return updateRun(runId, { worktreeState: 'removed', worktreeDetail: null });
    }
    return updateRun(runId, {
      worktreeState: 'removal_blocked',
      worktreeDetail: String(result?.detail || 'git worktree remove failed').slice(0, 2000),
    });
  }

  /**
   * `returningStep` names the step when it returns to a terminal it already used (a later
   * round of a loop, or a Resume): nothing was launched. If its agent has exited to the shell
   * there, `launchAgent` starts it again in that terminal, once; `launched` reports that, since
   * a newly started agent has no context to clear. The readiness limit counts only the time such
   * a terminal's agent is neither at its prompt nor working: work it was already doing is
   * finished first, however long it takes.
   */
  async function waitUntilReady(runId, sessionId, agentName, returningStep = null, launchAgent = null, launchCommand = null) {
    let waitedMs = 0;
    let lastState = null;
    let launched = false;
    // A launch command can be lost on its way to the shell. After a launch that the shell shows no
    // sign of, it is typed into the pane directly once; then the run fails saying so.
    let screenBeforeLaunch = null;
    let lostReadings = 0;
    let typedDirectly = false;

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
          screenBeforeLaunch = Array.isArray(lastState?.lines) ? lastState.lines.join('\n') : null;
          await launchAgent();
          continue;
        }
        if (typeof launchCommand === 'string' && launchNeverArrived(lastState, screenBeforeLaunch, launchCommand)) {
          lostReadings += 1;
          if (lostReadings < LAUNCH_LOST_READINGS) continue;
          lostReadings = 0;
          if (!typedDirectly) {
            typedDirectly = true;
            let terminal;
            try {
              terminal = JSON.stringify(await inspectTerminal(sessionId));
            } catch (err) {
              terminal = `could not be inspected: ${err?.message || err}`;
            }
            console.warn(`[pipeline-run] ${runId}: the launch command for ${agentName} did not reach ${sessionId}; terminal ${terminal}; typing it into the terminal directly`);
            screenBeforeLaunch = Array.isArray(lastState?.lines) ? lastState.lines.join('\n') : null;
            await typeIntoTerminal(sessionId, launchCommand);
            continue;
          }
          failRun(runId, `The launch command for agent ${agentName} never reached its terminal ${sessionId}, also when typed into it directly. Check the terminal, then Resume.`);
          return { ok: false, reason: 'launch_lost' };
        }
        failRun(runId, `The launch command for agent ${agentName} exited.`);
        return { ok: false, reason: 'exited' };
      }
      lostReadings = 0;

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

      // The limit is on a launch. An agent that is still working where the step returns is
      // waited for (Stop does not interrupt it); Stop, or the terminal closing, ends that wait.
      if (returningStep !== null && !launched && AGENT_AT_WORK.has(lastState?.executionReason)) continue;

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
  async function watchForDialog(runId, sessionId, workflow, isOver, { agentName, stepName, settle, cwd, restartedAttempt }) {
    const handle = getHandle(runId);
    const over = () => isOver() || handle.stopped || handle.workflow !== workflow;
    // A pass whose agent sits idle at an unchanged prompt never took its prompt (the CLI was
    // still clearing or starting when it was pasted, or stopped reading input). It is sent once
    // more; then the agent's terminal is started again and the step relaunches its agent there.
    // An agent started again that still takes nothing fails the run, rather than show a pass as
    // running that nothing works on. A pass in which the agent asked for input is left alone: it
    // was working, and the owner's answer came after.
    let pickup = { pass: null, idleMs: 0, resent: false, asked: false, screen: null };
    let silentStall = { pass: null, unchangedMs: 0, warned: false, screen: null };
    let dialogReadings = 0;
    let exitedReadings = 0;
    const watchPickup = (readiness, screen) => {
      const pass = workflow.snapshot();
      if (pass.iteration !== pickup.pass) pickup = { pass: pass.iteration, idleMs: 0, resent: false, asked: false, screen: null };
      if (pass.iteration !== silentStall.pass) silentStall = { pass: pass.iteration, unchangedMs: 0, warned: false, screen: null };
      if (pass.status === 'needs_input') pickup.asked = true;
      const unchanged = pickup.screen !== null && pickup.screen === screen;
      pickup.screen = screen;
      const stallUnchanged = silentStall.screen !== null && silentStall.screen === screen;
      silentStall.screen = screen;
      if (pass.status === 'running' && !handle.dialogPause && runStore.get(runId)?.status === 'running' && readiness !== 'ready' && stallUnchanged) {
        silentStall.unchangedMs += dialogPollMs;
        if (!silentStall.warned && silentStall.unchangedMs >= SILENT_STALL_WARN_MS) {
          silentStall.warned = true;
          console.warn(`[pipeline-run] ${runId}: step ${stepName} has shown no screen change for ${Math.round(silentStall.unchangedMs / 60000)}m in ${sessionId}`);
        }
      } else {
        silentStall.unchangedMs = 0;
        silentStall.warned = false;
      }
      if (pass.status !== 'running' || pickup.asked || handle.dialogPause
        || runStore.get(runId)?.status !== 'running' || readiness !== 'ready' || !unchanged) {
        pickup.idleMs = 0;
        return;
      }
      pickup.idleMs += dialogPollMs;
      if (pickup.idleMs < promptPickupMs) return;
      pickup.idleMs = 0;
      if (!pickup.resent) {
        pickup.resent = true;
        console.warn(`[pipeline-run] ${runId}: step ${stepName} left its prompt untaken in ${sessionId}; sending it again`);
        workflow.resubmit();
        return;
      }
      if (restartedAttempt) {
        failRun(runId, `The agent ${agentName} did not start step ${stepName}, also after it was started again in its terminal: it stays idle at an unchanged prompt and takes no input. Check the terminal, then Resume.`);
        workflow.stop();
        settle();
        return;
      }
      console.warn(`[pipeline-run] ${runId}: step ${stepName} still has not taken its prompt in ${sessionId}; starting its agent again`);
      handle.agentRestart = { sessionId, cwd };
      workflow.stop();
      settle();
    };
    while (true) {
      await delay(dialogPollMs, setTimeoutFn);
      if (over()) return;
      const state = await readExecutionState(sessionId);
      const readiness = classifyReadiness(state);
      const showsDialog = readiness === 'needs_input';
      const screen = Array.isArray(state?.lines) ? state.lines.join('\n') : null;
      await enqueueTransition(runId, async () => {
        if (over()) return;
        if (readiness === 'exited' || readiness === 'closed') {
          if (['running', 'needs_input'].includes(runStore.get(runId)?.status)
            && ['running', 'resetting', 'needs_input'].includes(workflow.snapshot().status)) {
            exitedReadings += 1;
            if (exitedReadings >= EXIT_DEBOUNCE_READINGS) {
              const message = readiness === 'closed'
                ? terminalGoneMessage(stepName)
                : `The agent ${agentName} exited during step ${stepName}. Check the terminal, then Resume.`;
              failRun(runId, message);
              workflow.stop();
              settle();
              return;
            }
          }
          return;
        }
        exitedReadings = 0;
        watchPickup(readiness, screen);
        if (over()) return;
        if (!showsDialog) {
          dialogReadings = 0;
          endDialogPause(runId);
          return;
        }
        dialogReadings += 1;
        if (dialogReadings < DIALOG_DEBOUNCE_READINGS) return;
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
    // A step marked to always ask the owner keeps its questions for the owner.
    if (!run.definition.agentsDecide || defStep.kind !== 'node' || defStep.askOwner === true || inputRequest.questions === null) return false;
    const handle = getHandle(runId);
    const { workflow, attachment } = handle;
    const identifier = workflow.signalIdentifier();
    // An agent that asks again in the same pass was not helped by the first answer.
    if (handle.decidedIdentifier === identifier) return false;

    // The loop adds a new identifier for the rest of the pass, so the answered request is never read again as a new one.
    const typed = workflow.answerText(ACCEPT_RECOMMENDATIONS_ANSWER);
    attachment.write(`\x1b[200~${typed}\x1b[201~`);
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
    await refreshBrief(runId);
    attachment.write('\r');
    workflow.input(typed);
    // The identifier the agent now signals under: asking again under it is asking again in this pass.
    handle.decidedIdentifier = workflow.signalIdentifier();
    return true;
  }

  // Read the exact attempt: a note from a previous failed round cannot substantiate this one.
  function verificationOutcome(run, index) {
    const note = noteStore.latestByStep(run.id).get(index);
    if (note?.attempt !== run.steps[index].attempt || note.status !== 'written') {
      throw new Error(`${run.definition.steps[index].name} requires an updated verification note for this attempt`);
    }
    const content = noteStore.lastContent(run.id, index);
    if (!content?.trim()) throw new Error('The verification note must describe the outcome');
    return content;
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
      if (verificationPrompts.has(current.definition.steps[current.currentStepIndex].prompt)) verificationOutcome(current, current.currentStepIndex);
      if (current.status === 'needs_input') {
        persistTransition(runId, { type: 'input_received' });
      }
      if (await failIfSetupDirty(current)) {
        return { terminal: true };
      }
      persistTransition(runId, { type: current.definition.steps[current.currentStepIndex]?.approval ? 'approval_requested' : 'step_complete', at: now() });
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
        persistTransition(runId, { type: current.definition.steps[current.currentStepIndex]?.approval ? 'approval_requested' : 'step_complete', at: now() });
      } else if (repeat?.mode === 'loop_back'
        && current.steps[current.currentStepIndex].roundsCompleted + 1 < repeat.max) {
        // Work is left and another round is allowed: the loop starts again at its first step.
        const handle = getHandle(runId);
        let progress = null;
        try {
          progress = await readProgressCount(current);
          if (progress !== null && (!Number.isSafeInteger(progress?.tasksDone) || progress.tasksDone < 0
            || !Number.isSafeInteger(progress?.tasksTotal) || progress.tasksTotal < 0 || progress.tasksDone > progress.tasksTotal)) {
            throw new TypeError('readProgressCount must return null or valid task totals');
          }
        } catch (error) {
          if (!progressWarnings.has(runId)) {
            progressWarnings.add(runId);
            console.warn(`[pipeline-progress-guard] run=${runId} read failed: ${error?.message || error}`);
          }
          progress = null;
        }
        if (progress === null) {
          handle.lastTasksDone = null;
          handle.roundsWithoutProgress = 0;
        } else {
          if (handle.lastTasksDone !== null) {
            handle.roundsWithoutProgress = progress.tasksDone > handle.lastTasksDone ? 0 : handle.roundsWithoutProgress + 1;
          }
          handle.lastTasksDone = progress.tasksDone;
        }
        persistTransition(runId, { type: 'loop_back', toStepIndex: repeat.toStepIndex, at: now() });
        if (handle.roundsWithoutProgress >= NO_PROGRESS_ROUNDS) {
          persistTransition(runId, { type: 'stop', reason: 'no_progress', at: now() });
          handle.lastTasksDone = null;
          handle.roundsWithoutProgress = 0;
        }
      } else {
        persistTransition(runId, { type: 'limit_reached', at: now() });
      }
      return { terminal: true };
    }

    if (snapshot.status === 'stopped') {
      if (getHandle(runId).stopRequested || getHandle(runId).agentRestart) {
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
      persistWorkflowState(runId, getHandle(runId).workflow);
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
        updateRun(runId, { steps });
      }
      persistWorkflowState(runId, getHandle(runId).workflow);
      return { terminal: false };
    }

    return { terminal: false };
  }

  async function completeCleanCommit(run, inspected, handle) {
    const index = run.currentStepIndex;
    if (run.steps[index - 1].status !== 'complete') throw new Error('Commit requires a completed verification step');
    const outcome = verificationOutcome(run, index - 1);
    const replies = answerStore.list(run.id).filter(reply => reply.stepIndex === index - 1 && !outcome.includes(reply.answer));
    const ownerNotes = replies.length ? ['', '## Owner responses during verification', '',
      ...replies.flatMap(reply => [reply.questions ?? 'Verification question', '', reply.answer, ''])] : [];
    const content = [outcome.trimEnd(), ...ownerNotes, '', '## Verified clean worktrees', '',
      ...inspected.map(tree => `- ${tree.repository} — ${tree.branch} — ${tree.head}`), ''].join('\n');
    await writeCommitNote(run, content);
    if (handle.stopped) return;
    const summary = outcome.trimStart().split(/\r?\n/, 1)[0].replace(/^#+/, '').trim().slice(0, 200);
    noteStore.add({ runId: run.id, stepIndex: index, stepName: 'Commit', attempt: run.steps[index].attempt, pass: 1, status: 'written', summary, content });
    onNoteWritten({ runId: run.id, taskId: run.taskId, input: run.input, stepIndex: index, content });
    persistTransition(run.id, { type: 'step_running' });
    persistTransition(run.id, { type: run.definition.steps[index].approval ? 'approval_requested' : 'step_complete', at: now() });
    if (runStore.get(run.id).status === 'complete') await finishComplete(run.id);
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
        run = updateRun(runId, {
          baseCommit,
          worktreeState: 'present',
          worktreeDetail: null,
        });
      }

      if (handle.stopped) return;
      run = runStore.get(runId);
      if (!run || !['pending', 'running'].includes(run.status)) return;

      // Read now, not when the run began: a repository may have been added to the task, or closed in it, since.
      const stepIndex = run.currentStepIndex;
      const defStep = run.definition.steps[stepIndex];
      let step = run.steps[stepIndex];

      // First step of a new run, or the next pending step after advance.
      if (run.status === 'pending' || step.status === 'pending') {
        persistTransition(runId, { type: 'start', at: now() });
        run = runStore.get(runId);
        step = run.steps[stepIndex];
      }

      const places = await listRunPlaces(run, { includeGit: defStep.inspectCleanCommit === true || verificationPrompts.has(defStep.prompt) });
      const inspected = [];
      if (defStep.inspectCleanCommit) {
        if (!places?.worktrees?.length || !places.worktrees.some(entry => entry.path === run.worktreePath && entry.branch === run.worktreeBranch)) {
          throw new Error(`Commit inspection: missing recorded worktree or branch for ${run.worktreePath}`);
        }
        for (const tree of places.worktrees) {
          if (handle.stopped) return;
          inspected.push(await inspectCommitWorktree(tree));
        }
      }
      if (handle.stopped) return;
      // Every attempt, including resume, checks the recorded copies before notes rewrite or agent launch.
      try {
        await verifyAttachments({
          worktreePath: run.worktreePath,
          attachments: run.attachments,
          notesDir: run.definition.notesDir,
        });
      } catch (error) {
        failRun(runId, String(error?.message || error).slice(0, 2000));
        return;
      }
      if (handle.stopped) return;
      if (run.definition.notesDir !== null) {
        await prepareNotes({
          worktreePath: run.worktreePath,
          definition: run.definition,
          input: run.input,
          attachments: run.attachments,
          ...(places === undefined ? {} : { places }),
        });
        await refreshBrief(runId);
      }
      if (handle.stopped) return;
      const feedback = reviewStore.listSentBack(run.id, stepIndex);
      const feedbackFile = feedback.length ? await writeFeedback({ worktreePath: run.worktreePath, definition: run.definition, stepIndex, reviews: feedback }) : undefined;
      const agent = defStep.agent;
      if (handle.stopped) return;

      if (defStep.inspectCleanCommit && feedback.length === 0 && inspected.every(tree => !tree.dirty)) {
        await completeCleanCommit(run, inspected, handle);
        return;
      }

      // A step works in the terminal of its agent: the one it used before (an earlier round of
      // a loop, or the attempt being resumed), else one where the same agent already runs in
      // this worktree. Its agent is cleared there before the prompt is sent. Only a step whose
      // agent has no terminal gets a new one, with the agent launched in it.
      let { sessionId } = step;
      if (sessionId === null) sessionId = findAgentTerminal(run, stepIndex);
      // A terminal can leave the worktree: its shell changed folder, or tmux lost the session and a
      // new one of the same name was opened in the project. Its agent would work in the wrong place.
      if (sessionId !== null) {
        const inside = await terminalInFolder(sessionId, run.worktreePath);
        if (typeof inside !== 'boolean') {
          throw new Error(`pipeline run: terminalInFolder must answer true or false for ${sessionId}`);
        }
        if (handle.stopped) return;
        if (!inside) {
          console.warn(`[pipeline-run] ${runId}: terminal ${sessionId} is not in ${run.worktreePath}; step ${defStep.name} opens a new terminal there`);
          if (step.sessionId === sessionId) {
            run = updateRun(runId, { steps: run.steps.map((s, i) => (
              i === stepIndex ? { ...s, sessionId: null, priorSessionIds: [...(s.priorSessionIds || []), sessionId] } : s
            )) });
            step = run.steps[stepIndex];
          }
          sessionId = null;
        }
      }
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
        run = updateRun(runId, { steps: stepsWithSession });
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

      const ready = await waitUntilReady(runId, sessionId, agent.name, returning ? defStep.name : null, launchAgent, agent.launchCommand);
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
      const guidance = buildStepGuidance(current.definition, stepIndex, {
        worktreePath: current.worktreePath,
        attachments: current.attachments,
        ...(feedbackFile ? { feedbackPath: feedbackFile } : {}),
        ...(places === undefined ? {} : { places }),
      });

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
      }, ...(run.attachments.length === 0 ? [] : [{
        // A repeat pass drives the agent again: its copies are checked first, as before every attempt.
        beforePass: () => verifyAttachments({
          worktreePath: run.worktreePath,
          attachments: run.attachments,
          notesDir: run.definition.notesDir,
        }),
      }]));
      persistWorkflowState(runId, workflow);

      if (agent.assignment) runStore.recordAttempt(current);

      const restartedAttempt = handle.restartedAttempt === `${stepIndex}:${attempt}`;
      watchForDialog(runId, sessionId, workflow, () => settled, { agentName: agent.name, stepName: defStep.name, settle: settleWorkflow, cwd: current.worktreePath, restartedAttempt }).catch((err) => {
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

    const restart = handle.agentRestart;
    handle.agentRestart = null;
    if (handle.stopped) return;

    if (restart) {
      const stepIndex = runStore.get(runId)?.currentStepIndex;
      const { name: stepName, agent: { name: agentName } } = runStore.get(runId).definition.steps[stepIndex];
      try {
        await restartAgentTerminal(restart.sessionId, restart.cwd);
      } catch (err) {
        failRun(runId, `The agent ${agentName} did not take the prompt of step ${stepName}, and its terminal could not be started again: ${String(err?.message || err)}`.slice(0, 2000));
        return;
      }
      if (handle.stopped || runStore.get(runId)?.status !== 'running') return;
      const relaunched = persistTransition(runId, { type: 'agent_restarted' });
      handle.restartedAttempt = `${stepIndex}:${relaunched.steps[stepIndex].attempt}`;
      await runStep(runId);
      return;
    }

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
      await finishComplete(runId);
    }
  }

  /**
   * Continues observing a pass that was reattached after a backend restart, then handles
   * restart/next-step/completion identically to `runStep`.
   */
  async function observeReattachedStep(runId, {
    sessionId,
    attachment,
    workflow,
    workflowFinished,
    settleWorkflow,
    isSettled,
    agentName,
    stepName,
    cwd,
  }) {
    const handle = getHandle(runId);
    try {
      watchForDialog(runId, sessionId, workflow, isSettled, {
        agentName,
        stepName,
        settle: settleWorkflow,
        cwd,
        restartedAttempt: false,
      }).catch((err) => {
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
        console.error(`[pipeline-run] release failed for ${runId}:`, err);
      }
      handle.attachment = null;
      handle.workflow = null;
      handle.dialogPause = false;
    }

    const restart = handle.agentRestart;
    handle.agentRestart = null;
    if (handle.stopped) return;

    if (restart) {
      const stepIndex = runStore.get(runId)?.currentStepIndex;
      const { name: currentStepName, agent: { name: currentAgentName } } = runStore.get(runId).definition.steps[stepIndex];
      try {
        await restartAgentTerminal(restart.sessionId, restart.cwd);
      } catch (err) {
        failRun(runId, `The agent ${currentAgentName} did not take the prompt of step ${currentStepName}, and its terminal could not be started again: ${String(err?.message || err)}`.slice(0, 2000));
        return;
      }
      if (handle.stopped || runStore.get(runId)?.status !== 'running') return;
      const relaunched = persistTransition(runId, { type: 'agent_restarted' });
      handle.restartedAttempt = `${stepIndex}:${relaunched.steps[stepIndex].attempt}`;
      await runStep(runId);
      return;
    }

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
      await finishComplete(runId);
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
      handle.lastTasksDone = null;
      handle.roundsWithoutProgress = 0;
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
        handle.lastTasksDone = null;
        handle.roundsWithoutProgress = 0;
        persistTransition(runId, { type: 'continue', at: now() });
        const after = runStore.get(runId);
        if (after.status === 'complete') {
          return finishComplete(runId);
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

    async approve(runId) {
      loadActionRun(runId, 'approve');
      return enqueue(runId, async () => {
        const run = loadActionRun(runId, 'approve');
        const index = run.currentStepIndex;
        reviewStore.add({ runId, stepIndex: index, stepName: run.definition.steps[index].name, attempt: run.steps[index].attempt, verdict: 'approved', comment: null });
        persistTransition(runId, { type: 'approve', at: now() });
        const after = runStore.get(runId);
        if (after.status === 'complete') return finishComplete(runId);
        enqueue(runId, () => runStep(runId)).catch(err => console.error(`[pipeline-run] approval execution failed for ${runId}:`, err));
        return after;
      });
    },

    async sendBack(runId, comment) {
      loadActionRun(runId, 'sendBack');
      return enqueue(runId, async () => {
        const run = loadActionRun(runId, 'sendBack');
        if (typeof comment !== 'string' || !comment.trim() || comment.length > 4000 || /[\x00-\x09\x0b-\x1f\x7f]/.test(comment)) throw new TypeError('send-back comment is invalid');
        const index = run.currentStepIndex;
        const sessionId = run.steps[index].sessionId;
        const newTerminal = sessionId === null || !terminalStillThere(sessionId);
        reviewStore.add({ runId, stepIndex: index, stepName: run.definition.steps[index].name, attempt: run.steps[index].attempt, verdict: 'sent_back', comment });
        const handle = getHandle(runId);
        handle.stopped = false;
        handle.stopRequested = false;
        persistTransition(runId, { type: 'send_back', newTerminal, at: now() });
        const after = runStore.get(runId);
        enqueue(runId, () => runStep(runId)).catch(err => console.error(`[pipeline-run] send-back execution failed for ${runId}:`, err));
        return after;
      });
    },

    async resume(runId) {
      const initial = runStore.get(runId);
      if (!initial) throw new Error(`pipeline run ${runId}: not found`);
      const reclaimable = initial.worktreeState === 'released' && canReclaimReleasedTaskWorktree(initial) === true;
      assertActionAllowed(reclaimable ? { ...initial, reclaimableTaskWorktree: true } : initial, 'resume');
      return enqueue(runId, async () => {
        let run = runStore.get(runId);
        if (run?.worktreeState === 'released') {
          if (canReclaimReleasedTaskWorktree(run) !== true) {
            const err = new Error('The task no longer owns this worktree, or another run is using it.');
            err.code = 'ACTION_REFUSED';
            throw err;
          }
          if (!await pathExists(run.worktreePath)) {
            const err = new Error('The task worktree directory is missing');
            err.code = 'WORKTREE_MISSING';
            throw err;
          }
          run = updateRun(runId, { worktreeState: 'external', worktreeDetail: null });
        }
        run = loadActionRun(runId, 'resume');
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
        const latest = loadActionRun(runId, 'resume');
        const { sessionId } = latest.steps[latest.currentStepIndex];
        const newTerminal = sessionId === null || !terminalStillThere(sessionId);
        const handle = getHandle(runId);
        handle.stopped = false;
        handle.stopRequested = false;
        handle.lastTasksDone = null;
        handle.roundsWithoutProgress = 0;
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
        // The loop adds a new identifier for the rest of the pass, so the answered request is never read again as a new one.
        const typed = workflow.answerText(answer);
        attachment.write(`\x1b[200~${typed}\x1b[201~`);
        await delay(launchEnterDelayMs, setTimeoutFn);
        if (handle.workflow !== workflow || workflow.snapshot().status !== 'needs_input') {
          throw unavailable('The agent stopped waiting while the answer was being sent.');
        }
        // Recorded before it is submitted, so every later step can read what was asked and answered.
        const asked = runStore.get(runId);
        answerStore.add({
          runId,
          stepIndex: asked.currentStepIndex,
          stepName: asked.definition.steps[asked.currentStepIndex].name,
          pass: workflow.snapshot().iteration,
          questions: asked.inputRequest?.questions ?? null,
          answer,
        });
        await refreshBrief(runId);
        attachment.write('\r');
        // The loop resumes on an answer; its running snapshot moves the run out of needs_input.
        workflow.input(typed);
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
     * Reconcile unfinished runs after a backend restart: reattach to live agent terminals
     * whose pass is still in flight (or whose signal arrived during downtime), and mark
     * truly non-recoverable runs as interrupted.
     * @returns {Promise<{ reattached: string[], interrupted: string[] }>}
     */
    async reconcileOnStartup() {
      const summary = { reattached: [], interrupted: [] };
      for (const run of runStore.list()) {
        if (!INTERRUPTIBLE_RUN_STATUSES.has(run.status)) continue;
        const stepIndex = run.currentStepIndex;
        const step = run.steps[stepIndex];
        const defStep = run.definition.steps[stepIndex];
        const savedState = run.workflowState;

        const eligible = ['running', 'needs_input'].includes(run.status)
          && ['running', 'needs_input'].includes(step?.status)
          && typeof step?.sessionId === 'string'
          && savedState !== null;

        if (!eligible) {
          markRunInterrupted(run.id);
          summary.interrupted.push(run.id);
          continue;
        }

        const sessionId = step.sessionId;
        let available = false;
        try {
          available = terminalStillThere(sessionId) && await terminalInFolder(sessionId, run.worktreePath);
        } catch (err) {
          console.warn(`[pipeline-run] startup terminal check failed for ${run.id} (${sessionId}): ${err?.message || err}`);
          available = false;
        }
        if (!available) {
          markRunInterrupted(run.id);
          summary.interrupted.push(run.id);
          continue;
        }

        let readiness = 'waiting';
        try {
          const execState = await readExecutionState(sessionId);
          readiness = classifyReadiness(execState);
        } catch (err) {
          console.warn(`[pipeline-run] startup execution state failed for ${run.id} (${sessionId}): ${err?.message || err}`);
        }

        let screenText = '';
        try {
          const lines = await readScreen(sessionId);
          if (Array.isArray(lines)) screenText = lines.join('\n');
        } catch (err) {
          console.warn(`[pipeline-run] startup screen read failed for ${run.id} (${sessionId}): ${err?.message || err}`);
        }

        const hasSignalOnScreen = savedState.phase === 'waiting' && findPassSignal(screenText, savedState) !== null;
        if (readiness === 'closed' || (readiness === 'exited' && !hasSignalOnScreen)) {
          markRunInterrupted(run.id);
          summary.interrupted.push(run.id);
          continue;
        }

        let attachment;
        try {
          attachment = attachBackground(sessionId, { cwd: run.worktreePath });
        } catch (err) {
          console.warn(`[pipeline-run] startup background attach failed for ${run.id} (${sessionId}): ${err?.message || err}`);
          markRunInterrupted(run.id);
          summary.interrupted.push(run.id);
          continue;
        }

        const handle = getHandle(run.id);
        handle.stopped = false;
        handle.stopRequested = false;
        handle.attachment = attachment;
        handle.dialogPause = run.status === 'needs_input' && run.inputRequest === null;
        syncTerminalMuting(run.id, run);

        const beforePassOption = run.attachments.length === 0 ? {} : {
          beforePass: () => verifyAttachments({
            worktreePath: run.worktreePath,
            attachments: run.attachments,
            notesDir: run.definition.notesDir,
          }),
        };

        let settled = false;
        let resolveWorkflow;
        const workflowFinished = new Promise(resolve => { resolveWorkflow = resolve; });
        const settleWorkflow = () => {
          if (settled) return;
          settled = true;
          handle.settleWorkflow = null;
          resolveWorkflow();
        };
        handle.settleWorkflow = settleWorkflow;

        const onNotify = (snapshot) => {
          enqueueTransition(run.id, async () => {
            try {
              const { terminal } = await applyWorkflowSnapshot(run.id, snapshot);
              if (terminal) settleWorkflow();
            } catch (err) {
              const message = String(err?.message || err || 'Run failed').slice(0, 2000);
              try {
                failRun(run.id, message);
              } catch (failErr) {
                console.error(`[pipeline-run] failRun after transition error failed for ${run.id}:`, failErr);
              }
              settleWorkflow();
            }
          });
        };

        let workflow = attachment.workflow;
        if (workflow) {
          if (typeof attachment.observe !== 'function') {
            try { attachment.release?.(); } catch (err) { console.warn(`[pipeline-run] release failed for ${run.id}:`, err); }
            handle.attachment = null;
            handle.dialogPause = false;
            markRunInterrupted(run.id);
            summary.interrupted.push(run.id);
            continue;
          }
          attachment.observe(onNotify);
        } else {
          workflow = createWorkflow({
            write: (data) => attachment.write(data),
            notify: onNotify,
          });
        }
        handle.workflow = workflow;

        try {
          workflow.reattach(savedState, beforePassOption);
        } catch (err) {
          console.warn(`[pipeline-run] startup workflow reattach failed for ${run.id} (${sessionId}): ${err?.message || err}`);
          try { attachment.release?.(); } catch (relErr) { console.warn(`[pipeline-run] release failed for ${run.id}:`, relErr); }
          handle.attachment = null;
          handle.workflow = null;
          handle.dialogPause = false;
          markRunInterrupted(run.id);
          summary.interrupted.push(run.id);
          continue;
        }

        if (hasSignalOnScreen) {
          workflow.replayScreen(screenText);
        }

        summary.reattached.push(run.id);
        enqueue(run.id, () => observeReattachedStep(run.id, {
          sessionId,
          attachment,
          workflow,
          workflowFinished,
          settleWorkflow,
          isSettled: () => settled,
          agentName: defStep.agent.name,
          stepName: defStep.name,
          cwd: run.worktreePath,
        })).catch((err) => {
          console.error(`[pipeline-run] reattached execution failed for ${run.id}:`, err);
        });
      }
      return summary;
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
