import { useCallback, useEffect, useRef, useState } from 'react';
import { namingPages } from '../utils/sessionNamingApi';

export function useSessionTitles() {
  const [titles, setTitles] = useState({});
  const [error, setError] = useState(null);
  const controller = useRef(null);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (controller.current || !mounted.current) return;
    const request = new AbortController(); controller.current = request;
    try {
      const records = await namingPages('titles', request.signal);
      if (!request.signal.aborted && mounted.current) {
        setTitles(Object.fromEntries(records.map(record => [record.sessionId, record]))); setError(null);
      }
    } catch (failure) {
      if (!request.signal.aborted && mounted.current) setError(failure.message);
    } finally { if (controller.current === request) controller.current = null; }
  }, []);
  useEffect(() => {
    mounted.current = true; refresh();
    const timer = setInterval(refresh, 2000);
    return () => { mounted.current = false; clearInterval(timer); controller.current?.abort(); controller.current = null; };
  }, [refresh]);
  return { titles, refresh, error };
}
