import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../ToastContext';
import {
  closeTask, closeTaskWorktree, commitTaskWorktree, listTaskWorktreeLandings, mergeTaskWorktree, openTaskWorktreePullRequest, renameTask,
} from '../../utils/tasksApi.js';
import { Button, ConfirmDialog, PromptDialog } from '../ui/index.jsx';
import AddRepositoryDialog from './AddRepositoryDialog.jsx';
import './task-view.css';

const plural = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;
const FALLBACK = 'Something went wrong. Please try again.';
const OPEN = ['active', 'pr_open'];
const first = list => list[0]?.message;

/**
 * How a task with several repositories gets its work back into the project: one row per
 * repository, each landed on its own. What a row shows is read from Git by the backend every
 * few seconds; every button round-trips through the backend and nothing here decides whether
 * an action is allowed. The task is finished when its last repository is merged or closed.
 */
export default function TaskRepositoriesLanding({ task, canAddRepository = false, onChanged, onFinished, onRepositoryFinished }) {
  const { showToast } = useToast();
  const [landings, setLandings] = useState(null);
  const [failure, setFailure] = useState(null);
  const [busy, setBusy] = useState(null);
  // What was refused and where: on a repository's row, or on the task (`worktreeId` null).
  const [refusal, setRefusal] = useState(null);
  const [remotes, setRemotes] = useState({});
  // Which action is asking for the owner's word, and for which repository.
  const [asking, setAsking] = useState(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await listTaskWorktreeLandings(task.id);
      if (!alive.current) return;
      setLandings(next);
      setFailure(null);
    } catch (error) {
      if (alive.current) setFailure(error instanceof Error ? error.message : FALLBACK);
    }
  }, [task.id]);

  useEffect(() => {
    alive.current = true;
    setLandings(null);
    setRefusal(null);
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [refresh]);

  /** Runs one action: one at a time, toast for either outcome, and the refusal kept where it belongs. */
  const act = async (name, worktreeId, action, success) => {
    if (busy) return null;
    setBusy(name);
    setRefusal(null);
    try {
      const result = await action();
      showToast({ type: 'success', message: success(result) });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : FALLBACK;
      showToast({ type: 'error', message });
      if (alive.current) setRefusal({ worktreeId, message, reasons: error?.reasons ?? [], conflicts: error?.conflicts ?? [] });
      return null;
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  // Terminals in a worktree that is gone are closed with it; the result says which, and which were not.
  const withClosed = (message, result) => (result.terminalsClosed.length === 0 ? message
    : `${message}${message.endsWith('.') ? '' : '.'} ${plural(result.terminalsClosed.length, 'terminal')} closed.`);
  const settled = (result) => {
    if (!result) return;
    if (result.terminalsNotClosed.length > 0) {
      showToast({ type: 'error', message: `${plural(result.terminalsNotClosed.length, 'terminal')} could not be closed: ${result.terminalsNotClosed.join(', ')}. Close ${result.terminalsNotClosed.length === 1 ? 'it from its tab' : 'them from their tabs'}.` });
    }
    onChanged();
    // A task whose last repository went is left; otherwise only that repository's terminals go.
    if (result.taskFinished) onFinished(result);
    else { onRepositoryFinished(result); refresh(); }
  };

  const open = landings ? landings.filter(entry => OPEN.includes(entry.state)) : [];
  const asked = asking && landings ? landings.find(entry => entry.worktreeId === asking.worktreeId) ?? null : null;
  const isLast = asked !== null && open.length === 1 && open[0].worktreeId === asked.worktreeId;
  const toolsOf = entry => entry.remotes.filter(candidate => candidate.tool !== null);
  const remoteOf = (entry) => {
    const tools = toolsOf(entry);
    return tools.find(candidate => candidate.name === remotes[entry.worktreeId]) ?? tools[0] ?? null;
  };

  const rename = async (title) => {
    const renamed = await act('rename', null, () => renameTask(task.id, { title, revision: task.revision }), result => `Renamed to ${result.title}`);
    setAsking(null);
    if (renamed) onChanged();
  };

  const commit = async (message) => {
    const entry = asked;
    const next = await act('commit', entry.worktreeId, () => commitTaskWorktree(task.id, entry.worktreeId, message), () => `Changes committed in ${entry.repository}`);
    setAsking(null);
    if (next && alive.current) setLandings(current => (current ? current.map(row => (row.worktreeId === next.worktreeId ? next : row)) : current));
  };

  const merge = async () => {
    const entry = asked;
    const merged = await act('merge', entry.worktreeId, () => mergeTaskWorktree(task.id, entry.worktreeId), (result) => {
      const done = result.filesRemoved ? `Merged ${entry.repository} into ${result.mergedInto}` : `Merged ${entry.repository} into ${result.mergedInto}, but its copy in this task could not be removed`;
      return withClosed(result.taskFinished ? `${done}. The task is finished.` : done, result);
    });
    setAsking(null);
    settled(merged);
  };

  const pullRequest = async () => {
    const entry = asked;
    const remote = remoteOf(entry);
    const opened = await act('pullRequest', entry.worktreeId, () => openTaskWorktreePullRequest(task.id, entry.worktreeId, remote.name), result => `Pull request opened for ${entry.repository}: ${result.prUrl}`);
    setAsking(null);
    if (opened) { onChanged(); refresh(); }
  };

  const closeRepository = async () => {
    const entry = asked;
    const closed = await act('close', entry.worktreeId, () => closeTaskWorktree(task.id, entry.worktreeId), (result) => {
      const done = `Closed ${entry.repository} in this task. Branch ${result.branchKept} was kept.`;
      return withClosed(result.taskFinished ? `${done} The task is closed.` : done, result);
    });
    setAsking(null);
    settled(closed);
  };

  const closeWholeTask = async () => {
    const closed = await act('closeTask', null, () => closeTask(task.id), result => withClosed(result.unmergedCommits > 0 ? `Task closed. Branch ${result.branchKept} was kept.` : 'Task closed', result));
    setAsking(null);
    if (!closed) return;
    if (closed.terminalsNotClosed.length > 0) {
      showToast({ type: 'error', message: `${plural(closed.terminalsNotClosed.length, 'terminal')} could not be closed: ${closed.terminalsNotClosed.join(', ')}. Close ${closed.terminalsNotClosed.length === 1 ? 'it from its tab' : 'them from their tabs'}.` });
    }
    onChanged();
    onFinished(closed);
  };

  const blocksClosing = open.find(entry => entry.blockers.close.length > 0) ?? null;
  const unmergedTotal = open.reduce((sum, entry) => sum + (entry.commitsAhead ?? 0), 0);
  const taskRefusal = refusal && refusal.worktreeId === null ? refusal : null;

  return (
    <div role="group" aria-label={`Task ${task.title}`} className="task-landing">
      <div className="task-landing-row">
        <strong className="pipeline-run-name" title={task.title}>{task.title}</strong>
        <Button variant="ghost" size="small" onClick={() => setAsking({ kind: 'rename', worktreeId: null })} disabled={busy !== null}>Rename</Button>
        {landings === null && failure === null && <span className="pipeline-run-muted">Reading the task…</span>}
        {failure && <span role="alert" className="pipeline-run-danger">{failure}</span>}
        {landings && <span className="pipeline-run-muted">{landings.length === 1 ? '1 repository' : `${landings.length} repositories`}</span>}
        {landings && (
          <div className="pipeline-run-actions">
            {canAddRepository && <Button size="small" onClick={() => setAsking({ kind: 'addRepository', worktreeId: null })} disabled={busy !== null} title="Give this task a copy of another repository of the project">Add repository</Button>}
            <Button size="small" onClick={() => setAsking({ kind: 'closeTask', worktreeId: null })} disabled={busy !== null || open.length === 0 || blocksClosing !== null}
              title={blocksClosing ? first(blocksClosing.blockers.close) : undefined}>Close task</Button>
          </div>
        )}
      </div>
      {taskRefusal && (
        <div role="alert" className="task-landing-refusal">
          <span className="pipeline-run-danger">{taskRefusal.message}</span>
          {taskRefusal.reasons.slice(1).map(reason => <span key={`${reason.code}:${reason.message}`} className="pipeline-run-warning">{reason.message}</span>)}
        </div>
      )}
      {landings && (
        <ul aria-label="Repositories of this task" style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: 0, listStyle: 'none' }}>
          {landings.map((entry) => {
            const isOpen = OPEN.includes(entry.state);
            const tools = toolsOf(entry);
            const chosen = remoteOf(entry);
            const canMerge = entry.blockers.merge.length === 0;
            const rowRefusal = refusal && refusal.worktreeId === entry.worktreeId ? refusal : null;
            return (
              <li key={entry.worktreeId} data-repository={entry.repository} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div className="task-landing-row">
                  <strong>{entry.repository}</strong>
                  {!isOpen && <span className="pipeline-run-muted">{entry.state}</span>}
                  {isOpen && !entry.filesPresent && <span className="pipeline-run-warning">Its files in this task are no longer on disk.</span>}
                  {isOpen && entry.uncommittedCount > 0 && <span className="pipeline-run-warning">{plural(entry.uncommittedCount, 'uncommitted file')}</span>}
                  {isOpen && entry.commitsAhead > 0 && <span>{`${plural(entry.commitsAhead, 'commit')} not yet in ${entry.baseBranch ?? 'its repository'}`}</span>}
                  {isOpen && entry.filesPresent && entry.uncommittedCount === 0 && entry.commitsAhead === 0 && <span className="pipeline-run-muted">No changes yet</span>}
                  {isOpen && entry.commitsBehind > 0 && <span className="pipeline-run-muted">{`${entry.baseBranch} has moved on by ${plural(entry.commitsBehind, 'commit')}`}</span>}
                  {entry.prUrl && <a href={entry.prUrl} target="_blank" rel="noreferrer noopener" className="task-landing-link">Pull request</a>}
                  {isOpen && (
                    <div className="pipeline-run-actions">
                      {entry.uncommittedCount > 0 && <Button size="small" aria-label={`Commit changes in ${entry.repository}`} onClick={() => setAsking({ kind: 'commit', worktreeId: entry.worktreeId })} disabled={busy !== null || entry.blockers.commit.length > 0} title={first(entry.blockers.commit)}>Commit changes</Button>}
                      {entry.baseBranch !== null && <Button size="small" variant={canMerge ? 'primary' : 'secondary'} aria-label={`Merge ${entry.repository} into ${entry.baseBranch}`} onClick={() => setAsking({ kind: 'merge', worktreeId: entry.worktreeId })} disabled={busy !== null || !canMerge} title={first(entry.blockers.merge)}>{`Merge into ${entry.baseBranch}`}</Button>}
                      {tools.length > 1 && <select aria-label={`Remote for the pull request of ${entry.repository}`} value={chosen.name} onChange={event => setRemotes(current => ({ ...current, [entry.worktreeId]: event.target.value }))} disabled={busy !== null}>{tools.map(candidate => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}</select>}
                      {tools.length > 0 && entry.baseBranch !== null && entry.prUrl === null && <Button size="small" aria-label={`Open a pull request for ${entry.repository}`} onClick={() => setAsking({ kind: 'pullRequest', worktreeId: entry.worktreeId })} disabled={busy !== null || entry.blockers.pullRequest.length > 0} title={first(entry.blockers.pullRequest)}>Open a pull request</Button>}
                      <Button size="small" aria-label={`Close ${entry.repository}`} onClick={() => setAsking({ kind: 'close', worktreeId: entry.worktreeId })} disabled={busy !== null || entry.blockers.close.length > 0} title={first(entry.blockers.close)}>Close</Button>
                    </div>
                  )}
                </div>
                {rowRefusal && (
                  <div role="alert" className="task-landing-refusal">
                    <span className="pipeline-run-danger">{rowRefusal.message}</span>
                    {rowRefusal.reasons.slice(1).map(reason => <span key={`${reason.code}:${reason.message}`} className="pipeline-run-warning">{reason.message}</span>)}
                    {rowRefusal.conflicts.length > 0 && <div className="pipeline-run-cleanup-paths">{rowRefusal.conflicts.map(file => <div key={file}>{file}</div>)}</div>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {landings && (
        <details className="task-landing-details">
          <summary>Details</summary>
          {landings.map(entry => (
            <div key={entry.worktreeId}>
              <div className="pipeline-run-muted">{`${entry.repository}: branch ${entry.branch}${entry.baseBranch ? `, started from ${entry.baseBranch}` : ''}`}</div>
              <div className="pipeline-run-muted">{entry.worktreePath}</div>
              {entry.uncommitted.length > 0 && <div className="pipeline-run-cleanup-paths">{entry.uncommitted.map(file => <div key={file}>{file}</div>)}{entry.uncommittedCount > entry.uncommitted.length && <div>{`and ${entry.uncommittedCount - entry.uncommitted.length} more`}</div>}</div>}
            </div>
          ))}
        </details>
      )}
      {asking?.kind === 'addRepository' && <AddRepositoryDialog task={task} onAdded={() => { onChanged(); refresh(); }} onClose={() => setAsking(null)} />}
      {asking?.kind === 'rename' && <PromptDialog title="Rename task" label="Task title" initialValue={task.title} maxLength={80} confirmLabel="Rename" requireChange onSubmit={rename} onCancel={() => setAsking(null)} />}
      {asking?.kind === 'commit' && asked && <PromptDialog title={`Commit changes in ${asked.repository}`} subtitle={`Commits ${plural(asked.uncommittedCount, 'changed file')} of ${asked.repository} in this task.`} label="Commit message" initialValue={task.title} maxLength={200} confirmLabel="Commit" onSubmit={commit} onCancel={() => setAsking(null)} />}
      {asking?.kind === 'merge' && asked && (
        <ConfirmDialog title={`Merge ${asked.repository} into ${asked.baseBranch}`} confirmLabel="Merge" onConfirm={merge} onCancel={() => setAsking(null)}>
          {`${asked.repository} is merged into ${asked.baseBranch} in its own checkout. Its copy in this task is removed afterwards and the terminals in it are closed. ${isLast ? 'This is the task\'s last repository: the task is finished.' : 'The task stays open for its other repositories.'}`}
        </ConfirmDialog>
      )}
      {asking?.kind === 'pullRequest' && asked && (
        <ConfirmDialog title={`Open a pull request for ${asked.repository}`} confirmLabel="Push and open" onConfirm={pullRequest} onCancel={() => setAsking(null)}>
          {`${asked.branch} of ${asked.repository} is pushed to ${remoteOf(asked).name} (${remoteOf(asked).host}) and a pull request into ${asked.baseBranch} is opened. Pushing publishes the branch.`}
        </ConfirmDialog>
      )}
      {asking?.kind === 'close' && asked && (
        <ConfirmDialog title={`Close ${asked.repository}`} confirmLabel="Close repository" tone={asked.commitsAhead > 0 && asked.state !== 'pr_open' ? 'danger' : 'primary'} onConfirm={closeRepository} onCancel={() => setAsking(null)}>
          {`${asked.repository} leaves this task: its copy is removed and the terminals in it are closed.${asked.commitsAhead > 0 && asked.state !== 'pr_open' ? ` Its ${plural(asked.commitsAhead, 'commit')} stay on the branch ${asked.branch}, not merged.` : ''}${isLast ? ' This is the task\'s last repository: the task is closed.' : ''}`}
        </ConfirmDialog>
      )}
      {asking?.kind === 'closeTask' && (
        <ConfirmDialog title="Close task" confirmLabel="Close task" tone={unmergedTotal > 0 ? 'danger' : 'primary'} onConfirm={closeWholeTask} onCancel={() => setAsking(null)}>
          {`Every repository of "${task.title}" is closed: the task's copies are removed and its terminals are closed.${unmergedTotal > 0 ? ` ${plural(unmergedTotal, 'commit')} that ${unmergedTotal === 1 ? 'is' : 'are'} not merged stay on the task's branches.` : ''}`}
        </ConfirmDialog>
      )}
    </div>
  );
}
