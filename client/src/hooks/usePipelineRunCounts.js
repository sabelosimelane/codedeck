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
        for (const [index, record] of runs.entries()) {
          const run = parseRun(record, index);
          const counts = next.get(run.project) ?? { open: 0, awaitingOwner: 0 };
          next.set(run.project, {
            open: counts.open + 1,
            awaitingOwner: counts.awaitingOwner + (AWAITING_OWNER.includes(run.status) ? 1 : 0),
          });
        }
        if (!disposed) {
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
