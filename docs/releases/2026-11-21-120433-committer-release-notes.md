## [2026-11-21] - Workflow Committer changelog and dated release notes

### Executive Summary
* Built-in workflow Committer steps now record every completed run in `CHANGELOG.md` and write a matching chronologically named release file under `docs/releases/` (`YYYY-MM-DD-HHmmss-<short-slug>.md`), making individual builds easy to browse in order. New runs no longer skip launching the Commit agent on clean worktrees so release notes and changelog updates are always written before committing.

### Technical Details
* **✨ New Feature:**
  * `shared/workflow-templates.mjs` — added `commitReleaseNotes` instructions to the `Commit` (`Committer`) node across `bug-fix`, `feature-build`, `feature-from-requirements`, and `troubleshoot` templates to update `CHANGELOG.md` and write a dated release file under `docs/releases/YYYY-MM-DD-HHmmss-<short-slug>.md` (creating `docs/releases/` if absent) before committing.
* **🛠️ Codebase:**
  * `server/routes/pipelines.js` — removed `standardCommits` / `inspectCleanCommit: true` tagging for newly created runs (and its unused `WORKFLOW_TEMPLATES` import) so the `Commit` agent always runs to produce release notes and changelog entries, while keeping `inspectCleanCommit` support in `run-store.js` and `run-engine.js` for existing persisted runs.
* **🧪 Tests:**
  * `server/__tests__/workflow-templates.test.js` — tightened the slash-command prompt check to allow relative paths like `docs/releases/` while still rejecting slash commands and `$var` references, and added coverage verifying `CHANGELOG.md` and `docs/releases/YYYY-MM-DD-HHmmss-<short-slug>.md` instructions on all committing templates.
  * `server/__tests__/pipelines-api.test.js` — updated the `Commit` snapshot test to assert `inspectCleanCommit` is not set on newly created runs.
