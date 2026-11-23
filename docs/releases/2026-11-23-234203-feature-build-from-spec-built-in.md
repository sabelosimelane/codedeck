## [2026-11-23] - Feature Build from Spec ships as a built-in workflow, with its skills

### Executive Summary
* The workflow that builds a feature from an existing todo file through the `feature-dev` and `feature-test` skills existed only in the owner's database, and the skills only in the owner's home folder. Both are now in the repository: the workflow as a built-in template that a new install starts with, the skills under `skills/` with install instructions.

### Technical Details
* **✨ New Feature:**
  * `shared/workflow-templates.mjs` — template `feature-build-from-spec` (Develop `/feature-dev {input}`, Review, Test `/feature-test {input}` looping to Develop up to 8 rounds; Progress file `docs/{input}`; agents decide).
  * `skills/feature-dev/`, `skills/feature-test/` (new) — the two skills as used by the owner, without the evaluation fixtures.
  * `skills/README.md` (new) — what the skills are for, how to install them and what they expect of a project.
* **🛠️ Codebase:**
  * `README.md` — the workflow and its skills under Workflow pipelines.
* **🧪 Tests:**
  * `server/__tests__/workflow-templates.test.js` — the template's content; it alone may call skills, set a Progress file and let agents decide; every skill a built-in workflow calls is in `skills/` with matching front matter and no machine paths.
