import React, { useEffect, useRef, useState } from 'react';
import { Check, Repeat } from 'lucide-react';
import { ACCEPT_RECOMMENDATIONS_ANSWER } from '../../../../shared/pipeline-definitions.mjs';
import { describeBlockedCleanup } from '../../utils/pipelineWorktreeCleanup';
import { approveRun, sendBackRun } from '../../utils/pipelinesApi';
import { useToast } from '../ToastContext';
import { describeRunStatus, describeStepState } from '../../utils/pipelineRunStatus';
import './pipeline-runs.css';

const ACCEPT_RECOMMENDATIONS = ACCEPT_RECOMMENDATIONS_ANSWER;

function passLabel(step) {
  if (step.repeat?.mode === 'until_complete') {
    if (step.status === 'complete') {
      return `${step.iteration} ${step.iteration === 1 ? 'pass' : 'passes'}`;
    }
    return step.iteration >= 1
      ? `pass ${step.iteration} (max ${step.repeat.max})`
      : `max ${step.repeat.max} passes`;
  }
  // A step that loops back counts rounds of its loop: the ones it sent back, plus the current one.
  if (step.repeat?.mode === 'loop_back') {
    const rounds = step.roundsCompleted + 1;
    return step.status === 'complete'
      ? `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`
      : `round ${rounds} (max ${step.repeat.max})`;
  }
  return null;
}

/**
 * Resume sends a step back to its own terminal: the agent there is cleared with its reset
 * command and the prompt is sent again; an agent that exited is started again there. The
 * backend opens a new terminal only when that one was closed; a step that never got a
 * terminal always starts in a new one.
 */
function resumeConfirmation(run, step) {
  if (!step?.sessionId) return `Resume ${run.workflowName}? ${step.name} starts in a new terminal.`;
  return `Resume ${run.workflowName}? The agent in ${step.sessionId} is cleared and ${step.name} starts again there. `
    + 'If its agent has exited, it is started again there. A new terminal is opened only if that one was closed.';
}

function chipLabel(step) {
  if (step.status === 'awaiting_approval') return `${step.name} awaiting approval`;
  const pass = passLabel(step);
  return pass ? `${step.name} ${step.status} · ${pass}` : `${step.name} ${step.status}`;
}

function ApprovalPanel({ run, onLoadNotes, onApprove, onSendBack }) {
  const { showToast } = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [note, setNote] = useState({ state: 'loading', content: null });
  const { stepIndex, stepName } = run.approvalRequest;
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const page = await onLoadNotes(run.id, 0, stepIndex);
        if (!active) return;
        const latest = page?.notes?.[0];
        setNote({ state: page === null ? 'error' : 'ready', content: latest?.status === 'written' ? latest.content : null });
      } catch (error) {
        if (active) setNote({ state: 'error', content: null });
      }
    };
    load();
    return () => { active = false; };
  }, [run.id, stepIndex, onLoadNotes]);
  const submit = async (kind) => {
    if (busyRef.current || (kind === 'sendBack' && !comment.trim())) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const action = kind === 'approve' ? (onApprove ?? approveRun) : (onSendBack ?? sendBackRun);
      const result = kind === 'approve' ? await action(run.id) : await action(run.id, comment);
      if (result !== null) {
        showToast({ type: 'success', message: kind === 'approve' ? `${stepName} approved` : `${stepName} sent back` });
        if (kind === 'sendBack') setComment('');
      }
    } catch (error) {
      showToast({ type: 'error', message: error?.message || 'Pipelines request failed' });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return <div role="group" aria-label={`${stepName} approval`} className="pipeline-run-panel">
    <strong>{`${stepName} is waiting for your approval`}</strong>
    {run.approvalRequest.note?.summary && <span>{run.approvalRequest.note.summary}</span>}
    {note.state === 'loading' && <span>Loading the step note…</span>}
    {note.state === 'error' && <span>The step note could not be loaded.</span>}
    {note.state === 'ready' && (note.content === null ? <span>This step left no note.</span> : <div className="pipeline-run-scroll-content">{note.content}</div>)}
    <div className="pipeline-run-form-row">
      <button type="button" disabled={busy} onClick={() => submit('approve')} className={describeRunStatus(run).primaryAction === 'approve' ? 'pipeline-run-primary' : undefined}>Approve</button>
      <textarea aria-label="Send-back comment" value={comment} maxLength={4000} disabled={busy} onChange={event => setComment(event.target.value)} rows={2} className="pipeline-run-textarea" />
      <button type="button" disabled={busy || !comment.trim()} onClick={() => submit('sendBack')}>Send back</button>
    </div>
  </div>;
}

/**
 * What a run is waiting for and, when the agent signalled it, a way to answer without
 * opening the terminal. The answer is typed into the agent's terminal by the backend.
 */
function InputRequestPanel({ run, onAnswer }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const request = run.inputRequest;
  const name = run.workflowName;

  const send = async (text) => {
    if (sending) return;
    setSending(true);
    // `onAnswer` resolves to the updated run, or null when the answer was not delivered.
    const delivered = await onAnswer(run.id, text);
    setSending(false);
    if (delivered) setDraft('');
  };

  return (
    <div role="group" aria-label={`${name} needs your input`} className="pipeline-run-panel">
      {request === null && (
        <span>The agent is showing a dialog in its terminal. Answer it there.</span>
      )}
      {request !== null && request.questions === null && (
        <span>The agent did not say what it needs. Read its terminal, then answer here or there.</span>
      )}
      {request !== null && request.questions !== null && (
        <div className="pipeline-run-request-content">
          {request.questions}
        </div>
      )}
      {request?.truncated && (
        <span className="pipeline-run-warning">The list was cut here. Read the rest in the agent's terminal.</span>
      )}
      {run.actions?.answer && (
        <div className="pipeline-run-form-row">
          <textarea
            aria-label={`Answer for ${name}`}
            rows={2}
            maxLength={4000}
            value={draft}
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type your answer; it is sent to the agent's terminal"
            className="pipeline-run-textarea"
          />
          <button type="button" disabled={sending || draft.trim() === ''} onClick={() => send(draft)} className={describeRunStatus(run).primaryAction === 'answer' ? 'pipeline-run-primary' : undefined}>
            Send answer
          </button>
          {request?.questions != null && (
            <button type="button" disabled={sending} onClick={() => send(ACCEPT_RECOMMENDATIONS)}>
              Accept recommendations
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The requests this run's agents settled themselves, loaded when the owner opens the list.
 * `onLoadDecisions(runId, page)` resolves to `{ decisions, hasNextPage }`, or null when the
 * page could not be loaded (the caller has already told the owner why).
 */
function DecisionsPanel({ run, onLoadDecisions }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ decisions: [], hasNextPage: false, pages: 0, status: 'idle' });
  // Only the answer to the latest request is shown; closing the list retires every request.
  const latest = useRef(0);
  const count = run.decisionCount;
  const noun = count === 1 ? 'decision' : 'decisions';

  const load = async (page) => {
    const request = ++latest.current;
    setState(current => ({ ...(page === 0 ? { decisions: [], hasNextPage: false, pages: 0 } : current), status: 'loading' }));
    const loaded = await onLoadDecisions(run.id, page);
    if (request !== latest.current) return;
    setState(current => (loaded === null
      ? { ...current, status: 'failed' }
      : {
        decisions: page === 0 ? loaded.decisions : [...current.decisions, ...loaded.decisions],
        hasNextPage: loaded.hasNextPage,
        pages: page + 1,
        status: 'idle',
      }));
  };

  // Opening the list loads it; so does a decision made while it is open.
  useEffect(() => {
    if (open) load(0);
    else latest.current += 1;
    // `load` reads only the run id, which identifies this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, count, run.id]);

  if (count === 0) return null;
  return (
    <div className="pipeline-run-panel">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="pipeline-run-panel-toggle">
        {`${count} ${noun} made by agents`}
      </button>
      {open && state.status === 'failed' && (
        <span className="pipeline-run-danger">
          The decisions could not be loaded.{' '}
          <button type="button" onClick={() => load(state.pages)}>Try again</button>
        </span>
      )}
      {open && state.decisions.length > 0 && (
        <ul
          aria-label={`Decisions agents made in ${run.workflowName}`}
          className="pipeline-run-list"
        >
          {state.decisions.map(decision => (
            <li key={decision.id} className="pipeline-run-list-item">
              <strong className="pipeline-run-primary-text">{`${decision.stepName}, pass ${decision.pass}`}</strong>
              <div className="pipeline-run-pre-wrap">{decision.questions}</div>
              {decision.truncated && <span className="pipeline-run-warning">The list was cut here.</span>}
              <span className="pipeline-run-muted">{`Answered: ${decision.answer}`}</span>
            </li>
          ))}
        </ul>
      )}
      {open && state.status !== 'failed' && state.hasNextPage && (
        <button type="button" disabled={state.status === 'loading'} onClick={() => load(state.pages)} className="pipeline-run-panel-toggle">
          Show more decisions
        </button>
      )}
    </div>
  );
}

const NOTE_WARNING = {
  missing: 'left no note on its last pass',
  unchanged: 'did not update its note on its last pass',
  unreadable: 'note could not be read on its last pass',
  too_large: 'note is too large on its last pass',
};

function NotesPanel({ run, onLoadNotes }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ notes: [], hasNextPage: false, pages: 0, status: 'idle' });
  const latest = useRef(0);
  const load = async page => {
    const request = ++latest.current;
    setState(current => ({ ...current, status: 'loading' }));
    try {
      const loaded = await onLoadNotes(run.id, page);
      if (request !== latest.current) return;
      setState(current => loaded === null ? { ...current, status: 'failed' } : {
        notes: page === 0 ? loaded.notes : [...current.notes, ...loaded.notes],
        hasNextPage: loaded.hasNextPage,
        pages: page + 1,
        status: 'idle',
      });
    } catch (error) {
      if (request === latest.current) setState(current => ({ ...current, status: 'failed', error: error?.message || 'Notes could not be loaded' }));
    }
  };
  useEffect(() => {
    if (open) load(0);
    else latest.current += 1;
    // The run id identifies the list; opening it refreshes page zero.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, run.id]);
  if (run.notesDir === null) return null;
  return (
    <div className="pipeline-run-panel">
      {run.steps.filter(step => step.note && step.note.status !== 'written').map(step => (
        <span key={step.index} className="pipeline-run-warning">{`${step.name} ${NOTE_WARNING[step.note.status]}`}</span>
      ))}
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="pipeline-run-panel-toggle">Notes</button>
      {open && state.status === 'failed' && <span className="pipeline-run-danger">{state.error || 'The notes could not be loaded.'} <button type="button" onClick={() => load(state.pages)}>Try again</button></span>}
      {open && state.notes.length > 0 && (
        <ul aria-label={`Notes in ${run.workflowName}`} className="pipeline-run-list">
          {state.notes.map(note => <li key={note.id} className="pipeline-run-list-item">
            <strong className="pipeline-run-primary-text">{`${note.stepName}, pass ${note.pass}`}</strong>
            {note.summary && <span>{note.summary}</span>}
            {note.content !== null && <div className="pipeline-run-pre-wrap">{note.content}</div>}
          </li>)}
        </ul>
      )}
      {open && state.hasNextPage && <button type="button" disabled={state.status === 'loading'} onClick={() => load(state.pages)}>Show more notes</button>}
    </div>
  );
}

export default function PipelineRunsBar({
  runs,
  onStop,
  onResume,
  onContinue,
  onCleanup,
  onAnswer,
  onActivateStep,
  onLoadDecisions,
  onLoadNotes,
  onApprove,
  onSendBack,
}) {
  if (!runs?.length) return null;

  return (
    <div data-testid="pipeline-runs-bar" className="pipeline-run-bar">
      {runs.map((run) => {
        const currentStep = run.steps?.[run.currentStepIndex] || run.steps?.find((step) => step.sessionId) || run.steps?.[0];
        const status = describeRunStatus(run);
        const blockedCleanup = run.worktree?.state === 'removal_blocked' && run.worktree.detail
          ? describeBlockedCleanup(run.worktree.detail)
          : null;
        return (
          <div key={run.id} className="pipeline-run-item">
          <div className="pipeline-run-heading">
            <strong className="pipeline-run-name">{run.workflowName}</strong>
            <span className="pipeline-run-status" data-status={run.status} data-tone={status.tone} aria-label={`Run status: ${status.label}`}>{status.label}</span>
            {run.agentsDecide && (
              <span title="Agents in this run go with their own recommendations instead of pausing for you" className="pipeline-run-agents-decide">agents decide</span>
            )}
            {run.worktree?.branch && (
              <span className="pipeline-run-branch" title={run.worktree.branch}>
                {run.worktree.branch}
              </span>
            )}
            <div className="pipeline-run-actions">
              {run.actions?.stop && !['interrupted', 'stopped', 'error', 'complete'].includes(run.status) && (
                <button type="button" onClick={() => onStop(run.id)}>Stop</button>
              )}
              {run.actions?.continue && (
                <button type="button" onClick={() => onContinue(run.id)} className={status.primaryAction === 'continue' ? 'pipeline-run-primary' : undefined}>Continue</button>
              )}
              {run.actions?.resume && (
                <button type="button" onClick={() => { if (window.confirm(resumeConfirmation(run, currentStep))) onResume(run.id); }} className={status.primaryAction === 'resume' ? 'pipeline-run-primary' : undefined}>Resume</button>
              )}
              {run.actions?.cleanup && (
                <button type="button" onClick={() => onCleanup(run.id)} className={status.primaryAction === 'cleanup' ? 'pipeline-run-primary' : undefined}>
                  {/* A worktree the owner chose is never removed; the run only lets go of it. */}
                  {run.worktree?.state === 'external' ? 'Dismiss run' : 'Clean up worktree'}
                </button>
              )}
            </div>
          </div>
          {run.progress !== null && run.progress !== undefined && (
              <div title={run.progress.file} className="pipeline-run-progress">
                {run.progress.status === 'in_progress' ? (
                  <>
                    <span className="pipeline-run-progress-phase">{`Phase ${run.progress.phase.number} of ${run.progress.phaseCount}${run.progress.phase.title ? `: ${run.progress.phase.title}` : ''}`}</span>
                    <span className="pipeline-run-muted">{` · ${run.progress.phase.tasksDone}/${run.progress.phase.tasksTotal} tasks`}</span>
                  </>
                ) : (
                  <span className={run.progress.status === 'all_done' ? 'pipeline-run-accent' : 'pipeline-run-warning'}>
                    {run.progress.status === 'all_done' && `All ${run.progress.phaseCount} ${run.progress.phaseCount === 1 ? 'phase' : 'phases'} ticked`}
                    {run.progress.status === 'no_phases' && `No "## Phase N" sections in ${run.progress.file}`}
                    {run.progress.status === 'missing' && `Progress file not found: ${run.progress.file}`}
                    {run.progress.status === 'unreadable' && `Progress file could not be read: ${run.progress.file}`}
                  </span>
                )}
              </div>
            )}
            <div className="pipeline-run-steps">
              {(run.steps || []).map((step) => {
                const label = chipLabel(step);
                const loopTarget = step.repeat?.mode === 'loop_back' ? run.steps?.find(target => target.index === step.repeat.toStepIndex) : null;
                return (
                  <button
                    key={`${run.id}-${step.index}`}
                    type="button"
                    disabled={!step.sessionId}
                    onClick={() => step.sessionId && onActivateStep(step.sessionId)}
                    aria-label={label}
                    title={label}
                    data-step-state={describeStepState(step, { isCurrent: step.index === run.currentStepIndex || (run.currentStepIndex === undefined && currentStep === step) }).state}
                    className="pipeline-run-step"
                  >
                    {step.status === 'complete' && <Check size={12} aria-hidden="true" />}
                    {loopTarget && <Repeat size={12} aria-hidden="true" title={`Loops back to ${loopTarget.name}`} />}
                    {label}
                  </button>
                );
              })}
            </div>

            {run.error && (
              <span className="pipeline-run-danger">{run.error}</span>
            )}
            {blockedCleanup && (
              <>
                <span className="pipeline-run-warning">{blockedCleanup.summary}</span>
                {blockedCleanup.paths.length > 0 && (
                  <details>
                    <summary>Show files</summary>
                    <div className="pipeline-run-cleanup-paths">
                      {blockedCleanup.paths.map((path, index) => <div key={`${index}-${path}`}>{path}</div>)}
                    </div>
                  </details>
                )}
              </>
            )}

          {run.status === 'needs_input' && <InputRequestPanel run={run} onAnswer={onAnswer} />}
          {run.status === 'awaiting_approval' && <ApprovalPanel run={run} onLoadNotes={onLoadNotes} onApprove={onApprove} onSendBack={onSendBack} />}
          <DecisionsPanel run={run} onLoadDecisions={onLoadDecisions} />
          <NotesPanel run={run} onLoadNotes={onLoadNotes} />
          </div>
        );
      })}
    </div>
  );
}
