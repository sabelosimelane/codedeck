import { useCallback, useEffect, useRef, useState } from 'react';
import { listOpenTasks } from '../utils/tasksApi';

/** Every open task, from the backend, refreshed every two seconds without overlapping requests. */
export function useTasks(showToast) {
  const [tasks, setTasks] = useState([]);
  const refreshRef = useRef(async () => {});
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let errorReported = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await listOpenTasks();
        if (!disposed) {
          setTasks(current => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
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
    refreshRef.current = refresh;
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [showToast]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { tasks, refresh };
}
