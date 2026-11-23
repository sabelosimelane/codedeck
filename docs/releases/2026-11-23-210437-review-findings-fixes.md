## [2026-11-23] - Review-findings fixes: artifact sync, cross-host sessions, host-aware tasks, and signal handling

### Executive Summary
* Addresses the uncommitted-tree review findings: portable ignored-artifact discovery and sync in `server/git-sync-service.js`, cross-host session search/resume/transfer via new `server/agent-history/transfer.js` and `server/agent-history/remote.js`, host-aware New Task and pipeline/worktree endpoints, truthful agy readiness from live running rows, and hardened terminal signal parsing — with regression coverage across the touched suites.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Artifact sync folded read/write failures into `skipped` with no `failed` outcome, read source permission bits only for local sources, and published remote artifacts through a single base64 shell argument that fails on Linux around 96 KiB (under the 5 MiB cap), while the sync toast could still report “already up to date”.
  * **Solution:** Reworked `server/git-sync-service.js` with portable ignored-artifact discovery (`discoverIgnoredArtifacts`, `isExcludedArtifactPath`, `MAX_ARTIFACT_BYTES`), runner-based transfer that stages through the host filesystem instead of one giant shell argument, and failure outcomes propagated through `server/routes/projects.js` clone/sync callers to the `ProjectLocationsDialog` toast.
* **✨ New Feature:**
  * `server/agent-history/transfer.js` (new) — session export/import scripts and `createSessionMaterializer` for cross-host resume with per-transfer staging.
  * `server/agent-history/remote.js` (new) — remote history collection (`REMOTE_COLLECTOR_SCRIPT`, `createRemoteAgentHistory`) with per-host caching.
  * `server/agent-history/service.js`, `server/agent-history/index.js` — session search and resume span bound project locations: `host` and `refresh` filters, per-host availability in `hosts`, and 503 when every bound location of a named project is unreachable (replacing the old local-only 409).
  * `client/src/components/tasks/NewTaskDialog.jsx` — Host select drives repository fetching, worktree candidates, and task creation (`host` forwarded to `tasksApi`/`projectRepositoriesApi`); `client/src/components/TerminalArea.jsx` and related API clients thread the selected host through.
  * `server/routes/pipelines.js` — `run-plans`, worktree, and worktree-candidate endpoints accept and forward `host`, resolving the run location and host-scoped Git/file tools end to end.
* **🐛 Bug Fix:**
  * **Problem:** An idle agy agent with a stale `N task(s)` footer and no live running row was classified as `agent_background_shells` forever, and cursor jumps on TUI screens could glue unrelated bytes around a workflow signal.
  * **Solution:** `server/agent-profiles/agy.js` counts `backgroundShells` only from live `● [hh:mm:ss] … running` rows (`RUNNING_TASK_ROW`); `server/terminal-workflow.js` splits screen text on cursor-movement CSI sequences before matching pass signals and resets the bad-identifier retry on a new pass; `server/terminal-execution-classifier.js` tightens shell-prompt matching.
* **🛠️ Codebase:**
  * `server/command-runner.js` — added `copyFrom` to local and SSH runners (scp-based) for artifact/session payloads.
  * `server/pipelines/workflow-store.js` — stock `Test` prompts upgraded so blocked checks use `NEEDS_INPUT` with collected evidence instead of re-running passing tests, and full suites run once per repository with code changes.
  * `server/terminal-runtime.js`, `server/routes/agent-sessions.js`, `server/routes/tasks.js`, `server/tasks/task-service.js`, `server/project-repositories.js`, `server/index.js`, `server/pipelines/run-engine.js` — host-aware plumbing and workflow polling-signal wiring backing the above.
  * `docs/specifications/2026-11-23-145623-merge-and-deploy-spec.md`, `docs/todos/2026-11-23-145623-merge-and-deploy.md` — merge-and-deploy design spec and todo committed alongside the fixes.
* **🧪 Tests:**
  * `server/__tests__/cross-host-sync.test.js`, `server/__tests__/command-runner.test.js` — artifact discovery/transfer, runner `copyFrom` ordering, and copy-failure propagation.
  * `server/__tests__/agent-history/api.test.js`, `server/__tests__/agent-history/transfer.test.js` (new), `server/__tests__/agent-history/remote.test.js` (new), `server/__tests__/agent-history/submit.test.js` — bound-host search, host filtering, refresh propagation, mixed availability and 503, submit awaiting with deferred completion/rejection including real-tmux fixtures.
  * `server/__tests__/pipeline-agent-readiness.test.js`, `server/__tests__/terminal-execution-classifier.test.js` — footer-only idle reads ready while live running rows still report waiting.
  * `server/__tests__/pipeline-run-engine.test.js`, `server/__tests__/terminal-workflow.test.js` — engine advances exactly once on a cursor-positioned current-pass signal through the poll loop, ignoring plain output, stale iterations, echoed prompts, and duplicate polls.
  * `server/__tests__/host-terminal-runtime.test.js`, `client` `SessionSearch`, `NewTaskDialog`, `RunWorkflowDialog`, `pipelinesApi`, `projectRepositoriesApi`, `tasksApi`, and `worktreeGroups` suites — host-aware coverage for the changed dialogs and endpoints.
