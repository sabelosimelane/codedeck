import React from 'react';
import { landingStatus, nextLandingStep, waitingReasons } from '../components/tasks/landingSteps.js';
import { closeRefusals, namedIgnored } from '../components/tasks/ignoredFiles.js';
import ConfirmSheet from './ConfirmSheet';

const plural = (number, word) => `${number} ${word}${number === 1 ? '' : 's'}`;
const OPEN = new Set(['active', 'pr_open']);
const pullRequestRemotes = entry => entry.remotes.filter(remote => remote.tool !== null);

/**
 * What one repository of the task offers, in the desktop's words. The backend decides what is
 * allowed (`blockers`); an action it refuses is not offered. The phone never deletes files Git
 * ignores, so a close that would is left to the desktop.
 */
function actionsFor(entry, { several, last }) {
  const name = entry.repository;
  const next = nextLandingStep(entry);
  const actions = [];
  const add = (kind, label) => actions.push({ kind, label, primary: next === kind });
  if (entry.uncommittedCount > 0 && entry.blockers.commit.length === 0) add('commit', several ? `Commit changes in ${name}` : 'Commit changes');
  if (entry.baseBranch !== null && entry.blockers.merge.length === 0) add('merge', several ? `Merge ${name} into ${entry.baseBranch}` : `Merge into ${entry.baseBranch}`);
  if (entry.baseBranch !== null && entry.blockers.pullRequest.length === 0 && pullRequestRemotes(entry).length > 0) {
    add('pullRequest', several ? `Open a pull request for ${name}` : 'Open a pull request');
  }
  if (entry.ignoredAtRiskCount === 0 && closeRefusals(entry).length === 0) add('close', several && !last ? `Close ${name}` : 'Close task');
  return [...actions.filter(item => item.primary), ...actions.filter(item => !item.primary)];
}

function confirmationFor(kind, entry, { several, last }) {
  const unmerged = entry.commitsAhead > 0 && entry.state !== 'pr_open';
  const kept = unmerged ? ` Its ${plural(entry.commitsAhead, 'commit')} stay on the branch ${entry.branch}, not merged.` : '';
  if (!several) {
    return kind === 'merge'
      ? `The task is merged into ${entry.baseBranch} in Main. Its copy is removed afterwards, its terminals are closed and the task is finished.`
      : `The task is closed: its copy is removed and its terminals are closed.${kept}`;
  }
  if (kind === 'merge') {
    return `${entry.repository} is merged into ${entry.baseBranch} in its own checkout. Its copy in this task is removed afterwards and the terminals in it are closed. `
      + (last ? 'This is the task\'s last repository: the task is finished.' : 'The task stays open for its other repositories.');
  }
  if (kind === 'close') {
    return `${entry.repository} leaves this task: its copy is removed and the terminals in it are closed.`
      + kept
      + `${last ? ' This is the task\'s last repository: the task is closed.' : ''}`;
  }
  return null;
}

function CommitSheet({ entry, title, busy, onCommit, onCancel }) {
  const [message, setMessage] = React.useState(title);
  const ready = message.trim().length > 0 && message.trim().length <= 200;
  return (
    <div className="m-sheet-layer">
      <div className="m-backdrop" aria-hidden="true" onClick={onCancel} />
      <div className="m-sheet m-sheet-auto m-confirm" role="dialog" aria-modal="true" aria-label="Commit changes">
        <span className="m-grabber" aria-hidden="true" />
        <p className="m-confirm-text">{`Commits ${plural(entry.uncommittedCount, 'changed file')} of ${entry.repository} in this task.`}</p>
        <label className="m-field">Commit message
          <textarea value={message} maxLength={200} rows={3} onChange={event => setMessage(event.target.value)} />
        </label>
        <div className="m-confirm-actions">
          <button type="button" className="m-primary m-press" disabled={busy || !ready} onClick={() => onCommit(message.trim())}>Commit</button>
          <button type="button" className="m-press m-run-dock-button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function PullRequestSheet({ entry, busy, onOpen, onCancel }) {
  const remotes = pullRequestRemotes(entry);
  const [remote, setRemote] = React.useState(remotes[0].name);
  const chosen = remotes.find(candidate => candidate.name === remote) ?? remotes[0];
  return (
    <div className="m-sheet-layer">
      <div className="m-backdrop" aria-hidden="true" onClick={onCancel} />
      <div className="m-sheet m-sheet-auto m-confirm" role="dialog" aria-modal="true" aria-label="Confirm">
        <span className="m-grabber" aria-hidden="true" />
        <p className="m-confirm-text">{`${entry.branch} of ${entry.repository} is pushed to ${chosen.name} (${chosen.host}) and a pull request into ${entry.baseBranch} is opened. Pushing publishes the branch.`}</p>
        {remotes.length > 1 && (
          <label className="m-field">Remote
            <select value={chosen.name} onChange={event => setRemote(event.target.value)}>
              {remotes.map(candidate => <option key={candidate.name} value={candidate.name}>{`${candidate.name} (${candidate.host})`}</option>)}
            </select>
          </label>
        )}
        <div className="m-confirm-actions">
          <button type="button" className="m-primary m-press" disabled={busy} onClick={() => onOpen(chosen.name)}>Push and open</button>
          <button type="button" className="m-press m-run-dock-button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * How the task stands in Git, read live when the screen opens, when the run changes and after
 * every action, with each repository's commit, merge, pull request and close. The app's handlers
 * toast success and failure and resolve null when an action or a read did not go through.
 */
export default function LandingSection({ taskId, title, runKey, onLoadLanding, onLand }) {
  if (typeof taskId !== 'string' || !taskId) throw new Error('landing: task id is required');
  if (typeof title !== 'string' || !title.trim()) throw new Error('landing: title is required');
  if (typeof onLoadLanding !== 'function') throw new Error('landing: onLoadLanding must be a function');
  if (typeof onLand !== 'function') throw new Error('landing: onLand must be a function');
  const [state, setState] = React.useState({ status: 'loading', landings: [] });
  const [asking, setAsking] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [reads, setReads] = React.useState(0);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);
  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const landings = await onLoadLanding(taskId);
        if (active) setState(landings === null ? { status: 'error', landings: [] } : { status: 'ready', landings });
      } catch (error) {
        console.warn(`Landing of task ${taskId} could not be read: ${error?.message}`);
        if (active) setState({ status: 'error', landings: [] });
      }
    })();
    return () => { active = false; };
  }, [taskId, runKey, reads, onLoadLanding]);

  const open = state.landings.filter(entry => OPEN.has(entry.state));
  // A task that ever had several repositories names them, also once only one is left open.
  const several = state.landings.length > 1;
  const last = open.length === 1;
  const land = async (kind, entry, extra = {}) => {
    setAsking(null);
    setBusy(true);
    try {
      const result = await onLand(kind, taskId, entry.worktreeId, extra);
      if (result && alive.current && !result.taskFinished) setReads(count => count + 1);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <section className="m-landing" aria-label="In Git">
      <div className="m-landing-head">
        <h2>In Git</h2>
        <button type="button" className="m-press m-chip-button" disabled={busy} onClick={() => setReads(count => count + 1)}>Refresh</button>
      </div>
      {state.status === 'error' && <p className="m-task-phase">How the task stands in Git could not be read.</p>}
      {state.status === 'loading' && <p className="m-task-phase">Reading Git…</p>}
      {state.status === 'ready' && (
        <ul className="m-landing-list">
          {open.map(entry => {
            const status = landingStatus(entry);
            const reasons = waitingReasons(entry);
            return (
              <li key={entry.worktreeId}>
                {several && <p className="m-landing-repository m-mono">{entry.repository}</p>}
                <p className={`m-landing-status is-${status.tone}`}>{status.text}</p>
                {entry.prUrl && <a className="m-landing-link" href={entry.prUrl} target="_blank" rel="noreferrer">Pull request open</a>}
                {reasons.map(reason => <p key={reason} className="m-task-phase">{reason}</p>)}
                {entry.ignoredAtRiskCount > 0 && (
                  <p className="m-task-phase">{`${entry.ignoredAtRiskCount === 1 ? '1 ignored file exists' : `${entry.ignoredAtRiskCount} ignored files exist`} only in this copy (${namedIgnored(entry)}). Close it on the desktop.`}</p>
                )}
                <div className="m-landing-actions">
                  {actionsFor(entry, { several, last }).map(item => (
                    <button key={item.kind} type="button" disabled={busy} className={`m-press ${item.primary ? 'm-primary' : 'm-run-dock-button'}`}
                      onClick={() => setAsking({ kind: item.kind, entry, label: item.label })}>{item.label}</button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {asking?.kind === 'commit' && <CommitSheet entry={asking.entry} title={title} busy={busy} onCommit={message => land('commit', asking.entry, { message })} onCancel={() => setAsking(null)} />}
      {asking?.kind === 'pullRequest' && <PullRequestSheet entry={asking.entry} busy={busy} onOpen={remote => land('pullRequest', asking.entry, { remote })} onCancel={() => setAsking(null)} />}
      {(asking?.kind === 'merge' || asking?.kind === 'close') && (
        <ConfirmSheet message={confirmationFor(asking.kind, asking.entry, { several, last })} confirmLabel={asking.kind === 'merge' ? 'Merge' : asking.label.startsWith('Close task') ? 'Close task' : 'Close repository'}
          danger={asking.kind === 'close' && asking.entry.commitsAhead > 0 && asking.entry.state !== 'pr_open'} busy={busy}
          onCancel={() => setAsking(null)} onConfirm={() => land(asking.kind, asking.entry)} />
      )}
    </section>
  );
}
