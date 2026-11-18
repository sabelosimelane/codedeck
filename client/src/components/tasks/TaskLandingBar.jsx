import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../ToastContext';
import { closeTask, commitTask, getTaskLanding, mergeTask, openTaskPullRequest, renameTask } from '../../utils/tasksApi.js';
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

  const rename = async () => {
    const title = window.prompt('Task title', task.title);
    if (title === null || title.trim() === '' || title.trim() === task.title) return;
    const renamed = await act('rename', () => renameTask(task.id, { title, revision: task.revision }), result => `Renamed to ${result.title}`);
    if (renamed) onChanged();
  };

  const commit = async () => {
    const message = window.prompt(`Commit ${plural(landing.uncommittedCount, 'changed file')} in this task. Message:`, task.title);
    if (message === null || message.trim() === '') return;
    const next = await act('commit', () => commitTask(task.id, message), () => 'Changes committed');
    if (next && alive.current) setLanding(next);
  };

  const merge = async () => {
    if (!window.confirm(`Merge "${task.title}" into ${landing.baseBranch}? The task's own copy of the project is removed afterwards.`)) return;
    const merged = await act('merge', () => mergeTask(task.id), result => (result.filesRemoved
      ? `Merged into ${result.mergedInto}`
      : `Merged into ${result.mergedInto}, but the task's folder could not be removed`));
    if (merged) { onChanged(); onFinished(); }
  };

  const tools = landing ? landing.remotes.filter(candidate => candidate.tool !== null) : [];
  const chosenRemote = tools.find(candidate => candidate.name === remote) ?? tools[0] ?? null;
  const pullRequest = async () => {
    if (!window.confirm(`Push ${landing.branch} to ${chosenRemote.name} (${chosenRemote.host}) and open a pull request into ${landing.baseBranch}? Pushing publishes the branch.`)) return;
    const opened = await act('pullRequest', () => openTaskPullRequest(task.id, chosenRemote.name), result => `Pull request opened: ${result.prUrl}`);
    if (opened) { onChanged(); refresh(); }
  };

  const close = async () => {
    const unmerged = landing.commitsAhead ?? 0;
    const warning = unmerged > 0 && landing.state !== 'pr_open' ? ` Its ${plural(unmerged, 'commit')} stay on the branch ${landing.branch}, not merged.` : '';
    if (!window.confirm(`Close "${task.title}"? Its copy of the project is removed.${warning}`)) return;
    const closed = await act('close', () => closeTask(task.id), result => (result.unmergedCommits > 0 ? `Task closed. Branch ${result.branchKept} was kept.` : 'Task closed'));
    if (closed) { onChanged(); onFinished(); }
  };

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
  // What stands between the work and a merge is said outright, once there is work to merge.
  const mergeHint = landing && hasWork && !canMerge ? landing.blockers.merge.filter(item => item.code !== 'uncommitted').map(item => item.message) : [];

  return (
    <div role="group" aria-label={`Task ${task.title}`} className="task-landing pipeline-run-bar">
      <div className="task-landing-row">
        <strong className="pipeline-run-name" title={task.title}>{task.title}</strong>
        <button type="button" onClick={rename} disabled={busy !== null} className="task-landing-quiet">Rename</button>
        {landing === null && failure === null && <span className="pipeline-run-muted">Reading the task…</span>}
        {failure && <span role="alert" className="pipeline-run-danger">{failure}</span>}
        {facts.map(fact => <span key={fact.text} className={fact.tone === 'plain' ? undefined : `pipeline-run-${fact.tone}`}>{fact.text}</span>)}
        {landing?.prUrl && <a href={landing.prUrl} target="_blank" rel="noreferrer noopener" className="task-landing-link">Pull request</a>}
        {landing && (
          <div className="pipeline-run-actions">
            {landing.uncommittedCount > 0 && <button type="button" onClick={commit} disabled={busy !== null || landing.blockers.commit.length > 0} title={first(landing.blockers.commit)}>{busy === 'commit' ? 'Committing…' : 'Commit changes'}</button>}
            {landing.baseBranch !== null && <button type="button" onClick={merge} disabled={busy !== null || !canMerge} title={first(landing.blockers.merge)} className={canMerge ? 'pipeline-run-primary' : undefined}>{busy === 'merge' ? 'Merging…' : `Merge into ${landing.baseBranch}`}</button>}
            {tools.length > 1 && <select aria-label="Remote for the pull request" value={chosenRemote.name} onChange={event => setRemote(event.target.value)} disabled={busy !== null}>{tools.map(candidate => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}</select>}
            {tools.length > 0 && landing.baseBranch !== null && landing.prUrl === null && <button type="button" onClick={pullRequest} disabled={busy !== null || landing.blockers.pullRequest.length > 0} title={first(landing.blockers.pullRequest)}>{busy === 'pullRequest' ? 'Opening…' : 'Open a pull request'}</button>}
            <button type="button" onClick={close} disabled={busy !== null || landing.blockers.close.length > 0} title={first(landing.blockers.close)}>{busy === 'close' ? 'Closing…' : 'Close task'}</button>
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
    </div>
  );
}
