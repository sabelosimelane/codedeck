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

// Where a run works: a task created for it, an open task, or directly in Main.
const NEW_TASK = 'new';
const MAIN = 'main';
const TASK_TITLE_MAX = 80;
// Setup prepares the copy of the project a new task gets, so only a new task needs a setup agent.
const SETUP_AGENT_MISSING = 'setup_agent_missing';
const FIELD_STYLE = {
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
};

function placeLabel(name, worktree) {
  if (!worktree) return `${name} — its files are no longer on disk`;
  const parts = [name];
  if (worktree.dirty) parts.push('uncommitted changes');
  return worktree.reason ? `${parts.join(' · ')} — ${worktree.reason.message}` : parts.join(' · ');
}

export default function RunWorkflowDialog({ projectName, tasks = [], defaultTaskId = null, onClose, onStart }) {
  const [workflows, setWorkflows] = useState([]);
  const [workflowId, setWorkflowId] = useState('');
  const [input, setInput] = useState('');
  const [preflight, setPreflight] = useState(null);
  const [worktrees, setWorktrees] = useState([]);
  const [place, setPlace] = useState(defaultTaskId ? `task:${defaultTaskId}` : NEW_TASK);
  const [title, setTitle] = useState(null);
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

  const projectTasks = tasks.filter(task => task.project === projectName);
  const home = worktrees.find(worktree => worktree.current) ?? null;
  const worktreeOf = task => worktrees.find(worktree => worktree.path === task.worktreePath) ?? null;
  // A task that was open when the dialog opened may have been finished since; then the run goes to a new one.
  const chosenTask = place.startsWith('task:') ? projectTasks.find(task => `task:${task.id}` === place) ?? null : null;
  const where = chosenTask ? 'task' : place === MAIN ? MAIN : NEW_TASK;
  const chosenWorktree = where === 'task' ? worktreeOf(chosenTask) : where === MAIN ? home : null;
  // Until the owner types a title, the task is named after what the run is about.
  const taskTitle = (title ?? input).slice(0, TASK_TITLE_MAX);
  const reasons = (preflight?.reasons ?? []).filter(reason => !(where !== NEW_TASK && reason.code === SETUP_AGENT_MISSING));
  const listable = (preflight?.reasons ?? []).every(reason => reason.code === SETUP_AGENT_MISSING);
  const placeUsable = where === NEW_TASK ? taskTitle.trim().length > 0 : Boolean(chosenWorktree?.selectable);
  const eligible = preflight !== null && reasons.length === 0 && placeUsable;
  const canStart = !loading && !starting && eligible && Boolean(workflowId);

  const handleStart = async () => {
    if (!canStart) return;
    setStarting(true);
    try {
      const started = await onStart({
        requestId: newRequestId(),
        workflowId,
        input,
        ...(where === NEW_TASK ? { newTask: { title: taskTitle.trim() } }
          : where === 'task' ? { taskId: chosenTask.id }
            : { worktreePath: chosenWorktree.path }),
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
                  Where to work
                  <select
                    aria-label="Where to work"
                    value={where === 'task' ? place : where}
                    onChange={(event) => setPlace(event.target.value)}
                    style={FIELD_STYLE}
                  >
                    <option value={NEW_TASK}>A new task</option>
                    {projectTasks.map((task) => (
                      <option key={task.id} value={`task:${task.id}`} disabled={!worktreeOf(task)?.selectable}>
                        {placeLabel(task.title, worktreeOf(task))}
                      </option>
                    ))}
                    {home && <option value={MAIN} disabled={!home.selectable}>{placeLabel('Main', home)}</option>}
                  </select>
                </label>
              )}

              {where === NEW_TASK && (
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                  Task title
                  <input
                    aria-label="Task title"
                    value={taskTitle}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={TASK_TITLE_MAX}
                    placeholder="What this task is called in the sidebar"
                    style={FIELD_STYLE}
                  />
                </label>
              )}

              {reasons.length > 0 && (
                <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {reasons.map((reason) => (
                    <span key={reason.code || reason.message}>{reason.message}</span>
                  ))}
                </div>
              )}

              <div style={{ color: 'var(--text-secondary)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {where === NEW_TASK && <span>The task gets its own copy of the project{preflight?.branch ? ` from ${preflight.branch}` : ''}, prepared by a Setup step, so other work can carry on beside it.</span>}
                {where === NEW_TASK && preflight?.dirty && <span style={{ color: 'var(--warning)' }}>Uncommitted changes in Main will not be in the task.</span>}
                {where === 'task' && <span>Runs in this task as it is, with no Setup step.</span>}
                {where === MAIN && <span>Runs directly in Main, with no copy of its own and no Setup step.</span>}
                {where !== NEW_TASK && chosenWorktree?.dirty && <span style={{ color: 'var(--warning)' }}>There are uncommitted changes here.</span>}
              </div>

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
