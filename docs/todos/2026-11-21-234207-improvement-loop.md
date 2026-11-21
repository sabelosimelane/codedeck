# Improvement Loop

**Spec**: `docs/specifications/2026-11-21-234207-improvement-loop-spec.md`
**Status**: In Progress
**Created**: 2026-11-21

Before Phase 1: `main` must have no uncommitted changes in the improvement files
(Spec §10, first assumption). A task starts from the last commit.

## Phase 1: Land the measured base
> Merge `feature/team-scoring` (`427fee9`) so that fixed criteria, the Verifier, interventions and replays are on `main`.
> **Inputs:** `main`, branch `feature/team-scoring`
> **Outputs:** one `main` with both lines of work, all suites green
> **Closed when:** full server suite, client build and the browser test pass on the merge

- [ ] Merge `feature/team-scoring` into the task's branch and resolve the 15 conflicted files (Spec §11.1 — the list and the three merge decisions)
- [ ] Keep five pairs: remove `TEAM_TRIAL_SIZE` and every use of a trial size of three (Spec §11.1 — `shared/scoring/team.mjs`, `team-trials.js`, their tests)
- [ ] Keep `main`'s two budget lanes and the `superseded` status in the merged `improvements.js`, `team-trials.js`, `shared/workflow-improvements.mjs`, `shared/team-score-responses.mjs` (Spec §11.1)
- [ ] Unit tests: the merged `team-scoring-engine`, `team-trials`, `team-replays`, `team-intent`, `verification`, `workflow-improvements` suites pass, single worker
- [ ] Integration test: `pipelines-api.test.js` and `pipeline-run-engine.test.js` pass with the merged `startRun` and `beforeStep`
- [ ] Run `client/e2e/team-improvements.mjs` against disposable data (Spec §9, first criterion — the branch's todo records it was never run)
- [ ] Run one verified run with a real Verifier agent on a disposable repository and record what its note contained (Spec §1.1 — nothing on the branch has run with live agents)

## Phase 2: Settled observations and signals
> A run is evidence once, when it is final, and its trouble is recorded as structured signals.
> **Inputs:** runs, reviews, step statuses, stop reasons, delivery verdicts
> **Outputs:** write-once outcome rows with `settledAt`, `signals`, `stepPrompts`
> **Closed when:** unit tests on the pure rules and the evidence integration tests pass

- [ ] Pure `isSettled(run, now, open)` and `signalsOf(run records)` (Spec §8.1, §8.2, §5.4 — six signal kinds; interrupted never settles)
- [ ] Unit tests: every status against the settled rule at the six-hour boundary; each signal kind present, absent and counted
- [ ] `improvement-evidence.js`: write an outcome when a run settles and never rewrite it; add `settledAt`, `signals`, `stepPrompts` (Spec §4.1, §8.1)
- [ ] `validateOutcome` checks every new field (Spec §4.1 — `shared/workflow-improvements.mjs`)
- [ ] `team-observations.js` reads settled runs only (Spec §8.1)
- [ ] `GET /outcomes` returns `settledAt` and `signals`; the run list on the Improvements screen shows the signals (Spec §6, §8.15)
- [ ] Integration test: a run that errors, is resumed within six hours and completes has one outcome, written at completion; a run sent back twice on Review carries `sentBack` for `Review` with count 2

## Phase 3: Replays from the baseline's own definition
> A team-role trial replays five past requests from the run's frozen definition with one agent changed, whatever was edited since.
> **Inputs:** settled observations, a pending team trial
> **Outputs:** five pairs (baseline run, replay run), void pairs replaced once, trial events in the ledger
> **Closed when:** unit tests on selection and patching, and the replay integration tests, pass

- [ ] Ledger store `server/pipelines/improvement-events.js`: append and list, every field validated on write and on read (Spec §4.6, §5.6)
- [ ] Pure `selectBaseline(observations, subject)` for `team_role` (Spec §8.5 — five most recent, different requests, champion matched in the run's own definition)
- [ ] Pure `patchDefinition(definition, subject)` for `team_role` (Spec §8.6 — only the role's team-assigned steps change)
- [ ] Unit tests: selection unchanged by edits to the workflow, the team and an unrelated agent; fewer than five when a profile differs; the patch changes nothing but the role's steps
- [ ] `startRun` option `replay: { trialId, sourceRunId }` and run creation from a copied definition (Spec §8.6 — `server/routes/pipelines.js`, `run-store.js`, `team-attribution.js`)
- [ ] Remove `reserve` from run start and group-against-group comparison as a trial verdict (Spec §8.6)
- [ ] `team-intent.js`: a replay takes its source run's criteria; no criteria call is made for it (Spec §8.6)
- [ ] Replay guidance in `step-guidance.js` (Spec §8.6 — no push, pull request, deploy, or change outside the task)
- [ ] `team-replays.js`: void pairs and one replacement per slot, column `replaced_source` (Spec §4.4, §8.7)
- [ ] `team-trials.js`: nomination grouped by team and role profile; superseding by champion only; `estimatedMs`; old-draft trials read as `superseded` (Spec §4.3, §8.5, §8.11)
- [ ] Ledger events for `trial_started`, `replay_started`, `replay_finished`, `replay_void`, `superseded`, `stopped`, `dismissed` (Spec §5.6)
- [ ] Trial card shows the agent-time estimate before Start (Spec §8.15)
- [ ] Integration test: start a trial, edit the workflow and delete an agent, and each replay still runs the source definition with the one change; a run the owner starts meanwhile has no `trialId`; an unexposed replay is replaced once and then stays void

## Phase 4: Pair verdict, version 3
> Two deliveries of one request are compared criterion by criterion, and one unverifiable criterion no longer decides a trial.
> **Inputs:** five pairs with shared criteria
> **Outputs:** verdict, reason, coverage, per-pair result
> **Closed when:** exhaustive unit tests on `compareReplays` and the trial API test pass

- [ ] `compareReplays` version 3 in `shared/scoring/team.mjs`: criteria one by one, the undecided rule, coverage, reasons; policy version 3 (Spec §8.8, §5.3)
- [ ] Unit tests: every row of the verdict table for both goals; coverage at 0.79, 0.8 and 1; an unverified criterion on either side; one-shot lost; a void pair; four of five and three of five pairs past the margin
- [ ] Unit test: seeded simulation of 10,000 speed trials of identical configurations with 20% variation gives `helped` in at most 8% (Spec §9)
- [ ] `team-observations.js` gives criteria by id to the pairs (Spec §8.8)
- [ ] `GET /trials`, `GET /trials/:id` with `pairs`, `comparison.reason`, `comparison.coverage`; validators in `shared/team-score-responses.mjs` (Spec §6, §7.2)
- [ ] Trial card: the pairs table, the verdict with its reason and coverage, and the sentence on what five pairs can show (Spec §8.15, §8.8)
- [ ] Integration test: the trial endpoints across happy path, invalid input, boundaries, empty and null values, hostile input and a repeated request (Spec §9)

## Phase 5: Safe hypotheses
> The reviewer proposes from recurring signals, reads whole prompts, and an unsafe replacement prompt is never stored.
> **Inputs:** settled outcomes with signals, the workflow's current step prompts, the ledger
> **Outputs:** pending workflow proposals with `goal` and `championHash`
> **Closed when:** unit tests on scheduling and the prompt check, and the reviewer integration tests, pass

- [ ] Pure `recurringSignals(outcomes, currentPrompts)` and the scheduling rule (Spec §8.2, §8.3 — grouped by workflow id; the loop trigger removed)
- [ ] Pure `checkStepPrompt(champion, challenger)` (Spec §8.4 — five checks)
- [ ] Unit tests: each scheduling condition; each prompt check at its boundary (19, 20, 8,192 and 8,193 characters; `{input}` present and absent; skill prefix kept, changed and dropped)
- [ ] Packet with whole step prompts, signals, current prompts and the last 20 ledger events (Spec §8.4 — `improvement-evidence.js`, `improvements.js`)
- [ ] Reviewer instructions and `validateDraft`: `goal` for workflow proposals, `championHash` set by the backend; migration of stored workflow drafts (Spec §4.2, §8.4)
- [ ] One repair call on a failed validation or prompt check; invalid findings dropped and counted (Spec §8.4)
- [ ] Runner proposals: result shown as `observed` from complete runs only; an approved runner proposal can be dismissed (Spec §8.12 — `shared/scoring/workflow.mjs`, `improvements.js`)
- [ ] Ledger events `proposed` and `dismissed` for proposals (Spec §5.6)
- [ ] Hypothesis card: both prompts in full with changed lines marked, signal, runs, goal (Spec §8.15 — `ImprovementProposal.jsx`)
- [ ] Integration test: a reviewer answer that drops `{input}` leads to one repair call and, when repeated, to a failed job with `invalid_output`; two runs that only looped on one step create no job; a workflow with a pending proposal gets no second job

## Phase 6: Workflow-step trials
> A prompt change is tested by the same replays and the same verdict as a team change, and reaches the workflow only through a trial.
> **Inputs:** a pending workflow proposal, settled observations
> **Outputs:** a `workflow_step` trial, its pairs, and on adoption one new workflow revision
> **Closed when:** unit tests on selection, patching and adoption rules, and the end-to-end trial test, pass

- [ ] `selectBaseline` and `patchDefinition` for `workflow_step` (Spec §8.5, §8.6 — the named step with the champion's hash; only its prompt changes)
- [ ] Unit tests: a run whose step prompt differs is not a baseline; a workflow with the step twice is refused; the patch leaves agents and other steps alone
- [ ] `team_trials.subject` and the `workflow_step` draft; proposal status `trialled` and `trial_id` (Spec §4.2, §4.3, §5.1)
- [ ] Decision `start` on a workflow proposal; `approve` on it returns 409 (Spec §6, §7.1)
- [ ] Adoption for `workflow_step`: one step's prompt, refused when its hash changed (Spec §8.9)
- [ ] Superseding of workflow proposals and trials by the step's prompt only (Spec §8.11)
- [ ] Trials of both subjects on the Improvements screen through one card; Start trial on the hypothesis with the count of comparable runs (Spec §8.15)
- [ ] Notice on a step under trial in `WorkflowEditor.jsx` and on a role under trial in `TeamList.jsx` (Spec §8.11)
- [ ] Replay line in the task view header (Spec §8.15 — `TaskView.jsx`)
- [ ] Integration test: with four qualifying runs Start returns 409 naming "4 of 5"; with five, the trial runs five replays whose only difference is the step's prompt; adoption creates one revision changing one step; adoption after the step was edited returns 409

## Phase 7: Watch, revert and history
> An adopted change is watched on the runs that follow, can be taken back, and every decision can be read.
> **Inputs:** adopted trials, settled runs after adoption, ledger events
> **Outputs:** watch state, `reverted` trials, the ledger endpoint
> **Closed when:** unit tests on the watch rule, and the adoption-to-revert integration test, pass

- [ ] Pure watch rule (Spec §8.10 — next five scored runs using the change; breached at two or more above the replays' count)
- [ ] Unit tests: breach exactly at the threshold; runs that do not use the change are not watched; a sixth run is not counted
- [ ] `adoption.previous`, decision `revert` for both subjects, status `reverted` (Spec §4.3, §8.10, §5.2)
- [ ] Ledger events `measured`, `adopted`, `watch_breached` (once), `reverted` (Spec §5.6)
- [ ] `GET /events` with filters and a stable order; `revert` on `/trials/:id/decision` and `/teams/trials/:id/decision` (Spec §6, §7.3, §7.4)
- [ ] History list, watch state and Revert on the Improvements screen (Spec §8.15)
- [ ] Integration test: adopt, three watched runs not delivered, one `watch_breached` event, revert restores the champion; revert after a further edit returns 409; the events endpoint across the six test dimensions and a page boundary

## Phase 8: Reviewer call accounting and loop health
> Every reviewer call ends with a recorded outcome, a call that was never made costs nothing, and an unchanged tick does no work.
> **Inputs:** reviewer calls of both lanes, the review model's circuit
> **Outputs:** call rows with duration and failure reason, lane pause, the loop health panel
> **Closed when:** unit tests on failure classification and the tick, and the accounting integration tests, pass

- [ ] Pure classification of a CLI failure into the five kinds (Spec §5.5, §8.13 — `server/cli-naming-client.js`)
- [ ] Unit tests: a rejected model, a missing command, a timeout, an invalid answer and any other failure each map to one kind
- [ ] `improvement_calls.error_kind`, `error_detail`, `duration_ms`; `improvement_model.paused_reason` (Spec §4.5)
- [ ] No claim, no call row and no attempt while the circuit is open or the lane is paused; a `config` failure pauses both lanes; saving the model clears the pause (Spec §8.13 — `improvements.js`, `server/index.js`)
- [ ] Retry waits of 3, 15 and 60 minutes; started calls interrupted at startup without using an attempt (Spec §8.13)
- [ ] Change token and observations computed once per tick (Spec §8.14 — `team-review-cycle.js`)
- [ ] `GET /status` with `lanes`; `GET /calls` with the new fields (Spec §6, §7.5)
- [ ] Loop health panel with Retry now (Spec §8.15)
- [ ] Integration test: ten ticks with the circuit open write no call row and use no attempt; a rejected model pauses both lanes and a saved model resumes them; a tick with no change and no due job makes only the change-token query

## Phase 9: Final Verification + Cleanup
> Local verification only.

- [ ] Run the full server suite with a single worker and the client suite (regression check)
- [ ] End-to-end on disposable data: a recurring signal, a hypothesis, a trial of five replays, a verdict, adoption, a watched run and a revert, for one workflow step and for one team role
- [ ] Run `client/e2e/team-improvements.mjs`, extended to a workflow-step trial
- [ ] Code review pass against the pre-commit checklists in `docs/guidelines/instructions.txt`
- [ ] Update `README.md` (new Improvements section), `docs/steering/api-standards.md`, `docs/steering/structure.md`, `docs/steering/product.md`, `shared/scoring/README.md`, `CHANGELOG.md`; point `docs/todos/team-scoring.md` to this todo (Spec §11.6)
