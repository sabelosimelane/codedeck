## [2026-11-23] - Agents own the test environment; owner-only checks no longer pause a run

### Executive Summary
* Workflow test steps asked the owner for a test environment more than any other step asked anything (33 recorded answers for Test). The built-in prompts told them to, and no step owned the environment. Setup now proves the worktree can be tested and records how, every working step is told the test environment is its own, the checks are sorted up front into those an agent verifies and **Owner checks**, and owner checks no longer pause a run.

### Technical Details
* **✨ New Feature:**
  * `server/pipelines/run-worktree.js` — the Setup prompt gains a step (`proveStep`): run one quick test, start and stop the app on free ports, find the test sign-in and the available emulators, simulators and browsers, and write it to `environment.md` in the run notes. Only a failed install or copy reports `NEEDS_INPUT`.
  * `server/pipelines/step-guidance.js` — every node that may change the worktree is told it owns the test environment and asks for one only after trying; `environmentPath` names the record, which Setup writes, working steps keep right and read-only steps read.
  * `shared/workflow-templates.mjs` — the steps that agree the checks say how an agent verifies each one and list owner-only checks (a physical device, a real account or recipient, production) under Owner checks; in `plan.md` they are plain bullets under `## Owner checks`, not tasks. Test, Review & Test and Verify set up what a check needs, do not wait for owner checks, and ask once when a check turns out to need the owner. Commit carries the open owner checks into the final note.
* **🛠️ Codebase:**
  * `server/pipelines/workflow-store.js` — `STOCK_PROMPT_UPGRADES` brings the 15 changed built-in prompts, and the 6 older ones that led to them, to the new wording in saved workflows; edited prompts are kept.
  * `README.md` — "Testing is the agents' job" under Workflow pipelines.
* **🧪 Tests:**
  * `server/__tests__/pipeline-step-guidance.test.js`, `pipeline-run-engine.test.js` — the ownership sentence and the record for Setup, working and read-only steps.
  * `server/__tests__/pipeline-run-worktree.test.js` — the Setup proof step for one and several worktrees.
  * `server/__tests__/workflow-templates.test.js` — agreed checks, owner checks and the test steps' wording.
  * `server/__tests__/pipeline-definition-store.test.js`, `fixtures/stock-prompts-before-owner-checks.json` — every previous built-in prompt reaches the current one.
