import { useCallback, useEffect, useRef, useState } from 'react';

export const LANDING_ERROR = 'Something went wrong. Please try again.';

// A mutation can outlive the bar that launched it if the owner dismisses or switches tabs.
const activeMutations = new Set();

export function useLandingStatus(taskId, read, onReconciled) {
  const [snapshot, setSnapshot] = useState(null);
  const [failure, setFailure] = useState(null);
  const alive = useRef(false);
  const sequence = useRef(0);

  const refresh = useCallback(async ({ preserveRefusal = false } = {}) => {
    if (!alive.current || activeMutations.has(taskId)) return;
    const request = ++sequence.current;
    try {
      const next = await read(taskId);
      if (!alive.current || request !== sequence.current || activeMutations.has(taskId)) return;
      // Keep an open confirmation valid across identical reads only.
      setSnapshot(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
      setFailure(null);
      if (!preserveRefusal) onReconciled(null);
    } catch (error) {
      if (!alive.current || request !== sequence.current || activeMutations.has(taskId)) return;
      setSnapshot(null);
      setFailure(error instanceof Error ? error.message : LANDING_ERROR);
    }
  }, [taskId, read, onReconciled]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      alive.current = false;
      sequence.current += 1;
      clearInterval(timer);
    };
  }, [refresh]);

  const begin = () => {
    if (activeMutations.has(taskId)) return false;
    activeMutations.add(taskId);
    sequence.current += 1;
    return true;
  };
  const end = () => { activeMutations.delete(taskId); };

  const reconcile = () => {
    if (!alive.current) return;
    setSnapshot(null);
    setFailure(null);
    refresh({ preserveRefusal: true });
  };

  return { snapshot, setSnapshot, failure, refresh, alive, begin, end, reconcile };
}
