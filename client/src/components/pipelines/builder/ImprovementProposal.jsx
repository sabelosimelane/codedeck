import React, { useState } from 'react';
import { metricNames } from '../../../../../shared/workflow-improvements.mjs';

export function duration(ms) {
  if (ms === null) return 'Unavailable';
  if (ms < 1000) return Math.round(ms) + ' ms';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
}
const metricValue = (key, v) =>
  v === null ? 'Unavailable' : key === 'activeMs' ? duration(v) : Number(v.toFixed(2));
export default function ImprovementProposal({ proposal: p, workflow, action, actionError, openRun, projects, implement, busy }) {
  const [reason, setReason] = useState(''),
    [destination, setDestination] = useState('');
  const d = p.draft,
    result = p.result;
  const stale = workflow && workflow.revision > p.revision;
  const references = (ids, label) => (
    <div className="imp-refs">
      <span>{label}</span>
      {ids.map((id) => (
        <button key={id} onClick={() => openRun(id)}>
          {id.slice(0, 8)}
        </button>
      ))}
    </div>
  );
  return (
    <article className="imp-proposal">
      <div className="imp-meta">
        {d.kind} · Revision {p.revision} · {p.status}
      </div>
      <h4>{d.title}</h4>
      <p>{d.reason}</p>
      {references(d.citations, 'Source runs')}
      <details open={p.status === 'pending'}>
        <summary>Proposed change and test</summary>
        <dl>
          <dt>{d.step ? 'Replace the ' + d.step + ' instruction' : 'Change'}</dt>
          <dd>
            <pre>{d.change}</pre>
          </dd>
          <dt>Regression test</dt>
          <dd>{d.test}</dd>
          <dt>Counterevidence</dt>
          <dd>{d.counterevidence}</dd>
          <dt>Success measure</dt>
          <dd>
            {metricNames[d.metric]} ↓ · Safeguard: {metricNames[d.safeguard]}
          </dd>
        </dl>
      </details>
      {p.reason && <p>Dismissal reason · {p.reason}</p>}
      {p.evaluation && (
        <p>
          Benchmark {p.evaluation.passed ? 'passed' : 'failed'} · {p.evaluation.count} labelled cases
        </p>
      )}
      {actionError && <p role="alert">{actionError}</p>}
      {p.status === 'pending' && stale && (
        <p>
          {workflow.name} is now at revision {workflow.revision}. This proposal applies to revision {p.revision}.
          {' '}Dismiss it to clear it from the list.
        </p>
      )}
      {p.status === 'pending' && (
        <div className="imp-actions">
          {d.kind === 'reviewer' && (
            <button disabled={busy} onClick={() => action('evaluation', {})}>
              Evaluate candidate
            </button>
          )}
          <button
            className="imp-primary"
            disabled={busy || stale || (d.kind === 'reviewer' && !p.evaluation?.passed)}
            onClick={() => action('decision', { action: 'approve' })}
          >
            Approve {d.kind === 'workflow' ? 'workflow edit' : 'proposal'}
          </button>
          <input
            aria-label="Dismissal reason"
            maxLength={1500}
            placeholder="Reason for dismissing"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            disabled={busy || !reason.trim()}
            onClick={() => action('decision', { action: 'dismiss', reason })}
          >
            Dismiss
          </button>
        </div>
      )}
      {p.status === 'approved' && d.kind === 'runner' && (
        <div className="imp-actions">
          <select
            aria-label="Implementation project"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          >
            <option value="">Choose implementation project</option>
            {projects.map((v) => (
              <option key={v.name}>{v.name}</option>
            ))}
          </select>
          <button disabled={!destination || busy} onClick={() => implement(p, destination)}>
            Open implementation workflow
          </button>
          <button disabled={busy} onClick={() => action('decision', { action: 'activate' })}>
            Confirm deployed and start measurement
          </button>
        </div>
      )}
      {result && (
        <div className="imp-result">
          <strong>{result.verdict}</strong> · Rev {p.revision} → {p.effectiveRevision}
          <p>
            {metricNames[d.metric]} · {metricValue(d.metric, result.before)} →{' '}
            {metricValue(d.metric, result.after)}
          </p>
          <p>
            {metricNames[d.safeguard]} · {metricValue(d.safeguard, result.guardBefore)} →{' '}
            {metricValue(d.safeguard, result.guardAfter)}
          </p>
          {references(result.beforeIds, 'Baseline (' + result.beforeIds.length + ')')}
          {references(result.afterIds, 'After (' + result.afterIds.length + '/5)')}
        </div>
      )}
    </article>
  );
}
