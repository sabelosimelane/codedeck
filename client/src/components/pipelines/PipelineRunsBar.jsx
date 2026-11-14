import React, { useState } from 'react';

const ACCEPT_RECOMMENDATIONS = 'Proceed with your recommendations.';

function passLabel(step) {
  if (step?.repeat?.mode === 'until_complete' && typeof step.repeat.max === 'number') {
    return `${step.iteration ?? 0}/${step.repeat.max}`;
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

export default function PipelineRunsBar({
  runs,
  onStop,
  onResume,
  onContinue,
  onCleanup,
  onAnswer,
  onActivateStep,
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
          </div>
        );
      })}
    </div>
  );
}
