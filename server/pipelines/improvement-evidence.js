import { createHash } from 'node:crypto';
import { classifyEvidence, statuses, validateOutcome } from '../../shared/workflow-improvements.mjs';

// Record status boundaries in the same transaction as the run. Earlier runs have no clock.
export function createEvidence({ db, runs, notes, answers, decisions, reviews, tasks }) {
  db.exec(`CREATE TABLE IF NOT EXISTS improvement_clock (
    seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL, step INTEGER NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, first INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS improvement_clock_run ON improvement_clock(run_id,seq);
    CREATE TRIGGER IF NOT EXISTS improvement_run_created AFTER INSERT ON pipeline_runs BEGIN
      INSERT INTO improvement_clock(run_id,step,status,at,first) VALUES(NEW.id,NEW.current_step_index,NEW.status,NEW.updated_at,1);
    END;
    CREATE TRIGGER IF NOT EXISTS improvement_run_changed AFTER UPDATE ON pipeline_runs
    WHEN OLD.status<>NEW.status OR OLD.current_step_index<>NEW.current_step_index BEGIN
      INSERT INTO improvement_clock(run_id,step,status,at,first) VALUES(NEW.id,NEW.current_step_index,NEW.status,NEW.updated_at,0);
    END;
    CREATE TABLE IF NOT EXISTS improvement_outcomes(id TEXT PRIMARY KEY, at TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)));
    CREATE INDEX IF NOT EXISTS improvement_outcomes_at ON improvement_outcomes(at);`);
  const changed = db.prepare(`SELECT r.id FROM pipeline_runs r LEFT JOIN improvement_outcomes o ON o.id=r.id
    WHERE r.status IN ('complete','error','stopped','interrupted') AND (o.at IS NULL OR r.updated_at<>o.at) ORDER BY r.updated_at,r.id LIMIT 100`);
  const save = db.prepare('INSERT OR REPLACE INTO improvement_outcomes VALUES(?,?,?)');
  const clock = db.prepare('SELECT * FROM improvement_clock WHERE run_id=? ORDER BY seq');
  function history(id) {
    const noteList = [];
    for (let offset = 0; ; offset += 100) {
      const page = notes.list(id, { offset, limit: 100, direction: 'asc' });
      noteList.push(...page.filter((n) => n.status === 'written'));
      if (page.length < 100) break;
    }
    return {
      notes: noteList,
      answers: answers.list(id),
      reviews: reviews.list(id),
      decisions: decisions.list(id, { offset: 0, limit: 100, direction: 'desc' }),
    };
  }
  function snapshot(run) {
    const { notes: written } = history(run.id);
    const times = clock.all(run.id),
      measured = times[0]?.first === 1;
    const active = run.steps.map(() => 0);
    let waitMs = 0;
    for (let i = 1; i < times.length; i++) {
      const prev = times[i - 1],
        duration = Date.parse(times[i].at) - Date.parse(prev.at);
      if (!Number.isSafeInteger(duration) || duration < 0)
        throw new Error('Invalid workflow clock for run ' + run.id);
      if (prev.status === 'running') active[prev.step] += duration;
      if (['needs_input', 'awaiting_approval'].includes(prev.status)) waitMs += duration;
    }
    const flags = new Set();
    const steps = run.steps.map((s, index) => {
      const name = run.definition.steps[index].name;
      const reports = written.filter((n) => n.stepIndex === index);
      for (const [j, n] of reports.entries()) {
        const found = classifyEvidence(name, n.summary + '\n' + n.content.slice(0, 1000));
        for (const f of found) {
          if (f === 'proofGap' && (run.status !== 'complete' || j !== reports.length - 1)) continue;
          if (f === 'cleanCommit' && !s.sessionId && !s.priorSessionIds.length) continue;
          flags.add(f);
        }
      }
      return {
        name,
        elapsedMs: s.elapsedMs,
        activeMs: measured ? active[index] : null,
        launches: new Set([...s.priorSessionIds, ...(s.sessionId ? [s.sessionId] : [])]).size,
        loops: s.roundsCompleted,
      };
    });
    const sum = (k) => steps.reduce((a, s) => a + s[k], 0);
    const repositories =
      run.taskId === null
        ? [run.homePath]
        : tasks
            .get(run.taskId)
            ?.worktrees.map((w) => w.repository)
            .sort();
    const workload = repositories?.length
      ? createHash('sha256')
          .update(JSON.stringify([repositories, run.definition.progressFile, /\.md$/i.test(run.input)]))
          .digest('hex')
      : null;
    return validateOutcome({
      workload,
      id: run.id,
      workflowId: run.workflowId,
      revision: run.definition.workflowRevision,
      name: run.definition.workflowName,
      project: run.project,
      status: run.status,
      at: run.finishedAt ?? run.updatedAt,
      createdAt: run.createdAt,
      flags: [...flags],
      steps,
      elapsedMs: sum('elapsedMs'),
      activeMs: measured ? sum('activeMs') : null,
      waitMs: measured ? waitMs : null,
      launches: sum('launches'),
      loops: sum('loops'),
      finalNote: written.some((n) => n.stepIndex === steps.length - 1),
    });
  }
  return {
    refresh: db.transaction(() => {
      db.prepare(
        `DELETE FROM improvement_outcomes WHERE id NOT IN (SELECT id FROM pipeline_runs WHERE status IN ('complete','error','stopped','interrupted'))`,
      ).run();
      const pending = changed.all();
      for (const { id } of pending) {
        const run = runs.get(id);
        if (run && statuses.includes(run.status)) save.run(id, run.updatedAt, JSON.stringify(snapshot(run)));
      }
      return pending.length;
    }),
    outcomes: () =>
      db
        .prepare('SELECT value FROM improvement_outcomes ORDER BY at,id')
        .all()
        .map((r) => validateOutcome(JSON.parse(r.value))),
    packet(id) {
      const run = runs.get(id);
      if (!run) throw Object.assign(new Error('Evidence run no longer exists'), { status: 404 });
      const h = history(id);
      // Include each step's latest report as well as early findings. Bound model context independently of storage.
      return {
        id,
        request: run.input.slice(0, 600),
        steps: run.definition.steps.map((s, i) => {
          const history = h.notes.filter((n) => n.stepIndex === i);
          const selected = history.length > 3 ? [history[0], ...history.slice(-2)] : history;
          return {
            name: s.name,
            prompt: s.prompt.slice(0, 500),
            notes: selected.map((n) => ({ id: n.id, summary: n.summary, excerpt: n.content.slice(0, 600) })),
          };
        }),
        ownerAnswers: h.answers
          .slice(-8)
          .map((a) => ({ step: a.stepName, question: a.questions, answer: a.answer.slice(0, 600) })),
        ownerReviews: h.reviews
          .slice(-8)
          .map((r) => ({ step: r.stepName, verdict: r.verdict, comment: r.comment })),
        agentDecisions: h.decisions
          .slice(0, 8)
          .map((d) => ({ step: d.stepName, answer: d.answer.slice(0, 400) })),
      };
    },
  };
}
