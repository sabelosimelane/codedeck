# Workflow Sharing and Updates — Feature Specification

**Version:** 1.0
**Date:** 2026-11-24
**Status:** Draft

## 1. Overview

A saved workflow is a copy that does not remember where it came from. A built-in workflow is saved once, on the first start with an empty list, and from then on reaches an install only through hand-written upgrades that look for an exact old prompt (`STOCK_PROMPT_UPGRADES` and `phasedBugFix` in `server/pipelines/workflow-store.js`). A workflow the owner builds cannot leave the machine at all.

This feature makes a workflow a **linked copy**: it remembers its source (a built-in, or an imported file) and the version it last took from it.

1. **Export and import.** The owner exports a workflow to a file and imports that file on another install, or gives it to someone else to import. Agents are not in the file: every step travels with its role and is assigned by team role on the install that imports it.
2. **Updates.** When a workflow's source has a newer version, an unchanged workflow takes it by itself and a changed one offers **Update available**: what changed, step by step, each change taken or left by the owner. The owner's agents stay. A built-in that is new to an install is offered to it instead of never arriving.

Workflows stay copies: a run keeps the snapshot of the workflow it started with, an update never changes a run in progress, and nothing changes a workflow behind the owner's back once they have edited it.

It extends [Workflow Pipelines](2026-11-13-134947-workflow-pipelines-spec.md).

### Out of scope

- Owner-saved templates (`pipeline_workflow_templates`) and saved steps (`pipeline_step_presets`): neither is exported, imported or linked.
- Following a file in a repository or at a URL (workflows that update when a repository changes). The package format in §3 is the format such a feature would read.
- Sending a workflow to a remote host from **Settings → Hosts**.
- Removing the existing hand-written upgrades. They stay and run first on start (§5.4); no new one is written after this feature.
- Teams, agents and roles: an import creates none of them.

## 2. Terms

| Term | Meaning |
|---|---|
| Definition | A workflow without agents and without its id, revision and timestamps: `name`, `description`, `kind`, `agentsDecide`, `progressFile` and `nodes`, each node without `agentId`. It is the body `validateWorkflowBody(…, { template: true })` accepts. |
| Source | Where a workflow's definition came from: `local` (made on this install), `builtin` (a `WORKFLOW_TEMPLATES` entry) or `imported` (a package file). |
| Source version | A positive integer that orders a source's definitions. A built-in's is in `shared/workflow-templates.mjs`; a package's is the revision of the workflow it was exported from. |
| Base | The definition the workflow last took from its source. With the workflow's current definition and the source's newer definition it is the third side of the comparison in §6. Unknown (`null`) for a workflow linked by name (§5.4). |
| Change | One difference the owner takes or leaves (§6.2), with a stable id. |

## 3. The package file

One JSON file per workflow, named `<slug>.codedeck-workflow.json`, where `<slug>` is the workflow name lower-cased with runs of characters other than `a-z0-9` replaced by `-`, trimmed of `-`, at most 64 characters (`workflow` when that leaves nothing).

```json
{
  "format": "codedeck.workflow",
  "formatVersion": 1,
  "source": { "id": "0b7c…-uuid-v4", "version": 7 },
  "exportedAt": "2026-11-24T13:05:52.000Z",
  "workflow": {
    "name": "Bug fix",
    "description": "Investigate, agree on a fix, build, review, test and commit.",
    "kind": "bugfix",
    "agentsDecide": false,
    "progressFile": null,
    "nodes": [
      { "name": "Clarify", "role": "Investigator", "prompt": "…", "repeat": { "mode": "once" }, "readOnly": true, "approval": false, "askOwner": true }
    ]
  }
}
```

| Field | Rule (checked on import, each field on its own, all failures reported at once) |
|---|---|
| `format` | Exactly `codedeck.workflow`. |
| `formatVersion` | Exactly the integer `1`. A higher one is refused with "This file was made by a newer CodeDeck (format N); update CodeDeck to import it." |
| `source` | Object with exactly `id` and `version`. |
| `source.id` | UUID v4. The id of the workflow the file was exported from, on the install that exported it. |
| `source.version` | Integer 1–2³¹−1. |
| `exportedAt` | ISO 8601 UTC timestamp. Shown in the preview; never compared. |
| `workflow` | Passes `validateWorkflowBody(workflow, { template: true })`; field errors are reported under `workflow.` (for example `workflow.nodes[2].prompt`). In addition every node has a non-empty `role`, because the step is assigned by team role on import. |
| any other key | Refused as an unknown field, at every level. |

The whole file is at most 512 KiB (the pipelines router's existing JSON limit); a larger request is refused with 413.

**Export** writes the workflow's definition (its `enabled` flags included), `source.id` = the workflow's own id and `source.version` = its revision. An imported workflow exported again is a new source: its own id, not the id of the file it came from. A workflow linked to a built-in exports the same way.

A workflow with a step that has no role cannot be exported: 409, naming each such step ("Give every step a role before exporting: Develop, Test."). The builder shows the same message beside **Export** and does not call the endpoint.

## 4. Data

### 4.1 `pipeline_workflows` — new columns

Added on start with `ALTER TABLE … ADD COLUMN` when missing, like the existing columns.

| Column | Type | Rule (checked when a row is written and again when it is read) |
|---|---|---|
| `source_kind` | TEXT NOT NULL DEFAULT `'local'` | One of `local`, `builtin`, `imported`. |
| `source_id` | TEXT | `local`: null. `builtin`: a template id, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1–64 characters (it need not be a template this release ships; see §5.5). `imported`: UUID v4. |
| `source_version` | INTEGER | `local`: null. Otherwise an integer 1–2³¹−1. |
| `source_base` | TEXT | `local`: null. Otherwise null (unknown base) or JSON of a definition that passes `validateWorkflowBody(…, { template: true })`. |
| `source_updated_at` | TEXT | Null, or the ISO timestamp of the last time the workflow took a version from its source by itself (§5.2). Shown as "Updated to version N" until the owner next saves the workflow, which sets it to null. |

A row that breaks any rule fails loudly on read with the row id and the column, as the existing hydration does.

A partial unique index allows one workflow per linked source: `CREATE UNIQUE INDEX IF NOT EXISTS pipeline_workflows_source ON pipeline_workflows (source_kind, source_id) WHERE source_kind <> 'local'`.

### 4.2 `pipeline_builtin_dismissals` — new table

```sql
CREATE TABLE IF NOT EXISTS pipeline_builtin_dismissals (
  template_id TEXT PRIMARY KEY,
  dismissed_at TEXT NOT NULL
);
```

`template_id` follows the built-in id rule of §4.1; `dismissed_at` is ISO. A row means: do not offer this built-in as new. It is written when the owner dismisses a new built-in, and when the owner deletes a workflow linked to a built-in (so a deleted built-in does not come back, as today). **Add** on a dismissed built-in from the **Add workflow** chooser still works and removes the row.

### 4.3 Built-in versions

Each `WORKFLOW_TEMPLATES` entry gains `version` (integer ≥ 1). Every template starts at `1` in this release.

`server/__tests__/fixtures/built-in-workflow-versions.json` records, per template id, its `version` and the SHA-256 of its canonical definition (§6.1). A test fails when a template's definition changes without its version going up, or its version goes up without the fixture being updated. Changing a built-in is therefore: edit the template, bump `version`, update the fixture.

### 4.4 API view of a workflow

`GET /workflows`, `GET /workflows/:id`, POST and PUT responses gain one read-only field (additive):

```json
"source": { "kind": "builtin", "id": "bug-fix", "version": 1, "latestVersion": 2, "updateAvailable": true, "updatedToVersionAt": null, "shipped": true }
```

- `kind`, `id`, `version`: the stored columns (`id` and `version` null for `local`).
- `latestVersion`: for `builtin`, the shipped template's version (null when not shipped); for `imported` and `local`, null (a package's newer version is known only when a file is imported).
- `updateAvailable`: `builtin` only, true when `latestVersion > version`.
- `updatedToVersionAt`: `source_updated_at`.
- `shipped`: `builtin` only, false when this release has no template with that id.

`source` is not accepted in a POST or PUT body; the existing unknown-field rule refuses it, and the client strips it before saving.

## 5. Behaviour

### 5.1 Creating and saving

- A workflow made in the builder, by **Duplicate**, from an owner-saved template or from **Blank** is `local`.
- A workflow made from a built-in in the **Add workflow** chooser, and the workflows the first-start seed saves, are `builtin` with `source_id` = template id, `source_version` = its version and `source_base` = its definition. When a workflow linked to that built-in already exists, the chooser's choice makes an unlinked `local` copy instead (the unique index of §4.1) and says so in its toast ("Added as a copy: Bug fix is already linked to the built-in.").
- Saving a workflow (PUT) changes neither its source nor its base: the owner's edits are what §6 compares against the base. It clears `source_updated_at`.
- **Duplicate** of any workflow makes a `local` one.
- Deleting a `builtin` workflow writes a dismissal (§4.2) in the same transaction.

### 5.2 On start: built-ins that changed

After the hand-written upgrades and the first-start seed, once per start, for every `builtin` workflow whose template ships with a higher version:

- When its current definition equals its base (§6.1), it takes the new definition: nodes are replaced, each node keeping the `agentId` of the node with the same name, a new node getting `agentId: null` (assigned by team role); `revision` goes up by one, `source_version`, `source_base` and `source_updated_at` are set. Logged once per workflow: `[workflows] <name> updated to built-in version N`.
- Otherwise nothing changes; `updateAvailable` is true and §6 applies.
- A run in progress keeps its snapshot either way.

A workflow whose new definition would be refused by `validateWorkflowBody` (for example its unique name now clashes) is left as it is, and the reason is logged with the workflow id. The start goes on.

### 5.3 New built-ins

`GET /builtin-workflows` lists, paginated, the shipped templates with whether each is linked, dismissed or new. The builder's workflow list shows, above the owner's workflows, one row per new built-in: "New built-in workflow: Brainstorm to spec — {description}" with **Add** (POST `…/additions`, §7) and **Dismiss** (POST `…/dismissals`). Neither is shown once every shipped built-in is linked or dismissed.

### 5.4 Workflows saved before this feature

On the first start with the new columns, each `local` workflow whose name equals a shipped template's name (case-insensitive) and whose kind equals its kind, and that no other workflow already links that template, becomes `builtin` for that template:

- Its definition equals the template's: `source_version` = the template's version, `source_base` = its definition. Up to date.
- Otherwise: `source_version` = the template's version and `source_base` = null (unknown), because which version it was copied from is not recorded anywhere. `updateAvailable` is false, and the builder shows **Compare with built-in** (§6.3), which lists every difference with **Keep mine** chosen; applying it sets the base to the template's definition, and later versions compare normally.

This linking runs once per database, recorded in a single-row table `pipeline_workflow_source_link (id INTEGER PRIMARY KEY CHECK (id = 1), linked_at TEXT NOT NULL)`, like the seed.

### 5.5 A built-in that is no longer shipped

A `builtin` workflow whose template id this release does not ship keeps working as an ordinary workflow. `source.shipped` is false and the builder says "Built-in no longer shipped". It is offered no update.

### 5.6 Import

The owner chooses **Import…** in the builder's workflow list and picks a `.json` file. The client reads it, sends it to `POST /workflow-imports/previews`, and shows the preview:

| The install has | Preview offers |
|---|---|
| No workflow linked to `source.id`, no workflow with that name | **Import**: a new `imported` workflow with the file's definition, every node `agentId: null`. |
| No linked workflow, but one with the same name | **Import as a copy** with a name field (prefilled "<name> (imported)", checked for clashes as typed), or **Replace <name>**: that workflow becomes `imported` from this source with an unknown base, and the §6 comparison is shown with every difference set to take the file's. |
| A linked workflow, file version higher than its `source_version` | The §6 comparison between its base, its current definition and the file's. When its definition equals its base, every change is pre-chosen and marked "unchanged by you". |
| A linked workflow, file version equal and definition equal to its base | "Already up to date." Nothing to apply. |
| A linked workflow, file version lower or equal with a different definition | Refused: "This file is version N; Bug fix already took version M from it." |

Applying sends `POST /workflow-imports` with the file and the choices. A new workflow is created with `revision` 1, `source_kind` `imported`, `source_id`/`source_version` from the file and `source_base` = the file's definition. An update writes the merged definition, `source_version` and `source_base` = the file's definition, in one transaction with the revision check.

A step with `agentId: null` runs only with a team that gives its role an agent; the preview says so when the install's teams give none of the file's roles an agent ("No team gives these roles an agent yet: Planner, Tester.").

## 6. Comparison and changes

### 6.1 Canonical definition

To compare definitions, each is normalised the way `normalizeNodes` stores it (trimmed names and roles, loops stored by target name, flags defaulting to false, `enabled` present only when false), with keys in a fixed order and `progressFile` trimmed or null. Two definitions are equal when their canonical JSON strings are equal. The SHA-256 of that string is the hash in §4.3.

### 6.2 Changes

`compareDefinitions({ base, mine, theirs })` in `shared/workflow-changes.mjs` is pure and returns the list of changes from `mine` to `theirs`. Each change has:

| Field | Meaning |
|---|---|
| `id` | Stable: `workflow.<field>` for `description`, `kind`, `agentsDecide`, `progressFile`; `step:<name>.<field>` for `role`, `prompt`, `repeat`, `readOnly`, `approval`, `askOwner`, `enabled`; `step:<name>.added`, `step:<name>.removed`; `order`. Step names are compared case-insensitively. The workflow's own `name` is never a change: it is the owner's. |
| `mine`, `theirs` | The two values (for `order`, the two lists of step names). |
| `conflict` | True when base is known and both sides changed the value from base, to different values; always true when base is unknown and the values differ. |
| `chosen` | Default choice: `true` (take theirs) when base is known and only theirs changed it from base; `false` (keep mine) otherwise. A step the owner removed that theirs changed is a conflict on `step:<name>.added`. |

Values equal in `mine` and `theirs` produce no change. A change where only `mine` changed from base produces no change either: the owner's edit stands and is not listed.

`applyChanges({ mine, theirs, take })` returns the merged definition: each change id in `take` takes `theirs`, the rest keep `mine`. An added step is placed after the step that precedes it in `theirs` (first if none); `order` taken reorders the steps both sides have to `theirs`' order, with steps only in `mine` keeping their place after their predecessor. Agents are kept by step name; an added step gets `agentId: null`. The result must pass `validateWorkflowBody`; when it does not (for example a loop to a step left out), the apply is refused with 409 and the validator's field errors, and nothing is written. The client shows them beside the changes that caused them.

### 6.3 The update screen

From the builder, **Update available — version N** on a workflow (or **Compare with built-in** for an unknown base, or the import preview of §5.6) opens one screen:

- A header: the source ("Built-in Bug fix", or "File exported 24 Nov 2026, version 7"), the version the workflow is on and the one offered.
- One row per change, grouped by step in `theirs`' order then workflow fields: what it is ("Develop — prompt", "Clarify — new step", "Test — repeat: loop to Develop, 8 rounds (was 3)"), a side-by-side or line diff for prompts, a **Conflict** mark where §6.2 says so, and a toggle **Take** / **Keep mine** starting at `chosen`.
- **Take all**, **Keep mine for all**, and **Apply**. Apply with nothing taken still sets the workflow to the offered version and base, so the same version is not offered again ("Kept your version; version N will not be offered again.").
- Toasts for success and failure; a 409 revision conflict reloads the comparison.

## 7. API

All under `/api/pipelines`, RFC 9457 problem details with `traceId` and an `errors` array on 400, per `~/.claude/standards/api-design.md` and `docs/steering/api-standards.md`. Lists use the existing `collection-query.js` paging envelope.

| Method | Path | Request | Success | Errors |
|---|---|---|---|---|
| GET | `/workflows/:id/export` | — | 200, the package (§3), `Content-Type: application/json`, `Content-Disposition: attachment; filename="<slug>.codedeck-workflow.json"` | 404 unknown id; 409 steps without a role |
| POST | `/workflow-imports/previews` | `{ package }` | 200 `{ target, workflow, changes, missingRoles }`: `target` is `{ mode: 'new' }`, `{ mode: 'name-clash', workflowId, revision }`, `{ mode: 'update', workflowId, revision, fromVersion }` or `{ mode: 'up-to-date', workflowId }`; `workflow` the file's definition; `changes` per §6.2 (empty for `new`) | 400 field errors under `package.`; 409 older or same-version different file |
| POST | `/workflow-imports` | `{ package, target }` where `target` is `{ mode: 'new', name? }`, `{ mode: 'replace', workflowId, revision, take }` or `{ mode: 'update', workflowId, revision, take }` | 201 new workflow / 200 updated workflow (with `source`) | 400 field errors, unknown change id in `take`; 404 workflow; 409 name clash, revision conflict, version refused, merged definition invalid |
| GET | `/workflows/:id/source-update` | — | 200 `{ fromVersion, toVersion, baseKnown, changes }` comparing with the shipped built-in | 404; 409 not a shipped built-in, or up to date with a known base |
| POST | `/workflows/:id/source-update` | `{ revision, toVersion, take }` | 200 updated workflow | 400; 404; 409 revision conflict, `toVersion` not the shipped one, merged definition invalid |
| GET | `/builtin-workflows` | `page`, `size`, filter `status` (`new`, `linked`, `dismissed`), sort `name,asc` with id as tie | 200 page of `{ id, name, kind, description, version, status, workflowId }` | 400 bad query |
| POST | `/builtin-workflows/:id/additions` | — | 201 the new linked workflow | 404 not shipped; 409 already linked (body names the workflow) or name clash |
| POST | `/builtin-workflows/:id/dismissals` | — | 204; repeating it is 204 | 404 not shipped; 409 linked |

`take` is an array of change ids, each listed at most once, at most 32 × 8 + 8 entries; an id the server's own comparison does not produce is a 400 naming it. The server always recomputes the comparison: a client never sends merged definitions. Repeating an import or update with the same `revision` after it succeeded is a 409 revision conflict, never a second write. Concurrent identical imports of a new workflow: one succeeds, the other is a 409 on the source index.

Refused requests are logged once with route and field names, never values (§6 of the API standard).

## 8. Client

- `client/src/utils/pipelinesApi.js`: `exportWorkflow`, `previewImport`, `importWorkflow`, `getSourceUpdate`, `applySourceUpdate`, `listBuiltinWorkflows`, `addBuiltinWorkflow`, `dismissBuiltinWorkflow`, each validating the response shape it reads, and `pipelineRecords.js` parsing `source`.
- Builder workflow list (`WorkflowList.jsx`, both variants): **Import…**; the new-built-in rows of §5.3; per workflow a badge: "Update available — version N", "Updated to version N", "Built-in no longer shipped", "Imported, version N".
- Builder editor: **Export** (downloads the file through the endpoint), disabled with its reason while the draft has unsaved edits ("Save before exporting") or a step without a role.
- The update screen of §6.3, used for built-in updates, unknown-base comparisons and import previews.
- Every mutating call shows a toast for success and failure, reading the problem detail's message.

## 9. What stays the same

- The workflow POST/PUT bodies and their validation; existing clients keep working (`source` is additive in responses).
- Runs, their snapshots and everything that reads them.
- The first-start seed of an empty install (it now also links what it saves).
- The hand-written upgrades in `workflow-store.js`, which run before §5.2 and §5.4.
- Owner-saved templates and saved steps.

## 10. Acceptance checks

1. Exporting a workflow gives a file that passes §3, carries no `agentId`, and is named by its slug; a workflow with a role-less step is refused naming the step. (API test, builder test.)
2. Importing that file on an empty database makes an `imported` workflow with the same definition, every step assigned by team role; a run of it starts with a team that covers its roles. (API test; a live import and run start from the UI on a second CodeDeck database.)
3. A file with an unknown key, a wrong format version, a bad UUID, a role-less step or an invalid node is refused with every field error at once; a 600 KiB body is 413. (API test across the six dimensions.)
4. Importing a file whose name clashes offers a copy with another name or a replace; both work. (API + client test.)
5. Exporting again after editing on the source install and importing on the target: unchanged on the target → the changes are pre-chosen and applied; edited on the target → only the source's changes are listed, the target's edits are not, and conflicts default to **Keep mine**; agents on the target are kept. (Pure tests for `compareDefinitions`/`applyChanges`; API test; live in the UI.)
6. An older or same-version-but-different file is refused; the same file twice says "Already up to date". (API test.)
7. Changing a built-in's prompt without bumping its version fails the fixture test. (Test.)
8. With a built-in at a higher version, an unchanged linked workflow takes it on start with its agents kept and says "Updated to version N"; an edited one shows **Update available**, and applying with nothing taken stops offering that version. (Store and start tests; live restart of the dev backend.)
9. A new built-in on an install that already has workflows is offered; Add links it, Dismiss hides it for good; deleting a linked built-in does not bring it back as new. (API test; UI.)
10. On the first start with this feature, saved workflows named like a built-in are linked; identical ones are up to date, others offer **Compare with built-in** with every difference on **Keep mine**. (Store test with fixtures of today's saved Bug fix and Feature build.)
11. A merge whose result is invalid is refused with field errors and writes nothing. (Pure + API test.)
12. A row with a bad `source_*` value fails loudly on read naming the row and column. (Store test.)

### Owner checks

- Import a file exported on this Mac into CodeDeck on the second host, and back. What to do: export **Bug fix** here, import it there, edit a prompt here, export and import again. Expect the second import to list only that prompt as a change. An agent verifies the same flow between two databases on this machine.
