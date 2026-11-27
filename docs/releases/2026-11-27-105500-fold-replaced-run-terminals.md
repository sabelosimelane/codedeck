## [2026-11-27] - Fold the terminals of a replaced run into the task's sidebar entry

### Executive Summary
* A task that has had more than one workflow run now stays one entry in the left sidebar. Starting a run in a task releases the run before it and takes over only the terminals its agents need; the rest of the earlier run's terminals were listed under the task as if opened by hand. They are now folded into the task's entry like the current run's own terminals, and are still listed while they are finished or dead.

### Technical Details
* **🛠️ Codebase:**
  * `server/pipelines/run-view.js` — an open run's view carries `inheritedSessionIds`: the step terminals (current and prior) of earlier released runs in the same project, host and worktree that the run does not use itself. A released run inherits none.
  * `client/src/hooks/usePipelineRunCounts.js` — requires `inheritedSessionIds` as a list of session ids on each open run and passes it to sidebar grouping. It is not required by the shared `parseRun`, which the phone also uses against older instances.
  * `client/src/utils/worktreeGroups.js` — each group collects `runSessionIds` from every run in it (step, prior and inherited terminals); `sidebarSessionsForGroup` folds those instead of only the newest run's steps.
* **🧪 Tests and verification:**
  * Red-then-green tests: the run view's inherited terminals (`server/__tests__/assistant-run-view.test.js`), folding across several runs of one task (`worktreeGroups.test.js`), the hook-to-sidebar fold of inherited terminals and the refusal of a malformed list (`usePipelineRunCountsFolding.test.jsx`).
  * Client suite: 2101 passed; the 9 failures (`SidebarWaitingCount`, lucide-react mock without `Server`; mobile `runsApi`) fail identically without this change. Server suite: 4457 passed; the `project-config` and `project-repositories-api` failures fail identically without it.
  * Live: `GET /api/pipelines/runs?open=true` returned `inheritedSessionIds` three terminals (sessions 11, 15 and 12) for the replacing run, and the sidebar showed that task as one entry without them.

