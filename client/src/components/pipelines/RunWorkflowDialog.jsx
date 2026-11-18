import React, { useEffect, useState } from 'react';
import { listWorkflows, listWorktrees, preflightProject } from '../../utils/pipelinesApi';
import { parsePreflight, parseWorktree } from '../../utils/pipelineRecords';
import { openWorkflowBuilder } from '../../utils/workflowBuilder';
import { WORKFLOW_KIND_LABELS } from '../../../../shared/pipeline-definitions.mjs';
import { Button, Dialog, Field, Note, SegmentedControl, Select, TextInput } from '../ui/index.jsx';

function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Where a run works: a task created for it, an open task, or directly in Main.
const NEW_TASK = 'new';
const OPEN_TASK = 'task';
const MAIN = 'main';
const TASK_TITLE_MAX = 80;
// Setup prepares the copy of the project a new task gets, so only a new task needs a setup agent.
const SETUP_AGENT_MISSING = 'setup_agent_missing';

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
  const [place, setPlace] = useState(defaultTaskId ? OPEN_TASK : NEW_TASK);
  const [taskId, setTaskId] = useState(defaultTaskId);
  const [title, setTitle] = useState('');
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

  const projectTasks = tasks.filter(task => task.project === projectName);
  const home = worktrees.find(worktree => worktree.current) ?? null;
  const worktreeOf = task => worktrees.find(worktree => worktree.path === task.worktreePath) ?? null;
  // A task that was open when the dialog opened may have been finished since; then the run goes to a new one.
  const chosenTask = place === OPEN_TASK ? projectTasks.find(task => task.id === taskId) ?? projectTasks.find(task => worktreeOf(task)?.selectable) ?? projectTasks[0] ?? null : null;
  const where = place === OPEN_TASK ? (chosenTask ? OPEN_TASK : NEW_TASK) : place;
  const chosenWorktree = where === OPEN_TASK ? worktreeOf(chosenTask) : where === MAIN ? home : null;
  // A title is sent only when the owner typed one. Without it the backend calls the task after
  // the input and names it from the run's work, with the CLI chosen for session naming.
  const typedTitle = title.trim().slice(0, TASK_TITLE_MAX).trim();
  const reasons = (preflight?.reasons ?? []).filter(reason => !(where !== NEW_TASK && reason.code === SETUP_AGENT_MISSING));
  const listable = (preflight?.reasons ?? []).every(reason => reason.code === SETUP_AGENT_MISSING);
  const placeUsable = where === NEW_TASK ? typedTitle.length > 0 || input.trim().length > 0 : Boolean(chosenWorktree?.selectable);
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
        ...(where === NEW_TASK ? { newTask: typedTitle ? { title: typedTitle } : {} }
          : where === OPEN_TASK ? { taskId: chosenTask.id }
            : { worktreePath: chosenWorktree.path }),
      });
      if (started) onClose();
    } finally {
      setStarting(false);
    }
  };

  const inputHint = selectedWorkflow?.progressFile?.includes('{input}')
    ? `This workflow reads its progress from ${selectedWorkflow.progressFile}. Type only the part that replaces {input}: a path inside the project, not a full path from your disk.`
    : 'A description of the work, or the path of a file its steps should work from.';
  const ready = !loading && !error;

  return (
    <Dialog title="Run workflow" closeLabel="Close run workflow" onClose={onClose} busy={starting}
      footer={ready && <>
        <Button onClick={onClose} disabled={starting}>Cancel</Button>
        <Button variant="primary" onClick={handleStart} disabled={!canStart}>{starting ? 'Starting…' : 'Start'}</Button>
      </>}>
      {loading && <span className="ui-field-hint" role="status">Loading…</span>}
      {error && <Note tone="danger" role="alert">{error}</Note>}

      {ready && (
        <>
          <Field label="Workflow"
            action={<Button variant="link" onClick={() => { onClose(); openWorkflowBuilder(); }}>Edit workflows…</Button>}
            hint={selectedWorkflow?.description || null}>
            <Select label="Workflow" value={workflowId} onChange={setWorkflowId}>
              {workflows.map(workflow => (
                <option key={workflow.id} value={workflow.id}>{workflow.kind && workflow.kind !== 'other' ? `${workflow.name} — ${WORKFLOW_KIND_LABELS[workflow.kind]}` : workflow.name}</option>
              ))}
            </Select>
          </Field>

          <Field label="What is this run about?" hint={inputHint}>
            <TextInput label="Input" value={input} onChange={setInput} maxLength={4096} placeholder="e.g. docs/todos/replies.md" />
          </Field>

          {listable && (
            <Field label="Where to work">
              <SegmentedControl label="Where to work" value={where} onChange={setPlace} options={[
                { value: NEW_TASK, label: 'A new task' },
                { value: OPEN_TASK, label: 'An open task', disabled: projectTasks.length === 0, title: projectTasks.length === 0 ? 'This project has no open tasks' : undefined },
                { value: MAIN, label: 'Main', disabled: !home?.selectable, title: home?.reason?.message },
              ]} />
              {where === NEW_TASK && (
                <TextInput label="Task title" value={title} onChange={setTitle} maxLength={TASK_TITLE_MAX} placeholder="Named from the work once the run starts, or type a title" />
              )}
              {where === OPEN_TASK && (
                <Select label="Task" value={chosenTask.id} onChange={setTaskId}>
                  {projectTasks.map(task => (
                    <option key={task.id} value={task.id} disabled={!worktreeOf(task)?.selectable}>{placeLabel(task.title, worktreeOf(task))}</option>
                  ))}
                </Select>
              )}
              <Note>
                {where === NEW_TASK && <span>The task gets its own copy of the project{preflight?.branch ? ` from ${preflight.branch}` : ''}, prepared by a Setup step, so other work can carry on beside it.</span>}
                {where === OPEN_TASK && <span>Runs in this task as it is, with no Setup step.</span>}
                {where === MAIN && <span>Runs directly in Main, with no copy of its own and no Setup step.</span>}
              </Note>
              {where === NEW_TASK && preflight?.dirty && <Note tone="warning">Uncommitted changes in Main will not be in the task.</Note>}
              {where !== NEW_TASK && chosenWorktree?.dirty && <Note tone="warning">There are uncommitted changes here.</Note>}
              {where === OPEN_TASK && chosenWorktree && !chosenWorktree.selectable && chosenWorktree.reason && <Note tone="warning">{chosenWorktree.reason.message}</Note>}
            </Field>
          )}

          {reasons.length > 0 && (
            <Note tone="danger" role="alert">
              {reasons.map(reason => <span key={reason.code || reason.message}>{reason.message}</span>)}
            </Note>
          )}
        </>
      )}
    </Dialog>
  );
}
