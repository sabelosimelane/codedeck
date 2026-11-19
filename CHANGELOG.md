# Changelog

## [2026-11-19] - A workflow template that starts a feature from its requirements

### Executive Summary
* Feature build starts from work that is already planned. A new built-in template, **Feature from requirements**, starts from an idea: Requirements asks you only what it could not find out, Specify writes the specification into the repository and waits for your approval, Plan turns it into phases and waits again, then the same Develop, Review and Test loop builds it and Commit commits it, specification included.
* **Requirements** is also a built-in step under **Insert a saved step…**, beside Clarify. It asks what a feature needs settled (who it is for, each case, what is out of scope, how it will be shown to work); Clarify asks about a fault.

### Technical Details
* **🛠️ Codebase:**
  * `shared/workflow-templates.mjs` — the `feature-from-requirements` template and the `requirements` built-in step. No engine change: the plan is the run's `plan.md`, as in Feature build, and the template has no Progress file.
* **📚 Documents:** `README.md`, `docs/steering/product.md`, `docs/steering/structure.md` and the workflow pipelines specification.
* **🧪 Tests:**
  * `server/__tests__/workflow-templates.test.js` — the template's steps, gates, loop and prompts; Requirements as a valid built-in step.
  * `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx` — the chooser offers the template and the step list offers Requirements.
  * Not run live: no run has been started from the template yet.
