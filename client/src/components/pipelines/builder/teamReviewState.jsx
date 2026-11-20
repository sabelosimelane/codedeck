import React, { useEffect, useState } from 'react';

export const percent = (value) =>
  value === null
    ? 'Unverified'
    : new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(value);
export const day = (stamp) => new Date(stamp).toLocaleDateString();

export function useRecords(loader, version) {
  const [state, setState] = useState({ data: null, error: '' });
  useEffect(() => {
    const request = new AbortController();
    loader(request.signal).then(
      (data) => {
        if (!request.signal.aborted) setState({ data, error: '' });
      },
      (error) => {
        if (!request.signal.aborted) setState((previous) => ({ ...previous, error: error.message }));
      },
    );
    return () => request.abort();
  }, [loader, version]);
  return state;
}

export function LoadFeedback({ error, loading }) {
  if (error) return <p role="alert">{error}</p>;
  if (loading) return <p role="status">Loading…</p>;
  return null;
}
