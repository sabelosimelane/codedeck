import React, { useState } from 'react';
import { useToast } from '../ToastContext';
import {
  closeTask, closeTaskWorktree, commitTaskWorktree, listTaskWorktreeLandings, mergeTaskWorktree, openTaskWorktreePullRequest, renameTask,
} from '../../utils/tasksApi.js';
import { Button, ConfirmDialog, PromptDialog } from '../ui/index.jsx';
import AddRepositoryDialog from './AddRepositoryDialog.jsx';
import LandingMenu from './LandingMenu.jsx';
import { LANDING_ERROR, useLandingStatus } from './useLandingStatus.js';
import { FINISH_TASK_LABEL, landingStatus, nextLandingStep, waitingReasons } from './landingSteps.js';
import { closeArguments, closeRefusals, namedIgnored } from './ignoredFiles.js';
import './task-view.css';

const plural = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;
const OPEN = ['active', 'pr_open'];
const messages = list => list.map(reason => reason.message);

/**
 * How a task with several repositories gets its work back into the project: one row per
 * repository, each landed on its own. What a row shows is read from Git by the backend every
 * few seconds; every button round-trips through the backend and nothing here decides whether
 * an action is allowed. The task is finished when its last repository is merged or closed.
 */
export default function TaskRepositoriesLanding({ task, canAddRepository = false, onChanged, onFinished, onRepositoryFinished }) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(null);
  // What was refused and where: on a repository's row, or on the task (`worktreeId` null).
  const [refusal, setRefusal] = useState(null);
  const [remotes, setRemotes] = useState({});
  // Which action is asking for the owner's word, and for which repository.
  const [confirmation, setAsking] = useState(null);
  const { snapshot: landings, setSnapshot: setLandings, failure, refresh, alive, begin, end, reconcile } = useLandingStatus(task.id, listTaskWorktreeLandings, setRefusal);
  const asking = confirmation && (confirmation.snapshot === landings || ['rename', 'addRepository'].includes(confirmation.kind)) ? confirmation : null;
  const ask = (kind, worktreeId = null) => setAsking({ kind, worktreeId, snapshot: landings });

  const act = async (name, worktreeId, action, success) => {
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
      if (alive.current) setRefusal({ worktreeId, message, reasons: error?.reasons ?? [], conflicts: error?.conflicts ?? [] });
      if (error?.partialClose) {
        warnAboutTerminals(error.partialClose);
        onRepositoryFinished?.(error.partialClose);
      }
      onChanged?.();
      return null;
    } finally {
      end();
      if (alive.current) setBusy(null);
      if (failed) reconcile();
    }
  };

  // Terminals in a worktree that is gone are closed with it; the result says which, and which were not.
  const withClosed = (message, result) => (result.terminalsClosed.length === 0 ? message
    : `${message}${message.endsWith('.') ? '' : '.'} ${plural(result.terminalsClosed.length, 'terminal')} closed.`);
  const warnAboutTerminals = result => {
    if (result.terminalsNotClosed.length > 0) {
      showToast({ type: 'error', message: `${plural(result.terminalsNotClosed.length, 'terminal')} could not be closed: ${result.terminalsNotClosed.join(', ')}. Close ${result.terminalsNotClosed.length === 1 ? 'it from its tab' : 'them from their tabs'}.` });
    }
  };
  const settled = (result, taskFinished = result?.taskFinished) => {
    if (!result) return;
    warnAboutTerminals(result);
    onChanged();
    // A task whose last repository went is left; otherwise only that repository's terminals go.
    if (result.folderRemoved === false) showToast({ type: 'error', message: 'The task folder was retained because it still contains files.' });
    if (taskFinished) {
      if (alive.current) setLandings(null);
      onFinished(result);
    } else {
      onRepositoryFinished(result);
      reconcile();
    }
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
    if (renamed) onChanged();
  };

  const commit = async (message) => {
    const entry = asked;
    const next = await act('commit', entry.worktreeId, () => commitTaskWorktree(task.id, entry.worktreeId, message), () => `Changes committed in ${entry.repository}`);
    if (next && alive.current) setLandings(current => (current ? current.map(row => (row.worktreeId === next.worktreeId ? next : row)) : current));
  };

  const merge = async () => {
    const entry = asked;
    const merged = await act('merge', entry.worktreeId, () => mergeTaskWorktree(task.id, entry.worktreeId), (result) => {
      const done = result.filesRemoved ? `Merged ${entry.repository} into ${result.mergedInto}` : `Merged ${entry.repository} into ${result.mergedInto}, but its copy in this task could not be removed`;
      return withClosed(result.taskFinished ? `${done}. The task is finished.` : done, result);
    });
    settled(merged);
  };

  const pullRequest = async () => {
    const entry = asked;
    const remote = remoteOf(entry);
    const opened = await act('pullRequest', entry.worktreeId, () => openTaskWorktreePullRequest(task.id, entry.worktreeId, remote.name), result => `Pull request opened for ${entry.repository}: ${result.prUrl}`);
    if (opened) { onChanged(); refresh(); }
  };

  const closeRepository = async () => {
    const entry = asked;
    const closed = await act('close', entry.worktreeId, () => closeTaskWorktree(task.id, entry.worktreeId, ...closeArguments(entry.ignoredAtRiskCount > 0)), (result) => {
      const done = `Closed ${entry.repository} in this task. Branch ${result.branchKept} was kept.`;
      return withClosed(result.taskFinished ? `${done} The task is closed.` : done, result);
    });
    settled(closed);
  };

  const closeWholeTask = async () => {
    const closed = await act('closeTask', null, () => closeTask(task.id, ...closeArguments(holdingIgnored.length > 0)), result => withClosed(result.unmergedCommits > 0 ? `Task closed. Branch ${result.branchKept} was kept.` : 'Task closed', result));
    settled(closed, true);
  };

  // Ignored files that exist only in a copy do not refuse Close; its dialog lists them and asks.
  const taskCloseReasons = open.flatMap(entry => closeRefusals(entry).map(reason =>
    reason.code === 'run_active' ? `${entry.repository}: ${reason.message}` : reason.message
  ));
  const holdingIgnored = open.filter(entry => entry.ignoredAtRiskCount > 0);
  const unmergedTotal = open.reduce((sum, entry) => sum + (entry.commitsAhead ?? 0), 0);
  const taskRefusal = refusal && refusal.worktreeId === null ? refusal : null;

  const taskMenu = [
    { key: 'rename', label: 'Rename task', onSelect: () => ask('rename') },
    ...(canAddRepository ? [{ key: 'add', label: 'Add repository', onSelect: () => ask('addRepository') }] : []),
    ...(landings ? [{ key: 'closeTask', label: FINISH_TASK_LABEL, tone: 'danger', disabledReasons: open.length === 0 ? ['Every repository is already merged or closed.'] : taskCloseReasons,
      onSelect: () => ask('closeTask') }] : []),
  ];

  /** Everything but the row's next step, for its menu. */
  const rowMenu = (entry, step) => {
    const tools = toolsOf(entry);
    const askRow = kind => () => ask(kind, entry.worktreeId);
    return [
      ...(entry.uncommittedCount > 0 && step !== 'commit' ? [{ key: 'commit', label: 'Commit changes', name: `Commit changes in ${entry.repository}`, disabledReasons: messages(entry.blockers.commit), onSelect: askRow('commit') }] : []),
      ...(entry.baseBranch !== null && entry.commitsAhead > 0 && step !== 'merge' ? [{ key: 'merge', label: `Merge into ${entry.baseBranch}`, name: `Merge ${entry.repository} into ${entry.baseBranch}`, disabledReasons: messages(entry.blockers.merge), onSelect: askRow('merge') }] : []),
      ...(tools.length > 0 && entry.baseBranch !== null && entry.commitsAhead > 0 && entry.prUrl === null ? [{ key: 'pullRequest', label: 'Open a pull request', name: `Open a pull request for ${entry.repository}`, disabledReasons: messages(entry.blockers.pullRequest), onSelect: askRow('pullRequest') }] : []),
      ...(step !== 'close' ? [{ key: 'close', label: `Close ${entry.repository}`, tone: 'danger', disabledReasons: messages(closeRefusals(entry)), onSelect: askRow('close') }] : []),
    ];
  };

  const primary = (entry, step) => {
    if (step === 'commit') return <Button size="small" variant="primary" aria-label={`Commit changes in ${entry.repository}`} onClick={() => ask('commit', entry.worktreeId)} disabled={busy !== null}>Commit changes</Button>;
    if (step === 'merge') return <Button size="small" variant="primary" aria-label={`Merge ${entry.repository} into ${entry.baseBranch}`} onClick={() => ask('merge', entry.worktreeId)} disabled={busy !== null}>{`Merge into ${entry.baseBranch}`}</Button>;
    if (step === 'close') return <Button size="small" variant="primary" aria-label={`Close ${entry.repository}`} onClick={() => ask('close', entry.worktreeId)} disabled={busy !== null}>Close</Button>;
    return null;
  };

  return (
    <div role="group" aria-label={`Task ${task.title}`} className="task-landing">
      <div className="task-landing-row">
        <strong className="pipeline-run-name" title={task.title}>{task.title}</strong>
        {landings === null && failure === null && <span className="pipeline-run-muted">Reading the task…</span>}
        {failure && <span role="alert" className="pipeline-run-danger">{failure}</span>}
        <div className="pipeline-run-actions">
          <LandingMenu label="Task actions" items={taskMenu} disabled={busy !== null} />
        </div>
      </div>
      {taskRefusal && (
        <div role="alert" className="task-landing-refusal">
          <span className="pipeline-run-danger">{taskRefusal.message}</span>
          {taskRefusal.reasons.slice(1).map(reason => <span key={`${reason.code}:${reason.message}`} className="pipeline-run-warning">{reason.message}</span>)}
        </div>
      )}
      {landings && (
        <ul aria-label="Repositories of this task" className="task-landing-repos">
          {landings.map((entry) => {
            const isOpen = OPEN.includes(entry.state);
            const step = isOpen ? nextLandingStep(entry) : null;
            const status = isOpen ? landingStatus(entry) : { tone: 'muted', text: entry.state };
            const rowRefusal = refusal && refusal.worktreeId === entry.worktreeId ? refusal : null;
            return (
              <li key={entry.worktreeId} data-repository={entry.repository} className="task-landing-repo">
                <div className="task-landing-row">
                  <span className="task-landing-dot" data-tone={status.tone} aria-hidden="true" />
                  <strong className="task-landing-repo-name">{entry.repository}</strong>
                  <span className="task-landing-status" data-tone={status.tone}>{status.text}</span>
                  {isOpen && entry.commitsBehind > 0 && <span className="pipeline-run-muted">{`${entry.baseBranch} has moved on by ${plural(entry.commitsBehind, 'commit')}`}</span>}
                  {isOpen && entry.ignoredAtRiskCount > 0 && <span className="pipeline-run-muted">{`${plural(entry.ignoredAtRiskCount, 'ignored file')} only here`}</span>}
                  {entry.prUrl && <a href={entry.prUrl} target="_blank" rel="noreferrer noopener" className="task-landing-link">Pull request</a>}
                  {isOpen && (
                    <div className="pipeline-run-actions">
                      {primary(entry, step)}
                      <LandingMenu label={`More actions for ${entry.repository}`} items={rowMenu(entry, step)} disabled={busy !== null} />
                    </div>
                  )}
                </div>
                {isOpen && waitingReasons(entry).map(message => <span key={message} className="task-landing-hint">{message}</span>)}
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
          {toolsOf(asked).length > 1 && (
            <label className="task-landing-remote">Remote
              <select aria-label={`Remote for the pull request of ${asked.repository}`} value={remoteOf(asked).name} onChange={event => setRemotes(current => ({ ...current, [asked.worktreeId]: event.target.value }))}>
                {toolsOf(asked).map(candidate => <option key={candidate.name} value={candidate.name}>{`${candidate.name} (${candidate.host})`}</option>)}
              </select>
            </label>
          )}
        </ConfirmDialog>
      )}
      {asking?.kind === 'close' && asked && (
        <ConfirmDialog title={`Close ${asked.repository}`} confirmLabel={asked.ignoredAtRiskCount > 0 ? 'Delete files and close' : 'Close repository'} tone={asked.ignoredAtRiskCount > 0 || (asked.commitsAhead > 0 && asked.state !== 'pr_open') ? 'danger' : 'primary'} onConfirm={closeRepository} onCancel={() => setAsking(null)}>
          {`${asked.repository} leaves this task: its copy is removed and the terminals in it are closed.${asked.commitsAhead > 0 && asked.state !== 'pr_open' ? ` Its ${plural(asked.commitsAhead, 'commit')} stay on the branch ${asked.branch}, not merged.` : ''}${isLast ? ' This is the task\'s last repository: the task is closed.' : ''}${asked.ignoredAtRiskCount > 0 ? ` Files Git ignores that exist only in this copy are deleted with it: ${namedIgnored(asked)}.` : ''}`}
        </ConfirmDialog>
      )}
      {asking?.kind === 'closeTask' && (
        <ConfirmDialog title={FINISH_TASK_LABEL} confirmLabel={holdingIgnored.length > 0 ? 'Delete files and close' : 'Finish task'} tone={holdingIgnored.length > 0 || unmergedTotal > 0 ? 'danger' : 'primary'} onConfirm={closeWholeTask} onCancel={() => setAsking(null)}>
          {`Every repository of "${task.title}" is closed: the task's copies are removed and its terminals are closed.${unmergedTotal > 0 ? ` ${plural(unmergedTotal, 'commit')} that ${unmergedTotal === 1 ? 'is' : 'are'} not merged stay on the task's branches.` : ''}${holdingIgnored.length > 0 ? ` Files Git ignores that exist only in this task are deleted with it: ${holdingIgnored.map(entry => `${entry.repository}: ${namedIgnored(entry)}`).join('; ')}.` : ''}`}
        </ConfirmDialog>
      )}
    </div>
  );
}
