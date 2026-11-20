import React, { useCallback, useEffect, useRef, useState } from 'react';
import { correctDeliveryVerdict, teamRunEvidence, teamRunHistory } from '../../../utils/pipelinesApi';
import { duration } from './ImprovementProposal';
import { day, LoadFeedback, useRecords } from './teamReviewState';

function Proof({ items }) {
  return (
    <dl>
      {items.map((c) => (
        <div key={c.id}>
          <dt>{c.text}</dt>
          <dd>
            <strong>{c.verdict}</strong> · {c.source}
          </dd>
          {c.proof.map((ref, i) => (
            <dd key={i}>
              <small>{ref.source}</small>
              {ref.check && <pre>{ref.check}</pre>}
              <pre>{ref.quote}</pre>
            </dd>
          ))}
        </div>
      ))}
    </dl>
  );
}

function VerdictHistory({ runId, version }) {
  const loader = useCallback((signal) => teamRunHistory(runId, signal), [runId]);
  const { data, error } = useRecords(loader, version);
  return (
    <div>
      <LoadFeedback error={error} loading={!data} />
      {data && !data.length && <p>No verdicts recorded yet.</p>}
      {data?.map((entry) => (
        <details key={entry.revision}>
          <summary>
            Revision {entry.revision} · {entry.author} · {day(entry.at)}
          </summary>
          <Proof items={entry.criteria} />
        </details>
      ))}
    </div>
  );
}

function Correction({ run, initialText, saved, cancel }) {
  const [text, setText] = useState(initialText);
  const [verdict, setVerdict] = useState(
    run.criteria.find((c) => c.text === initialText)?.verdict ?? 'unverified',
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await correctDeliveryVerdict(run.id, {
        revision: run.revision,
        signature: run.signature,
        text: text.trim(),
        verdict,
        reason: reason.trim(),
      });
      saved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="team-correction" onSubmit={submit}>
      <label>
        Acceptance criterion
        <input
          value={text}
          readOnly={Boolean(initialText)}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <label>
        Verdict
        <select value={verdict} onChange={(e) => setVerdict(e.target.value)}>
          <option value="met">Met</option>
          <option value="missed">Missed</option>
          <option value="unverified">Unverified</option>
        </select>
      </label>
      <label>
        Reason
        <input value={reason} maxLength={1500} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="imp-actions">
        <button className="imp-primary" disabled={busy || !reason.trim() || !text.trim()}>
          Save correction
        </button>
        <button type="button" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function AssignmentTable({ entries, attempts }) {
  return (
    <div className="imp-table">
      <table>
        <thead>
          <tr>
            <th>Step</th>
            {attempts && (
              <>
                <th>Attempt</th>
                <th>Active time</th>
                <th>Team</th>
              </>
            )}
            <th>Role</th>
            <th>Assignment</th>
            <th>Agent revision</th>
            <th>Provider / model</th>
            <th>Effort</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((a, i) => (
            <tr key={i}>
              <td>{a.stepName}</td>
              {attempts && (
                <>
                  <td>{a.attempt}</td>
                  <td>{duration(a.activeMs)}</td>
                  <td>{a.teamId ? a.teamId.slice(0, 8) + ' · Rev ' + a.teamRevision : 'Outside team'}</td>
                </>
              )}
              <td>{a.role || '—'}</td>
              <td>{a.source}</td>
              <td>
                {a.agentId.slice(0, 8)} · {a.agentRevision}
              </td>
              <td>{a.provider ? a.provider + ' / ' + (a.model || 'CLI default') : 'Custom command'}</td>
              <td>{a.provider ? a.effort || 'CLI default' : 'Unknown'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RunEvidence({ id, version, refresh, close }) {
  const load = useCallback((signal) => teamRunEvidence(id, signal), [id]);
  const { data: run, error } = useRecords(load, version);
  const [edit, setEdit] = useState(null);
  const [history, setHistory] = useState(false);
  const [notice, setNotice] = useState('');
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  return (
    <section ref={ref} aria-label="Team run evidence">
      <button className="imp-right" onClick={close}>
        Close evidence
      </button>
      <h3>Run evidence</h3>
      <LoadFeedback error={error} loading={!run} />
      {run && (
        <>
          <p>
            {run.project} · {run.workflowName} · {run.status}
            {run.mixed && ' · Mixed assignments'}
          </p>
          <h4>Original request</h4>
          <pre>{run.request}</pre>
          <h4>Acceptance criteria</h4>
          {!run.criteria.length && <p>No verified criteria yet.</p>}
          {run.criteria.map((c) => (
            <div className="imp-proposal" key={c.id}>
              <Proof items={[c]} />
              {run.status === 'complete' && (
                <button
                  onClick={() => {
                    setEdit({ text: c.text, run });
                    setNotice('');
                  }}
                >
                  Correct verdict
                </button>
              )}
            </div>
          ))}
          <div className="imp-actions">
            {run.status === 'complete' && (
              <button
                onClick={() => {
                  setEdit({ text: '', run });
                  setNotice('');
                }}
              >
                Add criterion
              </button>
            )}
            <button aria-expanded={history} onClick={() => setHistory(!history)}>
              Verdict history
            </button>
          </div>
          {edit !== null && (
            <Correction
              key={edit.text + edit.run.revision + edit.run.signature}
              run={edit.run}
              initialText={edit.text}
              cancel={() => setEdit(null)}
              saved={() => {
                setEdit(null);
                setNotice('Correction saved.');
                refresh();
              }}
            />
          )}
          {notice && <p role="status">{notice}</p>}
          {history && <VerdictHistory runId={id} version={version} />}
          <details>
            <summary>Execution attempts ({run.attempts.length})</summary>
            <AssignmentTable entries={run.attempts} attempts />
          </details>
          <details>
            <summary>Initial configuration</summary>
            <AssignmentTable entries={run.configuration} />
          </details>
          {run.sources.some((s) => s.id !== 'request') && (
            <details>
              <summary>Evidence sources</summary>
              {run.sources
                .filter((s) => s.id !== 'request')
                .map((s) => (
                  <div key={s.id}>
                    <strong>{s.id}</strong>
                    <pre>{s.text}</pre>
                  </div>
                ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
