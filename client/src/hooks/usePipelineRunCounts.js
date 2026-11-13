import { useEffect, useState } from 'react';
import { parseRun } from '../utils/pipelineRunRecords';
import { listOpenRuns } from '../utils/pipelinesApi';

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
          next.set(run.project, (next.get(run.project) || 0) + 1);
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
