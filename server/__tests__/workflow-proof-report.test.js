import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

it('compares five completed runs per workflow and cohort, with evidence and elapsed time separate from cost', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE pipeline_runs (id, workflow_id, definition, steps, created_at, finished_at, status);
      CREATE TABLE pipeline_run_notes (id, run_id, step_name, status, summary, content, attempt);
      CREATE TABLE pipeline_run_answers (id, run_id, step_name, questions, answer);
    `);
    const insert = db.prepare('INSERT INTO pipeline_runs VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [id, name] of [['9d3f050c-5c99-4417-9fa7-715b24b289d5', 'Bug fix'], ['fd4943d6-7be3-420d-8505-00c218c069d3', 'Troubleshoot']]) {
      for (const revision of [2, 3]) {
        for (let n = 1; n <= 7; n++) {
          const steps = [{ roundsCompleted: 1 }, { sessionId: revision === 2 ? 'Demo-1' : null }];
          const runId = [name, revision, n].join('/');
          insert.run(runId, id, JSON.stringify({ workflowName: name, workflowRevision: revision, steps: [{ name: name === 'Bug fix' ? 'Test' : 'Verify' }, { name: 'Commit' }] }),
            JSON.stringify(steps), `2026-11-19T00:0${n}:00Z`, `2026-11-19T00:0${n}:30Z`, n === 1 ? 'needs_input' : 'complete');
          db.prepare('INSERT INTO pipeline_run_notes VALUES (1, ?, ?, ?, ?, ?, 1)').run(runId, name === 'Bug fix' ? 'Test' : 'Verify', 'written', 'Regression: tag missing', '# Regression');
          db.prepare('INSERT INTO pipeline_run_answers VALUES (1, ?, ?, ?, ?)').run(runId, name === 'Bug fix' ? 'Test' : 'Verify', 'Phone pending', 'Defer paired phone');
        }
      }
    }
    const sql = readFileSync(new URL('../../docs/reports/workflow-proof.sql', import.meta.url), 'utf8');
    const results = db.prepare(sql).all();
    expect(results).toHaveLength(20);
    for (const row of results) {
      expect(row).toMatchObject({ elapsed_seconds: 30, token_cost: null, loop_backs: 1 });
      expect(row.verification_history).toContain('Regression: tag missing');
      expect(row.owner_evidence_decisions).toContain('Defer paired phone');
    }
    expect(results.filter(r => r.workflow === 'Bug fix' && r.cohort === 'after').map(r => r.run_id)).toEqual([2, 3, 4, 5, 6].map(n => 'Bug fix/3/' + n));
    expect(results.filter(r => r.workflow === 'Troubleshoot' && r.cohort === 'before').map(r => r.run_id)).toEqual([7, 6, 5, 4, 3].map(n => 'Troubleshoot/2/' + n));
  } finally {
    db.close();
  }
});
