import React from 'react';

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

export default function PipelineRunsBar({
  runs,
  onStop,
  onResume,
  onContinue,
  onCleanup,
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
          <div
            key={run.id}
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
                <button type="button" onClick={() => onCleanup(run.id)}>Clean up worktree</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
