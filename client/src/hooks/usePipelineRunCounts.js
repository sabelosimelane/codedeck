import { useEffect, useState } from 'react';
import { parseRun } from '../utils/pipelineRunRecords';
import { listOpenRuns } from '../utils/pipelinesApi';

// A run in one of these waits for the owner: an agent needs input, or a step reached its pass limit.
const AWAITING_OWNER = ['needs_input', 'limit_paused', 'awaiting_approval'];

/** Per project: how many runs are open, and how many of those wait for the owner. */
export function usePipelineRunCounts(showToast) {
  const [counts, setCounts] = useState(() => new Map());
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let errorReported = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const runs = await listOpenRuns();
        const next = new Map();
        const runsByProject = new Map();
        for (const [index, record] of runs.entries()) {
          const run = parseRun(record, index);
          const groupRuns = runsByProject.get(run.project) ?? [];
          groupRuns.push({
            id: run.id, project: run.project, status: run.status, stopReason: run.stopReason, workflowName: run.workflowName,
            worktree: { path: run.worktree.path, branch: run.worktree.branch },
            progress: run.progress, createdAt: run.createdAt,
            steps: run.steps.map(step => ({ status: step.status, name: step.name, sessionId: step.sessionId, note: step.note })),
          });
          runsByProject.set(run.project, groupRuns);
          const counts = next.get(run.project) ?? { open: 0, awaitingOwner: 0 };
          next.set(run.project, {
            open: counts.open + 1,
            awaitingOwner: counts.awaitingOwner + (AWAITING_OWNER.includes(run.status) || (run.status === 'stopped' && run.stopReason === 'no_progress') ? 1 : 0),
          });
        }
        if (!disposed) {
          next.runsByProject = runsByProject;
          setCounts(next);
          errorReported = false;
        }
      } catch (failure) {
        if (!disposed && !errorReported) {
          errorReported = true;
          showToast({ type: 'error', message: failure.message });
        }
      } finally {
        inFlight = false;
      }
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [showToast]);
  return counts;
}
