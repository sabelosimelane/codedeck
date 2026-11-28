import React from 'react';
import { ChevronLeft, Terminal as TerminalGlyph } from 'lucide-react';
import QuestionsPanel from '../components/tasks/QuestionsPanel.jsx';
import ApprovalReview from '../components/tasks/ApprovalReview.jsx';
import { describeLimitPause, describeRunCompletion, describeRunStatus, describeStepProgress, describeStepState } from '../utils/pipelineRunStatus';
import '../components/tasks/task-view.css';
import { formatPhasePosition } from '../utils/phaseLabel';

// What the highlighted button says for the actions the phone offers.
const ACTION_LABEL = { resume: 'Resume', continue: 'Continue past the limit' };

/** The latest note for a step that reached its limit. */
function LimitNote({ runId, stepIndex, onLoadNotes }) {
  if (typeof runId !== 'string' || !runId) throw new Error('limit note: run id is required');
  if (!Number.isSafeInteger(stepIndex) || stepIndex < 0) throw new Error('limit note: step index must be nonnegative');
  if (typeof onLoadNotes !== 'function') throw new Error('limit note: note loader is required');
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState({ state: 'idle', content: null });
  React.useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setNote({ state: 'loading', content: null });
    (async () => {
      try {
        const page = await onLoadNotes(runId, 0, stepIndex);
        if (!active) return;
        const latest = page?.notes?.[0];
        // The app's loader toasts a failure and resolves null; that is not an empty note.
        setNote({ state: page === null ? 'error' : 'ready', content: latest?.status === 'written' ? latest.content : null });
      } catch (error) {
        console.warn(`Step note could not be loaded: ${error?.message}`);
        if (active) setNote({ state: 'error', content: null });
      }
    })();
    return () => { active = false; };
  }, [open, runId, stepIndex, onLoadNotes]);
  if (!open) {
    return <button className="m-press" type="button" onClick={() => setOpen(true)}>Read full note</button>;
  }
  if (note.state !== 'ready') {
    return <p className="m-task-phase m-mono">{note.state === 'error' ? 'The step note could not be loaded.' : 'Loading the step note…'}</p>;
  }
  return <p className="m-task-phase m-mono">{note.content ?? 'This step left no note.'}</p>;
}

function progressLine(progress) {
  if (progress === null || progress.status !== 'in_progress') return null;
  const { title, tasksDone, tasksTotal } = progress.phase;
  return `${formatPhasePosition(progress.phase, progress.phaseCount)}${title ? `: ${title}` : ''} · ${tasksDone} of ${tasksTotal} tasks done`;
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
  const completion = run.status === 'complete' ? describeRunCompletion(run) : null;
  // The capped pause the next Continue grants one more round for, if the run is capped.
  const pause = describeLimitPause(run);
  const capped = pause && run.steps.find(step => step.index === pause.stepIndex);
  const capUnit = pause?.repeatMode === 'until_complete' ? 'pass' : 'round';
  const usedRounds = pause ? pause.maxRounds + pause.extraRounds : 0;
  const capUnitWords = usedRounds === 1 ? capUnit : (capUnit === 'pass' ? 'passes' : `${capUnit}s`);
  const capWords = pause ? `${pause.stepName} paused at its limit: ${usedRounds} ${capUnitWords} used of ${pause.maxRounds} allowed${pause.extraRounds > 0 ? ` + ${pause.extraRounds} granted` : ''}.` : null;
  // The open full note belongs to one pause and its latest note: a direct pause-to-pause
  // refresh (background poll / visibilitychange from round 8 to round 9 without rendering
  // running) must not keep showing the previous pause's full note.
  const cappedNoteKey = pause ? `${capped?.note?.attempt ?? ''}:${capped?.note?.createdAt ?? ''}` : '';
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
        {completion && <p className="m-task-phase m-mono">{completion.successfulSteps}/{completion.totalSteps} steps done</p>}
        {phase && <p className="m-task-phase m-mono">{phase}</p>}
        {pause && run.actions?.continue ? (
          <div className="m-task-limit" role="status" aria-label="Paused at its limit">
            <p className="m-task-phase m-mono">{capWords}</p>
            {capped?.note?.summary && <p className="m-task-phase m-mono">Latest finding: {capped.note.summary}</p>}
            <LimitNote key={`${run.id}:${pause.stepIndex}:${pause.roundsCompleted}:${pause.extraRounds}:${cappedNoteKey}`} runId={run.id} stepIndex={pause.stepIndex} onLoadNotes={onLoadNotes} />
            <button className="m-primary m-press" disabled={busy} onClick={() => onAction('continue', run.id, { stepIndex: pause.stepIndex, roundsCompleted: pause.roundsCompleted, extraRounds: pause.extraRounds })}>{pause.actionLabel}</button>
            {run.actions?.stop && <button className="m-press" disabled={busy} onClick={() => onAction('stop', run.id)}>Stop with work remaining</button>}
          </div>
        ) : (Object.hasOwn(ACTION_LABEL, action ?? '') && (
          <button className="m-primary m-press" disabled={busy} onClick={() => onAction(action, run.id)}>{ACTION_LABEL[action]}</button>
        ))}
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
                  {completion?.endedAtLimit && step.status === 'limit_accepted' && step.note && (
                    <LimitNote key={`${run.id}:${step.index}:${step.note.createdAt}`} runId={run.id} stepIndex={step.index} onLoadNotes={onLoadNotes} />
                  )}
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
