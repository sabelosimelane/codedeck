import React, { useState } from 'react';
import { decideTeamTrial } from '../../../utils/pipelinesApi';
import { duration } from './ImprovementProposal';
import { percent } from './teamReviewState';

const profile = (setting) =>
  [setting.provider, setting.model || 'default model', setting.effort || 'default effort'].join(' · ');
function TrialResult({ comparison }) {
  const { before, after } = comparison;
  return (
    <div className="imp-result">
      <h4>Observed trial outcome · {comparison.verdict}</h4>
      <p>{comparison.exposedRuns} trial runs executed the candidate assignment.</p>
      <div className="imp-table">
        <table>
          <thead>
            <tr>
              <th>Measure</th>
              <th>Baseline</th>
              <th>Trial</th>
            </tr>
          </thead>
          <tbody>
            {[
              ['Median active time', (s) => duration(s.metrics.activeMs.value)],
              ['Accuracy', (s) => percent(s.metrics.accuracy.value)],
              ['Delivery rate', (s) => percent(s.metrics.deliveryRate.value)],
              ['Verification coverage', (s) => percent(s.metrics.verificationCoverage.value)],
              ['Failed / stopped / interrupted', (s) => [s.failed, s.stopped, s.interrupted].join(' / ')],
              ['Unverified deliveries', (s) => s.unverified],
            ].map(([name, read]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{read(before)}</td>
                <td>{read(after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Trial({ trial, open, refresh }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const decide = async (action, message) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await decideTeamTrial(trial.id, { action, revision: trial.revision });
      setNotice(message);
      refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const { comparison, status, stale } = trial;
  const refs = (ids, label) => (
    <div className="imp-refs">
      <span>{label}</span>
      {ids.map((id) => (
        <button key={id} onClick={() => open(id)}>
          {id.slice(0, 8)}
        </button>
      ))}
    </div>
  );
  return (
    <article className="imp-proposal">
      <div className="imp-meta">
        {trial.teamName} · Revision {trial.teamRevision} · {status} · {trial.goal}
      </div>
      <h4>
        {trial.role} · {profile(trial.from)} → {profile(trial.to)}
      </h4>
      <p>{trial.reason}</p>
      <dl>
        <dt>Counterevidence</dt>
        <dd>{trial.counterevidence}</dd>
        <dt>Success measure</dt>
        <dd>{trial.success}</dd>
      </dl>
      {status === 'pending' && (
        <p>
          Next {trial.baselineIds.length} matching runs ({trial.project}) · Workflow {trial.workflowId.slice(0, 8)} revision{' '}
          {trial.workflowRevision}. Adoption requires a second approval.
        </p>
      )}
      {status === 'measured' && (
        <p>
          Adoption updates the {trial.role} role for future runs using {trial.teamName}.
        </p>
      )}
      {refs(trial.baselineIds, 'Baseline runs')}
      {status !== 'pending' &&
        refs(trial.assignmentIds, 'Trial assignments (' + trial.assignmentIds.length + '/' + trial.baselineIds.length + ')')}
      {trial.adoptedComparison ? (
        <>
          <p>Result at adoption</p>
          <TrialResult comparison={trial.adoptedComparison} />
          {comparison && JSON.stringify(comparison) !== JSON.stringify(trial.adoptedComparison) && (
            <>
              <p>Current evidence</p>
              <TrialResult comparison={comparison} />
            </>
          )}
        </>
      ) : (
        comparison && <TrialResult comparison={comparison} />
      )}
      {stale && <p>{trial.staleReason}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="imp-actions">
        {status === 'pending' && (
          <>
            <button
              className="imp-primary"
              disabled={busy || stale}
              onClick={() => decide('start', 'Measured trial started.')}
            >
              Start measured trial
            </button>
            <button disabled={busy} onClick={() => decide('dismiss', 'Recommendation dismissed.')}>
              Dismiss
            </button>
          </>
        )}
        {status === 'running' && (
          <button disabled={busy} onClick={() => decide('stop', 'Trial ended.')}>
            End trial early
          </button>
        )}
        {status === 'measured' && (
          <>
            <button
              className="imp-primary"
              disabled={busy || stale || comparison?.verdict !== 'helped'}
              onClick={() => decide('adopt', 'Team role updated.')}
            >
              Adopt for this team role
            </button>
            <button disabled={busy} onClick={() => decide('stop', 'Trial closed.')}>
              Close trial
            </button>
          </>
        )}
      </div>
    </article>
  );
}
