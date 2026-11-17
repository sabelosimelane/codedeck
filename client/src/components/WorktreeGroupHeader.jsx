import React from 'react';

const STATUS = {
  pending: 'paused', running: 'running', needs_input: 'needs you', limit_paused: 'paused',
  awaiting_approval: 'waiting for approval', interrupted: 'stopped', stopped: 'stopped', error: 'error', complete: 'done',
};
const WAITING = new Set(['needs_input', 'limit_paused', 'awaiting_approval']);

export default function WorktreeGroupHeader({ group, selected, onClick }) {
  const run = group.run;
  const phase = run?.progress?.phase;
  const note = run?.steps?.findLast(step => step.note?.summary)?.note?.summary;
  const currentStep = run?.steps?.find(step => ['running', 'launching', 'needs_input', 'awaiting_approval', 'limit_reached'].includes(step.status));
  const detail = phase && Number.isInteger(phase.number) && Number.isInteger(run.progress.phaseCount)
    ? `Phase ${phase.number} of ${run.progress.phaseCount}`
    : note ?? currentStep?.name ?? null;
  return (
    <button type="button" onClick={event => { event.stopPropagation(); onClick(); }}
      aria-label={`Select ${group.label} worktree`}
      data-testid="worktree-group-header"
      data-selected={String(selected)}
      style={{ width: '100%', marginTop: 7, padding: '4px 4px 4px 16px', textAlign: 'left', background: selected ? 'var(--bg-active)' : 'transparent', borderLeft: selected ? '2px solid var(--accent)' : '2px solid transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
        <span>{group.label}</span>
        {group.branch && <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{group.branch}</span>}
        {run && <span style={{ color: WAITING.has(run.status) ? 'var(--warning)' : 'var(--text-muted)' }}>{STATUS[run.status] ?? run.status}</span>}
        {run && WAITING.has(run.status) && <span aria-label="Waiting for owner" style={{ color: 'var(--warning)' }}>●</span>}
      </span>
      {detail && <span style={{ display: 'block', marginTop: 2, fontSize: 10, color: 'var(--text-muted)' }}>{detail}</span>}
    </button>
  );
}
