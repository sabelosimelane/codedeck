import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { ACCEPT_RECOMMENDATIONS_ANSWER } from '../../../../shared/pipeline-definitions.mjs';
import { describeBlockedCleanup } from '../../utils/pipelineWorktreeCleanup';
import { approveRun, sendBackRun } from '../../utils/pipelinesApi';
import { useToast } from '../ToastContext';

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
  return <div role="group" aria-label={`${stepName} approval`} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', border: '1px solid var(--warning)', borderRadius: 6, background: 'var(--bg-base)' }}>
    <strong>{`${stepName} is waiting for your approval`}</strong>
    {run.approvalRequest.note?.summary && <span>{run.approvalRequest.note.summary}</span>}
    {note.state === 'loading' && <span>Loading the step note…</span>}
    {note.state === 'error' && <span>The step note could not be loaded.</span>}
    {note.state === 'ready' && (note.content === null ? <span>This step left no note.</span> : <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflowY: 'auto' }}>{note.content}</div>)}
    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
      <button type="button" disabled={busy} onClick={() => submit('approve')}>Approve</button>
      <textarea aria-label="Send-back comment" value={comment} maxLength={4000} disabled={busy} onChange={event => setComment(event.target.value)} rows={2} style={{ flex: 1, background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border)' }} />
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
    <div
      role="group"
      aria-label={`${name} needs your input`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        border: '1px solid var(--warning)',
        borderRadius: 6,
        background: 'var(--bg-base)',
      }}
    >
      {request === null && (
        <span>The agent is showing a dialog in its terminal. Answer it there.</span>
      )}
      {request !== null && request.questions === null && (
        <span>The agent did not say what it needs. Read its terminal, then answer here or there.</span>
      )}
      {request !== null && request.questions !== null && (
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-primary)', lineHeight: 1.5, maxHeight: 220, overflowY: 'auto' }}>
          {request.questions}
        </div>
      )}
      {request?.truncated && (
        <span style={{ color: 'var(--warning)' }}>The list was cut here. Read the rest in the agent's terminal.</span>
      )}
      {run.actions?.answer && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea
            aria-label={`Answer for ${name}`}
            rows={2}
            maxLength={4000}
            value={draft}
            disabled={sending}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Type your answer; it is sent to the agent's terminal"
            style={{
              flex: 1,
              minWidth: 0,
              resize: 'vertical',
              padding: '6px 8px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--bg-surface)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
            }}
          />
          <button type="button" disabled={sending || draft.trim() === ''} onClick={() => send(draft)}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} style={{ alignSelf: 'flex-start' }}>
        {`${count} ${noun} made by agents`}
      </button>
      {open && state.status === 'failed' && (
        <span style={{ color: 'var(--danger)' }}>
          The decisions could not be loaded.{' '}
          <button type="button" onClick={() => load(state.pages)}>Try again</button>
        </span>
      )}
      {open && state.decisions.length > 0 && (
        <ul
          aria-label={`Decisions agents made in ${run.workflowName}`}
          style={{ listStyle: 'none', margin: 0, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-base)', maxHeight: 260, overflowY: 'auto' }}
        >
          {state.decisions.map(decision => (
            <li key={decision.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <strong style={{ color: 'var(--text-primary)' }}>{`${decision.stepName}, pass ${decision.pass}`}</strong>
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--text-primary)', lineHeight: 1.5 }}>{decision.questions}</div>
              {decision.truncated && <span style={{ color: 'var(--warning)' }}>The list was cut here.</span>}
              <span style={{ color: 'var(--text-muted)' }}>{`Answered: ${decision.answer}`}</span>
            </li>
          ))}
        </ul>
      )}
      {open && state.status !== 'failed' && state.hasNextPage && (
        <button type="button" disabled={state.status === 'loading'} onClick={() => load(state.pages)} style={{ alignSelf: 'flex-start' }}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {run.steps.filter(step => step.note && step.note.status !== 'written').map(step => (
        <span key={step.index} style={{ color: 'var(--warning)' }}>{`${step.name} ${NOTE_WARNING[step.note.status]}`}</span>
      ))}
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} style={{ alignSelf: 'flex-start' }}>Notes</button>
      {open && state.status === 'failed' && <span style={{ color: 'var(--danger)' }}>{state.error || 'The notes could not be loaded.'} <button type="button" onClick={() => load(state.pages)}>Try again</button></span>}
      {open && state.notes.length > 0 && (
        <ul aria-label={`Notes in ${run.workflowName}`} style={{ listStyle: 'none', margin: 0, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-base)', maxHeight: 260, overflowY: 'auto' }}>
          {state.notes.map(note => <li key={note.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <strong style={{ color: 'var(--text-primary)' }}>{`${note.stepName}, pass ${note.pass}`}</strong>
            {note.summary && <span>{note.summary}</span>}
            {note.content !== null && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{note.content}</div>}
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
    <div
      data-testid="pipeline-runs-bar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        fontSize: 12,
        color: 'var(--text-secondary)',
      }}
    >
      {runs.map((run) => {
        const currentStep = run.steps?.[run.currentStepIndex] || run.steps?.find((step) => step.sessionId) || run.steps?.[0];
        const blockedCleanup = run.worktree?.state === 'removal_blocked' && run.worktree.detail
          ? describeBlockedCleanup(run.worktree.detail)
          : null;
        return (
          <div key={run.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div
            style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}
          >
            <strong style={{ color: 'var(--text-primary)' }}>{run.workflowName}</strong>
            {run.worktree?.branch && (
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                {run.worktree.branch}
              </span>
            )}
            <span style={{ color: 'var(--text-muted)' }}>{run.status}</span>
            {run.agentsDecide && (
              <span title="Agents in this run go with their own recommendations instead of pausing for you" style={{ color: 'var(--warning)' }}>agents decide</span>
            )}

            {run.progress !== null && run.progress !== undefined && (
              <div title={run.progress.file} style={{ flexBasis: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                {run.progress.status === 'in_progress' ? (
                  <>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{`Phase ${run.progress.phase.number} of ${run.progress.phaseCount}${run.progress.phase.title ? `: ${run.progress.phase.title}` : ''}`}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{` · ${run.progress.phase.tasksDone}/${run.progress.phase.tasksTotal} tasks`}</span>
                  </>
                ) : (
                  <span style={{ color: run.progress.status === 'all_done' ? 'var(--accent)' : 'var(--warning)' }}>
                    {run.progress.status === 'all_done' && `All ${run.progress.phaseCount} ${run.progress.phaseCount === 1 ? 'phase' : 'phases'} ticked`}
                    {run.progress.status === 'no_phases' && `No "## Phase N" sections in ${run.progress.file}`}
                    {run.progress.status === 'missing' && `Progress file not found: ${run.progress.file}`}
                    {run.progress.status === 'unreadable' && `Progress file could not be read: ${run.progress.file}`}
                  </span>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {(run.steps || []).map((step) => {
                const label = chipLabel(step);
                return (
                  <button
                    key={`${run.id}-${step.index}`}
                    type="button"
                    disabled={!step.sessionId}
                    onClick={() => step.sessionId && onActivateStep(step.sessionId)}
                    aria-label={label}
                    title={label}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: '1px solid var(--border)',
                      background: 'var(--bg-hover)',
                      color: 'var(--text-primary)',
                      cursor: step.sessionId ? 'pointer' : 'default',
                      opacity: step.sessionId ? 1 : 0.6,
                    }}
                  >
                    {step.status === 'complete' && <Check size={12} color="var(--accent)" aria-hidden="true" />}
                    {label}
                  </button>
                );
              })}
            </div>

            {run.error && (
              <span style={{ color: 'var(--danger)' }}>{run.error}</span>
            )}
            {blockedCleanup && (
              <>
                <span style={{ color: 'var(--warning)' }}>{blockedCleanup.summary}</span>
                {blockedCleanup.paths.length > 0 && (
                  <details>
                    <summary>Show files</summary>
                    <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>
                      {blockedCleanup.paths.map((path, index) => <div key={`${index}-${path}`}>{path}</div>)}
                    </div>
                  </details>
                )}
              </>
            )}

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {run.actions?.stop && (
                <button type="button" onClick={() => onStop(run.id)}>Stop</button>
              )}
              {run.actions?.continue && (
                <button type="button" onClick={() => onContinue(run.id)}>Continue</button>
              )}
              {run.actions?.resume && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(resumeConfirmation(run, currentStep))) onResume(run.id);
                  }}
                >
                  Resume
                </button>
              )}
              {run.actions?.cleanup && (
                <button type="button" onClick={() => onCleanup(run.id)}>
                  {/* A worktree the owner chose is never removed; the run only lets go of it. */}
                  {run.worktree?.state === 'external' ? 'Dismiss run' : 'Clean up worktree'}
                </button>
              )}
            </div>
          </div>
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
