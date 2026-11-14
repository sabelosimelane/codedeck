import React, { useEffect, useRef, useState } from 'react';
import { ACCEPT_RECOMMENDATIONS_ANSWER } from '../../../../shared/pipeline-definitions.mjs';

const ACCEPT_RECOMMENDATIONS = ACCEPT_RECOMMENDATIONS_ANSWER;

function passLabel(step) {
  if (step?.repeat?.mode === 'until_complete' && typeof step.repeat.max === 'number') {
    return `${step.iteration ?? 0}/${step.repeat.max}`;
  }
  // A step that loops back counts rounds of its loop: the ones it sent back, plus the current one.
  if (step?.repeat?.mode === 'loop_back') {
    return `round ${step.roundsCompleted + 1}/${step.repeat.max}`;
  }
  return null;
}

function previousTerminalName(step) {
  if (step?.sessionId) return step.sessionId;
  if (step?.priorSessionIds?.length) return step.priorSessionIds[step.priorSessionIds.length - 1];
  return 'the previous terminal';
}

function chipLabel(step) {
  const pass = passLabel(step);
  return pass ? `${step.name} ${step.status} ${pass}` : `${step.name} ${step.status}`;
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

export default function PipelineRunsBar({
  runs,
  onStop,
  onResume,
  onContinue,
  onCleanup,
  onAnswer,
  onActivateStep,
  onLoadDecisions,
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
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: '1px solid var(--border)',
                      background: 'var(--bg-hover)',
                      color: 'var(--text-primary)',
                      cursor: step.sessionId ? 'pointer' : 'default',
                      opacity: step.sessionId ? 1 : 0.6,
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {run.error && (
              <span style={{ color: 'var(--danger)' }}>{run.error}</span>
            )}
            {run.worktree?.state === 'removal_blocked' && run.worktree.detail && (
              <span style={{ color: 'var(--warning)' }}>{run.worktree.detail}</span>
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
                    const previous = previousTerminalName(currentStep);
                    const confirmed = window.confirm(
                      `Resume ${run.workflowName}? The previous terminal (${previous}) may still be working.`,
                    );
                    if (confirmed) onResume(run.id);
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
          <DecisionsPanel run={run} onLoadDecisions={onLoadDecisions} />
          </div>
        );
      })}
    </div>
  );
}
