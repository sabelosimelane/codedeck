import React, { useEffect, useRef, useState } from 'react';
import { Check, CircleDot, Circle, Repeat, TriangleAlert, Square, Plus } from 'lucide-react';
import { NO_PROGRESS_ROUNDS } from '../../../../shared/pipeline-definitions.mjs';
import { describeRunStatus, describeStepProgress, describeStepState } from '../../utils/pipelineRunStatus';
import { describeBlockedCleanup } from '../../utils/pipelineWorktreeCleanup';
import ApprovalReview from './ApprovalReview.jsx';
import QuestionsPanel from './QuestionsPanel.jsx';
import '../pipelines/pipeline-runs.css';
import './task-view.css';

const STATE_ICON = { done: Check, current: CircleDot, failed: TriangleAlert, stopped: Square, pending: Circle };

function resumeConfirmation(run, step) {
  if (!step?.sessionId) return `Resume ${run.workflowName}? ${step.name} starts in a new terminal.`;
  return `Resume ${run.workflowName}? The agent in ${step.sessionId} is cleared and ${step.name} starts again there. `
    + 'If its agent has exited, it is started again there. A new terminal is opened only if that one was closed.';
}

function progressLine(progress) {
  if (progress === null || progress === undefined) return null;
  if (progress.status === 'in_progress') {
    return { tone: 'plain', text: `Phase ${progress.phase.number} of ${progress.phaseCount}${progress.phase.title ? `: ${progress.phase.title}` : ''}`,
      detail: `${progress.phase.tasksDone}/${progress.phase.tasksTotal} tasks in this phase` };
  }
  if (progress.status === 'all_done') return { tone: 'accent', text: `All ${progress.phaseCount} ${progress.phaseCount === 1 ? 'phase' : 'phases'} ticked`, detail: null };
  if (progress.status === 'no_phases') return { tone: 'warning', text: `No "## Phase N" sections in ${progress.file}`, detail: null };
  if (progress.status === 'missing') return { tone: 'warning', text: `Progress file not found: ${progress.file}`, detail: null };
  return { tone: 'warning', text: `Progress file could not be read: ${progress.file}`, detail: null };
}

/** A record list for one step, loaded when opened. `load()` resolves to an array, or null when it failed. */
function StepRecords({ label, emptyText, load, resetKey, render }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ status: 'idle', items: [] });
  const latest = useRef(0);
  useEffect(() => {
    if (!open) { latest.current += 1; return; }
    const request = ++latest.current;
    setState({ status: 'loading', items: [] });
    Promise.resolve().then(load).then(
      items => { if (request === latest.current) setState(items === null ? { status: 'failed', items: [] } : { status: 'ready', items }); },
      () => { if (request === latest.current) setState({ status: 'failed', items: [] }); },
    );
    // `resetKey` names the step and its latest change; `load` is recreated on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resetKey]);
  return (
    <div className="task-step-records">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="task-step-records-toggle">{label}</button>
      {open && state.status === 'loading' && <span className="pipeline-run-muted">Loading…</span>}
      {open && state.status === 'failed' && <span className="pipeline-run-danger">{`${label} could not be loaded.`}</span>}
      {open && state.status === 'ready' && state.items.length === 0 && <span className="pipeline-run-muted">{emptyText}</span>}
      {open && state.items.length > 0 && <ul aria-label={label} className="pipeline-run-list">{state.items.map(render)}</ul>}
    </div>
  );
}

function StepDetail({ run, step, isCurrent, terminalOpen, onOpenTerminal, onAnswer, onLoadNotes, onLoadDecisions, onLoadReviews, onLoadAnswers, onApprove, onSendBack }) {
  const progress = describeStepProgress(step);
  const loopTarget = step.repeat.mode === 'loop_back' ? run.steps.find(target => target.index === step.repeat.toStepIndex) : null;
  const resetKey = `${run.id}:${step.index}:${step.attempt}:${step.iteration}:${step.roundsCompleted}:${step.status}`;
  const asking = isCurrent && run.status === 'needs_input';
  const reviewing = isCurrent && run.status === 'awaiting_approval';
  return (
    <section aria-label={`Step ${step.name}`} className="task-step-detail" data-asking={asking || reviewing || undefined}>
      <div className="task-step-detail-heading">
        <strong className="pipeline-run-primary-text">{step.name}</strong>
        <span>{progress.detail ? `${progress.label} · ${progress.detail}` : progress.label}</span>
        {step.role && <span className="pipeline-run-muted">{step.role}</span>}
        {step.agentName && <span className="pipeline-run-muted">{step.agentName}</span>}
        {step.readOnly && <span className="pipeline-run-muted">read-only</span>}
        {step.askOwner && <span className="pipeline-run-muted" title="This step's questions always come to you, also when agents decide">always asks you</span>}
        {loopTarget && <span className="pipeline-run-muted">{`loops back to ${loopTarget.name}`}</span>}
      </div>
      {step.sessionId === null && step.status === 'pending' && <span className="pipeline-run-muted">This step has not started, so it has no terminal yet.</span>}
      {step.sessionId !== null && !terminalOpen && (
        <span className="pipeline-run-warning">
          This step&apos;s terminal is closed.{' '}
          <button type="button" onClick={onOpenTerminal}>Open a terminal here</button>
        </span>
      )}
      {/* Keyed by the request, so a new set of questions starts with fresh answers. */}
      {asking && <QuestionsPanel key={`${run.id}:${step.index}:${step.iteration}:${run.inputRequest?.questions ?? ''}`} run={run} onAnswer={onAnswer} />}
      {reviewing && <ApprovalReview key={`${run.id}:${step.index}:${step.attempt}:${step.iteration}`} run={run} onLoadNotes={onLoadNotes} onApprove={onApprove} onSendBack={onSendBack} />}
      <div className="task-step-records-row">
        {step.kind === 'node' && run.notesDir !== null && (
          <StepRecords label="Notes" emptyText="This step has left no note yet." resetKey={resetKey}
            load={async () => (await onLoadNotes(run.id, 0, step.index))?.notes ?? null}
            render={note => (
              <li key={note.id} className="pipeline-run-list-item">
                <strong className="pipeline-run-primary-text">{`Pass ${note.pass}${note.attempt > 1 ? `, attempt ${note.attempt}` : ''}`}</strong>
                {note.summary && <span>{note.summary}</span>}
                {note.content !== null ? <div className="pipeline-run-pre-wrap">{note.content}</div> : <span className="pipeline-run-warning">No note was written on this pass.</span>}
              </li>
            )} />
        )}
        {step.kind === 'node' && (
          <StepRecords label="Your answers" emptyText="This step has not asked you anything." resetKey={`${resetKey}:${run.status}`}
            load={async () => (await onLoadAnswers(run.id, step.index))?.answers ?? null}
            render={item => (
              <li key={item.id} className="pipeline-run-list-item">
                <strong className="pipeline-run-primary-text">{`Pass ${item.pass}`}</strong>
                <div className="pipeline-run-pre-wrap">{item.questions ?? 'The agent asked without listing its questions.'}</div>
                <span>{`You answered: ${item.answer}`}</span>
              </li>
            )} />
        )}
        {run.agentsDecide && (
          <StepRecords label="Decisions" emptyText="The agent decided nothing by itself in this step." resetKey={resetKey}
            load={async () => (await onLoadDecisions(run.id, 0, step.index))?.decisions ?? null}
            render={decision => (
              <li key={decision.id} className="pipeline-run-list-item">
                <strong className="pipeline-run-primary-text">{`Pass ${decision.pass}`}</strong>
                <div className="pipeline-run-pre-wrap">{decision.questions}</div>
                <span>{`Answered: ${decision.answer}`}</span>
              </li>
            )} />
        )}
        {step.approval && (
          <StepRecords label="Your reviews" emptyText="You have not reviewed this step yet." resetKey={resetKey}
            load={async () => (await onLoadReviews(run.id, step.index))?.reviews ?? null}
            render={review => (
              <li key={review.id} className="pipeline-run-list-item">
                <strong className="pipeline-run-primary-text">{review.verdict === 'approved' ? 'Approved' : 'Sent back'}</strong>
                {review.comment && <div className="pipeline-run-pre-wrap">{review.comment}</div>}
              </li>
            )} />
        )}
      </div>
    </section>
  );
}

/**
 * The screen of one piece of work that has a workflow run: what it is and how it stands, its
 * steps as the way to move around, and the selected step's detail above its terminal
 * (`children`: the terminals of this task, owned by the terminal area).
 */
export default function TaskView({
  title, tooltip, run, openSessionIds, inTask = false, children,
  onActivateStep, onOpenTerminal,
  onStop, onResume, onContinue, onCleanup, onAnswer,
  onLoadNotes, onLoadDecisions, onLoadReviews, onLoadAnswers = async () => ({ answers: [] }), onApprove, onSendBack,
}) {
  if (!run || typeof run !== 'object') throw new Error('task view: run is required');
  if (!Array.isArray(run.steps) || run.steps.length === 0) throw new Error('task view: run.steps must be a nonempty array');
  if (!(openSessionIds instanceof Set)) throw new Error('task view: openSessionIds must be a Set');
  if (typeof inTask !== 'boolean') throw new Error('task view: inTask must be a boolean');
  const currentIndex = Number.isInteger(run.currentStepIndex) ? run.currentStepIndex : 0;
  // The owner's pick holds until the run moves to another step; then the view follows the run.
  const [picked, setPicked] = useState(null);
  useEffect(() => { setPicked(null); }, [run.id, currentIndex]);
  const selectedIndex = picked !== null && run.steps.some(step => step.index === picked) ? picked : currentIndex;
  const selected = run.steps.find(step => step.index === selectedIndex) ?? run.steps[0];
  const current = run.steps.find(step => step.index === currentIndex) ?? run.steps[0];
  // The terminal follows the run: when the run starts working in another step's terminal, that
  // terminal is shown. It fires once per move, so a tab the owner then picks stays put, and a run
  // that is no longer working moves nothing.
  const working = !['complete', 'stopped', 'error', 'interrupted'].includes(run.status);
  const followSessionId = working && current.sessionId && openSessionIds.has(current.sessionId) ? current.sessionId : null;
  // Read through a ref: the callback is a new function on most renders, and that is not a move.
  const activateRef = useRef(onActivateStep);
  activateRef.current = onActivateStep;
  useEffect(() => {
    if (followSessionId) activateRef.current(followSessionId);
  }, [run.id, currentIndex, followSessionId]);
  const status = describeRunStatus(run);
  const progress = progressLine(run.progress);
  const blockedCleanup = run.worktree?.state === 'removal_blocked' && run.worktree.detail ? describeBlockedCleanup(run.worktree.detail) : null;
  const heading = title === run.workflowName ? title : `${title} · ${run.workflowName}`;

  const selectStep = step => {
    setPicked(step.index);
    if (step.sessionId && openSessionIds.has(step.sessionId)) onActivateStep(step.sessionId);
  };

  return (
    <div data-testid="task-view" className="task-view pipeline-run-bar">
      <header className="task-view-header">
        <div className="pipeline-run-heading">
          <strong className="pipeline-run-name" title={tooltip}>{heading}</strong>
          <span className="pipeline-run-status" data-status={run.status} data-tone={status.tone} aria-label={`Run status: ${status.label}`}>{status.label}</span>
          {run.agentsDecide && <span title="Agents in this run go with their own recommendations instead of pausing for you" className="pipeline-run-agents-decide">agents decide{run.decisionCount > 0 ? ` · ${run.decisionCount} so far` : ''}</span>}
          <div className="pipeline-run-actions">
            {run.actions?.stop && !['interrupted', 'stopped', 'error', 'complete'].includes(run.status) && <button type="button" onClick={() => onStop(run.id)}>Stop</button>}
            {run.actions?.continue && <button type="button" onClick={() => onContinue(run.id)} className={status.primaryAction === 'continue' ? 'pipeline-run-primary' : undefined}>Continue</button>}
            {run.actions?.resume && <button type="button" onClick={() => { if (window.confirm(resumeConfirmation(run, current))) onResume(run.id); }} className={status.primaryAction === 'resume' ? 'pipeline-run-primary' : undefined}>Resume</button>}
            {run.actions?.cleanup && (
              <button type="button" onClick={() => onCleanup(run.id)} className={status.primaryAction === 'cleanup' ? 'pipeline-run-primary' : undefined}>
                {/* A task keeps its files; ending the run only closes the run. */}
                {run.worktree?.state === 'external' ? 'Close run' : 'Clean up worktree'}
              </button>
            )}
          </div>
        </div>
        {progress && <div title={run.progress.file} className="pipeline-run-progress"><span className={progress.tone === 'plain' ? 'pipeline-run-progress-phase' : `pipeline-run-${progress.tone}`}>{progress.text}</span>{progress.detail && <span className="pipeline-run-muted">{` · ${progress.detail}`}</span>}</div>}
        {run.status === 'stopped' && run.stopReason === 'no_progress' && <div className="pipeline-run-warning">{`No task was ticked in the last ${NO_PROGRESS_ROUNDS} rounds. Check what the steps reported, then Resume to try again.`}</div>}
        {run.status === 'complete' && run.worktree?.state === 'external' && <div className="pipeline-run-muted">{inTask
          ? 'This run has finished. Its work is in the task: commit, merge or open a pull request from the bar above. Close run only takes the run off the screen.'
          : 'This run has finished. Close run takes it off the screen.'}</div>}
        {run.error && <span className="pipeline-run-danger">{run.error}</span>}
        {blockedCleanup && (
          <>
            <span className="pipeline-run-warning">{blockedCleanup.summary}</span>
            {blockedCleanup.paths.length > 0 && <details><summary>Show files</summary><div className="pipeline-run-cleanup-paths">{blockedCleanup.paths.map((path, index) => <div key={`${index}-${path}`}>{path}</div>)}</div></details>}
          </>
        )}
      </header>
      <div className="task-view-body">
        <nav aria-label="Steps" className="task-step-rail">
          {run.steps.map(step => {
            const state = describeStepState(step, { isCurrent: step.index === currentIndex }).state;
            const words = describeStepProgress(step);
            const Icon = STATE_ICON[state];
            return (
              <button key={step.index} type="button" onClick={() => selectStep(step)} className="task-step" data-step-state={state}
                aria-current={step.index === selectedIndex ? 'step' : undefined}
                aria-label={`${step.name}: ${words.detail ? `${words.label}, ${words.detail}` : words.label}`}>
                <Icon size={13} aria-hidden="true" className="task-step-icon" />
                <span className="task-step-text">
                  <span className="task-step-name">{step.name}{step.repeat.mode === 'loop_back' && <Repeat size={11} aria-hidden="true" />}</span>
                  <span className="task-step-words">{words.detail ? `${words.label} · ${words.detail}` : words.label}</span>
                </span>
              </button>
            );
          })}
          <button type="button" onClick={onOpenTerminal} className="task-step-rail-action"><Plus size={12} aria-hidden="true" /> Terminal</button>
        </nav>
        <div className="task-view-main">
          <StepDetail run={run} step={selected} isCurrent={selected.index === currentIndex}
            terminalOpen={selected.sessionId !== null && openSessionIds.has(selected.sessionId)}
            onOpenTerminal={onOpenTerminal} onAnswer={onAnswer} onLoadNotes={onLoadNotes} onLoadDecisions={onLoadDecisions}
            onLoadReviews={onLoadReviews} onLoadAnswers={onLoadAnswers} onApprove={onApprove} onSendBack={onSendBack} />
          {children}
        </div>
      </div>
    </div>
  );
}
