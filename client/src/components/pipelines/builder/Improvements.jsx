import React, { useEffect, useRef, useState } from 'react';
import { Activity, Clock3, ListChecks, ScanSearch, RefreshCw } from 'lucide-react';
import {
  improvementDashboard,
  improvementEvidence,
  improvementAction,
  configureReviewer,
  startRun,
} from '../../../utils/pipelinesApi';
import {
  validateProposal,
  validateCall,
  validateReviewerStatus,
  validatePacket,
  classifications,
  flagNames,
  runnerBrief,
  median,
  statuses,
  validateOutcome,
} from '../../../../../shared/workflow-improvements.mjs';
import ImprovementProposal, { duration } from './ImprovementProposal';
import TeamImprovements from './TeamImprovements';
import RunWorkflowDialog from '../RunWorkflowDialog';
import './improvements.css';

const day = (date) => date.toISOString().slice(0, 10);
const percentile = (v, max) => (max ? (v / max) * 100 + '%' : '0%');
const byDay = (rows) =>
  Object.entries(Object.groupBy(rows, (r) => r.at.slice(0, 10))).sort(([a], [b]) => a.localeCompare(b));
function Trends({ rows, drill }) {
  const days = byDay(rows);
  const max = Math.max(1, ...days.map(([, r]) => r.length));
  const timeDays = days.map(([date, all]) => ({
    date,
    all,
    measured: all.filter((r) => r.activeMs !== null && r.waitMs !== null),
  }));
  const maxMs = Math.max(
    1,
    ...timeDays.map((d) => d.measured.reduce((s, r) => s + r.activeMs + r.waitMs, 0)),
  );
  return (
    <div className="imp-pair">
      <section>
        <h3>Run outcomes</h3>
        <div className="imp-legend">
          {statuses.map((s) => (
            <span key={s}>
              <i className={'imp-' + s} />
              {s}
            </span>
          ))}
        </div>
        <div className="imp-chart">
          {days.map(([date, all]) => (
            <button
              key={date}
              onClick={() => drill(date, all)}
              aria-label={date + ' · ' + all.length + ' outcomes'}
            >
              <span>{date.slice(5)}</span>
              <span className="imp-track">
                {statuses.map((s) => (
                  <i
                    key={s}
                    title={s + ' ' + all.filter((r) => r.status === s).length}
                    className={'imp-' + s}
                    style={{ width: percentile(all.filter((r) => r.status === s).length, max) }}
                  />
                ))}
              </span>
              <b>{all.length}</b>
            </button>
          ))}
        </div>
        {!days.length && <p>No outcomes in this period.</p>}
      </section>
      <section>
        <h3>Execution and owner wait</h3>
        <div className="imp-legend">
          <span>
            <i className="imp-exec" />
            Execution
          </span>
          <span>
            <i className="imp-wait" />
            Owner wait
          </span>
        </div>
        <div className="imp-chart">
          {timeDays.map(({ date, all, measured }) => {
            const active = measured.reduce((s, r) => s + r.activeMs, 0),
              wait = measured.reduce((s, r) => s + r.waitMs, 0);
            return (
              <button
                key={date}
                onClick={() => drill(date + ' · timing', measured.length ? measured : all)}
                title={
                  duration(active) +
                  ' execution, ' +
                  duration(wait) +
                  ' owner wait, ' +
                  measured.length +
                  '/' +
                  all.length +
                  ' timed'
                }
              >
                <span>{date.slice(5)}</span>
                <span className="imp-track">
                  <i className="imp-exec" style={{ width: percentile(active, maxMs) }} />
                  <i className="imp-wait" style={{ width: percentile(wait, maxMs) }} />
                </span>
                <b>{measured.length ? duration(active + wait) : 'Unavailable'}</b>
              </button>
            );
          })}
        </div>
        {!days.length && <p>No timing samples in this period.</p>}
      </section>
    </div>
  );
}
function StepTable({ rows, drill }) {
  const groups = Object.entries(
    Object.groupBy(
      rows.flatMap((r) => r.steps.map((s) => ({ ...s, run: r }))),
      (s) => s.name,
    ),
  )
    .map(([name, steps]) => {
      const timed = steps.filter((s) => s.activeMs !== null);
      return {
        name,
        steps,
        timed,
        active: timed.length ? timed.reduce((a, s) => a + s.activeMs, 0) : null,
        elapsed: steps.reduce((a, s) => a + s.elapsedMs, 0),
      };
    })
    .sort((a, b) => (b.active ?? -1) - (a.active ?? -1) || b.elapsed - a.elapsed);
  return (
    <section>
      <h3>Where time goes</h3>
      <div className="imp-table">
        <table>
          <thead>
            <tr>
              {[
                'Step',
                'Active time',
                'Median active',
                'Timed / total',
                'Recorded elapsed',
                'Launches',
                'Loop-backs',
              ].map((k) => (
                <th key={k}>{k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(({ name, steps, timed, active, elapsed }) => (
              <tr key={name}>
                <td>
                  <button
                    onClick={() =>
                      drill(name + ' · source runs', [
                        ...new Map(steps.map((s) => [s.run.id, s.run])).values(),
                      ])
                    }
                  >
                    {name}
                  </button>
                </td>
                <td>{duration(active)}</td>
                <td>{duration(median(timed.map((s) => s.activeMs)))}</td>
                <td>
                  {timed.length} / {steps.length}
                </td>
                <td>{duration(elapsed)}</td>
                <td>{steps.reduce((a, s) => a + s.launches, 0)}</td>
                <td>{steps.reduce((a, s) => a + s.loops, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function Evidence({ id, onClose }) {
  const [detail, setDetail] = useState(null),
    [label, setLabel] = useState(''),
    [message, setMessage] = useState(''),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    improvementEvidence(id, c.signal)
      .then((d) => {
        if (!c.signal.aborted) setDetail(validatePacket(d));
      })
      .catch((e) => {
        if (!c.signal.aborted) setMessage(e.message);
      });
    return () => c.abort();
  }, [id]);
  return (
    <section className="imp-evidence">
      <button className="imp-right" onClick={onClose}>
        Close evidence
      </button>
      <h3>Run evidence</h3>
      <code>{id}</code>
      {detail && (
        <>
          <p>{detail.request}</p>
          {detail.finding && (
            <blockquote>
              {flagNames[detail.finding.label]} · {detail.finding.quote}
            </blockquote>
          )}
          {detail.steps.map((s, i) => (
            <details key={i}>
              <summary>
                {s.name} · {s.notes.length} report excerpts
              </summary>
              {s.notes.map((n) => (
                <div key={n.id}>
                  <b>{n.summary}</b>
                  <pre>{n.excerpt}</pre>
                </div>
              ))}
            </details>
          ))}
          {[
            ['Owner answers', detail.ownerAnswers],
            ['Owner reviews', detail.ownerReviews],
            ['Agent decisions', detail.agentDecisions],
          ].map(
            ([title, items]) =>
              items.length > 0 && (
                <details key={title}>
                  <summary>
                    {title} ({items.length})
                  </summary>
                  {items.map((a, i) => (
                    <p key={i}>
                      {a.step} · {a.question} {a.answer || a.verdict} {a.comment}
                    </p>
                  ))}
                </details>
              ),
          )}
          <div className="imp-actions">
            <select
              aria-label="Benchmark classification"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            >
              <option value="">Benchmark classification</option>
              {classifications.map((v) => (
                <option key={v} value={v}>
                  {flagNames[v]}
                </option>
              ))}
            </select>
            <button
              disabled={!label || saved}
              onClick={async () => {
                try {
                  await improvementAction('outcomes/' + id + '/label', { label });
                  setSaved(true);
                  setMessage('Case reserved for reviewer evaluation.');
                } catch (e) {
                  setMessage(e.message);
                }
              }}
            >
              Reserve labelled case
            </button>
          </div>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
function ModelSettings({ worker, onSaved }) {
  const [provider, setProvider] = useState(worker.provider ?? 'codex');
  const [model, setModel] = useState(worker.model ?? ''),
    [effort, setEffort] = useState(worker.effort ?? '');
  const [message, setMessage] = useState(''),
    [saving, setSaving] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await configureReviewer({ revision: worker.modelRevision, provider, model, effort: effort || null });
      onSaved();
    } catch (e) {
      setMessage(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <details>
      <summary>Reviewer model</summary>
      <form onSubmit={save} className="imp-filters">
        <label>
          Provider
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setEffort('');
            }}
          >
            {['codex', 'claude'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          Model ID
          <input required maxLength={256} value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label>
          Reasoning effort
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">Model default</option>
            {(provider === 'codex'
              ? ['minimal', 'low', 'medium', 'high', 'xhigh']
              : ['low', 'medium', 'high', 'xhigh', 'max']
            ).map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <button disabled={saving || !model.trim()}>Save reviewer model</button>
        {message && <p role="alert">{message}</p>}
      </form>
    </details>
  );
}
export default function Improvements(props) {
  const [view, setView] = useState('workflows');
  const switcher = (
    <nav aria-label="Improvement scores" className="workflow-views">
      <button aria-pressed={view === 'workflows'} onClick={() => setView('workflows')}>Workflows</button>
      <button aria-pressed={view === 'teams'} onClick={() => setView('teams')}>Teams</button>
    </nav>
  );
  return view === 'teams' ? <TeamImprovements switcher={switcher} /> : <WorkflowImprovements {...props} switcher={switcher} />;
}

function WorkflowImprovements({ workflows, projects = [], onChanged, switcher }) {
  const [workflow, setWorkflow] = useState(''),
    [revision, setRevision] = useState('');
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 29 * 86400000))),
    [to, setTo] = useState(() => day(new Date()));
  const [version, setVersion] = useState(0),
    [data, setData] = useState(null),
    [error, setError] = useState(''),
    [actionError, setActionError] = useState(null),
    [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState(null),
    [source, setSource] = useState(null),
    [implementation, setImplementation] = useState(null);
  const drawer = useRef(null),
    proposalsPanel = useRef(null);
  const filterKey = JSON.stringify({ workflow, revision, from, to });
  useEffect(() => {
    const c = new AbortController();
    const query = Object.fromEntries(
      Object.entries({ workflowId: workflow, revision, from, to }).filter(([, v]) => v),
    );
    const load = async () => {
      try {
        const [rows, proposals, calls, worker] = await improvementDashboard(query, c.signal);
        rows.forEach(validateOutcome);
        proposals.forEach(validateProposal);
        calls.forEach(validateCall);
        validateReviewerStatus(worker);
        if (!c.signal.aborted) {
          setData({ rows, proposals, calls, worker, filterKey });
          setError('');
        }
      } catch (e) {
        if (!c.signal.aborted) setError(e.message);
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => {
      clearInterval(timer);
      c.abort();
    };
  }, [filterKey, version]);
  useEffect(() => {
    setDrill(null);
    setSource(null);
  }, [filterKey]);
  useEffect(() => {
    if (drill || source) drawer.current?.scrollIntoView?.({ block: 'nearest' });
  }, [drill, source]);
  const openDrill = (title, rows) => {
    setSource(null);
    setDrill({ title, rows });
  };
  const action = async (proposalId, suffix, body) => {
    setBusy(true);
    setActionError(null);
    try {
      await improvementAction('proposals/' + proposalId + '/' + suffix, body);
      setVersion((v) => v + 1);
      if (body.action === 'approve') onChanged?.();
    } catch (e) {
      setActionError({ proposalId, message: e.message });
    } finally {
      setBusy(false);
    }
  };
  const rows = data?.rows ?? [],
    timed = rows.filter((r) => r.activeMs !== null),
    completed = rows.filter((r) => r.status === 'complete'),
    gaps = completed.filter((r) => r.flags.includes('proofGap'));
  const proposals = data?.proposals ?? [],
    pending = proposals
      .filter((p) => p.status === 'pending')
      .sort(
        (a, b) =>
          Number(b.draft.citations.some((id) => gaps.some((r) => r.id === id))) -
          Number(a.draft.citations.some((id) => gaps.some((r) => r.id === id))),
      ),
    decided = proposals.filter((p) => p.status !== 'pending' && p.status !== 'superseded'),
    superseded = proposals.filter((p) => p.status === 'superseded');
  const cards = [
    [
      'Finished runs',
      rows.filter((r) => r.status !== 'interrupted').length,
      Activity,
      () =>
        openDrill(
          'Finished runs',
          rows.filter((r) => r.status !== 'interrupted'),
        ),
    ],
    [
      'Median active time',
      duration(median(timed.map((r) => r.activeMs))),
      Clock3,
      () => openDrill('Timed outcomes', timed),
    ],
    [
      'Flagged proof gaps',
      gaps.length + ' / ' + completed.length,
      ScanSearch,
      () => openDrill('Flagged proof gaps', gaps),
    ],
    [
      'Awaiting decision',
      pending.length,
      ListChecks,
      () => proposalsPanel.current?.scrollIntoView?.({ block: 'start' }),
    ],
  ];
  const renderProposal = (p) => (
    <ImprovementProposal
      key={p.id}
      proposal={p}
      openRun={setSource}
      action={(suffix, body) => action(p.id, suffix, body)}
      actionError={actionError?.proposalId === p.id ? actionError.message : null}
      workflow={workflows.find((w) => w.id === p.workflowId)}
      projects={projects}
      busy={busy}
      implement={(proposal, project) => setImplementation({ proposal, project })}
    />
  );
  const costs = data?.calls.filter((c) => c.cost !== null) ?? [];
  return (
    <main className="imp-page">
      <div className="imp-inner">
        <header className="imp-heading">
          <div>
            <h2>Workflow improvements</h2>
            <p>Execution, evidence and review outcomes</p>
          </div>
          <button onClick={() => setVersion((v) => v + 1)}>
            <RefreshCw size={14} /> Refresh
          </button>
        </header>
        {switcher}
        <div className="imp-filters">
          <label>
            Workflow
            <select
              value={workflow}
              onChange={(e) => {
                setWorkflow(e.target.value);
                setRevision('');
              }}
            >
              <option value="">All workflows</option>
              {workflows.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Revision
            <input
              type="number"
              min="1"
              placeholder="All"
              disabled={!workflow}
              value={revision}
              onChange={(e) => setRevision(e.target.value)}
            />
          </label>
          <label>
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Through
            <input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        {data?.filterKey !== filterKey ? (
          <p role="status">Loading review data…</p>
        ) : (
          <>
            <div className="imp-cards">
              {cards.map(([label, value, Icon, click]) => (
                <button key={label} onClick={click}>
                  <span>
                    <Icon size={16} />
                    {label}
                  </span>
                  <strong>{value}</strong>
                </button>
              ))}
            </div>
            {!rows.length && <p className="imp-empty">No workflow outcomes match these filters.</p>}
            <div ref={drawer}>
              {drill && (
                <section className="imp-drill">
                  <button
                    className="imp-right"
                    onClick={() => {
                      setDrill(null);
                      setSource(null);
                    }}
                  >
                    Close list
                  </button>
                  <h3>
                    {drill.title} · {drill.rows.length}
                  </h3>
                  {drill.rows.map((r) => (
                    <button key={r.id} onClick={() => setSource(r.id)}>
                      {r.project} · {r.name} · r{r.revision} · {r.id.slice(0, 8)}
                    </button>
                  ))}
                </section>
              )}
              {source && <Evidence key={source} id={source} onClose={() => setSource(null)} />}
            </div>
            <Trends rows={rows} drill={openDrill} />
            {rows.length > 0 && <StepTable rows={rows} drill={openDrill} />}
            <section ref={proposalsPanel}>
              <h3>
                Needs a decision <small>{pending.length}</small>
              </h3>
              {pending.length ? pending.map(renderProposal) : <p>No proposals awaiting approval.</p>}
            </section>
            <section>
              <h3>Did it help?</h3>
              {decided.length ? (
                decided.map(renderProposal)
              ) : (
                <p>Approved changes and their measured outcomes appear here.</p>
              )}
              {superseded.length > 0 && (
                <details>
                  <summary>Superseded proposals ({superseded.length})</summary>
                  {superseded.map(renderProposal)}
                </details>
              )}
            </section>
            <section>
              <h3>Reviewer performance</h3>
              <div className="imp-review-stats">
                {[
                  ['Pending', pending.length],
                  ['Accepted', proposals.filter((p) => ['approved', 'applied'].includes(p.status)).length],
                  ['Dismissed', proposals.filter((p) => p.status === 'dismissed').length],
                  ['Superseded', superseded.length],
                  ['Helped', proposals.filter((p) => p.result?.verdict === 'helped').length],
                  ['Model calls', data.calls.length],
                  ['Failed calls', data.calls.filter((c) => c.status === 'failed').length],
                  [
                    'Billed cost',
                    costs.length
                      ? '$' +
                        costs.reduce((s, c) => s + c.cost, 0).toFixed(4) +
                        ' (' +
                        costs.length +
                        '/' +
                        data.calls.length +
                        ')'
                      : 'Unavailable',
                  ],
                ].map(([k, v]) => (
                  <div key={k}>
                    <small>{k}</small>
                    <b>{v}</b>
                  </div>
                ))}
              </div>
              <ModelSettings
                key={data.worker.modelRevision}
                worker={data.worker}
                onSaved={() => setVersion((v) => v + 1)}
              />
              <p>
                Reviewer revision {data.worker.reviewerRevision} · {data.worker.dailyBudget} calls per day ·{' '}
                {data.worker.queued} queued
                {!data.worker.configured && ' · Choose a reviewer model to start reviews.'}
              </p>
            </section>
          </>
        )}
        {implementation && (
          <RunWorkflowDialog
            projectName={implementation.project}
            repositories={projects.find((p) => p.name === implementation.project)?.repositories}
            initialInput={runnerBrief(implementation.proposal.draft)}
            initialRequestId={'improvement-' + implementation.proposal.id}
            onClose={() => setImplementation(null)}
            onStart={request => startRun({ ...request, project: implementation.project })}
          />
        )}
      </div>
    </main>
  );
}
