# Workflow Sharing and Updates

**Spec**: `docs/specifications/2026-11-24-150552-workflow-sharing-and-updates-spec.md`
**Status**: Not started
**Last completed**: none
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

- [ ] `shared/workflow-package.mjs`: `validatePackage` per Spec §3 (every field, unknown keys at every level, role on every node, all errors at once), `buildPackage(workflow)`, `packageFileName(name)` slug rule — unit tests first, including the boundary of each field
- [ ] `shared/workflow-changes.mjs`: `canonicalDefinition` and `definitionHash` per Spec §6.1 — unit tests: equal after trimming and flag defaults, different on any field
- [ ] `server/pipelines/workflow-store.js`: `source_kind`, `source_id`, `source_version`, `source_base`, `source_updated_at` columns and the partial unique index (Spec §4.1); written and hydrated with a guard per column; `source` in the record — store tests for each bad value failing loudly with row id and column
- [ ] `server/routes/pipelines.js`: GET `/workflows/:id/export` (Spec §7; 409 naming role-less steps); `source` in workflow responses (Spec §4.4, built-in fields null until Phase 2); refuse `source` in POST/PUT bodies (unchanged unknown-field rule)
- [ ] `server/routes/pipelines.js`: POST `/workflow-imports/previews` and POST `/workflow-imports` for modes `new` and `name-clash` → copy (Spec §5.6); `missingRoles` from the team store — API tests across the six dimensions (Spec §10 checks 1–4, 413 over 512 KiB, concurrent identical import → one 409)
- [ ] Client: `pipelinesApi.js` `exportWorkflow`, `previewImport`, `importWorkflow`; `pipelineRecords.js` parses `source`; `WorkflowList.jsx` **Import…** with the preview (new / copy with name); editor **Export** disabled with its reason (Spec §8) — component tests including failure toasts
- [ ] Check 2 by an agent: two CodeDeck databases on this machine (see memory note on worktree ports), export from one, import in the other, start a run with a team covering the roles

## Phase 2: Built-ins remember their version and update themselves when unchanged
> Built-ins become linked copies: an unchanged one takes a newer version on start, a new one is offered to installs that already have workflows.
> **Closed when:** Spec §10 checks 7, 8 (unchanged half), 9 and 10 (identical half) hold.

- [ ] `shared/workflow-templates.mjs`: `version: 1` on every template; `server/__tests__/fixtures/built-in-workflow-versions.json` and the test that fails on a changed definition without a version bump, or a bump without the fixture (Spec §4.3)
- [ ] Seed and **Add workflow** chooser create `builtin` workflows with version and base; a second one becomes a `local` copy with its toast (Spec §5.1); delete of a `builtin` writes a dismissal (Spec §4.2)
- [ ] One-time linking of saved workflows by name and kind, recorded in `pipeline_workflow_source_link` (Spec §5.4) — store tests with fixtures of today's saved Bug fix and Feature build, identical and edited
- [ ] On start, after the hand-written upgrades and the seed: unchanged `builtin` workflows take a higher shipped version, agents kept by step name, new steps by team role, logged; an invalid result is left and logged (Spec §5.2)
- [ ] `source.latestVersion`, `updateAvailable`, `updatedToVersionAt`, `shipped` in the API view (Spec §4.4, §5.5)
- [ ] GET `/builtin-workflows`, POST `…/additions`, POST `…/dismissals` (Spec §5.3, §7) — API tests including paging, sort tie, repeat dismissal 204, linked 409
- [ ] Client: new-built-in rows with **Add** / **Dismiss**; badges "Updated to version N" and "Built-in no longer shipped" — component tests
- [ ] Live: bump a built-in version in a dev database's worktree, restart the dev backend, see the unchanged workflow updated with its agents

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
