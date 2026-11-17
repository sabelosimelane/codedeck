import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { listWorkflows, listWorktrees, preflightProject } from '../../utils/pipelinesApi';
import { parsePreflight, parseWorktree } from '../../utils/pipelineRecords';
import '../session-search.css';

function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const NEW_WORKTREE = '';
// Setup prepares a worktree CodeDeck creates, so only a new worktree needs a setup agent.
const SETUP_AGENT_MISSING = 'setup_agent_missing';
const FIELD_STYLE = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
};

function worktreeLabel(worktree) {
  const parts = [worktree.name, worktree.branch ?? 'no branch'];
  if (worktree.current) parts.push('this checkout');
  if (worktree.dirty) parts.push('uncommitted changes');
  return worktree.reason ? `${parts.join(' · ')} — ${worktree.reason.message}` : parts.join(' · ');
}

export default function RunWorkflowDialog({ projectName, onClose, onStart }) {
  const [workflows, setWorkflows] = useState([]);
  const [workflowId, setWorkflowId] = useState('');
  const [input, setInput] = useState('');
  const [preflight, setPreflight] = useState(null);
  const [worktrees, setWorktrees] = useState([]);
  const [worktreePath, setWorktreePath] = useState(NEW_WORKTREE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);
  const selectedWorkflow = workflows.find(workflow => workflow.id === workflowId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [nextWorkflows, preflightResponse] = await Promise.all([
          listWorkflows(),
          preflightProject(projectName),
        ]);
        const nextPreflight = parsePreflight(preflightResponse);
        // Worktrees exist only for a local git project; a missing setup agent does not change that.
        const listable = nextPreflight.reasons.every(reason => reason.code === SETUP_AGENT_MISSING);
        const nextWorktrees = listable ? (await listWorktrees(projectName)).map(parseWorktree) : [];
        if (cancelled) return;
        setWorkflows(nextWorkflows);
        setPreflight(nextPreflight);
        setWorktrees(nextWorktrees);
        setWorktreePath(NEW_WORKTREE);
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

  const chosenWorktree = worktrees.find(worktree => worktree.path === worktreePath) ?? null;
  const reasons = (preflight?.reasons ?? []).filter(reason => !(chosenWorktree && reason.code === SETUP_AGENT_MISSING));
  const listable = (preflight?.reasons ?? []).every(reason => reason.code === SETUP_AGENT_MISSING);
  const eligible = preflight !== null && reasons.length === 0 && (chosenWorktree === null || chosenWorktree.selectable);
  const canStart = !loading && !starting && eligible && Boolean(workflowId);

  const handleStart = async () => {
    if (!canStart) return;
    setStarting(true);
    try {
      const started = await onStart({
        requestId: newRequestId(),
        workflowId,
        input,
        ...(chosenWorktree ? { worktreePath: chosenWorktree.path } : {}),
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
                  style={FIELD_STYLE}
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
                  style={FIELD_STYLE}
                />
              </label>
              <p className="pipeline-hint">What this run is about: a description of the task, or the path of a file its steps should work from.</p>
              {selectedWorkflow?.progressFile?.includes('{input}') && <p className="pipeline-hint">This workflow reads its progress from {selectedWorkflow.progressFile}, so the input must be that file&apos;s path.</p>}

              {listable && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                  Worktree
                  <select
                    aria-label="Worktree"
                    value={worktreePath}
                    onChange={(event) => setWorktreePath(event.target.value)}
                    style={FIELD_STYLE}
                  >
                    <option value={NEW_WORKTREE}>
                      {preflight.branch ? `New worktree (new branch from ${preflight.branch})` : 'New worktree (new branch from the current commit)'}
                    </option>
                    {worktrees.map((worktree) => (
                      <option key={worktree.path} value={worktree.path} disabled={!worktree.selectable}>
                        {worktreeLabel(worktree)}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {reasons.length > 0 && (
                <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {reasons.map((reason) => (
                    <span key={reason.code || reason.message}>{reason.message}</span>
                  ))}
                </div>
              )}

              {chosenWorktree === null && preflight?.dirty && (
                <div style={{ color: 'var(--warning)', fontSize: 12 }}>
                  Uncommitted changes in this checkout will not be in the run&apos;s worktree
                </div>
              )}

              {chosenWorktree && (
                <div style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span>Runs in this worktree as it is: no Setup step, and CodeDeck will not remove it when the run ends.</span>
                  {chosenWorktree.dirty && <span style={{ color: 'var(--warning)' }}>This worktree has uncommitted changes.</span>}
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
