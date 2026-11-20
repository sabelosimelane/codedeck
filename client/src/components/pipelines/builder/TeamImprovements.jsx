import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clock3, ListChecks, RefreshCw } from 'lucide-react';
import { teamImprovementDashboard, teamScoreRuns } from '../../../utils/pipelinesApi';
import { duration } from './ImprovementProposal';
import { day, percent, LoadFeedback, useRecords } from './teamReviewState';
import RunEvidence from './TeamRunEvidence';
import Trial from './TeamTrial';

function Scorecard({ card, inspect }) {
  const { score } = card;
  const metric = score.metrics;
  return (
    <section aria-label={card.name + ' scorecard'}>
      <header className="imp-heading">
        <div>
          <h3>{card.name}</h3>
          <p>
            Team revision {card.teamRevision} · Scoring policy {score.policyVersion}
            {card.trialId && ' · Trial ' + card.trialId.slice(0, 8)}
          </p>
        </div>
        <button onClick={() => inspect('All runs', score.runIds)}>View all {score.total} runs</button>
      </header>
      {Array.from(
        new Set(
          card.configuration
            .filter((slot) => slot.source === 'team' || slot.source === 'trial')
            .map((slot) =>
              [
                slot.role,
                ...(slot.provider
                  ? [slot.provider, slot.model || 'Default model', slot.effort || 'Default effort']
                  : ['Custom command']),
                'agent rev ' + slot.agentRevision,
                slot.agentId.slice(0, 8),
              ].join(' · '),
            ),
        ),
      ).map((label) => (
        <p key={label}>{label}</p>
      ))}
      <div className="imp-cards team-score-metrics">
        <button onClick={() => inspect('Timed deliveries', metric.activeMs.evidenceIds)}>
          <span>
            <Clock3 size={15} /> Delivery speed
          </span>
          <strong>{duration(metric.activeMs.value)}</strong>
          <small>Median active time · {score.timed} timed deliveries</small>
        </button>
        <button onClick={() => inspect('Verified deliveries', metric.accuracy.evidenceIds)}>
          <span>
            <ListChecks size={15} /> Solution accuracy
          </span>
          <strong>{percent(metric.accuracy.value)}</strong>
          <small>
            {score.met} of {score.met + score.missed} verified deliveries met the request
          </small>
        </button>
        {Object.entries(metric)
          .filter(
            ([key]) =>
              !['activeMs', 'accuracy', 'elapsedMs', 'deliveryRate', 'verificationCoverage'].includes(key),
          )
          .map(([key, m]) => {
            const name = key
              .replace(/([a-z])([A-Z])/g, '$1 $2')
              .toLowerCase()
              .replace(/^./, (c) => c.toUpperCase());
            return (
              <button key={key} onClick={() => inspect(name, m.evidenceIds)}>
                <span>{name}</span>
                <strong>{m.value === null ? 'Unavailable' : m.value + ' ' + m.unit}</strong>
                <small>
                  {m.direction} is better · {m.eligible} eligible · {m.excluded} excluded
                </small>
              </button>
            );
          })}
      </div>
      <p>
        {score.delivered} delivered · {score.missed} missed · {score.unverified} unverified ·{' '}
        {duration(metric.elapsedMs.value)} median elapsed
      </p>
      <p>
        {score.failed} failed · {score.stopped} stopped · {score.interrupted} interrupted · {score.unfinished}{' '}
        unfinished · {score.mixed} mixed assignments
      </p>
      {score.roles.length > 0 && (
        <details>
          <summary>Active time by role</summary>
          <div className="imp-table">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Median active time</th>
                  <th>Measured runs</th>
                </tr>
              </thead>
              <tbody>
                {score.roles.map((r) => (
                  <tr key={r.role}>
                    <td>{r.role}</td>
                    <td>{duration(r.activeMs)}</td>
                    <td>
                      <button onClick={() => inspect(r.role + ' runs', r.runIds)}>
                        {r.runIds.length} runs
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function RunList({ selection, open, close, version }) {
  const load = useCallback((signal) => teamScoreRuns(selection.cardId, signal), [selection.cardId]);
  const { data, error } = useRecords(load, version);
  const ids = new Set(selection.ids);
  const runs = data?.filter((row) => ids.has(row.id));
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selection]);
  return (
    <section ref={ref} aria-label={selection.title}>
      <button className="imp-right" onClick={close}>
        Close list
      </button>
      <h3>{selection.title}</h3>
      <LoadFeedback error={error} loading={!data} />
      {runs && !runs.length && <p>No runs in this sample.</p>}
      {runs?.map((row) => (
        <p key={row.id}>
          <button onClick={() => open(row.id)}>
            {row.project} · {row.workflowName} · {row.id.slice(0, 8)}
          </button>{' '}
          {day(row.at)} · {row.status} · {row.verdict} · {duration(row.activeMs)} active
          {row.mixed && ' · Mixed assignments'}
        </p>
      ))}
    </section>
  );
}

export default function TeamImprovements({ switcher }) {
  const [version, setVersion] = useState(0);
  const [selection, setSelection] = useState(null);
  const [runId, setRunId] = useState(null);
  const { data, error } = useRecords(teamImprovementDashboard, version);
  const refresh = () => setVersion((value) => value + 1);
  const select = (cardId, title, ids) => {
    setSelection({ cardId, title, ids });
    setRunId(null);
  };
  return (
    <main className="imp-page">
      <div className="imp-inner">
        <header className="imp-heading">
          <div>
            <h2>Team improvements</h2>
            <p>Delivery speed, accuracy and measured trials</p>
          </div>
          <button onClick={refresh}>
            <RefreshCw size={14} /> Refresh
          </button>
        </header>
        {switcher}
        <LoadFeedback error={error} loading={!data} />
        {data && (
          <>
            {!data[0].length && (
              <section>
                <h3>Team scorecards</h3>
                <p>
                  No team scorecards yet. Start a workflow with a saved team to collect delivery evidence.
                </p>
              </section>
            )}
            {data[0].map((card) => (
              <React.Fragment key={card.id}>
                <Scorecard card={card} inspect={(title, ids) => select(card.id, title, ids)} />
                {selection?.cardId === card.id && (
                  <RunList
                    key={card.id}
                    selection={selection}
                    version={version}
                    open={setRunId}
                    close={() => setSelection(null)}
                  />
                )}
              </React.Fragment>
            ))}
            {runId && (
              <RunEvidence
                key={runId}
                id={runId}
                version={version}
                refresh={refresh}
                close={() => setRunId(null)}
              />
            )}
            <section>
              <h3>Recommendations and trials</h3>
              {!data[1].length && <p>No recommendations yet. Trials need five comparable team runs.</p>}
              {data[1].map((trial) => (
                <Trial key={trial.id} trial={trial} open={setRunId} refresh={refresh} />
              ))}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
