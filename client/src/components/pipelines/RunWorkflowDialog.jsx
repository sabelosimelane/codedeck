import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { listWorkflows, preflightProject } from '../../utils/pipelinesApi';
import '../session-search.css';

function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function RunWorkflowDialog({ projectName, onClose, onStart }) {
  const [workflows, setWorkflows] = useState([]);
  const [workflowId, setWorkflowId] = useState('');
  const [input, setInput] = useState('');
  const [preflight, setPreflight] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [nextWorkflows, nextPreflight] = await Promise.all([
          listWorkflows(),
          preflightProject(projectName),
        ]);
        if (cancelled) return;
        setWorkflows(nextWorkflows);
        setPreflight(nextPreflight);
        if (nextWorkflows.length > 0) setWorkflowId(nextWorkflows[0].id);
      } catch (failure) {
        if (!cancelled) setError(failure.message || 'Failed to load workflows');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectName]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const eligible = preflight?.eligible === true;
  const canStart = !loading && !starting && eligible && Boolean(workflowId);

  const handleStart = async () => {
    if (!canStart) return;
    setStarting(true);
    try {
      const started = await onStart({
        requestId: newRequestId(),
        workflowId,
        input,
      });
      if (started) onClose();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div
      className="session-search-overlay"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="session-search-modal" role="dialog" aria-modal="true" aria-label="Run workflow" style={{ width: 'min(480px, 100%)' }}>
        <div className="session-search-heading">
          <span>Run workflow</span>
          <button type="button" aria-label="Close run workflow" onClick={onClose}><X size={16} /></button>
        </div>

        <div style={{ padding: '0 18px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading && <div className="session-search-state">Loading…</div>}
          {error && <div className="session-search-state" role="alert">{error}</div>}

          {!loading && !error && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                Workflow
                <select
                  aria-label="Workflow"
                  value={workflowId}
                  onChange={(event) => setWorkflowId(event.target.value)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                >
                  {workflows.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                  ))}
                </select>
              </label>

              <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                Input
                <input
                  aria-label="Input"
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  maxLength={4096}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-primary)',
                  }}
                />
              </label>

              {preflight?.reasons?.length > 0 && (
                <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {preflight.reasons.map((reason) => (
                    <span key={reason.code || reason.message}>{reason.message}</span>
                  ))}
                </div>
              )}

              {preflight?.dirty && (
                <div style={{ color: 'var(--warning)', fontSize: 12 }}>
                  Uncommitted changes in this checkout will not be in the run&apos;s worktree
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={!canStart}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: canStart ? 'var(--bg-active)' : 'var(--bg-surface)',
                    color: canStart ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: canStart ? 'pointer' : 'not-allowed',
                  }}
                >
                  Start
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
