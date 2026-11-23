## [2026-11-23] - A new install starts with the built-in workflows

### Executive Summary
* The built-in workflows and their prompts were in the repository only as templates, so a new install opened on an empty workflow list. The first start now saves all six as workflows whose steps are assigned by team role; the user adds agents and a team.

### Technical Details
* **✨ New Feature:**
  * `server/pipelines/workflow-seed.js` (new) — `seedBuiltInWorkflows` saves every entry of `WORKFLOW_TEMPLATES` with `agentId: null`, once per database, in one transaction, and records it in `pipeline_workflow_seed`. A database that already has workflows is recorded as done with nothing added; deleted workflows do not return.
  * `server/index.js` — runs it after the workflow store is created and logs the names when it saved any.
* **🛠️ Codebase:**
  * `README.md`, `docs/steering/structure.md` — what a new install starts with.
* **🧪 Tests:**
  * `server/__tests__/pipeline-workflow-seed.test.js` (new) — content and validity of the saved workflows, once only, existing installs untouched, all or none, stored-record and argument checks.
