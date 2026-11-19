import React from 'react';
import { ChevronLeft, Terminal as TerminalGlyph } from 'lucide-react';
import QuestionsPanel from '../components/tasks/QuestionsPanel.jsx';
import ApprovalReview from '../components/tasks/ApprovalReview.jsx';
import { describeRunStatus, describeStepProgress, describeStepState } from '../utils/pipelineRunStatus';
import '../components/tasks/task-view.css';

// What the highlighted button says for the actions the phone offers.
const ACTION_LABEL = { resume: 'Resume', continue: 'Continue past the limit' };

function progressLine(progress) {
  if (progress === null || progress.status !== 'in_progress') return null;
  const { number, title, tasksDone, tasksTotal } = progress.phase;
  return `Phase ${number} of ${progress.phaseCount}${title ? `: ${title}` : ''} · ${tasksDone} of ${tasksTotal} tasks done`;
}

/**
 * A workflow run as its task: how it stands, its steps, and on the step that waits for the
 * owner its questions or its approval. The questions and the approval are the desktop's own
 * panels; the handlers report success and failure themselves and resolve to null when an
 * action did not go through.
 */
export default function TaskScreen({ row, busy, banner = null, onBack, onOpenSession, onAnswer, onApprove, onSendBack, onLoadNotes, onAction }) {
  if (!row || typeof row !== 'object' || !row.run) throw new Error('task screen: row is required');
  for (const [name, value] of Object.entries({ onBack, onOpenSession, onAnswer, onApprove, onSendBack, onLoadNotes, onAction })) {
    if (typeof value !== 'function') throw new Error(`task screen: ${name} must be a function`);
  }
  const { run } = row;
  const action = describeRunStatus(run).primaryAction;
  const phase = progressLine(run.progress);
  const sessionById = new Map(row.sessions.map(session => [session.id, session]));

  return (
    <main className="mobile-app m-task-screen">
      <header className="m-bar">
        <button className="m-icon m-press" onClick={onBack} aria-label="Back to sessions"><ChevronLeft size={22} aria-hidden="true" /></button>
        <div className="m-term-title m-rise">
          <h1>{row.title}</h1>
          <p className="m-mono"><span className={`m-dot is-${row.tone}`} /><span className={`m-state is-${row.tone}`}>{row.label}</span> · {row.workflowName} · {row.projectName}</p>
        </div>
      </header>
      {banner}
      <section className="m-task" aria-label="Task">
        {run.error !== null && <p role="alert" className="m-task-error">{run.error}</p>}
        {row.repositories !== null && (
          <ul className="m-task-repositories m-mono" aria-label="Repositories">
            {row.repositories.map(entry => (
              <li key={entry.name}>{[entry.name, entry.current ? 'the run works here' : null, entry.state === 'active' ? null : entry.state === 'pr_open' ? 'pull request open' : entry.state].filter(Boolean).join(' · ')}</li>
            ))}
          </ul>
        )}
        {phase && <p className="m-task-phase m-mono">{phase}</p>}
        {Object.hasOwn(ACTION_LABEL, action ?? '') && (
          <button className="m-primary m-press" disabled={busy} onClick={() => onAction(action, run.id)}>{ACTION_LABEL[action]}</button>
        )}
        <ol className="m-steps" aria-label="Steps">
          {run.steps.map(step => {
            const isCurrent = step.index === run.currentStepIndex;
            const { state } = describeStepState(step, { isCurrent });
            const { label, detail } = describeStepProgress(step);
            const session = step.sessionId === null ? undefined : sessionById.get(step.sessionId);
            return (
              <li key={step.index} className={`m-step is-${state}`} aria-current={isCurrent ? 'step' : undefined}>
                <span className="m-step-mark" aria-hidden="true" />
                <div className="m-step-body">
                  <div className="m-step-head">
                    <span className="m-step-name">{step.name}</span>
                    {session && (
                      <button className="m-step-terminal m-press" aria-label={`Open terminal of ${step.name}`} onClick={() => onOpenSession(session)}>
                        <TerminalGlyph size={16} aria-hidden="true" />Terminal
                      </button>
                    )}
                  </div>
                  <span className="m-step-meta">{[label, detail, step.agentName].filter(Boolean).join(' · ')}</span>
                  {isCurrent && run.status === 'needs_input' && (
                    <QuestionsPanel key={`${run.id}:${run.inputRequest?.questions ?? ''}`} run={run} onAnswer={onAnswer} />
                  )}
                  {isCurrent && run.approvalRequest !== null && (
                    <ApprovalReview key={`${run.id}:${run.approvalRequest.stepIndex}:${run.approvalRequest.note?.createdAt ?? ''}`} run={run}
                      onLoadNotes={onLoadNotes} onApprove={onApprove} onSendBack={onSendBack} />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </main>
  );
}
