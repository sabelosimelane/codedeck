## [2026-11-24] - Brainstorm to spec built-in workflow

### Executive Summary
* A new built-in workflow, **Brainstorm to spec**, for an idea that still needs thinking through. Its Brainstorm step talks the idea over with the owner one question at a time, each with a recommended answer, building on and challenging each answer, and moves on only when the owner agrees the idea has landed. Specify then writes the specification and a phased todo shaped for Feature Build from Spec and waits for approval; Commit commits those two files only. Existing installs add it from Settings → Workflows → Add workflow.

### Technical Details
* **✨ New Feature:**
  * `shared/workflow-templates.mjs` — `brainstorm-to-spec` template: Brainstorm (Thinking partner, read-only, always asks the owner), Specify (Planner, approval gate, spec + todo with `## Phase N`, `## Session notes`, `**Repositories**` line in multi-repository projects, at most 4 phases), Commit (spec and todo only, never pushes).
* **🧪 Tests:**
  * `server/__tests__/workflow-templates.test.js` — the template list, its step settings, and the conversation, specification and commit rules in its prompts.
* **📝 Documentation:**
  * `README.md`, `docs/steering/product.md` — listed among the built-in workflows, with how a run of it goes.
