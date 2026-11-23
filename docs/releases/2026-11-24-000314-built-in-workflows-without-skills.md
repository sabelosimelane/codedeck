## [2026-11-24] - Every built-in workflow carries its own prompts; no skills shipped

### Executive Summary
* Feature Build from Spec was shipped with steps that called two skills, which a new user had to install by hand before the workflow worked. Its steps now carry written-out prompts like every other built-in workflow, and the `skills/` folder is removed.

### Technical Details
* **🛠️ Codebase:**
  * `shared/workflow-templates.mjs` — `feature-build-from-spec`: Develop, Review and Test are written out and work from the todo file `docs/{input}`; same steps, loop, Progress file and agents-decide setting as before.
  * `skills/` — removed (`feature-dev`, `feature-test`, `README.md`).
  * `README.md` — the workflow described without skills.
* **🧪 Tests:**
  * `server/__tests__/workflow-templates.test.js` — no built-in step calls a skill and no `skills/` folder ships; the workflow's steps and wording.
