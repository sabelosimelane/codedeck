import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../ToastContext';
import { closeTask, commitTask, getTaskLanding, mergeTask, openTaskPullRequest, renameTask } from '../../utils/tasksApi.js';
import { Button, ConfirmDialog, PromptDialog } from '../ui/index.jsx';
import './task-view.css';

const plural = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;
const FALLBACK = 'Something went wrong. Please try again.';

/**
 * How a task's work gets back into the project. What it shows is read from Git by the
 * backend every few seconds; every button round-trips through the backend and nothing here
 * decides whether an action is allowed.
 */
export default function TaskLandingBar({ task, onChanged, onFinished }) {
  const { showToast } = useToast();
  const [landing, setLanding] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(null);
  const [refusal, setRefusal] = useState(null);
  const [remote, setRemote] = useState('');
  // Which action is asking for the owner's word: rename, commit, merge, pullRequest or close.
  const [asking, setAsking] = useState(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await getTaskLanding(task.id);
      if (!alive.current) return;
      setLanding(next);
      setFailure(null);
    } catch (error) {
      if (alive.current) setFailure(error instanceof Error ? error.message : FALLBACK);
    }
  }, [task.id]);

  useEffect(() => {
    alive.current = true;
    setLanding(null);
    setRefusal(null);
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);

  /** Runs one action: one at a time, toast for either outcome, and the refusal kept on screen. */
  const act = async (name, action, success) => {
    if (busy) return;
    setBusy(name);
    setRefusal(null);
    try {
      const result = await action();
      showToast({ type: 'success', message: success(result) });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : FALLBACK;
      showToast({ type: 'error', message });
      if (alive.current) setRefusal({ message, reasons: error?.reasons ?? [], conflicts: error?.conflicts ?? [] });
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const rename = async (title) => {
    const renamed = await act('rename', () => renameTask(task.id, { title, revision: task.revision }), result => `Renamed to ${result.title}`);
    setAsking(null);
    if (renamed) onChanged();
  };

  const commit = async (message) => {
    const next = await act('commit', () => commitTask(task.id, message), () => 'Changes committed');
    setAsking(null);
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
    onChanged();
    onFinished(result);
  };

  const merge = async () => {
    const merged = await act('merge', () => mergeTask(task.id), result => withClosed(result.filesRemoved
      ? `Merged into ${result.mergedInto}`
      : `Merged into ${result.mergedInto}, but the task's folder could not be removed`, result));
    setAsking(null);
    finished(merged);
  };

  const tools = landing ? landing.remotes.filter(candidate => candidate.tool !== null) : [];
  const chosenRemote = tools.find(candidate => candidate.name === remote) ?? tools[0] ?? null;
  const pullRequest = async () => {
    const opened = await act('pullRequest', () => openTaskPullRequest(task.id, chosenRemote.name), result => `Pull request opened: ${result.prUrl}`);
    setAsking(null);
    if (opened) { onChanged(); refresh(); }
  };

  const close = async () => {
    const closed = await act('close', () => closeTask(task.id), result => withClosed(result.unmergedCommits > 0 ? `Task closed. Branch ${result.branchKept} was kept.` : 'Task closed', result));
    setAsking(null);
    finished(closed);
  };
  const unmerged = landing?.commitsAhead ?? 0;

  const first = list => list[0]?.message;
  const facts = [];
  if (landing) {
    if (!landing.filesPresent) facts.push({ tone: 'warning', text: "This task's files are no longer on disk." });
    if (landing.uncommittedCount > 0) facts.push({ tone: 'warning', text: `${plural(landing.uncommittedCount, 'uncommitted file')}` });
    if (landing.commitsAhead > 0) facts.push({ tone: 'plain', text: `${plural(landing.commitsAhead, 'commit')} not yet in ${landing.baseBranch ?? 'the project'}` });
    if (landing.filesPresent && landing.uncommittedCount === 0 && landing.commitsAhead === 0) facts.push({ tone: 'muted', text: 'No changes yet' });
    if (landing.commitsBehind > 0) facts.push({ tone: 'muted', text: `${landing.baseBranch} has moved on by ${plural(landing.commitsBehind, 'commit')}` });
  }
  const hasWork = landing && (landing.uncommittedCount > 0 || landing.commitsAhead > 0);
  const canMerge = landing && landing.blockers.merge.length === 0;
  // What stands between the work and a merge is said outright, but only once merging is the
  // next thing to do. While a run is working the task is simply in progress, and "no commits
  // yet" and "commit first" are already told by the uncommitted count and its button.
  const SAID_ELSEWHERE = new Set(['uncommitted', 'nothing_to_land', 'run_active']);
  const mergeHint = landing && !landing.runActive && hasWork && !canMerge
    ? landing.blockers.merge.filter(item => !SAID_ELSEWHERE.has(item.code)).map(item => item.message)
    : [];

  return (
    <div role="group" aria-label={`Task ${task.title}`} className="task-landing">
      <div className="task-landing-row">
        <strong className="pipeline-run-name" title={task.title}>{task.title}</strong>
        <Button variant="ghost" size="small" onClick={() => setAsking('rename')} disabled={busy !== null}>Rename</Button>
        {landing === null && failure === null && <span className="pipeline-run-muted">Reading the task…</span>}
        {failure && <span role="alert" className="pipeline-run-danger">{failure}</span>}
        {facts.map(fact => <span key={fact.text} className={fact.tone === 'plain' ? undefined : `pipeline-run-${fact.tone}`}>{fact.text}</span>)}
        {landing?.prUrl && <a href={landing.prUrl} target="_blank" rel="noreferrer noopener" className="task-landing-link">Pull request</a>}
        {landing && (
          <div className="pipeline-run-actions">
            {landing.uncommittedCount > 0 && <Button size="small" onClick={() => setAsking('commit')} disabled={busy !== null || landing.blockers.commit.length > 0} title={first(landing.blockers.commit)}>Commit changes</Button>}
            {landing.baseBranch !== null && <Button size="small" variant={canMerge ? 'primary' : 'secondary'} onClick={() => setAsking('merge')} disabled={busy !== null || !canMerge} title={first(landing.blockers.merge)}>{`Merge into ${landing.baseBranch}`}</Button>}
            {tools.length > 1 && <select aria-label="Remote for the pull request" value={chosenRemote.name} onChange={event => setRemote(event.target.value)} disabled={busy !== null}>{tools.map(candidate => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}</select>}
            {tools.length > 0 && landing.baseBranch !== null && landing.prUrl === null && <Button size="small" onClick={() => setAsking('pullRequest')} disabled={busy !== null || landing.blockers.pullRequest.length > 0} title={first(landing.blockers.pullRequest)}>Open a pull request</Button>}
            <Button size="small" onClick={() => setAsking('close')} disabled={busy !== null || landing.blockers.close.length > 0} title={first(landing.blockers.close)}>Close task</Button>
          </div>
        )}
      </div>
      {mergeHint.map(message => <span key={message} className="pipeline-run-warning">{message}</span>)}
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
        </ConfirmDialog>
      )}
      {asking === 'close' && (
        <ConfirmDialog title="Close task" confirmLabel="Close task" tone={unmerged > 0 && landing.state !== 'pr_open' ? 'danger' : 'primary'} onConfirm={close} onCancel={() => setAsking(null)}>
          {`"${task.title}" is closed, its copy of the project is removed and its terminals are closed.${unmerged > 0 && landing.state !== 'pr_open' ? ` Its ${plural(unmerged, 'commit')} stay on the branch ${landing.branch}, not merged.` : ''}`}
        </ConfirmDialog>
      )}
    </div>
  );
}
