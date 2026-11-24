# Workflow Sharing and Updates

**Spec**: `docs/specifications/2026-11-24-150552-workflow-sharing-and-updates-spec.md`
**Status**: In progress
**Last completed**: Phase 2 — Built-ins remember their version and update themselves when unchanged (Pass 11 repairs verified)
**Created**: 2026-11-24

> Working rules for every phase: strict TDD (red test first), Vitest with `--maxWorkers=1`, per-field
> guards on everything crossing an edge including rows read back from SQLite and every field of an
> imported file, no fallback logic, no silent error swallowing, toasts for every mutating client call.
> Read `docs/steering/api-standards.md` and `~/.claude/standards/api-design.md` before touching an endpoint.
> Server tests: `cd server && npx vitest run __tests__/<file> --maxWorkers=1`.
> Client tests: `cd client && npx vitest run <path> --maxWorkers=1`.

## Phase 1: Export a workflow and import it as a new one
> The smallest useful slice: a workflow leaves one install as a file and arrives on another, assigned by team role.
> **Closed when:** a workflow exported from one database imports into another as an `imported` workflow with the same definition, and a name clash can be imported as a copy.

- [x] `shared/workflow-package.mjs`: `validatePackage` per Spec §3 (every field, unknown keys at every level, role on every node, all errors at once), `buildPackage(workflow)`, `packageFileName(name)` slug rule — unit tests first, including the boundary of each field
- [x] `shared/workflow-changes.mjs`: `canonicalDefinition` and `definitionHash` per Spec §6.1 — unit tests: equal after trimming and flag defaults, different on any field
- [x] `server/pipelines/workflow-store.js`: `source_kind`, `source_id`, `source_version`, `source_base`, `source_updated_at` columns and the partial unique index (Spec §4.1); written and hydrated with a guard per column; `source` in the record — store tests for each bad value failing loudly with row id and column
- [x] `server/routes/pipelines.js`: GET `/workflows/:id/export` (Spec §7; 409 naming role-less steps); `source` in workflow responses (Spec §4.4, built-in fields null until Phase 2); refuse `source` in POST/PUT bodies (unchanged unknown-field rule)
- [x] `server/routes/pipelines.js`: POST `/workflow-imports/previews` and POST `/workflow-imports` for modes `new` and `name-clash` → copy (Spec §5.6); `missingRoles` from the team store — API tests across the six dimensions (Spec §10 checks 1–4, 413 over 512 KiB, concurrent identical import → one 409)
- [x] Client: `pipelinesApi.js` `exportWorkflow`, `previewImport`, `importWorkflow`; `pipelineRecords.js` parses `source`; `WorkflowList.jsx` **Import…** with the preview (new / copy with name); editor **Export** disabled with its reason (Spec §8) — component tests including failure toasts
- [x] Check 2 by an agent: two CodeDeck databases on this machine (see memory note on worktree ports), export from one, import in the other, start a run with a team covering the roles

## Phase 2: Built-ins remember their version and update themselves when unchanged
> Built-ins become linked copies: an unchanged one takes a newer version on start, a new one is offered to installs that already have workflows.
> **Closed when:** Spec §10 checks 7, 8 (unchanged half), 9 and 10 (identical half) hold.

- [x] `shared/workflow-templates.mjs`: `version: 1` on every template; `server/__tests__/fixtures/built-in-workflow-versions.json` and the test that fails on a changed definition without a version bump, or a bump without the fixture (Spec §4.3)
- [x] Seed and **Add workflow** chooser create `builtin` workflows with version and base; a second one becomes a `local` copy with its toast (Spec §5.1); delete of a `builtin` writes a dismissal (Spec §4.2)
- [x] One-time linking of saved workflows by name and kind, recorded in `pipeline_workflow_source_link` (Spec §5.4) — store tests with fixtures of today's saved Bug fix and Feature build, identical and edited
- [x] On start, after the hand-written upgrades and the seed: unchanged `builtin` workflows take a higher shipped version, agents kept by step name, new steps by team role, logged; an invalid result is left and logged (Spec §5.2)
- [x] `source.latestVersion`, `updateAvailable`, `updatedToVersionAt`, `shipped` in the API view (Spec §4.4, §5.5)
- [x] GET `/builtin-workflows`, POST `…/additions`, POST `…/dismissals` (Spec §5.3, §7) — API tests including paging, sort tie, repeat dismissal 204, linked 409
- [x] Client: new-built-in rows with **Add** / **Dismiss**; badges "Updated to version N" and "Built-in no longer shipped" — component tests
- [x] Live: bump a built-in version in a dev database's worktree, restart the dev backend, see the unchanged workflow updated with its agents

## Phase 3: Update available — take or leave each change
> The three-way comparison, for an edited built-in and for a re-imported file.
> **Closed when:** Spec §10 checks 5, 6, 8 (edited half), 10 (edited half) and 11 hold.

- [ ] `shared/workflow-changes.mjs`: `compareDefinitions({ base, mine, theirs })` and `applyChanges({ mine, theirs, take })` per Spec §6.2 — pure tests for every change id, conflicts with known and unknown base, owner-only edits not listed, added/removed steps, order, agents kept, invalid merge refused
- [ ] GET and POST `/workflows/:id/source-update` (Spec §7) — API tests: revision conflict, wrong `toVersion`, unknown change id, invalid merge 409 with field errors and nothing written, nothing taken still records the version
- [ ] Import preview and apply for modes `update`, `up-to-date`, `replace`, and refusal of an older or same-version different file (Spec §5.6) — API tests
- [ ] Client: the update screen (Spec §6.3) used for built-in updates, **Compare with built-in** and import previews; badge "Update available — version N" — component tests including the 409 reload
- [ ] Live: export, edit on the source database, re-import on the target with and without target edits; the target's agents and edits stay
- [ ] Full server and client suites, one at a time; README (Workflow pipelines: sharing and updates) and `docs/steering/api-standards.md` rows for the new endpoints

## Owner checks
- Export **Bug fix** on this Mac, import it on the second host, edit a prompt here, export and import again: the second import lists only that prompt. An agent verifies the same flow between two databases on this machine.

## Session Notes

### 2026-11-24 — Develop pass, Phase 1 built (iteration dc9514bd-1)

Phase 1 is fully ticked. Every acceptance check has a red-then-green test; the full
suite is left to Test. New files: `shared/workflow-package.mjs`,
`shared/workflow-changes.mjs` (canonical + hash only; `compareDefinitions`/`applyChanges`
arrive in Phase 3), `server/__tests__/workflow-package.test.js` (11),
`workflow-changes.test.js` (7), `workflow-source.test.js` (6),
`workflow-sharing.test.js` (8), `client/src/utils/__tests__/workflowSharingApi.test.js`
(7), `client/src/components/pipelines/__tests__/WorkflowSharing.test.jsx` (8).

What the next round needs to know:

- Staging decisions (all in the Spec's Phase 3 scope, not shortcuts): preview
  classifies `update`/`up-to-date`/older-file-409 fully, but apply of `update`/`replace`
  answers 409 "not offered in this release" and writes nothing; an `update` preview
  carries `changes: []` until `compareDefinitions` exists. `suggestedName` truncates the
  stem to fit 64 chars. `isUuid` (versions 1–5) is used for package `source.id`,
  consistent with the codebase, where the Spec says v4.
- `source_updated_at` is cleared on every PUT (Spec §5.1), already in Phase 1.
- Fixture updates that follow the new contract (not weakened tests): seed test strips
  `source` from the body check; `PipelineSettings`/`RunWorkflowDialog`/`WorkflowsScreen`
  fixtures and the settings fake backend now serve `source`; template helper has none.
- Pre-existing failure, verified on the untouched base via `git stash -u`:
  `PipelineSettings.test.jsx` "offers blank and templates…" expects the Bug fix
  template's Test step at max 3; the template ships 8. The two neighbouring
  "adds a workflow…" failures seen mid-pass were my own regression (the settings fake
  backend answered saves without `source`), fixed by serving `source` from it.
  Everything else in the touched areas is green, including `pipelines-api.test.js`
  (342), `WorkflowsScreen` (12/12), `RunWorkflowDialog` (48/48) and `PipelineSettings`
  (92/93).
- Live check (task 7) passed end to end and the probe is kept at
  `/tmp/wf-live-check.mjs` (18 assertions: export file + slug header + no `agentId`,
  preview new + missing role, import 201 + `imported` source, team run started with the
  step assigned by team role). Scratch homes/repos were `/tmp/wf-{a,b}-home`,
  `/private/tmp/wf-repo-{a,b}` — note macOS `/tmp` is a symlink, so run `worktreePath`
  must use `/private/tmp`. Scratch backends (PIDs 73551/73586) were stopped with
  `run --stop`; scratch tmux session `wf-proj-b-*` and the `/tmp/wf-*` dirs may remain.
- Incident during the live check: a broad `kill` for scratch servers matched and killed
  the owner's live backend on 43001. Recovered with `./server.sh restart` from the home
  checkout; the home stack (backend + frontend) is healthy again (health `ok`, a real
  client connected), but `server.sh status` says "not running" because its launcher
  bookkeeping is stale — the owner's next `restart` reconciles it; `start` alone will
  refuse while the ports are held. Never kill by name match again: stop only PIDs from
  `run` output.
- Left for Review/Test: Phase 2 and 3 tasks are untouched; no commit was made (files
  listed in `git status` are the whole change).

### Feature test — 2026-11-24 — Phase 1 needs fixes (iteration 4d3477c0-1)

The export endpoint and live two-database import and team run check held. Reopened
the five Phase 1 tasks covering package validation, canonical equality, store guards,
import request validation, and the import preview. Chrome downloaded the file,
imported it on the second install and started the workflow with the selected team.
An overlong isolated tmux socket interrupted the first terminal launch. After
shortening the socket path, the run resumed and launched the team's test agent.
Details and repair checks are in `.codedeck/runs/7c333c09/03-test.md`.

### Develop repair — 2026-11-24 — Phase 1 fixes green (iteration 62515238-2)

All eight Test repair checks have a red-then-green test; the five reopened Phase 1
tasks are ticked again. Strict v4 UUIDs for package `source.id` and imported
`source_id` (new `isUuidV4` in `shared/workflow-package.mjs`, local regex in
`workflow-store.js`; the shared `isUuid` still accepts v1–v5 elsewhere).
`validatePackage` also rejects `workflow.revision` and impossible calendar dates
(Feb 30 fails the UTC round-trip). `canonicalDefinition` trims the workflow name
and description like the stored values. `prepareSourceForWrite` mirrors every
hydrate guard — a refused write throws before the insert, leaving zero rows.
Malformed import targets (`{}`, unknown modes) are 400 with a `target.mode`
error; `replace`/`update` stay 409 until Phase 3. Refusals log once as
`request refused … route=<METHOD> <path> fields=<names>` with no values.
`WorkflowList` checks the copy name against the workflow list as typed
(`aria-invalid` + disabled apply + inline alert) and shows
`File exported 24 Nov 2026 · version N`. `previewImport` validates the preview
workflow as a definition (fields + role per node) and requires UUID workflowIds.

What the next round needs to know:

- Targeted suites only: server `workflow-package/changes/source/sharing`,
  `pipeline-workflow-seed`, `pipelines-api` (397 passed); client
  `WorkflowSharing`, `workflowSharingApi`, `pipelineRecords` (203 passed) plus
  `WorkflowsScreen`/`RunWorkflowDialog` (72 with sharing). The full suites belong
  to Test. No live browser re-check was run; the preview UI changes (copy clash,
  export date) are covered by component tests only.

### Develop repair — 2026-11-24 — Phase 1 second fixes green (iteration fd95bd72-3)

All four Test repair checks (`.codedeck/runs/7c333c09/03-test.md`) have a
red-then-green test; the three reopened Phase 1 tasks are ticked again.

- `shared/workflow-changes.mjs`: `canonicalDefinition` normalises an omitted
  `kind` to `'other'` and a missing/non-string `description` to `''` — the
  stored defaults — so an accepted package hashes like its stored form. Tests:
  `canonicalDefinition` equality and `definitionHash` equality for omitted
  fields (`server/__tests__/workflow-changes.test.js`, both confirmed red).
- `server/pipelines/workflow-store.js`: `requireIso` now checks the calendar
  components form a real date (leap-aware month lengths, hour ≤ 23, min/sec ≤
  59), so `2026-02-30T13:05:52.000Z` is refused on write (before the insert —
  row count stays 0) and on hydration, both naming `source_updated_at` with the
  row id. Applies to every ISO column (`created_at`, `updated_at` too). Test:
  one new case in `server/__tests__/workflow-source.test.js` (confirmed red).
- `client/src/utils/pipelinesApi.js`: `previewImport` rejects a nonempty
  `changes` on a `new` target, non-object change entries, and blank
  `missingRoles` entries (whitespace-only included). `importWorkflow` validates
  the receipt per Spec §7–8: UUID `id`, `source` with agreeing kind/id/version
  (`local` nulls, `builtin` slug + int, `imported` v4 + int), and nodes that
  are non-null objects with a non-empty role. Tests: two new cases in
  `client/src/utils/__tests__/workflowSharingApi.test.js` (both confirmed
  red); the exact Test payloads (`changes [null]` + `missingRoles [""]`,
  `{"id":"bad","source":{"kind":"unexpected"},"nodes":[null]}`) are rejected.

What the next round needs to know:

- Targeted suites only: server `workflow-package/changes/source/sharing`,
  `pipeline-workflow-seed`, `pipelines-api` (401 passed); client
  `WorkflowSharing`, `workflowSharingApi`, `pipelineRecords`,
  `WorkflowsScreen`, `RunWorkflowDialog` (266 passed). The full suites belong
  to Test. No live browser re-check was run.
- A throwaway probe replicated all eight Test assertions end to end (8 PASS);
  it ran from `server/` for `better-sqlite3` resolution and was deleted
  afterwards. `/tmp/wf-pass3-probe.mjs` remains but was not the executed copy.
- `agentsDecide` is intentionally not defaulted in `canonicalDefinition`: the
  validator requires it, so only `kind`/`description` needed storage defaults.
- No commit was made; `git status` lists the whole change.
- Phases 2 and 3 are untouched.
- The direct probe now prints `canonical whitespace equality: true`, package
  fields `source.id,exportedAt,workflow.revision` for the triple-bad file,
  `local+base refused: true` and `rows after refused write: 0`.
- No commit was made; `git status` lists the whole change.
- Phases 2 and 3 are untouched.

### Develop repair — 2026-11-24 — Phase 1 client receipt and preview guards (iteration 9268a511-1)

All three outstanding Phase 1 Test checks
(`.codedeck/runs/7c333c09/03-test.md` REPAIR 3) have a red-then-green test;
the Client task is ticked. Only `client/src/utils/pipelinesApi.js` and its
test changed in this pass.

- `previewImport`: `isPreviewChanges` now requires an empty array for every
  staged mode, not just `new` — the server always answers `changes: []`
  until Phase 3 implements the §6.2 shape, so a name-clash preview with
  `changes: [{}]` is rejected. Regression covers `name-clash`, `update`
  and `up-to-date` carrying `[{}]`.
- `importWorkflow`: the receipt is now checked as a persisted record, not a
  write body — `description` (string, ≤280, single line), `kind` (a shipped
  kind), `progressFile` (null or text), and per node `agentId` (UUID, or
  null with a role), boolean `readOnly`/`approval`/`askOwner`,
  `enabled` when present. `WorkflowList` parses the same receipt with
  `parseWorkflow`, which requires these fields. One rejection case per
  omitted field (`description`, `kind`, `progressFile`, `readOnly`,
  `approval`, `askOwner`, `agentId`).
- Receipt timestamps (`createdAt`, `updatedAt`, nullable
  `source.updatedToVersionAt`): `isImportTimestamp` now verifies the
  calendar components form a real date (leap-aware month lengths, hour ≤
  23, min/sec ≤ 59), mirroring the server's `requireIso` — `Date.parse`
  rolls Feb 30 over to Mar 2. `2026-02-30T13:05:52.000Z` is rejected in all
  three fields; a real `updatedToVersionAt` (`2026-02-28`) still resolves.

What the next round needs to know:

- Targeted suites only: `workflowSharingApi` (16), `pipelineRecords`
  (182), `WorkflowSharing` (12), `WorkflowsScreen` and `RunWorkflowDialog`
  (60) — 270 passed. The full suites belong to Test. No live browser
  re-check was run; the guards are covered by API-level tests.
- Phase 1 is now fully ticked; Phases 2 and 3 are untouched and Phase 1's
  `Check 2` live-import evidence stands from the earlier pass.
- Known adjacent gap, out of this pass's named scope: `pipelineRecords.js`
  `isTimestamp` (used by `parseWorkflow`/`parseSource`) still accepts
  impossible calendar dates via `Date.parse`. Harmless today because
  `importWorkflow` rejects them first, but worth aligning when the
  comparison/preview work lands.
- No commit was made; `git status` lists the whole change.


### Feature test — 2026-11-24 — Phase 1 needs fixes (iteration 481419e1-2)

The repaired package and import-target validation held against the running worktree.
Chrome verified the export date in both preview modes, disabled copy import for a
case-insensitive name clash, and accepted a free copy name. The v4 and local-source
store repairs also held. Three tasks are open for newly reproduced gaps: a valid
definition with omitted optional fields hashes differently from its stored form, an
impossible source update timestamp passes SQLite write and read validation, and the
client accepts malformed preview and import response fields. The buildable repair
checks and command results are in `.codedeck/runs/7c333c09/03-test.md`. Phases 2
and 3 still have unticked tasks. Full suites were deferred.

### Feature test — 2026-11-24 — Phase 1 needs fixes (iteration 461d7284-1)

Chrome imported a package with omitted optional definition fields. The same file
previewed as up to date, and its hash matched the stored workflow. SQLite
rejected the impossible source timestamp on write and read. Reopened the Phase 1
client task after observing a name-clash preview with `changes: [{}]` and import
receipts missing `description` or `nodes[0].readOnly` or carrying February 30 in
`createdAt` resolve successfully. The exact probes and outstanding work are in
`.codedeck/runs/7c333c09/03-test.md`.

### Feature test — 2026-11-24 — Phase 1 needs fixes (iteration f8ba9c75-2)

The previous preview, required-field and calendar-date failures now reject.
Chrome showed the error toast for a malformed preview and a malformed import
receipt, then successfully imported a copy with the real API response. The
copy was stored as imported with a null agent assignment. Reopened the client
task because the receipt guard still accepts a local source or an explicit
step agent in a new import response. The test evidence and remaining checks
are in `.codedeck/runs/7c333c09/03-test.md`. Phases 2 and 3 are still open,
so the full suites were deferred.

### Develop repair — 2026-11-24 — Phase 1 new-import receipt invariants (iteration ffdbea56-2)

The REPAIR 4 `phase-1-new-import-receipt-invariants` check has a red-then-green
test; the Phase 1 Client task is ticked again. Only `client/src/utils/pipelinesApi.js`
and its two test files changed in this pass.

- `importWorkflow` is now mode-aware: when `target.mode === 'new'` the 201
  receipt must be a linked copy per Spec §5.6 — `source.kind === 'imported'`
  with `source.id`/`source.version` equal to the sent package's, and every
  node `agentId === null` (assigned by team role on this install). Other
  modes keep the existing generic receipt checks, so Phase 3 update/replace
  work is unaffected.
- New tests in `client/src/utils/__tests__/workflowSharingApi.test.js`: one
  rejects a `local` source and mismatched `imported` id/version; one rejects
  a non-null UUID in `nodes[0].agentId`. Both confirmed red (2 failed, 16
  passed) before the fix, green after (18 passed). The passing real-receipt
  path is retained.
- Two `WorkflowSharing.test.jsx` fixtures mocked receipts the server never
  sends (an assigned `agentId`, and a `local` source on the copy import —
  the chooser's copy also sends `{ mode: 'new', name }` and the server always
  answers `imported` with null agents). They now serve the contract-shaped
  receipts; this aligns the mocks with `server/routes/pipelines.js`
  (POST `/workflow-imports` creates `{ kind: 'imported', id, version }`
  with `agentId: null` nodes), not a weakening.

What the next round needs to know:

- Targeted suites only: `workflowSharingApi`, `pipelineRecords`,
  `WorkflowSharing`, `WorkflowsScreen`, `RunWorkflowDialog` — 272 passed.
  The full suites belong to Test. No live browser re-check was run; the
  guards are covered by API-level tests.
- Phase 1 is fully ticked; Phases 2 and 3 are untouched. Phase 1's live
  two-database import evidence stands from the earlier pass.
- No commit was made; `git status` lists the whole change.

### Feature test — 2026-11-24 — Phase 1 fully tested (iteration f35aca5a-3)

The new-import receipt checks passed against a live HTTP 201 receipt and rejected
a local source, the wrong source ID or version, an explicitly assigned agent
and a receipt for a package missing its source. Chrome showed an error and let
the user retry after receiving a copy receipt with an explicit agent. The real
retry closed the dialog and showed the imported badge. SQLite confirmed one copy
at revision 1, linked to the package with the Developer role and a null agent.
The Phase 1 tasks remain ticked. Phases 2 and 3 are open, so the full suites and
the second-host check remain pending. See `.codedeck/runs/7c333c09/03-test.md`.

### Develop pass — 2026-11-24 — Phase 2 built and live-verified (iteration f4aacf7e-3)

All eight Phase 2 tasks are ticked. Phase 2 code and targeted tests were already
in the working tree from the preceding interrupted pass; this pass verified the
targeted server and client suites, ran the live restart check against an isolated
backend on port 43134, and caught and fixed a bug in `applyBuiltinUpdates`
(`server/pipelines/workflow-store.js`):

- `applyBuiltinUpdates` previously updated only `nodes` and not `description`,
  `kind`, `agents_decide`, or `progress_file`, which left the workflow's top-level
  fields out of sync with the new `source_base` on a built-in bump. Added a
  failing assertion in `server/__tests__/workflow-builtin.test.js` (confirmed red),
  updated the `UPDATE pipeline_workflows` statement in `applyBuiltinUpdates`, and
  confirmed green (16/16 across `built-in-workflow-versions`, `workflow-builtin`,
  `workflow-builtin-routes`).
- Live restart check (port 43134, isolated `HOME`): seeded DB, created an agent
  and assigned it to `Quick change`'s `Develop` step (`rev: 2`), stopped backend,
  temporarily bumped `quick-change` to `version: 2` with a `(v2)` description,
  restarted backend (`[workflows] Quick change updated to built-in version 2`),
  and verified `rev: 3`, updated `(v2)` description, `source.version: 2`,
  `source.updatedToVersionAt` set, and `Develop`'s `agentId` preserved; then
  stopped backend, reverted `shared/workflow-templates.mjs`, and removed the
  scratch directory.

What the next round needs to know:

- Targeted suites only: server `built-in-workflow-versions`, `workflow-builtin`,
  `workflow-builtin-routes` (16 passed), plus earlier in this pass `pipelines-api`,
  `workflow-sharing`, `pipeline-workflow-seed`, `workflow-source` (375 passed);
  client `WorkflowBuiltins`, `workflowBuiltinApi` (14 passed) and
  `WorkflowsScreen`, `WorkflowSharing`, `pipelineRecords`, `workflowSharingApi`
  (224 passed). Full suites belong to Test.
- Phase 3 tasks remain unticked. No `git commit` was run.


### 2026-11-24 — Develop pass, Phase 2 verified and ticked (iteration cbc25059-2)

Phase 2 is fully ticked. All Phase 2 code and targeted tests were present in the
worktree, verified passing, and the live restart check (task 8) was executed against an
isolated backend on port `43141` (`HOME=.codedeck/runs/7c333c09/01-live-p2`).

What the next round needs to know:

- Targeted suites only:
  - Server: `built-in-workflow-versions.test.js` (2), `workflow-builtin.test.js` (7),
    `workflow-builtin-routes.test.js` (7), `pipeline-workflow-seed.test.js` (11) — 27
    passed; plus `pipelines-api.test.js` (342), `workflow-sharing.test.js` (13),
    `workflow-source.test.js` (9) — 364 passed.
  - Client: `WorkflowBuiltins.test.jsx` (5), `workflowBuiltinApi.test.js` (9) — 14
    passed; plus `WorkflowsScreen.test.jsx` (12), `WorkflowSharing.test.jsx` (12),
    `pipelineRecords.test.js` (182) — 206 passed.
  - Full server and client suites are left to Test.
- Live restart check (task 8): seeded `Bug fix` at version 1 (`revision: 1`), assigned a
  saved agent (`601b5281-c0d6-427d-ab48-aae8a55be9ab`) to `Develop` (`revision: 2`),
  temporarily bumped `bug-fix` to `version: 2` in `shared/workflow-templates.mjs` and
  restarted the isolated backend. Observed log `[workflows] Bug fix updated to built-in
  version 2`, `revision: 3`, `source.version: 2`, `source.updatedToVersionAt` set, and
  `Develop.agentId` preserved. Reverted `shared/workflow-templates.mjs` and removed the
  scratch `HOME` directory afterwards.
- Left for Review/Test: Phase 3 tasks remain unticked; all changes remain uncommitted
  (no `git commit` run).

### Feature test — 2026-11-24 — Phase 2 needs fixes (iteration 4d6edbc4-4)

Chrome verified new built-in offers, Add, Dismiss, the linked-template copy
and toast, deletion, and the updated and retired badges. The dismissals survived
an isolated backend restart. The version fixture failed when a prompt changed
without a version bump and when a version changed without a fixture update.

Reopened five tasks. A startup update recorded version 2 but omitted
`enabled: false` from both the saved step and its base. SQLite hydration
accepted invalid `linked_at` and `dismissed_at` values. The client accepted
contradictory built-in source fields, an impossible update date, a list id
above 64 characters, and an HTTP 200 JSON reply for dismissal. Prior evidence
for agents surviving a live version bump still applies to that scenario.
Details and repair checks are in `.codedeck/runs/7c333c09/03-test.md`.

### Develop repair — 2026-11-24 — Phase 2 Test repairs green (iteration b0d3bb6d-4)

All five reopened Phase 2 Test checks (`.codedeck/runs/7c333c09/03-test.md` REPAIR 6)
have a red-then-green test; all eight Phase 2 tasks are ticked again.

- `phase-2-migrate-marker-date` (`server/pipelines/workflow-store.js`): extracted
  `isIsoTimestamp` (regex + leap-aware calendar check) and enforced it in
  `linkBuiltinSources` on both read (`SELECT linked_at`) and write (`now()` before
  inserting), throwing `pipeline_workflow_source_link row 1 field linked_at: must be an ISO-8601 timestamp`.
- `phase-2-startup-preserve-enabled` (`server/pipelines/workflow-store.js`):
  `builtinTemplateDefinition` now preserves `enabled` on each mapped node when defined,
  so `validateWorkflowBody` validates it and `normalizeNodes` / `source_base` preserve
  `enabled: false` on startup updates while invalid `enabled` values are refused and logged.
- `phase-2-dismissal-row-guards` (`server/pipelines/workflow-store.js`): added
  `requireTemplateId` / `requireDismissedAt` / `writeDismissal` guarding
  `pipeline_builtin_dismissals` on hydration (`builtinDismissals()`) and writes
  (`dismissBuiltinTemplate`, `remove`), naming row and column (`template_id`, `dismissed_at`).
- `phase-2-client-source-view` (`client/src/utils/pipelineRecords.js`, `pipelinesApi.js`):
  `parseWorkflow`/`parseSource` and `isImportSource` now enforce Spec §4.4 relationships
  (`shipped: false` requires `latestVersion: null` and `updateAvailable: false`;
  `shipped: true` requires integer `latestVersion >= 1` and `updateAvailable === (latestVersion > version)`)
  and share `isImportTimestamp` with leap-aware calendar validation for `updatedToVersionAt`.
- `phase-2-client-builtin-response` (`client/src/utils/pipelinesApi.js`):
  `isBuiltinRow` now enforces `id.length <= 64`, and `dismissBuiltinWorkflow` passes
  `expectedStatus: 204` to `request` so HTTP 200 JSON is refused while HTTP 204 resolves `{}`.
  Updated `WorkflowBuiltins.test.jsx`'s dismissal mock from default 200 to 204.

What the next round needs to know:

- Targeted regressions: server 7 files / 394 passed (`built-in-workflow-versions`,
  `workflow-builtin`, `workflow-builtin-routes`, `pipeline-workflow-seed`,
  `workflow-source`, `workflow-sharing`, `pipelines-api`); client 6 files / 287 passed
  (`pipelineRecords`, `workflowBuiltinApi`, `workflowSharingApi`, `WorkflowBuiltins`,
  `WorkflowSharing`, `RunWorkflowDialog`). Full suites belong to Test.
- Phase 3 tasks remain unticked; all changes remain uncommitted (no `git commit` run).

### Feature test — 2026-11-24 — Phase 2 startup write needs a guard (iteration 9700661a-5)

The Phase 2 repair checks passed. A live version bump of Bug fix retained its
assigned Analyse agent and saved the disabled step in both the workflow and its
base. Chrome showed the version 2 badge, rejected an unexpected HTTP 200 from
Dismiss, then removed the offer on the real 204. Reopened the startup task
because an impossible update timestamp is written to SQLite, logged as a
success and then refused on hydration. Phase 3 is still open. See
`.codedeck/runs/7c333c09/03-test.md` for the reproduction and remaining checks.

### Develop repair — 2026-11-24 — Phase 2 startup update timestamp guard (iteration dff750d0-5)

Addressed the `phase-2-startup-update-timestamp` Test repair check
(`.codedeck/runs/7c333c09/03-test.md` REPAIR 7) using red-then-green TDD, and
re-ticked the Phase 2 startup task.

- `server/pipelines/workflow-store.js`: `applyBuiltinUpdates` now validates
  `clock()` with `requireIso(workflow.id, 'updated_at', clock())` inside the
  per-row `try/catch` before running the `UPDATE pipeline_workflows` statement.
  An impossible date (`2026-02-30T00:00:00.000Z`) or invalid timestamp throws
  `pipeline_workflows row <id> field updated_at: must be an ISO-8601 timestamp`,
  leaves the original row untouched and readable (`revision` and `source.version`
  unchanged), and logs `[workflows] <id>: built-in update refused: ...`.
- `server/__tests__/workflow-builtin.test.js`: added a regression test in
  `startup update to a newer built-in` with `now: () => '2026-02-30T00:00:00.000Z'`
  (confirmed red before the fix, green after).

What the next round needs to know:

- Targeted regressions: 5 server files / 40 passed (`workflow-builtin`,
  `workflow-builtin-routes`, `built-in-workflow-versions`,
  `pipeline-workflow-seed`, `workflow-source`) with `--maxWorkers=1`. Full
  suites belong to Test.
- Phase 3 tasks remain unticked; all changes remain uncommitted (no `git commit` run).

### Feature test — 2026-11-24 — Phase 2 fully tested (iteration eac6190c-6)

The startup timestamp repair passed an independent SQLite probe. An impossible
timestamp left the entire Bug fix row unchanged and readable at revision 1,
logged the workflow ID and `updated_at`, and allowed Quick change to advance
to version 2 with matching timestamps. The isolated backend booted and the
workflow list returned the original Bug fix after restart. Phase 2 remains
ticked. The six Phase 3 tasks and final suites remain open. See
`.codedeck/runs/7c333c09/03-test.md`.
