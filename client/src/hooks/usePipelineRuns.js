import { useCallback, useEffect, useRef, useState } from 'react';
import {
  answerRun as apiAnswerRun,
  approveRun as apiApproveRun,
  sendBackRun as apiSendBackRun,
  cleanupRun as apiCleanupRun,
  continueRun as apiContinueRun,
  getRun as apiGetRun,
  listOpenRuns,
  listRunDecisions as apiListRunDecisions,
  listRunNotes as apiListRunNotes,
  listRunReviews as apiListRunReviews,
  listRunAnswers as apiListRunAnswers,
  resumeRun as apiResumeRun,
  startRun as apiStartRun,
  stopRun as apiStopRun,
} from '../utils/pipelinesApi';
import { parseAnswerPage, parseDecisionPage, parseNotePage, parseReviewPage, parseInputRequest, parseRunAutonomy } from '../utils/pipelineRunRecords';
import { describeBlockedCleanup } from '../utils/pipelineWorktreeCleanup';

// What the runs bar shows of a run is checked before the run is shown.
function checkRun(run, index) {
  parseInputRequest(run, index);
  parseRunAutonomy(run, index);
}

function failureMessage(failure) {
  if (failure instanceof TypeError || failure?.message === 'network down') return 'Server unreachable';
  // A validation refusal says what is wrong with each field; its own message only says that one failed.
  const fields = (Array.isArray(failure?.errors) ? failure.errors : [])
    .map(item => item?.message)
    .filter(message => typeof message === 'string' && message.trim() !== '');
  if (fields.length > 0) return fields.join(' ');
  return failure?.message || 'Pipelines request failed';
}

function statusToastMessage(run) {
  const name = run.workflowName || 'Workflow';
  switch (run.status) {
    case 'complete':
      return `${name} completed`;
    case 'stopped':
      return `${name} stopped`;
    case 'error':
      return run.error || `${name} failed`;
    case 'needs_input':
      return `${name} needs input`;
    case 'limit_paused':
      return `${name} reached its pass limit`;
    case 'interrupted':
      return `${name} was interrupted`;
    default:
      return null;
  }
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function mergeRun(runs, next) {
  const index = runs.findIndex((run) => run.id === next.id);
  if (index < 0) return [...runs, next];
  const copy = runs.slice();
  copy[index] = next;
  return copy;
}

export function usePipelineRuns({ projectName, showToast }) {
  const [runs, setRuns] = useState([]);
  const [locallyStartedRunIds, setLocallyStartedRunIds] = useState(() => new Set());
  const inFlightRef = useRef(false);
  const pendingRefreshRef = useRef(false);
  const pollErrorToastedRef = useRef(false);
  const mountedRef = useRef(false);
  const previousStatusRef = useRef(new Map());
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;

  const toastStatusTransitions = useCallback((nextRuns) => {
    const previous = previousStatusRef.current;
    const nextMap = new Map();
    for (const run of nextRuns) {
      nextMap.set(run.id, run.status);
    }
    for (const run of nextRuns) {
      const prior = previous.get(run.id);
      if (prior === undefined || prior === run.status) continue;
      const message = statusToastMessage(run);
      if (message) {
        showToast({
          type: run.status === 'error' ? 'error' : 'success',
          message,
        });
      }
    }
    previousStatusRef.current = nextMap;
  }, [showToast]);

  const refresh = useCallback(async ({ queueIfBusy = false } = {}) => {
    const project = projectNameRef.current;
    if (!project) return;
    if (inFlightRef.current) {
      if (queueIfBusy) pendingRefreshRef.current = true;
      return;
    }
    inFlightRef.current = true;
    pendingRefreshRef.current = false;
    try {
      const next = await listOpenRuns({ project });
      if (!mountedRef.current || projectNameRef.current !== project) return;
      // The runs bar shows what an agent asked; a malformed request is refused, not rendered.
      next.forEach(checkRun);

      // Completed runs drop out of open=true; fetch finals so completion toasts still fire.
      const openIds = new Set(next.map((run) => run.id));
      const disappearedIds = [...previousStatusRef.current.keys()].filter((id) => !openIds.has(id));
      let transitionRuns = next;
      if (disappearedIds.length > 0) {
        // Let the poll error handler preserve known runs/statuses on failure;
        // the next poll must retry before forgetting a disappeared run.
        const finals = await Promise.all(disappearedIds.map((id) => apiGetRun(id)));
        if (!mountedRef.current || projectNameRef.current !== project) return;
        transitionRuns = [...next, ...finals];
      }

      setRuns(next);
      setLocallyStartedRunIds((current) => {
        if (current.size === 0) return current;
        let changed = false;
        const pruned = new Set();
        for (const id of current) {
          if (openIds.has(id)) pruned.add(id);
          else changed = true;
        }
        return changed ? pruned : current;
      });
      toastStatusTransitions(transitionRuns);
      // Keep previousStatus keyed to open runs only so disappear detection stays accurate.
      previousStatusRef.current = new Map(next.map((run) => [run.id, run.status]));
      pollErrorToastedRef.current = false;
    } catch (failure) {
      if (!mountedRef.current || projectNameRef.current !== project) return;
      if (!pollErrorToastedRef.current) {
        pollErrorToastedRef.current = true;
        showToast({ type: 'error', message: failureMessage(failure) });
      }
    } finally {
      inFlightRef.current = false;
      if (pendingRefreshRef.current && mountedRef.current && projectNameRef.current === project) {
        pendingRefreshRef.current = false;
        refresh({ queueIfBusy: true });
      }
    }
  }, [showToast, toastStatusTransitions]);

  useEffect(() => {
    mountedRef.current = true;
    previousStatusRef.current = new Map();
    pollErrorToastedRef.current = false;
    pendingRefreshRef.current = false;
    setRuns([]);
    if (!projectName) return undefined;

    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [projectName, refresh]);

  const runAction = useCallback(async (successMessage, action, runId) => {
    const project = projectNameRef.current;
    try {
      const next = await action(runId);
      if (!mountedRef.current || projectNameRef.current !== project) return next;
      checkRun(next, 0);
      setRuns((current) => mergeRun(current, next));
      previousStatusRef.current.set(next.id, next.status);
      // The request can succeed while the run it returns has already failed (a Setup guard, a
      // launch that exits): the owner is told what the run says, not that the action worked.
      if (next.status === 'error') {
        showToast({ type: 'error', message: statusToastMessage(next) });
      } else {
        showToast({
          type: 'success',
          message: typeof successMessage === 'function' ? successMessage(next) : successMessage,
        });
      }
      await refresh({ queueIfBusy: true });
      return next;
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      return null;
    }
  }, [refresh, showToast]);

  const startRun = useCallback(async ({ requestId, workflowId, input, worktreePath, taskId, newTask, startIn }) => {
    const project = projectNameRef.current;
    if (!project) {
      showToast({ type: 'error', message: 'Select a project before starting a workflow' });
      return null;
    }
    try {
      const created = await apiStartRun({ requestId, workflowId, project, input, worktreePath, taskId, newTask, startIn });
      if (!mountedRef.current || projectNameRef.current !== project) return created;
      setLocallyStartedRunIds((current) => {
        const next = new Set(current);
        next.add(created.id);
        return next;
      });
      setRuns((current) => mergeRun(current, created));
      previousStatusRef.current.set(created.id, created.status);
      showToast({ type: 'success', message: `${created.workflowName || 'Workflow'} started` });
      await refresh({ queueIfBusy: true });
      return created;
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      return null;
    }
  }, [refresh, showToast]);

  const stopRun = useCallback(
    (runId) => runAction((run) => `${run.workflowName || 'Workflow'} stopped`, apiStopRun, runId),
    [runAction],
  );
  const resumeRun = useCallback(
    (runId) => runAction((run) => `${run.workflowName || 'Workflow'} resumed`, apiResumeRun, runId),
    [runAction],
  );
  const continueRun = useCallback(
    (runId) => runAction((run) => `${run.workflowName || 'Workflow'} continued`, apiContinueRun, runId),
    [runAction],
  );
  const answerRun = useCallback(
    (runId, answer) => runAction(
      (run) => `Answer sent to ${run.workflowName || 'the agent'}`,
      (id) => apiAnswerRun(id, answer),
      runId,
    ),
    [runAction],
  );
  const approveRun = useCallback(
    runId => runAction(run => `${run.workflowName || 'Workflow'} approved`, apiApproveRun, runId),
    [runAction],
  );
  const sendBackRun = useCallback(
    (runId, comment) => runAction(run => `${run.workflowName || 'Workflow'} sent back`, id => apiSendBackRun(id, comment), runId),
    [runAction],
  );
  /** What the owner answered in one step, or null when it could not be loaded. */
  const loadRunAnswers = useCallback(async (runId, stepIndex) => {
    try {
      return parseAnswerPage(await apiListRunAnswers(runId, { stepIndex }));
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      return null;
    }
  }, [showToast]);
  /** The owner's reviews of one step, or null when they could not be loaded. */
  const loadRunReviews = useCallback(async (runId, stepIndex) => {
    try {
      return parseReviewPage(await apiListRunReviews(runId, { stepIndex }));
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      return null;
    }
  }, [showToast]);
  /** One page of the requests a run's agents settled themselves, or null when it could not be loaded. */
  const loadRunDecisions = useCallback(async (runId, page, stepIndex) => {
    try {
      return parseDecisionPage(await apiListRunDecisions(runId, page, { stepIndex }));
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      return null;
    }
  }, [showToast]);
  const loadRunNotes = useCallback(async (runId, page, stepIndex) => {
    try {
      return parseNotePage(await apiListRunNotes(runId, page, { stepIndex }));
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      return null;
    }
  }, [showToast]);
  const cleanupRun = useCallback(async (runId) => {
    const project = projectNameRef.current;
    try {
      // The backend closed the run's terminals with it; `closed` is returned so the caller takes their tabs away.
      const closed = await apiCleanupRun(runId);
      const { terminalsClosed, terminalsNotClosed, ...next } = closed;
      if (!mountedRef.current || projectNameRef.current !== project) return closed;
      setRuns((current) => mergeRun(current, next));
      previousStatusRef.current.set(next.id, next.status);
      const withClosed = message => (terminalsClosed.length === 0 ? `${message}.` : `${message}. ${plural(terminalsClosed.length, 'terminal')} closed.`);
      if (terminalsNotClosed.length > 0) {
        showToast({
          type: 'error',
          message: `${plural(terminalsNotClosed.length, 'terminal')} could not be closed: ${terminalsNotClosed.join(', ')}. Close ${terminalsNotClosed.length === 1 ? 'it from its tab' : 'them from their tabs'}.`,
        });
      }
      if (next.worktree?.state === 'removal_blocked') {
        showToast({
          type: 'error',
          message: next.worktree.detail
            ? describeBlockedCleanup(next.worktree.detail).summary
            : `${next.workflowName || 'Workflow'} worktree cleanup was blocked`,
        });
      } else if (next.worktree?.state === 'released') {
        showToast({
          type: 'success',
          message: withClosed(`${next.workflowName || 'Workflow'} run closed; its work is left in place`),
        });
      } else {
        showToast({
          type: 'success',
          message: withClosed(`${next.workflowName || 'Workflow'} worktree cleaned up`),
        });
      }
      await refresh({ queueIfBusy: true });
      return closed;
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      return null;
    }
  }, [refresh, showToast]);

  return {
    runs,
    locallyStartedRunIds,
    refresh,
    startRun,
    stopRun,
    resumeRun,
    continueRun,
    answerRun,
    approveRun,
    sendBackRun,
    loadRunDecisions,
    loadRunReviews,
    loadRunAnswers,
    loadRunNotes,
    cleanupRun,
  };
}
