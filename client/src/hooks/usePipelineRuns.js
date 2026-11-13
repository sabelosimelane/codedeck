import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cleanupRun as apiCleanupRun,
  continueRun as apiContinueRun,
  getRun as apiGetRun,
  listOpenRuns,
  resumeRun as apiResumeRun,
  startRun as apiStartRun,
  stopRun as apiStopRun,
} from '../utils/pipelinesApi';

function failureMessage(failure) {
  if (failure instanceof TypeError || failure?.message === 'network down') return 'Server unreachable';
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
      setRuns((current) => mergeRun(current, next));
      previousStatusRef.current.set(next.id, next.status);
      showToast({
        type: 'success',
        message: typeof successMessage === 'function' ? successMessage(next) : successMessage,
      });
      await refresh({ queueIfBusy: true });
      return next;
    } catch (failure) {
      showToast({ type: 'error', message: failureMessage(failure) });
      return null;
    }
  }, [refresh, showToast]);

  const startRun = useCallback(async ({ requestId, workflowId, input }) => {
    const project = projectNameRef.current;
    if (!project) {
      showToast({ type: 'error', message: 'Select a project before starting a workflow' });
      return null;
    }
    try {
      const created = await apiStartRun({ requestId, workflowId, project, input });
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
  const cleanupRun = useCallback(async (runId) => {
    const project = projectNameRef.current;
    try {
      const next = await apiCleanupRun(runId);
      if (!mountedRef.current || projectNameRef.current !== project) return next;
      setRuns((current) => mergeRun(current, next));
      previousStatusRef.current.set(next.id, next.status);
      if (next.worktree?.state === 'removal_blocked') {
        showToast({
          type: 'error',
          message: next.worktree.detail || `${next.workflowName || 'Workflow'} worktree cleanup was blocked`,
        });
      } else {
        showToast({
          type: 'success',
          message: `${next.workflowName || 'Workflow'} worktree cleaned up`,
        });
      }
      await refresh({ queueIfBusy: true });
      return next;
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
    cleanupRun,
  };
}
