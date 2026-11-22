import React from 'react';
import { Check } from 'lucide-react';
import { describeWorktreeGroup } from '../utils/worktreeGroups';
import { describeRunStatus } from '../utils/pipelineRunStatus';

export default function WorktreeGroupHeader({ group, selected, onClick }) {
  const run = group.run;
  const { title, tooltip } = describeWorktreeGroup(group);
  const status = run ? describeRunStatus(run) : null;
  const phase = run?.progress?.phase;
  const note = run?.steps?.findLast(step => step.note?.summary)?.note?.summary;
  const currentStep = run?.steps?.find(step => ['running', 'launching', 'needs_input', 'awaiting_approval', 'limit_reached'].includes(step.status));
  const detail = phase && Number.isInteger(phase.number) && Number.isInteger(run.progress.phaseCount)
    ? `Phase ${phase.number} of ${run.progress.phaseCount}`
    : note ?? currentStep?.name ?? null;
  return (
    <button type="button" onClick={event => { event.stopPropagation(); onClick(); }}
      aria-label={`Select ${title} worktree`}
      title={tooltip}
      data-testid="worktree-group-header"
      data-selected={String(selected)}
      className="worktree-group-header">
      <span className="worktree-group-header-row">
        <span className="worktree-group-header-title">{title}</span>
        {status && (
          <span className="worktree-group-header-status" data-tone={status.tone}>
            {status.tone === 'done' && <Check size={10} strokeWidth={2.75} aria-hidden="true" />}
            {status.label.toLowerCase()}
          </span>
        )}
      </span>
      {detail && <span className="worktree-group-header-detail">{detail}</span>}
    </button>
  );
}
