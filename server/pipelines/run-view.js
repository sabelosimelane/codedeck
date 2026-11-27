import { publicRoleFallback } from './team-attribution.js';
import { computeActions } from './run-machine.js';
import { publicAttachments } from './attachments.js';
import { notePath } from './run-notes.js';
import { readRunProgress, createRunProgressReader, createCachedProgressReader } from './run-progress.js';
import { canReclaimReleasedTaskRun } from './released-task-run.js';

// How long a remote run's progress answer is reused: views poll every two seconds, and every
// read on a remote host is several SSH round trips.
const REMOTE_PROGRESS_TTL_MS = 5_000;

/**
 * The capped pause a run waits on: which step hit its configured maximum, how many extra
 * rounds the owner already granted it, and the latest finding on that step. The client
 * binds its grant to this pause, so a duplicate click, a restart, or a stale request
 * cannot spend a second extension.
 */
function describeLimitPause(run) {
  const stepIndex = run.currentStepIndex;
  const defStep = run.definition.steps[stepIndex];
  const progress = run.steps[stepIndex];
  return {
    stepIndex,
    stepName: defStep.name,
    repeatMode: defStep.repeat.mode,
    ...(defStep.repeat.mode === 'loop_back' ? { toStepIndex: defStep.repeat.toStepIndex } : {}),
    maxRounds: defStep.repeat.max,
    extraRounds: progress.extraRounds ?? 0,
    roundsCompleted: progress.roundsCompleted,
    attempt: progress.attempt,
  };
}

/** `decisionCount` is how many requests the run's agents settled themselves (see /decisions). */
function buildRunView(run, decisionCount, progress, latestNotes, inheritedSessionIds) {
  const currentNote = latestNotes.get(run.currentStepIndex);
  const approvalNote = currentNote === undefined ? null : (({ status, summary, attempt, pass, createdAt }) => ({ status, summary, attempt, pass, createdAt }))(currentNote);
  return {
    id: run.id,
    requestId: run.requestId,
    workflowId: run.workflowId,
    taskId: run.taskId,
    workflowName: run.definition.workflowName,
    // Whether this run's agents settle their own questions, as the workflow said when it started.
    agentsDecide: run.definition.agentsDecide,
    decisionCount,
    notesDir: run.definition.notesDir,
    // The team this run is labelled with, or null; `changed` when its lineup was changed after it started.
    team: run.definition.team ?? null,
    progress,
    project: run.project,
    host: run.host ?? 'local',
    input: run.input,
    attachments: publicAttachments(run.attachments),
    status: run.status,
    approvalRequest: run.status === 'awaiting_approval' ? { stepIndex: run.currentStepIndex, stepName: run.definition.steps[run.currentStepIndex].name, note: approvalNote } : null,
    stopReason: run.stopReason,
    error: run.error,
    currentStepIndex: run.currentStepIndex,
    steps: run.definition.steps.map((defStep, index) => {
      const progress = run.steps[index];
      return {
        index,
        kind: defStep.kind,
        name: defStep.name,
        role: defStep.role,
        askOwner: defStep.askOwner,
        readOnly: defStep.readOnly,
        approval: defStep.approval,
        agentName: defStep.agent.name,
        agentId: defStep.agent.id,
        ...(defStep.agent.assignment && { agentSource: defStep.agent.assignment.source }),
        ...(defStep.agent.fallbackAgent && { fallbackAgent: publicRoleFallback(defStep.agent.fallbackAgent) }),
        ...(defStep.nextAgent && {
          nextAgentId: defStep.nextAgent.id,
          nextAgentName: defStep.nextAgent.name,
          ...(defStep.nextAgent.assignment && { nextAgentSource: defStep.nextAgent.assignment.source }),
          ...(defStep.nextAgent.fallbackAgent && { nextFallbackAgent: publicRoleFallback(defStep.nextAgent.fallbackAgent) }),
        }),
        notePath: notePath(run.definition, index),
        note: latestNotes.get(index) === undefined ? null : (({ status, summary, attempt, pass, createdAt }) => ({ status, summary, attempt, pass, createdAt }))(latestNotes.get(index)),
        repeat: defStep.repeat,
        status: progress.status,
        sessionId: progress.sessionId,
        priorSessionIds: progress.priorSessionIds,
        attempt: progress.attempt,
        iteration: progress.iteration,
        roundsCompleted: progress.roundsCompleted,
        extraRounds: progress.extraRounds ?? 0,
        detail: progress.detail,
        startedAt: progress.startedAt,
        finishedAt: progress.finishedAt,
        elapsedMs: progress.elapsedMs,
      };
    }),
    worktree: {
      path: run.worktreePath,
      branch: run.worktreeBranch,
      baseCommit: run.baseCommit,
      state: run.worktreeState,
      detail: run.worktreeDetail,
    },
    // What an agent that signalled NEEDS_INPUT asked for; null when the run is not waiting on one.
    inputRequest: run.inputRequest === null ? null : {
      questions: run.inputRequest.questions,
      truncated: run.inputRequest.truncated,
    },
    actions: computeActions(run),
    // The pause the owner's next Continue grants one more round for, if the run is capped.
    limitPause: run.status === 'limit_paused' ? describeLimitPause(run) : null,
    // Terminals of earlier runs in this worktree that it replaced and did not take over.
    inheritedSessionIds,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  };
}

const stepSessionIds = run => run.steps.flatMap(step => [step.sessionId, ...step.priorSessionIds]).filter(id => id !== null);

/**
 * A run started in a task replaces (releases) the run before it there and takes over the terminals
 * its agents need; the rest stay open in the worktree. They are listed here so that they are known
 * as run terminals and not as ones the owner opened. A released run inherits none.
 */
function inheritedSessionIdsOf(run, allRuns) {
  if (run.worktreeState === 'released' || !run.worktreePath) return [];
  const own = new Set(stepSessionIds(run));
  const inherited = [];
  for (const earlier of allRuns) {
    if (earlier.id === run.id || earlier.project !== run.project || earlier.host !== run.host || earlier.worktreePath !== run.worktreePath) continue;
    if (earlier.worktreeState !== 'released' || earlier.createdAt >= run.createdAt) continue;
    for (const id of stepSessionIds(earlier)) if (!own.has(id) && !inherited.includes(id)) inherited.push(id);
  }
  return inherited;
}


export function createRunViewBuilder({ runStore, taskStore, workflowStore, decisionStore, noteStore, progressReader, resolveHostTools } = {}) {
  for (const [name, value] of Object.entries({ runStore, taskStore, workflowStore, decisionStore, noteStore, progressReader })) {
    if (!value) throw new TypeError(`run view requires ${name}`);
  }
  // Recent answers per remote host are kept for the builder's lifetime; the host's tools are resolved
  // on each real read, so a changed host setting or reachability applies at once.
  const remoteReaders = new Map();
  const readerFor = host => {
    if (host === 'local' || !resolveHostTools) return progressReader;
    if (!remoteReaders.has(host)) {
      const current = () => createRunProgressReader({ fs: resolveHostTools(host).fs });
      remoteReaders.set(host, createCachedProgressReader({
        worktreeExists: worktreePath => current().worktreeExists(worktreePath),
        read: request => current().read(request),
      }, { ttlMs: REMOTE_PROGRESS_TTL_MS }));
    }
    return remoteReaders.get(host);
  };
  return async run => {
    const viewRun = run.worktreeState === 'released' && canReclaimReleasedTaskRun({ run, taskStore, runStore })
      ? { ...run, reclaimableTaskWorktree: true } : run;
    const inspected = await readRunProgress({ run: viewRun, workflowProgressFile: workflowStore.get(run.workflowId)?.progressFile ?? null, progressReader: readerFor(run.host) });
    const progress = inspected === null ? null : { file: inspected.file, status: inspected.status, phaseCount: inspected.phaseCount, phase: inspected.phase, tasksDone: inspected.tasksDone, tasksTotal: inspected.tasksTotal };
    return buildRunView(viewRun, decisionStore.count(run.id), progress, noteStore.latestByStep(run.id), inheritedSessionIdsOf(run, run.worktreeState === 'released' ? [] : runStore.list()));
  };
}
