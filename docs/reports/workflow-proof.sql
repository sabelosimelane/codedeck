-- Run from the CodeDeck checkout:
-- sqlite3 -readonly -json ~/.codedeck.db < docs/reports/workflow-proof.sql
-- The last five completions on revision 2 and first five completions on revision 3 or later,
-- per saved workflow. A run still waiting for evidence has not entered the completed cohort.
-- Read Commit's note to distinguish a historical no-op launch from an agent that committed.
-- Session IDs include reused terminals. The local ledger does not record billed token costs.
WITH completed AS (
  SELECT r.*,
    json_extract(definition, '$.workflowName') AS workflow,
    CASE WHEN json_extract(definition, '$.workflowRevision') = 2 THEN 'before' ELSE 'after' END AS cohort
  FROM pipeline_runs r
  WHERE status = 'complete'
    AND workflow_id IN ('9d3f050c-5c99-4417-9fa7-715b24b289d5', 'fd4943d6-7be3-420d-8505-00c218c069d3')
    AND json_extract(definition, '$.workflowRevision') >= 2
), ranked AS (
  SELECT *, row_number() OVER (
    PARTITION BY workflow_id, cohort
    ORDER BY CASE WHEN cohort = 'before' THEN finished_at END DESC,
             CASE WHEN cohort = 'after' THEN finished_at END ASC, id
  ) AS sample
  FROM completed
)
SELECT cohort, sample, workflow, id AS run_id,
  CAST(round((julianday(finished_at) - julianday(created_at)) * 86400) AS INTEGER) AS elapsed_seconds,
  NULL AS token_cost,
  json_extract(steps, '$[#-1].sessionId') AS commit_terminal,
  json_extract(definition, '$.steps[#-1].inspectCleanCommit') IS 1 AS inspection_enabled,
  (SELECT summary FROM pipeline_run_notes n WHERE n.run_id = r.id AND step_name = 'Commit'
     AND status = 'written' ORDER BY n.id DESC LIMIT 1) AS commit_headline,
  (SELECT sum(json_extract(state.value, '$.roundsCompleted'))
     FROM json_each(r.steps) state JOIN json_each(r.definition, '$.steps') def ON def.key = state.key
     WHERE json_extract(def.value, '$.name') IN ('Test', 'Verify')) AS loop_backs,
  (SELECT group_concat(summary, char(10) ORDER BY n.id) FROM pipeline_run_notes n
     WHERE n.run_id = r.id AND n.step_name IN ('Test', 'Verify') AND n.status = 'written') AS verification_history,
  (SELECT group_concat(coalesce(questions, '') || char(10) || answer, char(10) ORDER BY a.id)
     FROM pipeline_run_answers a WHERE a.run_id = r.id AND a.step_name IN ('Test', 'Verify')) AS owner_evidence_decisions,
  (SELECT content FROM pipeline_run_notes n WHERE n.run_id = r.id AND n.step_name IN ('Test', 'Verify')
     AND n.status = 'written' ORDER BY n.id DESC LIMIT 1) AS final_verification
FROM ranked r
WHERE sample <= 5
ORDER BY workflow, cohort, sample;
