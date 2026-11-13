/**
 * Per-run promise-chain executor (Spec §8.3–§8.9).
 * All I/O (worktree, session, attach, workflow, readiness) is injected.
 * Status transitions go through run-machine.applyEvent — never inside notify.
 */

import { applyEvent, computeActions } from './run-machine.js';

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_ENTER_DELAY_MS = 100;

function maxIterationsFor(repeat) {
  if (repeat?.mode === 'until_complete') return repeat.max;
  return 1;
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
  removeWorktree = async () => ({ ok: true }),
  listDirtyPaths = async () => [],
  pathExists = async () => true,
  now = () => new Date().toISOString(),
  setTimeout: setTimeoutFn = setTimeout,
  readinessPollMs = DEFAULT_POLL_MS,
  readinessTimeoutMs = DEFAULT_TIMEOUT_MS,
  launchEnterDelayMs = DEFAULT_ENTER_DELAY_MS,
} = {}) {
  if (!runStore) throw new Error('createRunEngine: runStore is required');
  if (typeof createWorktree !== 'function') throw new Error('createRunEngine: createWorktree is required');
  if (typeof startSession !== 'function') throw new Error('createRunEngine: startSession is required');
  if (typeof attachBackground !== 'function') throw new Error('createRunEngine: attachBackground is required');
  if (typeof createWorkflow !== 'function') throw new Error('createRunEngine: createWorkflow is required');
  if (typeof classifyReadiness !== 'function') throw new Error('createRunEngine: classifyReadiness is required');
  if (typeof readExecutionState !== 'function') throw new Error('createRunEngine: readExecutionState is required');

  const handles = new Map();

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

  async function waitUntilReady(runId, sessionId, agentName) {
    let waitedMs = 0;
    let lastState = null;

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
        return { ok: true, state: lastState };
      }

      if (result === 'exited') {
        failRun(runId, `The launch command for agent ${agentName} exited.`);
        return { ok: false, reason: 'exited' };
      }

      if (result === 'closed') {
        failRun(runId, `The terminal closed while launching agent ${agentName}.`);
        return { ok: false, reason: 'closed' };
      }

      if (result === 'needs_input') {
        const current = runStore.get(runId);
        if (current?.status === 'running') {
          persistTransition(runId, { type: 'needs_input' });
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

  async function applyWorkflowSnapshot(runId, snapshot) {
    const current = runStore.get(runId);
    if (!current) return { terminal: true };
    if (['complete', 'error', 'stopped'].includes(current.status)) {
      return { terminal: true };
    }

    if (snapshot.status === 'complete') {
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
      if (current.status === 'needs_input') {
        persistTransition(runId, { type: 'input_received' });
      }
      const defStep = current.definition.steps[current.currentStepIndex];
      if (defStep?.repeat?.mode === 'once') {
        persistTransition(runId, { type: 'step_complete', at: now() });
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
        persistTransition(runId, { type: 'needs_input' });
      }
      return { terminal: false };
    }

    if (snapshot.status === 'running' || snapshot.status === 'resetting') {
      if (current.status === 'needs_input') {
        persistTransition(runId, { type: 'input_received' });
      }
      const step = current.steps[current.currentStepIndex];
      if (typeof snapshot.iteration === 'number' && step && snapshot.iteration !== step.iteration) {
        const steps = current.steps.map((s, i) => (
          i === current.currentStepIndex ? { ...s, iteration: snapshot.iteration } : s
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

      const sessionId = await startSession({
        project: run.project,
        cwd: run.worktreePath,
      });
      if (handle.stopped) return;

      const stepsWithSession = run.steps.map((s, i) => (
        i === stepIndex ? { ...s, sessionId } : s
      ));
      run = runStore.update(runId, { steps: stepsWithSession });

      attachment = attachBackground(sessionId, { cwd: run.worktreePath });
      handle.attachment = attachment;

      if (handle.stopped) return;

      attachment.write(agent.launchCommand);
      await delay(launchEnterDelayMs, setTimeoutFn);
      if (handle.stopped) return;
      attachment.write('\r');

      const ready = await waitUntilReady(runId, sessionId, agent.name);
      if (!ready.ok) return;

      let current = runStore.get(runId);
      step = current.steps[stepIndex];
      if (step.status === 'launching') {
        current = persistTransition(runId, { type: 'step_running' });
      }

      const attempt = current.steps[stepIndex].attempt;
      // Snapshot prompts are already composed once at POST /runs (Spec §4.4).
      const command = defStep.prompt;
      const maxIterations = maxIterationsFor(defStep.repeat);
      const requestId = `run-${runId}-${stepIndex}-${attempt}`;

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
        if (run.worktreeState === 'present') {
          const exists = await pathExists(run.worktreePath);
          if (!exists) {
            const err = new Error('The worktree directory is missing');
            err.code = 'WORKTREE_MISSING';
            throw err;
          }
        }
        const handle = getHandle(runId);
        handle.stopped = false;
        handle.stopRequested = false;
        persistTransition(runId, { type: 'resume', at: now() });
        const updated = runStore.get(runId);
        // Acknowledge Resume immediately; keep execution on the same chain.
        enqueue(runId, () => runStep(runId)).catch((err) => {
          console.error(`[pipeline-run] resume execution failed for ${runId}:`, err);
        });
        return updated;
      });
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
