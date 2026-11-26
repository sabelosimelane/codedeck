import { publicRoleFallback } from './team-attribution.js';
import { computeActions } from './run-machine.js';
import { publicAttachments } from './attachments.js';
import { notePath } from './run-notes.js';
import { readRunProgress, createRunProgressReader, createCachedProgressReader } from './run-progress.js';
import { canReclaimReleasedTaskRun } from './released-task-run.js';

// How long a remote run's progress answer is reused: views poll every two seconds, and every
// read on a remote host is several SSH round trips.
const REMOTE_PROGRESS_TTL_MS = 5_000;

/** `decisionCount` is how many requests the run's agents settled themselves (see /decisions). */
function buildRunView(run, decisionCount, progress, latestNotes) {
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
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  };
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
    return buildRunView(viewRun, decisionStore.count(run.id), progress, noteStore.latestByStep(run.id));
  };
}
