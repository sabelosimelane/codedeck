# Team scoring and measured improvements

**Status** Complete

**Last completed** Phase 3 — Owner dashboard

## Phase 1 — Measurement

- [x] Extract versioned metrics and preserve workflow verdicts.
- [x] Record effective team and attempt assignments.
- [x] Score deliveries against cited acceptance evidence and retain owner corrections.

## Phase 2 — Improvement trials

- [x] Nominate a single role change and freeze a bounded trial.
- [x] Apply the candidate in the normal launcher and gate adoption on the observed result.

## Phase 3 — Owner dashboard

- [x] Expose paginated scorecards, evidence, and trial decisions.
- [x] Verify the owner experience and trial lifecycle on disposable data.

### Session — 2026-11-20 (Phases 1–3)

The standalone policies live in `shared/scoring`. Run attribution, acceptance reviews, and measured adoption live in `server/pipelines/team-attribution.js`, `team-observations.js`, `team-delivery-evidence.js`, and `team-trials.js`. The owner dashboard is in `TeamImprovements.jsx`.

A review uses the delivery and its latest written evidence as its identity. Late verification triggers reassessment. Explicit owner corrections carry forward within the same delivery. Trials retain the original configuration and baseline, cap assignments at five, and check both candidate exposure and current revisions before adoption.

The targeted regression suite passed 768 server tests and 16 dashboard tests. The client build passed. Chromium exercised scorecards, corrections, history, five assignments, comparison, adoption, and isolation of a second team with disposable SQLite data. The launcher integration exercised five baseline launches, five candidate launches, restoration of the default, and the adopted assignment.

### Deviations

- Recommendations use deterministic comparisons and locally configured profiles. The shared reviewer budget goes toward judging acceptance evidence.
- A positive trial verdict requires verified acceptance evidence for every delivered run on both sides. Incomplete coverage yields an inconclusive result.
