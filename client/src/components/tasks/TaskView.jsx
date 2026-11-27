import { listRunAudit } from '../../utils/pipelinesApi';
import { liveAgentChangeTiming } from '../../../../shared/pipeline-definitions.mjs';
import ChangeRunAgent from '../pipelines/ChangeRunAgent';
import ChangeRunTeam from '../pipelines/ChangeRunTeam';
import React, { useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, CircleDot, Circle, Repeat, TriangleAlert, Square, Plus } from 'lucide-react';
import { NO_PROGRESS_ROUNDS } from '../../../../shared/pipeline-definitions.mjs';
import { describeAuditIntervals, describeLimitPause, describeRunCompletion, describeRunDuration, describeRunStatus, describeStepDuration, describeStepProgress, describeStepState } from '../../utils/pipelineRunStatus';
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

function cleanupConfirmation(run) {
  if (run.worktree?.state === 'external') {
    return `Close ${run.workflowName}? Its terminals are closed and the run leaves the screen. The task and its files remain available.`;
  }
  return `Clean up the worktree for ${run.workflowName}? This removes the run's worktree and closes its terminals.`;
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
function StepRecords({ label, emptyText, load, resetKey, render, summary }) {
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
      {open && state.items.length > 0 && summary?.(state.items)}
      {open && state.items.length > 0 && <ul aria-label={label} className="pipeline-run-list">{state.items.map(render)}</ul>}
    </div>
  );
}

function StepDetail({ run, step, isCurrent, terminalOpen, onOpenTerminal, onAnswer, onLoadNotes, onLoadDecisions, onLoadReviews, onLoadAnswers, onApprove, onSendBack, onEditAgent }) {
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
        {step.nextAgentName && <span className="pipeline-run-muted">{`${step.index < run.currentStepIndex ? 'Next round' : 'Next pass'} · ${step.nextAgentName}`}</span>}
        {onEditAgent && <button type="button" onClick={onEditAgent}>Change agent</button>}
        {step.readOnly && <span className="pipeline-run-muted">read-only</span>}
        {step.askOwner && <span className="pipeline-run-muted" title="This step's questions always come to you, also when agents decide">always asks you</span>}
        {loopTarget && <span className="pipeline-run-muted">{`loops back to ${loopTarget.name}`}</span>}
      </div>
      {step.sessionId === null && step.status === 'pending' && !step.elapsedMs && <span className="pipeline-run-muted">This step has not started, so it has no terminal yet.</span>}
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
        <StepRecords label="Audit timeline" emptyText="No controller evidence for this interval." resetKey={`${resetKey}:${run.updatedAt}`}
          load={() => listRunAudit(run.id, step.index)}
          summary={events => describeAuditIntervals(events).map(row => <p key={row.attempt}>{`Attempt ${row.attempt} · ${row.words}`}</p>)}
          render={event => <li key={event.id} className="pipeline-run-list-item">
            <strong>{`Attempt ${event.attempt} · ${event.kind === 'quota_takeover' ? 'Usage limit takeover' : event.kind.replaceAll('_',' ')}`}</strong>
            <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString()}</time>
            <span>{[event.host, event.worktreePath, event.sessionId, event.agentName, event.model, event.effort].filter(Boolean).join(' · ')}</span>
            {event.detail && <span>{event.detail}</span>}
          </li>} />
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
/** The team a run is labelled with; the agents themselves are named on each step. */
function RunTeam({ team }) {
  if (team === null) {
    return <span className="pipeline-run-muted" aria-label="Team: none" title="This run was started without a team; each step names its own agent">No team</span>;
  }
  return (
    <span className="pipeline-run-team" aria-label={team.changed ? `Team: ${team.name}, changed during the run` : `Team: ${team.name}`}
      title={team.changed ? 'The team or a step\'s agent was changed after this run started; earlier steps kept the agents they ran with' : 'The team whose members run this run\'s steps'}>
      {`Team: ${team.name}`}{team.changed && <span className="pipeline-run-muted"> · changed</span>}
    </span>
  );
}

export default function TaskView({
  title, tooltip, run, openSessionIds, inTask = false, repository = null, children,
  onActivateStep, onOpenTerminal,
  onStop, onResume, onContinue, onCleanup, onAnswer,
  onLoadNotes, onLoadDecisions, onLoadReviews, onLoadAnswers = async () => ({ answers: [] }), onApprove, onSendBack, onChangeAgent,
}) {
  if (!run || typeof run !== 'object') throw new Error('task view: run is required');
  if (!Array.isArray(run.steps) || run.steps.length === 0) throw new Error('task view: run.steps must be a nonempty array');
  if (!(openSessionIds instanceof Set)) throw new Error('task view: openSessionIds must be a Set');
  if (typeof inTask !== 'boolean') throw new Error('task view: inTask must be a boolean');
  // The repository the run works in, given when its task or project has more than one to tell apart.
  if (repository !== null && (typeof repository !== 'string' || repository.trim() === '')) throw new Error('task view: repository must be a name or null');
  const currentIndex = Number.isInteger(run.currentStepIndex) ? run.currentStepIndex : 0;
  // The owner's pick holds until the run moves to another step; then the view follows the run.
  const [picked, setPicked] = useState(null);
  useEffect(() => { setPicked(null); }, [run.id, currentIndex]);
  const selectedIndex = picked !== null && run.steps.some(step => step.index === picked) ? picked : currentIndex;
  const selected = run.steps.find(step => step.index === selectedIndex) ?? run.steps[0];
  const current = run.steps.find(step => step.index === currentIndex) ?? run.steps[0];
  const [editingAgent, setEditingAgent] = useState(null);
  const editingStep = run.steps.find(step => step.index === editingAgent?.index);
  const agentTiming = step => liveAgentChangeTiming(run.status, run.steps, run.steps, currentIndex, step.index);
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
  // A run closed by accepting the limit keeps its audit and notes, but reads Ended at
  // limit with only verified steps counted — never the green completion banner.
  const completion = run.status === 'complete' ? describeRunCompletion(run) : null;
  // The capped pause the next Continue grants one more round for, if the run is capped.
  const pause = describeLimitPause(run);
  const capped = pause && run.steps.find(step => step.index === pause.stepIndex);
  const capUnit = pause?.repeatMode === 'until_complete' ? 'pass' : 'round';
  const usedRounds = pause ? pause.maxRounds + pause.extraRounds : 0;
  const capUnitWords = usedRounds === 1 ? capUnit : (capUnit === 'pass' ? 'passes' : `${capUnit}s`);
  const capWords = pause ? `${pause.stepName} paused at its limit: ${usedRounds} ${capUnitWords} used of ${pause.maxRounds} allowed${pause.extraRounds > 0 ? ` + ${pause.extraRounds} granted` : ''}.` : null;
  // One limit-recovery action at a time: while the grant or stop is in flight both
  // buttons stay disabled, so a rapid second click cannot fire a duplicate request.
  // The handlers toast their own failures; anything they throw still surfaces after the reset.
  const [limitBusy, setLimitBusy] = useState(false);
  const limitBusyRef = useRef(false);
  const runLimitAction = async action => {
    if (limitBusyRef.current) return;
    limitBusyRef.current = true;
    setLimitBusy(true);
    try {
      await action();
    } finally {
      limitBusyRef.current = false;
      setLimitBusy(false);
    }
  };
  // The run's time and any working step's time are counted on this device once a second.
  const [now, setNow] = useState(() => Date.now());
  const duration = describeRunDuration(run, now);
  const stepDurations = run.steps.map(step => describeStepDuration(step, now));
  const counting = duration.live || stepDurations.some(item => item?.live);
  useEffect(() => {
    if (!counting) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [counting, run.id]);
  const progress = progressLine(run.progress);
  const blockedCleanup = run.worktree?.state === 'removal_blocked' && run.worktree.detail ? describeBlockedCleanup(run.worktree.detail) : null;
  const heading = title === run.workflowName ? title : `${title} · ${run.workflowName}`;

  const selectStep = step => {
    setPicked(step.index);
    if (step.sessionId && openSessionIds.has(step.sessionId)) onActivateStep(step.sessionId);
  };

  return (
    <div data-testid="task-view" className="task-view pipeline-run-bar">
      <header className="task-view-header" data-run-status={completion?.endedAtLimit ? 'ended_at_limit' : run.status}>
        <div className="pipeline-run-heading">
          <strong className="pipeline-run-name" title={tooltip}>{heading}</strong>
          {run.team !== undefined && <RunTeam team={run.team} />}
          {repository !== null && <span className="pipeline-run-muted" title="The run's current directory is this repository's worktree">{`works in ${repository}`}</span>}
          <span className="pipeline-run-status" data-status={run.status} data-tone={status.tone} aria-label={`Run status: ${status.label}`}>
            {status.tone === 'done' && <Check size={12} strokeWidth={2.5} aria-hidden="true" />}
            {status.label}
          </span>
          <span className="pipeline-run-muted" title={duration.live ? 'Time since this run was started, waiting for you included' : 'Time from the start of this run to its end, waiting for you included'}
            aria-label={`${duration.live ? 'Run time so far' : 'Run time'}: ${duration.words}`}>{duration.live ? duration.words : `took ${duration.words}`}</span>
          {run.agentsDecide && <span title="Agents in this run go with their own recommendations instead of pausing for you" className="pipeline-run-agents-decide">agents decide{run.decisionCount > 0 ? ` · ${run.decisionCount} so far` : ''}</span>}
          <div className="pipeline-run-actions">
            {run.actions?.stop && !['interrupted', 'stopped', 'error', 'complete'].includes(run.status) && !(pause && run.actions?.continue) && <button type="button" onClick={() => onStop(run.id)}>Stop</button>}
            {run.actions?.continue && !pause && <button type="button" onClick={() => onContinue(run.id)} className={status.primaryAction === 'continue' ? 'pipeline-run-primary' : undefined}>Continue</button>}
            {/* Always in view until the run is complete, so it can be found; the backend only takes it from a run that is not working. */}
            {run.status !== 'complete' && <ChangeRunTeam run={run} disabledReason={run.actions?.resume ? null : 'Stop the run to change its team. Steps already done keep their agents.'} />}
            {run.actions?.resume && <button type="button" onClick={() => { if (window.confirm(resumeConfirmation(run, current))) onResume(run.id); }} className={status.primaryAction === 'resume' ? 'pipeline-run-primary' : undefined}>Resume</button>}
            {run.actions?.cleanup && (
              <button type="button" onClick={() => { if (window.confirm(cleanupConfirmation(run))) onCleanup(run.id); }} className={status.primaryAction === 'cleanup' ? 'pipeline-run-primary' : undefined}
                title={run.worktree?.state === 'external' ? 'Takes the run off the screen and closes the terminals it used. An agent still working in one of them is stopped.' : undefined}>
                {/* A task keeps its files; ending the run closes the run and the terminals it used. */}
                {run.worktree?.state === 'external' ? 'Close run' : 'Clean up worktree'}
              </button>
            )}
          </div>
        </div>
        {progress && <div title={run.progress.file} className="pipeline-run-progress"><span className={progress.tone === 'plain' ? 'pipeline-run-progress-phase' : `pipeline-run-${progress.tone}`}>{progress.text}</span>{progress.detail && <span className="pipeline-run-muted">{` · ${progress.detail}`}</span>}</div>}
        {pause && run.actions?.continue && (
          <div className="pipeline-run-limit" role="status" aria-label="Paused at its limit">
            <span className="pipeline-run-limit-words">{capWords}</span>
            {capped?.note?.summary && <span className="pipeline-run-limit-finding" title="Latest finding on the capped step">{`Latest finding: ${capped.note.summary}`}</span>}
            <span className="pipeline-run-limit-actions">
              <button type="button" disabled={limitBusy} onClick={() => runLimitAction(() => onContinue(run.id, { stepIndex: pause.stepIndex, roundsCompleted: pause.roundsCompleted, extraRounds: pause.extraRounds }))} className={status.primaryAction === 'continue' ? 'pipeline-run-primary' : undefined}>{pause.actionLabel}</button>
              <button type="button" disabled={limitBusy} onClick={() => runLimitAction(() => onStop(run.id))}>Stop with work remaining</button>
            </span>
          </div>
        )}
        {run.status === 'needs_input' && run.inputRequest === null && (
          <div className="pipeline-run-warning">
            {`${current.name} is paused on a terminal dialog (not a workflow question). Answer or dismiss the prompt directly in its terminal below.`}
          </div>
        )}
        {run.status === 'stopped' && run.stopReason === 'no_progress' && (
          <div className="pipeline-run-warning">
            {run.progress
              ? `No task was ticked in the last ${NO_PROGRESS_ROUNDS} rounds. Check what the steps reported, then Resume to try again.`
              : `This loop ran ${NO_PROGRESS_ROUNDS} rounds without finishing. Check what the steps reported, then Resume to try again.`}
          </div>
        )}
        {run.status === 'complete' && !completion.endedAtLimit && (
          <div className="task-complete-banner" role="status" aria-label="Workflow complete">
            <span className="task-complete-badge" aria-hidden="true"><CheckCircle2 size={18} strokeWidth={2.2} /></span>
            <div className="task-complete-copy">
              <div className="task-complete-heading">
                <strong className="task-complete-title">Workflow complete</strong>
                <span className="task-complete-meta">{`${completion.successfulSteps}/${completion.totalSteps} steps done · ${duration.words}`}</span>
              </div>
              <div className="task-complete-text">{run.worktree?.state === 'external'
                ? (inTask
                  ? 'This run has finished. Its work is in the task: commit, merge or open a pull request from the bar above. Close run takes the run off the screen and closes the terminals it used.'
                  : 'This run has finished. Close run takes it off the screen and closes the terminals it used.')
                : 'All steps finished. Review the work or clean up the worktree when ready.'}</div>
            </div>
          </div>
        )}
        {run.status === 'complete' && completion.endedAtLimit && (
          <div className="task-complete-banner task-complete-ended" role="status" aria-label="Ended at limit">
            <div className="task-complete-copy">
              <div className="task-complete-heading">
                <strong className="task-complete-title">Ended at limit</strong>
                <span className="task-complete-meta">{`${completion.successfulSteps}/${completion.totalSteps} steps done · ${duration.words}`}</span>
              </div>
              <div className="task-complete-text">This run stopped at its limit and was closed with work remaining. Only verified steps count as done. Its audit and notes are preserved below.</div>
            </div>
          </div>
        )}
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
          {run.steps.map((step, i) => {
            const state = describeStepState(step, { isCurrent: step.index === currentIndex }).state;
            const words = describeStepProgress(step);
            const took = stepDurations[i];
            const elapsed = took?.live && step.attempt > 1
              ? `Attempt ${step.attempt} · ${describeStepDuration({...step,elapsedMs:0},now).words} since last start · ${took.words} total`
              : took?.words;
            const Icon = STATE_ICON[state];
            return (
              <button key={step.index} type="button" onClick={() => selectStep(step)} className="task-step" data-step-state={state}
                aria-current={step.index === selectedIndex ? 'step' : undefined}
                aria-label={`${step.name}: ${[words.label, words.detail, elapsed !== took?.words ? elapsed : took && (took.live ? `${took.words} so far` : `took ${took.words}`)].filter(Boolean).join(', ')}`}>
                <Icon size={13} aria-hidden="true" className="task-step-icon" />
                <span className="task-step-text">
                  <span className="task-step-name">{step.name}{step.repeat.mode === 'loop_back' && <Repeat size={11} aria-hidden="true" />}</span>
                  <span className="task-step-words" title="Elapsed time across all attempts of this step">{[words.label, words.detail, elapsed].filter(Boolean).join(' · ')}</span>
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
            onLoadReviews={onLoadReviews} onLoadAnswers={onLoadAnswers} onApprove={onApprove} onSendBack={onSendBack}
            onEditAgent={onChangeAgent && agentTiming(selected) !== null ? () => setEditingAgent({ runId: run.id, index: selected.index }) : undefined} />
          {editingAgent?.runId === run.id && editingStep && <ChangeRunAgent run={run} step={editingStep}
            timing={agentTiming(editingStep)} onSave={onChangeAgent} onClose={() => setEditingAgent(null)} />}
          {children}
        </div>
      </div>
    </div>
  );
}
