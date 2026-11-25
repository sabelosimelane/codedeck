import React, { useState } from 'react';
import { useToast } from '../ToastContext';
import { closeTask, commitTask, getTaskLanding, mergeTask, openTaskPullRequest, renameTask } from '../../utils/tasksApi.js';
import { Button, ConfirmDialog, PromptDialog } from '../ui/index.jsx';
import TaskRepositoriesLanding from './TaskRepositoriesLanding.jsx';
import AddRepositoryDialog from './AddRepositoryDialog.jsx';
import LandingMenu from './LandingMenu.jsx';
import { LANDING_ERROR, useLandingStatus } from './useLandingStatus.js';
import { FINISH_TASK_LABEL, landingStatus, nextLandingStep, waitingReasons } from './landingSteps.js';
import { closeArguments, closeRefusals, namedIgnored } from './ignoredFiles.js';
import './task-view.css';

const plural = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;

/**
 * How a task's work gets back into the project. What it shows is read from Git by the
 * backend every few seconds; every button round-trips through the backend and nothing here
 * decides whether an action is allowed.
 */
/** `canAddRepository`: the task can be given one more repository, one of its project's or one from any other folder. */
export default function TaskLandingBar({ task, canAddRepository = false, onChanged, onFinished, onRepositoryFinished }) {
  // A task with several repositories lands each on its own; one with a single worktree is landed as a whole.
  if (Array.isArray(task.worktrees) && task.worktrees.length > 1) {
    return <TaskRepositoriesLanding key={task.id} task={task} canAddRepository={canAddRepository} onChanged={onChanged} onFinished={onFinished} onRepositoryFinished={onRepositoryFinished} />;
  }
  return <TaskLanding key={task.id} task={task} canAddRepository={canAddRepository} onChanged={onChanged} onFinished={onFinished} />;
}

function TaskLanding({ task, canAddRepository, onChanged, onFinished }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [remote, setRemote] = useState('');
  // Which action is asking for the owner's word: rename, commit, merge, pullRequest or close.
  const [confirmation, setAsking] = useState(null);
  const { snapshot: landing, setSnapshot: setLanding, failure, refresh, alive, begin, end, reconcile } = useLandingStatus(task.id, getTaskLanding, setRefusal);
  const asking = confirmation && (confirmation.snapshot === landing || ['rename', 'addRepository'].includes(confirmation.kind))
    ? confirmation.kind : null;

  const act = async (name, action, success) => {
    if (!begin()) return null;
    setBusy(name);
    setAsking(null);
    setRefusal(null);
    let failed = false;
    try {
      const result = await action();
      showToast({ type: 'success', message: success(result) });
      return result;
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : LANDING_ERROR;
      showToast({ type: 'error', message });
      if (alive.current) setRefusal({ message, reasons: error?.reasons ?? [], conflicts: error?.conflicts ?? [] });
      onChanged?.();
      return null;
    } finally {
      end();
      if (alive.current) setBusy(null);
      if (failed) reconcile();
    }
  };

  const rename = async (title) => {
    const renamed = await act('rename', () => renameTask(task.id, { title, revision: task.revision }), result => `Renamed to ${result.title}`);
    if (renamed) onChanged();
  };

  const commit = async (message) => {
    const next = await act('commit', () => commitTask(task.id, message), () => 'Changes committed');
    if (next && alive.current) setLanding(next);
  };

  // A finished task's terminals are closed with it; the result says which, and which were not.
  const withClosed = (message, result) => (result.terminalsClosed.length === 0 ? message
    : `${message}${message.endsWith('.') ? '' : '.'} ${plural(result.terminalsClosed.length, 'terminal')} closed.`);
  const finished = result => {
    if (!result) return;
    if (result.terminalsNotClosed.length > 0) {
      showToast({ type: 'error', message: `${plural(result.terminalsNotClosed.length, 'terminal')} could not be closed: ${result.terminalsNotClosed.join(', ')}. Close ${result.terminalsNotClosed.length === 1 ? 'it from its tab' : 'them from their tabs'}.` });
    }
    if (result.folderRemoved === false) showToast({ type: 'error', message: 'The task folder was retained because it still contains files.' });
    if (alive.current) setLanding(null);
    onChanged();
    onFinished(result);
  };

  const merge = async () => {
    const merged = await act('merge', () => mergeTask(task.id), result => withClosed(result.filesRemoved
      ? `Merged into ${result.mergedInto}`
      : `Merged into ${result.mergedInto}, but the task's folder could not be removed`, result));
    finished(merged);
  };

  const tools = landing ? landing.remotes.filter(candidate => candidate.tool !== null) : [];
  const chosenRemote = tools.find(candidate => candidate.name === remote) ?? tools[0] ?? null;
  const pullRequest = async () => {
    const opened = await act('pullRequest', () => openTaskPullRequest(task.id, chosenRemote.name), result => `Pull request opened: ${result.prUrl}`);
    if (opened) { onChanged(); refresh(); }
  };

  const close = async () => {
    const closed = await act('close', () => closeTask(task.id, ...closeArguments(deletesIgnored)), result => withClosed(result.unmergedCommits > 0 ? `Task closed. Branch ${result.branchKept} was kept.` : 'Task closed', result));
    finished(closed);
  };
  const unmerged = landing?.commitsAhead ?? 0;
  // Ignored files that exist only here do not refuse Close; its dialog lists them and asks.
  const deletesIgnored = landing !== null && landing.ignoredAtRiskCount > 0;
  const closeRefused = landing ? closeRefusals(landing) : [];

  const messages = list => list.map(reason => reason.message);
  const step = landing ? nextLandingStep(landing) : null;
  const status = landing ? landingStatus(landing) : null;
  const ask = kind => () => setAsking({ kind, snapshot: landing });
  const menu = landing ? [
    ...(landing.uncommittedCount > 0 && step !== 'commit' ? [{ key: 'commit', label: 'Commit changes', disabledReasons: messages(landing.blockers.commit), onSelect: ask('commit') }] : []),
    ...(landing.baseBranch !== null && landing.commitsAhead > 0 && step !== 'merge' ? [{ key: 'merge', label: `Merge into ${landing.baseBranch}`, disabledReasons: messages(landing.blockers.merge), onSelect: ask('merge') }] : []),
    ...(tools.length > 0 && landing.baseBranch !== null && landing.commitsAhead > 0 && landing.prUrl === null ? [{ key: 'pullRequest', label: 'Open a pull request', disabledReasons: messages(landing.blockers.pullRequest), onSelect: ask('pullRequest') }] : []),
    { key: 'rename', label: 'Rename task', onSelect: ask('rename') },
    ...(canAddRepository ? [{ key: 'add', label: 'Add repository', onSelect: ask('addRepository') }] : []),
    ...(step !== 'close' ? [{ key: 'close', label: FINISH_TASK_LABEL, tone: 'danger', disabledReasons: messages(closeRefused), onSelect: ask('close') }] : []),
  ] : [
    { key: 'rename', label: 'Rename task', onSelect: ask('rename') },
    ...(canAddRepository ? [{ key: 'add', label: 'Add repository', onSelect: ask('addRepository') }] : []),
  ];
  const primaryLabel = { commit: 'Commit changes', merge: landing?.baseBranch ? `Merge into ${landing.baseBranch}` : null, close: FINISH_TASK_LABEL }[step];

  return (
    <div role="group" aria-label={`Task ${task.title}`} className="task-landing">
      <div className="task-landing-row">
        {status && <span className="task-landing-dot" data-tone={status.tone} aria-hidden="true" />}
        <strong className="pipeline-run-name" title={task.title}>{task.title}</strong>
        {landing === null && failure === null && <span className="pipeline-run-muted">Reading the task…</span>}
        {failure && <span role="alert" className="pipeline-run-danger">{failure}</span>}
        {status && <span className="task-landing-status" data-tone={status.tone}>{status.text}</span>}
        {landing && landing.commitsBehind > 0 && <span className="pipeline-run-muted">{`${landing.baseBranch} has moved on by ${plural(landing.commitsBehind, 'commit')}`}</span>}
        {deletesIgnored && <span className="pipeline-run-muted">{`${plural(landing.ignoredAtRiskCount, 'ignored file')} only here`}</span>}
        {landing?.prUrl && <a href={landing.prUrl} target="_blank" rel="noreferrer noopener" className="task-landing-link">Pull request</a>}
        <div className="pipeline-run-actions">
          {primaryLabel && <Button size="small" variant="primary" onClick={ask(step)} disabled={busy !== null}>{primaryLabel}</Button>}
          <LandingMenu label="Task actions" items={menu} disabled={busy !== null} />
        </div>
      </div>
      {landing && waitingReasons(landing).map(message => <span key={message} className="task-landing-hint">{message}</span>)}
      {refusal && (
        <div role="alert" className="task-landing-refusal">
          <span className="pipeline-run-danger">{refusal.message}</span>
          {refusal.reasons.slice(1).map(reason => <span key={reason.code} className="pipeline-run-warning">{reason.message}</span>)}
          {refusal.conflicts.length > 0 && <div className="pipeline-run-cleanup-paths">{refusal.conflicts.map(file => <div key={file}>{file}</div>)}</div>}
        </div>
      )}
      {landing && (
        <details className="task-landing-details">
          <summary>Details</summary>
          {landing.uncommitted.length > 0 && <div className="pipeline-run-cleanup-paths">{landing.uncommitted.map(file => <div key={file}>{file}</div>)}{landing.uncommittedCount > landing.uncommitted.length && <div>{`and ${landing.uncommittedCount - landing.uncommitted.length} more`}</div>}</div>}
          <div className="pipeline-run-muted">{`Branch ${landing.branch}${landing.baseBranch ? `, started from ${landing.baseBranch}` : ''}`}</div>
          <div className="pipeline-run-muted">{task.worktreePath}</div>
        </details>
      )}
      {asking === 'addRepository' && <AddRepositoryDialog task={task} onAdded={onChanged} onClose={() => setAsking(null)} />}
      {asking === 'rename' && <PromptDialog title="Rename task" label="Task title" initialValue={task.title} maxLength={80} confirmLabel="Rename" requireChange onSubmit={rename} onCancel={() => setAsking(null)} />}
      {asking === 'commit' && <PromptDialog title="Commit changes" subtitle={`Commits ${plural(landing.uncommittedCount, 'changed file')} in this task.`} label="Commit message" initialValue={task.title} maxLength={200} confirmLabel="Commit" onSubmit={commit} onCancel={() => setAsking(null)} />}
      {asking === 'merge' && (
        <ConfirmDialog title={`Merge into ${landing.baseBranch}`} confirmLabel="Merge" onConfirm={merge} onCancel={() => setAsking(null)}>
          {`"${task.title}" is merged into ${landing.baseBranch}. The task's own copy of the project is removed afterwards and its terminals are closed.`}
        </ConfirmDialog>
      )}
      {asking === 'pullRequest' && (
        <ConfirmDialog title="Open a pull request" confirmLabel="Push and open" onConfirm={pullRequest} onCancel={() => setAsking(null)}>
          {`${landing.branch} is pushed to ${chosenRemote.name} (${chosenRemote.host}) and a pull request into ${landing.baseBranch} is opened. Pushing publishes the branch.`}
          {tools.length > 1 && (
            <label className="task-landing-remote">Remote
              <select aria-label="Remote for the pull request" value={chosenRemote.name} onChange={event => setRemote(event.target.value)}>
                {tools.map(candidate => <option key={candidate.name} value={candidate.name}>{`${candidate.name} (${candidate.host})`}</option>)}
              </select>
            </label>
          )}
        </ConfirmDialog>
      )}
      {asking === 'close' && (
        <ConfirmDialog title={FINISH_TASK_LABEL} confirmLabel={deletesIgnored ? 'Delete files and close' : 'Finish task'} tone={deletesIgnored || (unmerged > 0 && landing.state !== 'pr_open') ? 'danger' : 'primary'} onConfirm={close} onCancel={() => setAsking(null)}>
          {`"${task.title}" is closed, its copy of the project is removed and its terminals are closed.${unmerged > 0 && landing.state !== 'pr_open' ? ` Its ${plural(unmerged, 'commit')} stay on the branch ${landing.branch}, not merged.` : ''}${deletesIgnored ? ` Files Git ignores that exist only in this task are deleted with it: ${namedIgnored(landing)}.` : ''}`}
        </ConfirmDialog>
      )}
    </div>
  );
}
