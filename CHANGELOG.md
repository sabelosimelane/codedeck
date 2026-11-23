# Changelog

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

## [2026-11-23] - Placeholders for private names in tests and reports

### Technical Details
* **🛠️ Codebase:**
  * Test fixtures, one specification and the workflow handoff report used a real host name, user name and project name. They now use `media-server.example.ts.net`, `dev` and `acme`; the host name is painted over in `docs/reports/2026-11-23-workflow-handoff.png`. No behaviour changes.

## [2026-11-23] - A landing is finished before the backend stops

### Executive Summary
* Merging a task of CodeDeck itself changed the backend's own files, so `node --watch` stopped the backend in the middle of the merge: the commit was merged and the folder removed, but the branch stayed and the task was still recorded as active. The backend now finishes landing actions before it exits.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `merge` in `server/tasks/task-landing.js` runs `git merge`, removes the folder, deletes the branch and only then records the task as merged. SIGTERM had no handler, so the process died between those steps.
  * **Solution:** `server/shutdown.js` (new, `createShutdown`) waits on SIGTERM and SIGINT for `taskLanding.idle()` and then exits; after 60 seconds it logs that work is unfinished and exits with a failure. Node's watcher starts the next process only after this one is gone. `idle()` on the landing service resolves when no landing action is running or queued.
* **🧪 Tests:**
  * `server/__tests__/shutdown.test.js` (new) — waits for work in progress, the limit, a failed wait, one signal only, argument checks.
  * `server/__tests__/task-landing.test.js` — `idle()` resolves only after a merge under way is recorded, and after queued and failed actions.

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

## [2026-11-22] - Streamline Feature from requirements, add stage disabling, and highlight completed runs

### Executive Summary
* The **Feature from requirements** workflow now reaches implementation faster and avoids redundant test-suite execution inside the build loop: `Specify` writes both the repository specification and the phased `plan.md` in a single pass (removing the separate `Plan` cold-start stage), `Review` focuses on diff auditing and defect fixes without re-running broad test suites that `Test` runs immediately afterward, and `Test` pauses via `NEEDS_INPUT` when blocked on owner evidence or later-stage artifacts instead of looping on unchanged diffs (with the default build loop cap lowered from 12 to 8). Workflow stages can now also be disabled in the **Workflow Builder** or toggled per run in the **Run Workflow** dialog without deleting them, and completed runs display a high-contrast completion badge in task headers and worktree switchers.

### Technical Details
* **✨ New Feature:**
  * `shared/workflow-templates.mjs` — folded `plan.md` creation into `Specify` in `feature-from-requirements` (`Requirements → Specify → Develop → Review → Test → Commit`), updated `Review` prompts across `bug-fix`, `feature-build`, and `feature-from-requirements` to avoid duplicating `Test`'s broad test-suite execution, updated `Test` prompts in `feature-build` and `feature-from-requirements` to use `NEEDS_INPUT` when blocked on external/owner evidence, and lowered the default build loop limit from 12 to 8.
  * `shared/pipeline-definitions.mjs` — added optional `enabled` boolean validation on workflow, template, and step-preset nodes (requiring at least one enabled node and an enabled loop target for enabled `loop_back` steps) and `disabledSteps` validation on `validateRunStartBody`.
  * `client/src/components/pipelines/WorkflowEditor.jsx`, `client/src/components/pipelines/WorkflowList.jsx` — added the `Enable this step` checkbox per stage, `disabled` step-rail metadata badge, and `(disabled)` workflow summary label.
  * `client/src/components/pipelines/RunWorkflowDialog.jsx`, `client/src/utils/pipelinesApi.js`, `client/src/hooks/usePipelineRuns.js`, `client/src/utils/pipelineRecords.js` — added per-run `Enabled`/`Disabled` step toggles under `Step assignments` and forwarded `disabledSteps` on run start.
  * `client/src/components/TerminalArea.jsx`, `client/src/components/WorktreeGroupHeader.jsx`, `client/src/components/pipelines/pipeline-runs.css`, `client/src/components/tasks/task-view.css`, `client/src/styles/global.css` — added check icons and high-contrast `done` status pill and completion banner styling for completed workflow runs.
* **🛠️ Codebase:**
  * `server/pipelines/workflow-store.js`, `server/pipelines/library-store.js`, `server/pipelines/request-store.js`, `server/routes/pipelines.js` — persisted `enabled: false` on disabled workflow and template nodes, migrated unmodified stock `Feature from requirements` and `Review`/`Test` prompts, serialized `disabledSteps` in start reservations, and filtered disabled stages out of `buildDefinitionSnapshot` while keeping loop `toStepIndex` aligned.
* **🧪 Tests:**
  * `server/__tests__/workflow-templates.test.js`, `server/__tests__/pipeline-definitions.test.js`, `server/__tests__/pipeline-definition-store.test.js`, `server/__tests__/pipelines-api.test.js`, `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx`, `client/src/components/pipelines/__tests__/RunWorkflowDialog.test.jsx`, `client/src/components/pipelines/builder/__tests__/WorkflowsScreen.test.jsx` — updated template assertions and added unit and integration tests for workflow-level and per-run stage disabling.

## [2026-11-22] - Incremental workflow reviews, active-only step timers, Quick change template, and untracked loop guardrails

### Executive Summary
* Workflow execution now scales with change complexity and reports truthful active step durations: `Review` passes scope repeat reviews to changes since the previous pass (instead of re-auditing already-verified phases from scratch), step timers pause while a run waits in `needs_input` (and warn explicitly when a step is blocked on a CLI terminal dialog), a 4-step `Quick change` template and upfront multi-repository checks in `Clarify`/`Requirements` reduce ceremony and mid-run stalls, and untracked loops pause after two repeat rounds without finishing.

### Technical Details
* **✨ New Feature:**
  * `shared/workflow-templates.mjs` — added the 4-step `quick-change` (`Quick change`) workflow template (`Scope → Develop → Review & Test → Commit`), updated `Review` prompts for incremental repeat passes, added upfront repository/worktree checks to `Clarify` and `Requirements`, and set default loop limits on `Bug fix` and `Troubleshoot` to 3 passes.
  * `server/pipelines/step-guidance.js`, `server/pipelines/run-engine.js` — passed `attempt` to `buildStepGuidance` so repeat passes inside a note-keeping loop instruct the agent to read its previous note and focus on what changed since that pass.
  * `server/pipelines/workflow-store.js` — added an exact-match node migration in `upgradeNodes` to upgrade unmodified stock `Clarify`, `Requirements`, and `Review` prompts and cap unmodified `bugfix`/`troubleshoot` loop limits at 3 while preserving custom prompts.
  * `client/src/components/tasks/TaskView.jsx` — added an explicit header warning when `needs_input` has `inputRequest: null` (CLI terminal dialog) and updated the `no_progress` warning banner for runs without a `plan.md` progress file.
* **🐛 Bug Fix:**
  * **Problem:** `WORKING_STEP` included `needs_input`, folding hours of owner wait time or silent CLI startup dialogs into a step's displayed working time (`elapsedMs`), and note-keeping loops without a `plan.md` progress file bypassed `NO_PROGRESS_ROUNDS`.
  * **Solution:** Removed `needs_input` from `WORKING_STEP` in `server/pipelines/run-machine.js` and `client/src/utils/pipelineRunStatus.js`, banked active time on `needs_input` and resumed `startedAt` on `input_received` with backend timestamps in `server/pipelines/run-engine.js`, and enforced `NO_PROGRESS_ROUNDS` on note-keeping loops without a progress file.
* **🧪 Tests:**
  * `server/__tests__/workflow-templates.test.js`, `server/__tests__/pipeline-step-guidance.test.js`, `server/__tests__/pipeline-run-machine.test.js`, `server/__tests__/pipeline-definition-store.test.js`, `server/__tests__/pipeline-run-engine.test.js`, `client/src/utils/__tests__/pipelineRunStatus.test.js`, `client/src/components/tasks/__tests__/TaskView.test.jsx`, `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx` — updated and added coverage for all four improvements.

## [2026-11-22] - Live per-stage timing, resilient workflow signals, and Muse Code preset

### Executive Summary
* Workflow runs now display live per-stage working durations while a stage runs and keep showing accumulated working time when a stage stops, fails, pauses, or loops back. Workflow automation is also more resilient: transient tmux/SSH client exits no longer kill active runs before re-attaching, and agents that typo the iteration identifier in their final signal are automatically asked once to re-emit it instead of immediately failing the pass. Also adds the Muse Code agent preset and expands Codex session history discovery to include interactive IDE/app-server threads ordered by recency.

### Technical Details
* **✨ New Feature:**
  * `client/src/utils/pipelineRunStatus.js` — updated `describeStepDuration(step, now)` to count live (`elapsedMs + (now - startedAt)`) for working steps (`launching`, `running`, `needs_input`) and return settled `elapsedMs` for stopped, failed, interrupted, paused, awaiting-approval, and looped-back steps.
  * `client/src/components/tasks/TaskView.jsx` — threaded the 1-second `now` ticker into `describeStepDuration(step, now)` and updated step rail `aria-label`s to distinguish live (`so far`) from settled (`took`) durations.
  * `shared/agent-presets.mjs` — added the `muse` (`Muse Code`) workflow agent preset (`--effort`, `--yolo`).
* **🐛 Bug Fix:**
  * **Problem:** `registerPtyExitHandler` and `registerRemotePtyExitHandler` called `s.workflow?.stop()` before checking whether the underlying tmux session was still recoverable, stopping active runs with `Stopped: terminal closed` on transient client exits. In addition, a single character typo by an agent in its `[[CDW:<id>:<STATUS>]]` signal immediately failed the entire pass.
  * **Solution:** Moved `s.workflow?.stop()` after the recoverability/re-attach branch (and into `markDead()` for remote sessions) in `server/ws-handler.js`, and added a one-shot correction reminder in `server/terminal-workflow.js` asking the agent to re-emit its signal with the exact iteration identifier without redoing work.
* **🛠️ Codebase:**
  * `server/ws-handler.js` — deferred `s.workflow?.stop()` until unrecoverable session death in local and remote PTY exit handlers.
  * `server/terminal-workflow.js` — added `MAX_BAD_IDENTIFIER_RETRIES = 1`, `badIdentifierRetries` tracking per pass, and `buildBadIdentifierPrompt(identifier)`.
  * `server/agent-history/codex.js` — included `vscode`, `atlas`, and `chatgpt` interactive sources and read `recency_at_ms` instead of `updated_at_ms`.
* **🧪 Tests:**
  * `client/src/utils/__tests__/pipelineRunStatus.test.js`, `client/src/components/tasks/__tests__/TaskView.test.jsx` — updated and added tests for live and settled per-stage durations.
  * `server/__tests__/ws-handler.test.js` — added regression test verifying recoverable tmux client exits do not stop active workflows while session death does.
  * `server/__tests__/terminal-workflow.test.js`, `server/__tests__/terminal-workflow-ws.test.js` — updated tests for one-shot signal identifier retry and failure on a second mismatch.
  * `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx`, `server/__tests__/agent-presets.test.js`, `server/__tests__/agent-history/readers.test.js` — added coverage for the Muse Code preset and Codex history sources/recency.

## [2026-11-21] - Fix remote background terminal attach and remote task landing

### Executive Summary
* Remote workflow runs can now attach to remote tmux terminals in the background and inspect or land remote tasks without failing on local-only runtime checks or local Git calls.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Starting a workflow on a remote host failed immediately with `Background attach requires a terminal runtime.` because `attachBackgroundSession` required a synchronous `runtime.spawn()` method, while remote `hostRuntime`s expose `spawnAsync()`/`isSessionRecoverableAsync()`. In addition, task status/landing requests failed with 500 (`Task request failed`) because `task-landing.js` computed host-scoped `tools` in `load()` but ignored them and ran local `execFile`/`fs` against remote paths.
  * **Solution:** Added async remote-aware `attachBackgroundSessionAsync` and `backgroundSessionAvailableAsync` in `server/ws-handler.js`, awaited them in `server/pipelines/run-engine.js`, fixed `resolveHostRuntime(sessionId)?.host` in `server/index.js`, and threaded `tools` through every helper and action in `server/tasks/task-landing.js`.
* **🛠️ Codebase:**
  * `server/ws-handler.js` — added `backgroundSessionAvailableAsync` and `attachBackgroundSessionAsync` supporting both sync local runtimes and async remote `hostRuntime`s with `registerRemotePtyExitHandler`.
  * `server/pipelines/run-engine.js` — awaited `attachBackground` and made `terminalStillThere` and `findAgentTerminal` async.
  * `server/index.js` — wired `attachBackgroundSessionAsync`, `backgroundSessionAvailableAsync`, and `resolveHostRuntime(sessionId)?.host` into `pipelineRunEngine`.
  * `server/tasks/task-landing.js` — threaded `tools` from `load()`/`inspect()` into `remotes`, `currentBranch`, `movedPast`, `sameBytes`, `sameFolder`, `sameFile`, `isVerifiedRunAttachment`, `listUnverifiedAttachments`, `listIgnoredAtRisk`, `removeFolder`, `removeFiles`, `afterFinished`, `closeInspected`, `commit`, `merge`, and `pullRequest`.
* **🧪 Tests:**
  * `server/__tests__/cross-host-sync.test.js` — added regression tests for remote `attachBackgroundSessionAsync`/`backgroundSessionAvailableAsync` and remote `createTaskLanding` inspection via `resolveHostTools`.

## [2026-11-21] - Fix remote-host workflow runs executing locally

### Executive Summary
* Starting a workflow on a remote host now actually creates the task and executes every step on that remote host instead of silently falling back to `local`. Both the client request hook and the server's pipeline run engine now preserve and forward the selected host end-to-end across session creation, run notes, worktree checks, and remote filesystem calls.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Starting a workflow from `RunWorkflowDialog` with a remote host selected silently ran on `local` because `usePipelineRuns.startRun` dropped `host` and `skipSync` before calling `POST /api/pipelines/runs`. Downstream, `createRunEngine`, `createRunPlaces`, `createTerminalInFolder`, and `host-fs.js` also lacked remote-host forwarding/support for step sessions, run notes, path checks, and `stat().nlink`/`open().readFile()`/`mkdir` `EEXIST`.
  * **Solution:** Forwarded `host` and `skipSync` in `usePipelineRuns.startRun`, propagated `run.host` through `createRunEngine` and its host-scoped helpers in `server/index.js`, made `createRunPlaces` and `createTerminalInFolder` host-aware, and added `nlink`, `open().readFile()`, and `EEXIST` support to remote `createHostFs`.
* **🛠️ Codebase:**
  * `client/src/hooks/usePipelineRuns.js` — destructured and forwarded `host` and `skipSync` in `startRun` to `apiStartRun`.
  * `server/pipelines/run-engine.js` — forwarded `run.host` to `startSession`, `prepareNotes`, `writeBrief`, `readNote`, `writeFeedback`, `verifyAttachments`, `listDirtyPaths`, `inspectCommitWorktree`, and `pathExists`, and allowed injecting `writeCommitNote`.
  * `server/pipelines/run-notes.js` — added optional `{ fs }` parameter to `writeCommitNote`.
  * `server/pipelines/run-places.js` — resolved the run host's location path/repositories via `getProjectLocation` and executed Git through `resolveHostTools(run.host).execFile`.
  * `server/pipelines/terminal-folder.js` — accepted an optional host-aware `resolveRealpath(sessionId, target)` resolver.
  * `server/host-fs.js` — included `nlink` in remote `stat()`, added `readFile()` to remote `open()` handles, and mapped non-recursive `mkdir` `File exists` failures to `EEXIST`.
  * `server/index.js` — wired `terminalInFolder`, `listRunPlaces`, `prepareNotes`, `readNote`, `writeFeedback`, `writeBrief`, `writeCommitNote`, `verifyAttachments`, and `inspectCommitWorktree` through `resolveHostTools`.
* **🧪 Tests:**
  * `client/src/hooks/__tests__/usePipelineRuns.test.jsx` — added regression test verifying `host` and `skipSync` are forwarded to `POST /api/pipelines/runs`.
  * `server/__tests__/pipeline-run-engine.test.js` — added regression test verifying `run.host` is forwarded to `startSession`, notes, and resume `pathExists`.
  * `server/__tests__/pipeline-run-places.test.js` — added regression test verifying `createRunPlaces` resolves remote host locations and uses `resolveHostTools(run.host).execFile`.
  * `server/__tests__/cross-host-sync.test.js` — added regression test verifying remote `createHostFs` supports `stat().nlink`, `open().readFile()`, and `mkdir` `EEXIST`.

## [2026-11-21] - Cross-host Git sync, multi-repo project workspaces, and Hosts & sync input fix

### Executive Summary
* Projects can now span multiple hosts and multiple related repositories (`backend`, `frontend`, `mobile-app`, `mcp`, etc.) with automatic `git pull --ff-only` syncing, auto-detected Git remotes, parent workspace-folder auto-discovery, and one-click multi-repo cloning onto remote hosts. Also fixed a bug where the **Hosts & sync** dialog inputs ignored typing because their `onChange` handlers expected DOM events instead of string values.

### Technical Details
* **✨ New Feature:**
  * `server/project-config.js` — evolved project normalization to multi-host `locations[]` with `defaultHost`, `gitUrl`, `autoSync`, `workspaceMode` (`repo` | `folder`), and a project-level `repoManifest` (`upsertManifestRepo`, `removeManifestRepo`).
  * `server/git-sync-service.js`, `server/host-exec.js`, `server/host-fs.js`, `server/host-tools.js`, `server/terminal-session-host-store.js` — added cross-host Git sync (`git pull --ff-only` across all bound repos), remote clone, SSH exec/fs adapters, and per-session host routing.
  * `server/routes/projects.js`, `server/routes/hosts.js`, `server/host-service.js`, `server/host-runtime-resolver.js` — added cross-host location bind/clone/remove/sync endpoints, `POST /api/projects/:name/discover-remotes`, multi-repo `locations/clone`, `locations/:host/clone-missing`, and child Git repo auto-discovery for workspace-folder projects.
  * `server/project-repositories.js`, `server/routes/project-repositories.js`, `server/tasks/task-service.js`, `server/tasks/task-store.js`, `server/tasks/task-landing.js`, `server/routes/tasks.js`, `server/routes/pipelines.js`, `server/pipelines/run-store.js`, `server/pipelines/run-worktree.js`, `shared/pipeline-definitions.mjs` — extended repositories, tasks, and workflow runs to support multi-host execution and workspace-folder projects.
  * `client/src/components/ProjectLocationsDialog.jsx`, `client/src/components/SyncConflictDialog.jsx`, `client/src/components/HostsSection.jsx`, `client/src/components/ProjectRepositoriesDialog.jsx`, `client/src/components/Sidebar.jsx`, `client/src/components/TerminalArea.jsx`, `client/src/components/DirectoryBrowser.jsx`, `client/src/components/tasks/NewTaskDialog.jsx`, `client/src/components/pipelines/RunWorkflowDialog.jsx`, `client/src/App.jsx`, `client/src/utils/tasksApi.js`, `client/src/utils/pipelinesApi.js` — added Hosts & sync dialog with auto-discovered multi-repo remotes, selective multi-repo cloning, `Clone missing`, sync conflict handling, and cross-host task/workflow controls.
* **🐛 Bug Fix:**
  * **Problem:** Typing in the Git repository URL / Destination path inputs or changing Target host in `ProjectLocationsDialog.jsx` threw `TypeError: Cannot read properties of undefined (reading 'value')` because `TextInput` and `Select` pass string values directly to `onChange`.
  * **Solution:** Updated all three handlers in `client/src/components/ProjectLocationsDialog.jsx` to accept string values directly (`onChange={setGitUrl}`, `onChange={setSelectedHost}`, `onChange={setTargetPath}`).
* **🛠️ Codebase:**
  * `server/index.js`, `server/mobile-session-start.js`, `server/project-deletion-service.js`, `server/routes/terminal-delete.js`, `server/terminal-session-worktree-start.js` — wired host-aware session startup, sync hooks, and cleanup across local and remote locations.
* **🧪 Tests:**
  * `server/__tests__/multi-repo-projects.test.js`, `server/__tests__/cross-host-sync.test.js`, `client/src/components/__tests__/ProjectLocationsDialog.test.jsx`, `client/src/components/__tests__/SyncConflictDialog.test.jsx` — added unit and API tests covering cross-host sync, workspace-folder auto-discovery, `discover-remotes`, multi-repo clone, `clone-missing`, and dialog input/multi-repo interactions.
  * `client/src/components/__tests__/Sidebar.test.jsx`, `server/__tests__/mobile-session-start.test.js`, `server/__tests__/project-repositories.test.js`, `server/__tests__/task-service.test.js`, `server/__tests__/task-store.test.js` — updated existing tests for cross-host project locations.

## [2026-11-21] - Live CLI and UI sync across backend restarts and mid-pass exits

### Executive Summary
* Workflow runs now stay in sync with live CLI agents across backend restarts instead of being marked `Interrupted` while the model is still actively working. Active pass state is persisted so the server seamlessly reattaches to running tmux sessions, picks up completion signals emitted during downtime, and immediately flags mid-pass CLI exits rather than leaving the UI stuck on `Running`.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Backend restarts unconditionally marked all `pending`, `running`, and `needs_input` pipeline runs as `interrupted` while their tmux-backed CLI sessions kept working, causing the UI to display `Interrupted` / `Resume` over a busy agent and miss completion signals. Additionally, mid-pass CLI exits back to the shell were not detected by `watchForDialog`, leaving runs stuck on `Running`.
  * **Solution:** Persisted active workflow pass state in SQLite, added non-destructive workflow reattachment and scrollback signal replay on startup reconciliation, and added debounced mid-pass exit/close detection in `watchForDialog`.
* **🗄️ Database:**
  * `server/pipelines/run-store.js` — added nullable `workflow_state` column and migration on `pipeline_runs`, `interruptOnStart` option on `createRunStore`, and `markInterrupted(id)` helper that clears `input_request` and `workflow_state`.
* **🛠️ Codebase:**
  * `server/terminal-workflow.js` — added `exportState()`, `reattach(savedState, options)`, `findPassSignal()`, and `replayScreen(screenText)` to hydrate in-flight passes without re-sending prompts or resetting context and to match only signals from the active pass.
  * `server/pipelines/run-engine.js` — persisted `workflowState` on pass start and transitions, added `reconcileOnStartup()` and `observeReattachedStep()` to reattach to live tmux sessions (or mark truly non-recoverable runs `interrupted`), and added 2-poll debounced `exited`/`closed` detection in `watchForDialog`.
  * `server/index.js` — initialized `pipelineRunStore` with `{ interruptOnStart: false }` and invoked `await pipelineRunEngine.reconcileOnStartup()` before mounting pipeline routes.
* **🧪 Tests:**
  * `server/__tests__/terminal-workflow.test.js` — added tests for `exportState`, `reattach`, `replayScreen` scrollback filtering, and `reset_output` timer recovery.
  * `server/__tests__/pipeline-run-store.test.js` — added tests for `workflowState` persistence, `interruptOnStart: false`, and `markInterrupted`.
  * `server/__tests__/pipeline-run-engine.test.js` — added tests for startup reattachment to a still-working CLI, downtime signal replay ignoring older scrollback signals, truthful interruption when a CLI exited, and debounced mid-pass CLI exit detection.

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

## [2026-11-21] - Workflow efficiency, autonomous self-improvement, and resilient run controls

### Executive Summary
* Workflows now avoid no-op reviews, skip clean Commit launches on build workflows, debounce transient terminal dialogs, and remove redundant pre-coding approval pauses so tasks finish faster with fewer manual interruptions. Background self-improvement no longer wastes its daily budget on obsolete revisions or transient interruptions, reserves a dedicated lane for team delivery assessments, and lowers trial cohorts to three cross-project runs so autonomous recommendations actually trigger in day-to-day use.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Background workflow reviews re-queued the same runs on transient `interrupted`/`error`/`stopped` states, kept burning daily budget on obsolete workflow revisions, timed out at 65s with swallowed CLI errors, and starved `team_delivery_reviews` of shared budget.
  * **Solution:** Excluded `interrupted` runs and added a 6-hour cooldown for non-complete outcomes in `server/pipelines/improvement-evidence.js`; deduplicated active jobs, auto-purged obsolete revision jobs, and split the daily budget into dedicated `workflow` (6) and `team` (6) lanes in `server/pipelines/improvements.js`; increased review CLI timeout to 180s (`185s` circuit breaker) and logged underlying CLI failures in `server/cli-naming-client.js` and `server/index.js`.
  * **Problem:** Transient TUI redraws flapped `needs_input`, terminal query replies (OSC/string sequences) could prematurely resume `needs_input`, and `Develop` committing early left `Review` inspecting empty working trees.
  * **Solution:** Debounced `watchForDialog` `needs_input` transitions to two consecutive polls and added 15-minute silent-stall warnings in `server/pipelines/run-engine.js`; hardened escape-sequence parsing across chunks in `server/terminal-workflow.js`; updated `Develop` and `Review` prompts in `shared/workflow-templates.mjs` so changes stay uncommitted and `Review` inspects both uncommitted and branch-committed diffs.
* **✨ New Feature:**
  * `shared/scoring/team.mjs`, `shared/scoring/index.mjs`, `shared/team-score-responses.mjs`, `server/pipelines/team-trials.js`, `client/src/components/pipelines/builder/TeamTrial.jsx`, and `client/src/components/pipelines/builder/TeamImprovements.jsx` — lowered team trial cohorts from five to three runs and grouped trials across projects by `(teamId, teamRevision, workflowId, workflowRevision, configurationKey)`.
  * `shared/scoring/workflow.mjs` — relaxed `compareWorkflow` to compare ≥ 3 runs per side across projects while preserving safeguard checks.
  * `server/pipelines/released-task-run.js`, `server/pipelines/run-machine.js`, `server/pipelines/run-engine.js`, and `server/routes/pipelines.js` — allow reclaiming and resuming a dismissed run while its task still owns the same open worktree, and enable `inspectCleanCommit` for `feature-build` and `feature-from-requirements` workflows.
  * `client/src/components/tasks/QuestionsPanel.jsx`, `client/src/components/tasks/TaskView.jsx`, and `client/src/components/pipelines/PipelineRunsBar.jsx` — preserve unsent question answer drafts across re-renders and add confirmation prompts before closing/cleaning up runs.
* **🗄️ Database:**
  * `server/pipelines/improvements.js` — added idempotent `lane` column migration (`TEXT NOT NULL DEFAULT 'workflow'`) on `improvement_calls`.
* **🛠️ Codebase:**
  * `shared/workflow-templates.mjs` — streamlined pre-coding approval gates to a single gate (`Specify`) on `Bug fix` and `Feature from requirements`, and aligned `Commit` outcome guidance across templates.
* **🧪 Tests:**
  * Updated and added unit/integration coverage in `server/__tests__/workflow-improvements.test.js`, `server/__tests__/team-trials.test.js`, `server/__tests__/team-scoring-engine.test.js`, `server/__tests__/team-score-responses.test.js`, `server/__tests__/workflow-templates.test.js`, `server/__tests__/pipeline-run-engine.test.js`, `server/__tests__/pipeline-run-machine.test.js`, `server/__tests__/pipelines-api.test.js`, `server/__tests__/terminal-workflow.test.js`, `server/__tests__/agent-profile-generalization.test.js`, `server/__tests__/released-task-run.test.js`, `client/src/components/pipelines/builder/__tests__/TeamImprovements.test.jsx`, `client/src/components/pipelines/__tests__/PipelineRunsBar.test.jsx`, `client/src/components/tasks/__tests__/QuestionsPanel.test.jsx`, and `client/src/components/tasks/__tests__/TaskView.test.jsx`.

## [2026-11-20] - Attach files in the Run workflow dialog

### Executive Summary
* Pick or drop several reference files before starting a workflow so the agent can open them in its run checkout. The larger description field lets you review dictated or pasted paragraphs before submitting.

### Technical Details
* **✨ New Feature:**
  * `RunWorkflowDialog.jsx`, `RunWorkflowDialog.css` and `WorkflowAttachments.jsx` provide the resizable input, file picker, drop area, removal controls and retry actions.
* **🛠️ Codebase:**
  * `pipelinesApi.js`, `usePipelineRuns.js`, `App.jsx` and `Improvements.jsx` send files through both launch paths and preserve the submission on retry.
  * `workflow-attachments.mjs` and `attachments.js` share filename and batch limits across the dialog and server.
* **🧪 Tests:**
  * `RunWorkflowDialog.test.jsx` and `pipelinesApi.test.js` cover file selection, multiline input, retry, cancellation and multipart serialization.

## [2026-11-20] - Workflow start attachment and multiline input support

### Executive Summary
* The workflow API accepts reference files and multiline descriptions. Agents can read the files from the run checkout and receive the description with its paragraph breaks intact. The Run workflow dialog still needs the file picker and multiline editor.

### Technical Details
* **🔌 API/Interface:**
  * The run start endpoint accepts multipart uploads, keeps JSON starts compatible, and returns the published attachment names, paths and sizes.
* **🛠️ Codebase:**
  * Run storage, notes and agent guidance carry the attachment manifest and multiline description. Attachments are checked before agent attempts, and cleanup preserves unsafe or changed attachment paths.
  * The verifier rejects named pipes without waiting for a writer. Checkout cleanup protects a dangling attachment-folder symlink.

## [2026-11-20] - Team scoring, measured model trials and workflow approval feedback

### Executive Summary

* Teams can compare delivery speed and accuracy, inspect the evidence for a score, and correct a verdict. Owners can approve a model or effort change for five comparable runs, see whether it helped, and decide separately whether to keep it. Workflow proposals now show when an approval is stale or has failed.

### Technical Details

* **✨ New Feature**
  * The Teams view in Improvements shows scorecards, run evidence, correction history, trial assignments and results. Adoption updates the selected team's role and preserves other teams that share its agent.
* **🐛 Bug Fix**
  * Workflow approval cards display revision conflicts and decision errors at the point of action.
* **🛠️ Codebase**
  * Versioned policies in `shared/scoring` calculate workflow and team measurements from observations. Run attribution records the effective configuration for each attempt, and the review worker reassesses deliveries when new verification arrives.
* **🔌 API/Interface**
  * Team scoring routes provide paginated scorecards, runs, history and trials. Changes require the revision the owner reviewed.
* **🧪 Tests**
  * The scoring, launcher, API and dashboard suites exercise attribution, evidence, trial limits and adoption. The browser test runs the owner flow against disposable SQLite data.

## [2026-11-19] - Workflow evidence, background reviews and an improvements dashboard

### Executive Summary
* Bug fix and Troubleshoot can skip an unnecessary Commit session and pause when acceptance evidence is missing. The Improvements dashboard links performance statistics to the runs behind them. Owners can approve suggestions and track whether they helped.

### Technical Details
* **✨ New Feature:**
  * The workflow builder, Improvements view, proposal panel and run dialog support evidence drill-down, reviewer configuration, approval and implementation handoff.
  * The reviewer schedules evidence-backed proposals, measures approved changes and tests candidate reviewer instructions against owner-labelled cases.
* **🛠️ Codebase:**
  * Workflow templates and the run engine merge the Troubleshoot investigation and verify repository state before skipping Commit. Run notes preserve owner decisions.
  * Workflow stores, API routes, CLI integration and the background worker record timing boundaries, enforce call limits and check revision conflicts.
* **🧪 Tests:**
  * Runner, template, report, API, CLI and dashboard tests cover evidence pauses, clean worktrees, approval conflicts, comparable workloads and reviewer evaluation.

## [2026-11-19] - A run shows how long each step took, and how long it has been going

### Executive Summary
* In the task view, a finished step now says how long it worked in the step rail on the left ("Done · 4m 12s"), and the header counts the whole run: once a second while it is going ("12m 5s"), and "took 1h 5m" once it is over.
* A step's time is its total: every round of a loop and every attempt after Resume or Send back is added up by the backend. Waiting for your answer counts as work; waiting for your approval, waiting for the next round and lying interrupted do not.
* The run's time runs from its start to its end and includes all the time it waited for you; an interrupted run stops counting at its last change.
* Steps that finished before today have only their last start on record. They show that stretch, or nothing when it is not known.

### Technical Details
* **🗄️ Database:** each step in `pipeline_runs.steps` gains `elapsedMs` (integer ≥ 0). At startup, steps stored without it get the time from their last start to its end when both are stored, and 0 otherwise.
* **🛠️ Codebase:**
  * `server/pipelines/run-machine.js` — `addWorkedTime(step, at)` adds the stretch a working step (launching, running or waiting for input) has just ended, on complete, approval requested, limit reached, loop back, error and stop. Approve adds nothing, since the work ended when approval was asked for. It refuses a working step without a start time, an event without a time and an end before the start.
  * `server/pipelines/run-store.js` — validates and keeps `elapsedMs`; the upgrade above.
  * `server/routes/pipelines.js` — a run's steps carry `elapsedMs`.
  * `client/src/utils/pipelineRunStatus.js` — `describeStepDuration(step)` (null unless the step is done and has a time) and `describeRunDuration(run, now)` (`{words, live}`); a device clock behind the backend's shows "under 1s", never a negative time.
  * `client/src/utils/pipelineRunRecords.js` — `elapsedMs` is checked when sent and may be absent, because the phone reads runs with this parser from a backend older than itself.
  * `client/src/components/tasks/TaskView.jsx` — the step rail adds the time to a step's words and to its accessible name; the header shows the run's time and ticks once a second only while the run is not over.
* **📚 Documents:** `README.md`, `docs/steering/api-standards.md`.
* **🧪 Tests:** `server/__tests__/pipeline-run-machine.test.js` (8 cases: each way a stretch ends, attempts and rounds added up, approval and interruption left out, the refused inputs), `pipeline-run-store.test.js` (validation, keeping, the upgrade), `client/src/utils/__tests__/pipelineRunStatus.test.js`, `pipelineRunRecords.test.js` and `components/tasks/__tests__/TaskView.test.jsx`. Stored-step fixtures in four server test files carry the new field.
* **Not covered:** not seen in a browser, which needs a live run. A stretch cut short by a backend restart is not counted, because its end is not known. The phone's run view is unchanged.

## [2026-11-19] - Changes: what was merged in a project, with a summary of each

### Executive Summary
* After a task was merged, nothing said what the change had been: the app shows open tasks only, the merge left no trace in Git when it fast-forwarded, and the branch was deleted. A project's menu in the sidebar now has **Changes…**: the tasks merged in that project, newest first, each with its title, when it was merged, its workflow, the repositories it landed in and a summary.
* The summary is written by the run. The last step of a run, the Commit step in the built-in workflows, is now told that the owner reads its note in the list of changes, and to start the note with one line saying what the run changed, followed by what changed and why. The list shows that line; **Details** opens the rest of the note. This applies to workflows already saved, without editing them.
* A merge now keeps the commit its checkout stood at afterwards, shown beside each repository of a change, so the change can be found in Git once its branch is gone.
* Tasks merged before today are listed too, with the note their last step wrote then and no commit. A task merged without a run, or whose last step wrote no note, says so in place of a summary.

### Technical Details
* **🗄️ Database:** `task_worktrees.merged_commit` (TEXT, null unless the worktree is merged; added to existing databases at startup). Nothing else is stored: a change is read from the task, its merged worktrees and `pipeline_run_notes`.
* **🛠️ Codebase:**
  * `server/pipelines/step-guidance.js` — `summaryStepIndex(definition)`: the run's last agent step, or null for a run without notes; that step gets one more sentence of guidance. The prompt preview shows it, since it is built by the same function.
  * `server/tasks/task-changes.js` (new) — `createTaskChanges({taskStore, noteStore, listRuns}).list()`: one change per task with a merged worktree, with the last written note of the summary step of the task's most recent run, newest merge first. Every field it reads of a run is checked.
  * `server/pipelines/note-store.js` — `lastWritten(runId, stepIndex)`: the note a step last wrote, in full.
  * `server/tasks/task-store.js` — `setWorktreeState` takes `mergedCommit` with a merge only; a stored one on a worktree that is not merged, or that is not a commit id, fails loudly.
  * `server/tasks/task-landing.js` — after a merge, reads `HEAD` of the checkout merged into and records it.
  * `server/routes/tasks.js` — `GET /api/tasks/changes` (page, size, `sort=mergedAt,asc|desc`, filter `project`), registered before `/:id`; the router now requires `changes.list`.
  * `client/src/utils/tasksApi.js` — `parseChange`, `listTaskChanges`.
  * `client/src/components/tasks/ChangesDialog.jsx` (new) and the **Changes…** entry in `Sidebar.jsx`, for local projects.
* **📚 Documents:** `README.md`, `docs/steering/product.md`, `structure.md` and `api-standards.md`.
* **🧪 Tests:**
  * `server/__tests__/task-changes.test.js` (new, 8 cases), `tasks-api.test.js` (the changes list: envelope and exact fields, empty and past-the-end pages, ties across a page boundary, the project filter with a hostile name, null fields and hostile text, 14 refused queries, the limits, two requests at once, GET only, a hidden failure), `task-store.test.js`, `task-landing.test.js`, `pipeline-note-store.test.js`, `pipeline-step-guidance.test.js`.
  * `client/src/components/tasks/__tests__/ChangesDialog.test.jsx` (new, 10 cases), `utils/__tests__/tasksApi.test.js`, `components/__tests__/Sidebar.test.jsx`.
* **Not covered:** a task merged outside CodeDeck or through a pull request is not listed, and neither is a run in Main, which has no task. When a task had several runs the summary is the most recent run's. The summary is as good as the note the agent writes; no run has yet been made with the new guidance.

## [2026-11-19] - Run workflow sits beside New task, and both ask for a new task the same way

### Executive Summary
* **Run workflow** was an unlabelled Play icon among a tab's own actions, beside Session search, although a run works in a task or in Main and by default creates a new task. It is now a labelled button beside **New task**, in the strip of Main and the project's tasks, and is offered for local projects only, as New task is.
* The two dialogs asked for the same thing, a new task, with different controls: New task had one tick list of repositories with the branch each copy starts from, Run workflow had a select and "Also include …" boxes with no branch. Both now show the same title input and the same **Repositories** list. In Run workflow the repository the run starts in is ticked, cannot be unticked and is marked "the run starts here"; **Start in** has a visible label.
* The Run workflow dialog opened on the task being looked at even when that task could not take a run, with Start disabled. It now opens on a new task in that case, and choosing **An open task** selects the first one a run can start in. The reason shown for a busy task or a busy Main no longer says "worktree".

### Technical Details
* **🛠️ Codebase:**
  * `client/src/components/tasks/NewTaskFields.jsx` (new) — `TaskTitleInput` (the title, at most `TASK_TITLE_MAX` characters, with the placeholder for a required or an optional title) and `TaskRepositories` (the tick list, with `startsIn` for the repository that is always included). `TaskRepositories` refuses a `repositories` that is not an array, a `ticked` that is not a Set, an `onToggle` that is not a function and a `startsIn` that is not one of the repositories.
  * `client/src/components/tasks/NewTaskDialog.jsx` — uses the two shared pieces in place of its own input and fieldset.
  * `client/src/components/pipelines/RunWorkflowDialog.jsx` — uses the shared pieces for a new task; the Start in options are named by repository alone, since the list says where each copy starts from, and the select has a visible label. `place` and `taskId` now hold only what the owner chose: until then the dialog shows the task named by `defaultTaskId` when its worktree is selectable, and a new task otherwise.
  * `client/src/components/TerminalArea.jsx` — the Run workflow button moved from the tab bar's actions to the strip of Main and tasks, with its name and a tooltip, shown where New task is.
  * `client/src/styles/global.css` — the strip's action buttons keep their extra margin only after a task, not between each other.
  * `server/routes/pipelines.js` — the `in_use` reason reads "An open workflow run is already using it.", in the worktree list, the preflight reasons and the 409 a refused start returns.
* **📚 Documents:** `README.md`, `docs/steering/structure.md` and the workflow pipelines specification.
* **🧪 Tests:**
  * `client/src/components/tasks/__tests__/NewTaskFields.test.jsx` (new, 12 cases) — the title input and its two placeholders; the list with each copy's starting point; an unusable repository; toggling; nothing ticked; the repository a run starts in kept ticked; disabled; the four refused inputs.
  * `client/src/components/pipelines/__tests__/RunWorkflowDialog.test.jsx` — the shared list in a project with several repositories and with a todo's Repositories line; the visible Start in label; opening on a new task when the task looked at cannot take a run, and showing that task with its reason when no open task can.
  * `client/src/components/__tests__/TerminalAreaWorktree.test.jsx`, `TerminalAreaWorktreeFilter.test.jsx` — Run workflow in the strip, by name, once, calling `onOpenRunWorkflow`; none for a remote project.
  * `server/__tests__/pipelines-api.test.js` — the new `in_use` wording in the five places it is returned.
* **Not covered:** the dialog opening on a new task for a busy task was not seen in a browser, because that needs a live run; it is verified by tests only. The other reasons a place cannot be chosen (folder missing, unreadable, no branch checked out) still say "worktree".

## [2026-11-19] - Close run closes the terminals the run used

### Executive Summary
* **Close run** took a finished run off the screen and left its step terminals open, where they turned into ordinary tabs of the task and rows in the sidebar. It now closes the terminals the run's steps used, for a run that is complete, stopped, failed or interrupted, and the toast says how many. An agent still working in one of them is stopped with it.
* Nothing else is closed: a terminal you opened in the task or in Main yourself stays, as does one another run still on screen uses, and the task's files and branch are untouched. Only pressing Close run does this. A run that is closed because another run starts in its place keeps its terminals, since the new run goes on in the tabs its agents already have.
* A terminal that could not be closed is named in an error toast and keeps its tab; the run is closed all the same.

### Technical Details
* **🛠️ Codebase:**
  * `server/pipelines/run-terminals.js` (new) — `createRunTerminalCloser` closes each step's `sessionId` and `priorSessionIds` when the terminal is still open, was started in the run's worktree and is not recorded by another open run. The worktree check is there because a session id is given out again after a restart, so an id a step recorded can later name a terminal opened elsewhere. `createTerminalPlaces` reads where a terminal was started: its recorded worktree, or the project's own folder.
  * `server/routes/pipelines.js` — `POST /api/pipelines/runs/:id/cleanup` closes the run through the engine as before, then closes its terminals and adds `terminalsClosed` and `terminalsNotClosed` to the run it returns. A run left `removal_blocked` is still open and keeps its terminals. The router now requires `closeRunTerminals`.
  * `server/index.js` — wires the closer to the session map, the terminal worktree store and the session deleter.
  * `client/src/utils/pipelinesApi.js`, `client/src/hooks/usePipelineRuns.js`, `client/src/components/TerminalArea.jsx`, `client/src/components/tasks/TaskView.jsx` — the response is checked, the toasts report the terminals closed and not closed, the closed terminals' tabs are removed, and the wording on a finished run and the button's tooltip say what Close run does.
* **📚 Documents:** `README.md`, `docs/steering/product.md`, `docs/steering/structure.md`, `docs/steering/api-standards.md` and the workflow pipelines specification.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-terminals.test.js` (new, 17 cases) — the run's terminals closed once each; a hand-opened terminal in the same worktree kept; a dead or already closed one skipped; one whose id now names a terminal elsewhere kept; a run in Main; one another open run uses kept; a failed close reported; refused inputs.
  * `server/__tests__/pipelines-api.test.js` — Close run for a complete, stopped, failed and interrupted run; a second Close run refused; a terminal not closed still closes the run; the other open runs passed along; a `removal_blocked` run keeps its terminals; no terminal closed on a refused Close run, on Stop or Resume, or when another run takes a finished run's place; a malformed answer from the terminal layer is a 500 problem.
  * `client` — `pipelinesApi.test.js`, `usePipelineRuns.test.jsx`, `TerminalAreaWorktreeFilter.test.jsx` and `TaskView.test.jsx` cover the checked response, the toasts, the tabs removed and kept, and the wording.
* **Not covered:** a terminal the owner closed by hand whose id, after a backend restart, went to a new terminal opened in the same worktree is taken for the run's and closed with it. Not checked in a browser against a live run; verified by tests only.
## [2026-11-19] - Close task lists ignored files that exist only in the task and deletes them when you agree

### Executive Summary
* A task whose folder held a file Git ignores that exists nowhere else could not be closed: Close task was disabled, the reason was only its tooltip, and the files had to be deleted by hand. Two leftover tasks were stuck this way on Gradle caches, `.project` and `logs/`. The bar now counts such files, Close task lists them by name, and **Delete files and close** closes the task and deletes them. Without that choice nothing is deleted.
* Gradle caches (`.gradle`) now go with a task's folder without asking, like `node_modules` and `build`.

### Technical Details
* **🛠️ Codebase:**
  * `server/tasks/task-landing.js` — the landing status lists `ignoredAtRisk` (at most 50) with `ignoredAtRiskCount`. `close` and `closeWorktree` take `{deleteIgnored}`; true lifts only the `ignored_files` blocker, and anything but true or false is refused with 400. `.gradle` joined the disposable folders. Merge is unchanged: it still keeps a folder that holds such files.
  * `server/routes/tasks.js` — `POST /:id/close` and `POST /:id/worktrees/:worktreeId/close` accept no body or `{deleteIgnored}`; a request without a body behaves as before.
  * `client/src/utils/tasksApi.js` — `parseLanding` requires the two fields; `closeTask` and `closeTaskWorktree` send `{deleteIgnored: true}` only when asked to.
  * `client/src/components/tasks/ignoredFiles.js` (new), `TaskLandingBar.jsx`, `TaskRepositoriesLanding.jsx` — Close is refused by every reason except ignored files; its dialog lists them, per repository for a whole task, and its button reads "Delete files and close".
* **📚 Documents:** `README.md` (Tasks) and `docs/steering/api-standards.md`.
* **Known limit:** the dialog lists the files read at the last refresh (every five seconds). An ignored file created between that and the click is deleted with the folder without having been listed.
* **🧪 Tests:** `server/__tests__/task-landing.test.js`, `task-landing-repositories.test.js`, `tasks-api.test.js`; `client/src/utils/__tests__/tasksApi.test.js` and the tests of both landing components.

## [2026-11-19] - A task merged outside CodeDeck says its commits are already in the base branch

### Executive Summary
* A task whose branch was merged into its base branch with plain Git read "No changes yet", and Merge and Open a pull request were disabled because "This task has no commits of its own yet." Both were wrong: the task had commits, and they were already in the base branch. Such a task now reads **Commits already in `main`**, and the two buttons say that there is nothing left to merge and that Close task finishes it. A task that has done nothing reads "No changes yet" as before. Nothing is finished automatically.

### Technical Details
* **🐛 Bug Fix:**
  * `server/tasks/task-landing.js` — the landing status has `alreadyInBase`: true when the worktree has no commit its base lacks (`commitsAhead` 0) and `git rev-list --count <baseCommit>..HEAD` is above 0, false otherwise, null when Git was not asked (files gone, or the worktree finished). The merge and pull-request blockers then carry `already_in_base` in place of `nothing_to_land`. Each worktree of a task with several repositories is judged on its own, against the checkout it is listed with. A task started from a commit has no base branch and is never reported this way.
  * `server/routes/tasks.js` — `alreadyInBase` is part of how one repository stands.
  * `client/src/utils/tasksApi.js` — `parseLanding` requires `alreadyInBase` (true only with `commitsAhead` 0, false or null).
  * `client/src/components/tasks/TaskLandingBar.jsx`, `TaskRepositoriesLanding.jsx` — show "Commits already in `<base branch>`" in place of "No changes yet"; the reason is the title of the disabled buttons.
* **📚 Documents:** `README.md` (Tasks) and `docs/steering/api-standards.md` (`GET /:id/landing`).
* **Known limits:** a task whose branch only caught up with its base branch (for example `git merge main` in it, with no commit of its own) reads the same, because the two histories are identical. A squash or rebase merge outside CodeDeck is not recognised: Git sees different commits, so the task still shows them as not yet in the base branch.
* **🧪 Tests:**
  * `server/__tests__/task-landing.test.js` — fresh task, own commit, fast-forward merge outside CodeDeck with the base moved on, new work afterwards, a merge commit with uncommitted files beside it, a task started from a commit, and vanished files.
  * `server/__tests__/task-landing-repositories.test.js` — one repository already in its base branch and one untouched in the same task.
  * `server/__tests__/tasks-api.test.js`, `client/src/utils/__tests__/tasksApi.test.js`, and the tests of both landing components.

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

## [2026-11-19] - Resume waits for an agent that is still working, and Codex is read as working while it writes

### Executive Summary
* A run step failed with "did not become ready within 120 seconds (last reason: agent_working)" when Resume was pressed while the agent in that terminal was still in a turn. The 120 seconds are a limit on a launch; a step that returns to a terminal now waits for an agent, or a sub-agent it started, for as long as it works. Stop, or the terminal closing, ends the wait.
* Codex hides its `• Working (…)` line while it writes text, so CodeDeck took a turn that was still running for a finished one, started the step into it, and the run then failed with "Workflow signal identifier does not match the current iteration". Codex is now also read from the run state in its footer (`· Working ·`).

### Technical Details
* **🐛 Bug Fix:**
  * `server/pipelines/run-engine.js` — `waitUntilReady` does not count time towards the readiness limit while a returning step's agent reports `agent_working` or `agent_delegated`. A first launch, an agent started again in the terminal, and any other waiting reason still fail after 120 seconds.
  * `server/agent-profiles/codex.js` — `read` treats a footer segment `Working` below the prompt as a turn in progress. A footer cut short before the run state is read as before, and a folder named Working is not taken for it.
* **📚 Documents:** `README.md` (keep `run-state` in Codex's status line) and the workflow pipelines specification (§8.4 and Known Limits).
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-engine.test.js` — Resume keeps waiting past the limit for both reasons, still fails for an agent that is neither working nor at its prompt, and counts only the time the agent is not at work.
  * `server/__tests__/pipeline-agent-readiness.test.js` — two Codex screens captured while it wrote text read as working; ready once the footer says Ready; the run state is read only below the prompt.
  * Checked read-only against four open Codex terminals that were idle: each footer said Ready and each was read as idle, before and with the change. No working Codex was open at that moment to observe.

## [2026-11-19] - A workflow run takes one entry in the sidebar

### Executive Summary
* Every task with a run listed all of the run's terminals under it in the sidebar, two lines each, so three runs filled the column. A task with a run is now one entry: its title, how the run stands and the phase it is on. The run's own terminals are folded into that entry. One of them is listed again only while it needs attention (finished and waiting for you, or dead), and a terminal you opened in the task yourself stays listed. Main and tasks without a run are unchanged.

### Technical Details
* **🛠️ Codebase:**
  * `client/src/utils/worktreeGroups.js` — `sidebarSessionsForGroup` chooses the terminals listed under a group: all of them without a run; with a run, those that are not a step's terminal (current or earlier) or that show as finished or dead.
  * `client/src/components/Sidebar.jsx` — uses it for each group's rows.
  * `README.md` — the sidebar's entry for a task with a run.
* **🧪 Tests:**
  * `client/src/utils/__tests__/worktreeGroups.test.js` — 5 cases: no run, the run's terminals folded (also one a step used before, and while busy), kept when finished or dead, and refused inputs.
  * `client/src/components/__tests__/Sidebar.test.jsx` — a task with a run shows its entry and the hand-opened terminal, not the run's terminals or their last output.

## [2026-11-19] - A todo says which repositories its work touches; one Start for all of them

### Executive Summary
* Starting work that spans repositories meant choosing every repository by hand and starting each run separately. A todo can now carry one line, `**Repositories**: backend (this todo), mobile-app (docs/todos/…-phone.md), frontend (minor)`, written by whoever writes the todo. The Run workflow dialog reads it for a new task: it starts in the repository that holds the todo, ticks the `minor` repositories to include, and offers a run for each repository that has a todo of its own. One Start then starts them all, each in its own task. Every choice can be changed first, and a line that cannot be read is shown with the reason, never guessed at.
* The Run dialog's **Start in** now reaches the backend for an open task. It was dropped on the way, so a run in an open task with several repositories started where the task started.

### Technical Details
* **🛠️ Codebase:**
  * `shared/todo-repositories.mjs` — `parseTodoRepositories` reads the line from a todo's header: names, `this todo`, `minor` or a `.md` path; at most 9 repositories; one `this todo`; a format it cannot read is a `problem`.
  * `server/routes/pipelines.js` — `POST /api/pipelines/run-plans` takes `{workflowId, project, input}` and returns where the progress file is among the project's repositories at their current commit and what its line asks for, with, for each other todo, whether it is committed there and the input a run takes for it. It reads only. `server/pipelines/run-worktree.js` — `readCommittedFile`.
  * `client/src/components/pipelines/RunWorkflowDialog.jsx` — looks the todo up 400 ms after typing stops, pre-fills Start in, "Also include…" and "Also start a run in…", and starts the ticked runs after the first. `client/src/App.jsx` — a further run does not move the view away from the first.
  * `client/src/utils/pipelinesApi.js`, `client/src/hooks/usePipelineRuns.js` — `startIn` is passed through to `POST /runs`; `planRun` and `parseRunPlan` are new.
  * `README.md`, `docs/steering/api-standards.md`, `docs/steering/structure.md` — the line, the endpoint and the module.
* **🧪 Tests:**
  * `server/__tests__/todo-repositories.test.js` — 16 cases for the parser.
  * `server/__tests__/pipelines-api.test.js` — 8 cases for the endpoint: the answer and its repeatability, a todo in another repository and one typed as its whole path, nothing to read, a line that cannot be used, a todo that is not committed or does not fit, each refused field with its boundaries, hostile input, and 404s.
  * `client` — the plan parser's guards, the request, 8 dialog cases, the app keeping its view for a further run, and `startIn` reaching the request from the hook and the API client.

## [2026-11-19] - The Repositories dialog says what is not added yet, and on which branch

### Executive Summary
* The repositories found beside a project looked as if they already belonged to it. Their section is now headed "Beside this project, not added yet", and each one shows the branch its folder is on, with a line explaining that a task starts from and merges into the folder you add. A repository whose folder is on a feature branch, with its main branch checked out in another folder, is now visible as such before it is added.

### Technical Details
* **🛠️ Codebase:**
  * `server/project-repositories.js`, `server/routes/project-repositories.js` — `GET /api/projects/:name/repository-candidates` returns `branch` with each entry (`null` when no branch is checked out). The field is added; nothing is removed. The branch is read from the folder's `.git/HEAD` file: no Git command runs in a folder that is not listed yet, because Git can run a program named in a repository's own configuration. A folder whose `.git` holds no `HEAD` Git would accept is not offered.
  * `client/src/utils/projectRepositoriesApi.js` — `parseCandidate` requires `branch` to be text or null.
  * `client/src/components/ProjectRepositoriesDialog.jsx` — the heading, the explanation and the branch on each offered row.
  * `README.md`, `docs/steering/api-standards.md` — the new field and wording.
* **🧪 Tests:**
  * `server/__tests__/project-repositories.test.js`, `project-repositories-api.test.js` — the branch of each neighbour, a neighbour with no branch checked out, no Git command in an unlisted folder, a folder without a readable `HEAD` left out, and the endpoint's envelope.
  * `client/src/utils/__tests__/projectRepositoriesApi.test.js`, `client/src/components/__tests__/ProjectRepositoriesDialog.test.jsx` — the parser's guard, the heading, the explanation and the three branch states.

## [2026-11-19] - A run accepts the progress file's whole path as its input

### Executive Summary
* A workflow whose Progress file is `docs/{input}` refused a run started with `docs/todos/feature.md`, because it looked for `docs/docs/todos/feature.md`. The run now starts: when the file as typed is not there and the input is the file's whole path, the input is read as the part that replaces `{input}`, in the progress file and in every prompt. The Run workflow dialog says both forms are accepted.

### Technical Details
* **🛠️ Codebase:**
  * `shared/pipeline-definitions.mjs` — `inputFromProgressFilePath(template, input)` returns the part of a whole path that replaces `{input}`, or null when the input cannot be read that way.
  * `server/routes/pipelines.js` — `POST /api/pipelines/runs` looks for the progress file as composed first; when it is absent, it looks for the input itself as the path and, if present, records the run with the part. The file as typed wins when both exist. When neither is present the refusal names both paths. The request reservation keeps the input as sent.
  * `client/src/components/pipelines/RunWorkflowDialog.jsx` — the hint under "What is this run about?" names both forms.
  * `README.md`, `docs/steering/api-standards.md` — the rule and the `input` a response returns.
* **🧪 Tests:**
  * `server/__tests__/pipeline-definitions.test.js` — 13 cases for the function: the part from a prefix, from a prefix and an ending, null for each input that cannot be a whole path, and a non-text argument refused.
  * `server/__tests__/pipelines-api.test.js` — 7 cases: the run starts with the part in its prompts and progress file; the file as typed wins; both paths in the refusal; a template that also ends the path; an input that cannot be a whole path keeps the one-path refusal; a replay returns the same run and the part alone under the same id is 409; a chosen worktree.
  * `client/src/components/pipelines/__tests__/RunWorkflowDialog.test.jsx` — the hint.

## [2026-11-19] - Build output in `target` goes with a closed task

### Executive Summary
* Closing a task was refused when its folder held a `target` folder, the build output of Maven and Cargo projects, because the folder is ignored by Git and exists nowhere else. It is rebuilt by the next build, so it now goes with the task, as `node_modules`, `dist`, `build` and `.codedeck` already did.

### Technical Details
* **🛠️ Codebase:**
  * `server/tasks/task-landing.js` — `target` added to the ignored folders that may go with a task's folder, at the top level and inside an ignored folder.
  * `README.md` — The Tasks section now says which ignored files keep a task's folder and which go with it.
* **🧪 Tests:**
  * `server/__tests__/task-landing.test.js` — The disposable-folders case includes `target`; it failed with "exist nowhere else: target/" before the change. All 49 landing tests pass.

## [2026-11-19] - Closing a task no longer trips over a copied settings folder

### Executive Summary
* Close and Merge keep a task's folder when it holds files Git ignores that exist nowhere else. That check treated every ignored folder as lost, even one whose files are all identical to Main's, so a task whose Setup step had copied `.local-secrets/` from Main could not be closed until the folder was deleted by hand. A folder now goes with the task when every file in it, at any depth, is copied byte for byte at the same place in Main. A folder that holds anything else is still kept: a file Main does not have, a file whose bytes differ, or a link.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Git lists a wholly ignored folder as one entry ending in `/`, and `sameBytes` in `server/tasks/task-landing.js` returned false for any such entry without looking inside it. A single ignored file, such as `.env.local`, was compared properly.
  * **Solution:** `sameFolder` walks the task's folder and requires each regular file to be a regular file of the same size and SHA-256 in Main; it stops at the first difference, does not look into disposable folders (`node_modules`, `dist`, `build`, `.codedeck`) inside it, and counts a link or any other kind of entry as one that would be lost. The refusal still names the folder.
* **🧪 Tests:**
  * `server/__tests__/task-landing.test.js` — 10 new cases: a folder that is a full copy (with a nested folder and an empty one) closes; a folder is kept for a file or nested file Main lacks, the same length with other bytes, another length, no such folder in Main, a file whose name is a folder in Main and the reverse, and a link; disposable folders inside are skipped. All 49 landing tests and the other task tests (224 in all) pass.
  * Checked read-only against a real task folder of another project: the guard on main named `.local-secrets/`, `.project`, `.settings/` and `target/`; the fixed guard names `.project` and `target/`. By checksum, `.local-secrets/` (8 files) and `.settings/` (4 files) are identical in Main and `.project` is not.

## [2026-11-19] - A refused run start says which field and why

### Executive Summary
* Starting a run showed only "One or more fields failed validation." when the backend refused it, with nothing to say which field or why. In the case found, the workflow reads its progress from `docs/{input}` and the input was the file's full path from disk, which the backend refuses because `docs//Users/…` is not a path inside the project. The backend's reason was in the response but the toast left it out, and the reason itself only said "input does not form a valid progress file path". The toast now shows what the backend says about each refused field. That refusal now names the template, shows what the progress file would have been, and says what to type. The hint under the input says the same before you start.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `failureMessage` in `client/src/hooks/usePipelineRuns.js` used only the problem's `message`, which for every 400 is the generic line; the field messages in `errors` were dropped.
  * **Solution:** when the refusal carries field messages they are shown, joined; otherwise the problem's message as before. This applies to every pipelines toast.
* **🛠️ Codebase:**
  * `server/routes/pipelines.js` — The `input` refusal for a progress file template reads: "This workflow reads its progress from `<template>`. With this input that is "`<composed, at most 120 characters>`", which is not the path of a .md file inside the project. Type only the part that replaces {input}."
  * `client/src/components/pipelines/RunWorkflowDialog.jsx` — The input hint for such a workflow reads: "This workflow reads its progress from `<template>`. Type only the part that replaces {input}: a path inside the project, not a full path from your disk."
* **🧪 Tests:**
  * `server/__tests__/pipelines-api.test.js` — An absolute path, a path that leaves the project, a path without `.md` and one too long to show in full. `client/src/hooks/__tests__/usePipelineRuns.test.jsx` — Field messages in the toast, and a refusal that names no field. `RunWorkflowDialog.test.jsx` — The hint.
  * Client suite: 80 files, 1,415 tests passed. `pipelines-api.test.js`: 222 passed.

## [2026-11-19] - A run's task is named from the work, not from a file path

### Executive Summary
* A task created for a workflow run was titled with the run's input. When the run was started from a dropped file the title was only a path, such as `"/tmp/codedeck-drops/1795037620464-Screenshot….png"`, in the sidebar, the task strip and on the phone. Session naming never applied: it names terminals, and a task's title was set once from what the Run dialog sent. The Run dialog now sends a title only when you type one. Otherwise the task is first called after the input, and as soon as a step of the run writes its note the CLI chosen under Settings → Session naming is asked for a short title that describes the work, and the task is renamed. A title you typed or changed with Rename is never replaced. Tasks that already exist keep their titles.

### Technical Details
* **✨ New Feature:**
  * `server/tasks/task-naming.js` — New. `createTaskNaming({ taskStore, readSettings, generate, warn })`: `noteWritten({ taskId, input, content })` asks the naming CLI with what was asked and what the step reported (at most 12,000 characters) and applies the title. It does nothing for a run without a task, a finished task, a title that is not made from the input, or when session naming is not configured. A CLI failure is logged once per task and reason and the next note tries again. `provisionalTaskTitle(input, workflowName)`: what the task is called until then.
  * `server/tasks/task-store.js` — `tasks.title_source` (`owner`, `input`, `generated`), added to existing databases as `owner`. `create` requires `titleSource` (`owner` or `input`). `applyGeneratedTitle(id, title)` replaces only an open task's `input` title and returns null otherwise. `rename` marks the title as the owner's.
  * `server/pipelines/run-engine.js` — Optional `onNoteWritten`, called after a step's note is stored as `written`; a failure in it is logged and never affects the run.
* **🛠️ Codebase:**
  * `shared/pipeline-definitions.mjs`, `server/routes/pipelines.js` — `POST /api/pipelines/runs` accepts `newTask: {}`. A typed `title` is stored as the owner's; without one the task gets the provisional title and `titleSource: 'input'`. A request replay matches by typed title, or for an untitled request by the task's title not being the owner's. A `title` that is present but blank is still 400. Clients that always send a title keep working.
  * `server/tasks/task-service.js` — `plan` takes `titleSource`; a task made by hand is `owner`. `server/tasks/task-adoption.js` — adopted worktrees are `owner`.
  * `server/index.js` — Wires task naming to the session-naming settings and CLI client and to the run engine.
  * `client/src/components/pipelines/RunWorkflowDialog.jsx` — The task title field starts empty with the placeholder "Named from the work once the run starts, or type a title", and `newTask` carries a title only when one was typed.
  * `README.md`, `docs/steering/api-standards.md`, `docs/steering/structure.md`.
* **🧪 Tests:**
  * `server/__tests__/task-naming.test.js` — New, 34 tests. `task-store.test.js` — 21 new cases, including the migration of an older table. `task-service.test.js`, `pipelines-api.test.js`, `pipeline-definitions.test.js`, `pipeline-run-engine.test.js`, `client/.../RunWorkflowDialog.test.jsx` — the title source through planning, the run endpoint with and without a title and its replays, the engine's note listener, and the dialog.
  * Checked on a backup copy of the live database: the migration read all 9 tasks back as `owner`, and with the real naming CLI the open task titled `/tmp/codedeck-audit-todo-b2bd312.md` became "Fix Task Worktree Audit Bugs" in 6 seconds. An isolated backend booted and accepted `newTask: {}` past validation.

## [2026-11-18] - The phone shows a workflow run as its task

### Executive Summary
* On the phone a workflow run appeared only as its separate step terminals, with nothing to say which task, workflow or step they belonged to, and a question or an approval could only be dealt with by opening the terminal. The Now view now lists each run as one row under **Tasks**: its task's title, how the run stands in words, the step it is in, its workflow and project. Opening it shows the steps, and on the step that waits for you the agent's questions (answered by choosing, as on the desktop) or the approval with the step's note. Resume and Continue past the limit are offered when the run needs them. A run's terminals are reached from its task instead of crowding the session list. Reaches the phone with the next APK.

### Technical Details
* **✨ New Feature:**
  * `client/src/mobile/nowView.js` — `buildNowView` takes `runs` and `tasks` and returns `tasks` (one row per run) and `quietTaskCount`. Sessions that are a listed run's step terminals are left out of the session groups; the headline counts each run once. A run is listed under Active while it is working, needs its owner, or changed in the last 8 hours.
  * `client/src/mobile/TaskScreen.jsx` — New. The run as its task: header, optional phase line, the steps with their state, and the desktop's `QuestionsPanel` and `ApprovalReview` on the waiting step.
  * `client/src/mobile/runsApi.js` — New. Reads open runs and open tasks and posts answer, approve, send back, resume and continue to the endpoints the desktop uses, at the instance address. Records are checked with `parseRun`, `parseTask` and `parseNotePage`.
* **🛠️ Codebase:**
  * `client/src/mobile/MobileApp.jsx` — Loads runs and tasks on connect and with the 5-second refresh (now also while a task is open), renders the Tasks group and the task screen, returns from a step terminal to its task, and leaves a task whose run was closed with a notice.
  * `client/src/mobile/companion.js` — `sendToInstance`: the time limit and the "could not reach" message, shared by both clients.
  * `client/src/mobile/mobile.css` — The task row's third line, the step rail, and touch sizes for the shared question and approval panels.
  * No backend change and no new endpoint.
* **🧪 Tests:**
  * `client/src/mobile/__tests__/taskRows.test.js` (28), `runsApi.test.js` (37), `TaskScreen.test.jsx` (24) — New. `MobileApp.test.jsx` — 11 new cases: the task list, opening a task and a step terminal and coming back, answering, a refused answer, approving, sending back, resuming, a run closed elsewhere, quiet tasks, and an unreadable run.
  * Client suite: 80 files, 1,412 tests passed; the phone bundle builds.
  * Checked in a browser at 375×812 against canned answers: the list, answering (the run moves on), the approval note, and a refused send-back.

## [2026-11-18] - The phone keeps its access across a restart

### Executive Summary
* The Android companion showed "Failed to fetch" and could not connect. The backend only lets the phone in when it is started with the Tailscale Serve origin and the owner's login, and those were passed in the environment of one restart command. The launcher started at 16:42 on 2026-11-18 had none of them, so the backend refused every phone request with a 403. A refusal carries no cross-origin permission, so the app could not read it and showed the browser's own "Failed to fetch". The settings are now read from a private file, `~/.codedeck/launch.env`, each time the backend starts. The backend log says on startup whether phone access is on, and the app says which instance it could not reach and what to check.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `server/index.js` read `CODEDECK_SERVE_ORIGIN`, `CODEDECK_TAILSCALE_OWNER` and `CODEDECK_FIREBASE_CREDENTIALS` from `process.env` only. A plain `./server.sh restart` left all three unset; `createPrivateAccess` then denies every request that is not from a loopback origin, and push notifications are off.
  * **Solution:** `server/launch-settings.js` (new) reads the three settings from `~/.codedeck/launch.env`. A missing file means no saved settings. An unknown name, a repeated name, an empty or quoted value, or a line that is not `NAME=value` stops the server with a message naming the file and line, never the value. A setting present in both the environment and the file with different values stops the server.
* **🛠️ Codebase:**
  * `server/index.js` — Uses the settled settings for private access and the notification provider, and logs `[companion] phone access is off: …` or `[companion] phone access is on through <origin>; push notifications are …` at startup.
  * `client/src/mobile/companion.js` — A request that rejects with a `TypeError` is reported as "Could not reach `<origin>`. Check that Tailscale is connected on this phone and that CodeDeck on the host allows phone access." Other failures are passed on unchanged. Reaches the phone with the next APK.
  * `docs/android-companion.md`, `docs/steering/tech.md`, `docs/steering/structure.md` — The settings file.
* **🧪 Tests:**
  * `server/__tests__/launch-settings.test.js` — New, 23 tests: reading, each rejected line, messages that never repeat a value, the environment and the file agreeing or conflicting, and the startup line.
  * `client/src/mobile/__tests__/companion.test.js` — A lost connection names the instance; a timeout is passed on.
  * Verified against two isolated backends: with no settings file a phone-shaped request gets 403 with no `Access-Control-Allow-Origin`; with a settings file and an empty environment the preflight gets 204 and the request 200, and another Tailscale login still gets 403.

## [2026-11-18] - Terminal tabs can no longer share an id

### Executive Summary
* After switching to a project with no terminals, the previous project's tabs and one of its terminal panes stayed on screen above the "No terminals open" card. Two tabs in that project's saved layout had the same id, and the page cannot remove an element whose id is duplicated. The duplicate came from restoring a layout: a tab built for a terminal that had no tab yet took the next free number, but the tab counter was not advanced, so the next terminal opened reused a number. Restoring a layout now always leaves the counter at or above the highest tab number, and a saved layout that already holds a duplicate is renumbered when it is restored.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `resolveInitialTerminalState` returned `tabCounter` as the larger of the saved counter and the number of tabs, ignoring ids handed out by `filterLayoutByLiveSessions` for live sessions without a tab and saved ids above the saved counter. `TerminalArea.jsx` mints `tab-${++tabCounter}`, so a later tab could take an id already in use. Tab ids are React keys for the tab bar and the pane containers.
  * **Solution:** the counter is at least the highest `tab-N` in the returned state on every path; duplicate ids in a saved layout are repaired before it is used.
* **🛠️ Codebase:**
  * `client/src/utils/terminalLayoutState.js` — `repairDuplicateTabIds`: the first tab with an id keeps it, each later one gets the next number above the layout's highest, order and contents unchanged. Applied on both saved-layout paths. `tabCounter` raised to the highest tab number on all three paths that return tabs.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalArea.test.js` — A tab added for a live session without one, a saved counter below a saved id, the duplicated layout found on the live instance (with and without live sessions, and with one more live session), an already unique layout left unchanged, and tabs built from live sessions alone.
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — With the duplicated layout saved, seven tabs render, a new terminal makes eight with eight distinct saved ids, and React logs no duplicate-key warning.
  * Client suite: 69 files, 1,111 tests passed.

## [2026-11-18] - A run shows live status only on the terminal it is working in

### Executive Summary
* A workflow run uses one terminal per agent, usually three, and only one is working at a time. The idle ones still showed status colours and "finished" markers on their tabs, pane headers and sidebar rows, so it was not obvious which terminal the run was in. A run now mutes the status of its terminals that are not the one it is working in, and lifts the muting on a terminal the moment its step starts. While the run waits for its owner the terminal of that step stays live; when the run is stopped, interrupted, failed or complete all its terminals are muted; closing the run lifts the muting. A terminal muted or unmuted by hand keeps that state until the run next changes state. Terminals that do not belong to an open run are not touched.

### Technical Details
* **✨ New Feature:**
  * `server/pipelines/run-terminal-muting.js` — New. `planRunTerminalMuting(run)`: for each terminal of a run, whether its status is muted, from the run's stored state alone.
  * `server/pipelines/run-engine.js` — Every stored change to a run now goes through one helper that applies that plan through a new required dependency, `setTerminalMuted`. A terminal that cannot be muted yet is retried at the next change; a failure warns once and never affects the run.
* **🛠️ Codebase:**
  * `server/pipelines/terminal-muting-adapter.js` — New. Mutes a terminal through the existing attention tracker once its status has been observed.
  * `server/index.js` — Wires the adapter into the engine. No new endpoint, table or field: the browser and phone read `statusMuted` as before.
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md`, `docs/steering/structure.md` — The rule and the new modules.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-terminal-muting.test.js` — New. The plan for every run status, a current step without a terminal, a closed run, preconditions, and the adapter for a known and an unknown terminal.
  * `server/__tests__/pipeline-run-engine.test.js` — The plan applied across a run, a retry after a terminal that could not be muted yet, a failing call that leaves the run's outcome unchanged, and the dependency being required.
  * `server/__tests__/pipeline-run-live.test.js` — With real tmux: in a two-agent run each terminal is live only during its own step and both are muted when the run completes.
  * Server suite: 82 files, 2,348 tests passed. Client suite: 69 files, 1,103 tests passed. Applied to the live run's state, the rule gave one live terminal (the current step's) and two muted.

## [2026-11-17] - Stop a looping run that has stopped making progress

### Executive Summary
* A run with a loop spent four rounds achieving nothing: one step was blocked every round and the step that closes the loop reported that work was left each time, while the run's progress file showed the same number of ticked tasks throughout. Nothing noticed. At the end of each loop round CodeDeck now compares the number of ticked tasks in the run's progress source with the number after the previous round. After two rounds in a row with no new ticked task the run stops before the next round, says why, and counts as waiting for the owner on the sidebar and the phone. Resume gives it two more rounds. A run without a readable progress source is not guarded and behaves as before.

### Technical Details
* **✨ New Feature:**
  * `server/pipelines/run-engine.js` — Where a loop's closing step would start another round, the engine reads the ticked-task count through a new required dependency, keeps the previous count and the number of rounds without progress in memory per run, and after `NO_PROGRESS_ROUNDS` such rounds applies the loop-back and then stops the run with the reason `no_progress`. A reading that is absent resets the count; a failed reading warns once and never stops or fails the run; Resume, Stop and a restart reset it.
  * `server/pipelines/run-progress.js` — `parsePhaseProgress` also returns the ticked and total tasks across all phases, and `readRunProgress` resolves and reads a run's progress source for both the API view and the engine.
  * `client/src/components/pipelines/PipelineRunsBar.jsx`, `client/src/utils/pipelineRunStatus.js` — Such a run reads "Stopped: no progress" with a line saying no task was ticked in the last two rounds, and Resume as the primary action.
* **🔌 API/Interface:**
  * `server/pipelines/run-machine.js`, `server/pipelines/run-store.js`, `client/src/utils/pipelineRunRecords.js` — Stop reason `no_progress` beside `user` and `terminal`. No new status, endpoint or stored column.
  * `docs/steering/api-standards.md` — The new stop reason.
* **🛠️ Codebase:**
  * `shared/pipeline-definitions.mjs` — `NO_PROGRESS_ROUNDS = 2`, shared by the engine and the runs bar.
  * `server/index.js`, `server/mobile-integration.js` — The engine's progress reading is wired from the shared function; `runNeedsOwner` treats a run stopped for no progress, like one awaiting approval, as needing the owner.
  * `server/routes/pipelines.js` — The run view uses the shared resolve-and-read function.
  * `client/src/hooks/usePipelineRunCounts.js` — A run stopped for no progress counts as waiting for the owner.
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` — The guard, what it needs and what Resume does.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-engine.test.js` — Two rounds without progress stop the run before the next round; progress in between resets the count; a falling count is no progress; an absent reading and a failing reading never stop the run; the last allowed round still pauses at its limit; Resume needs two more rounds; a workflow without a loop is not read.
  * `server/__tests__/pipeline-run-live.test.js` — With real tmux: a looping run whose progress file never changes stops for no progress, and one whose tasks are ticked each round runs on.
  * `server/__tests__/pipeline-run-progress.test.js`, `server/__tests__/pipeline-run-machine.test.js`, `server/__tests__/pipeline-run-store.test.js`, `server/__tests__/pipelines-api.test.js`, `server/__tests__/mobile-integration.test.js` — Totals and the shared reader, the stop reason, the stopped run's actions, and the owner lookup.
  * `client/src/utils/__tests__/pipelineRunRecords.test.js`, `client/src/utils/__tests__/pipelineRunStatus.test.js`, `client/src/components/pipelines/__tests__/PipelineRunsBar.test.jsx`, `client/src/hooks/__tests__/usePipelineRunCounts.test.jsx` — The reason, its label and primary action, the explanation line and the count.
  * Server suite: 81 files, 2,316 tests passed. Client suite: 69 files, 1,103 tests passed.

## [2026-11-17] - A workflow run that reads at a glance

### Executive Summary
* It was hard to tell whether a run was running, finished or waiting. The run header printed raw status words such as `interrupted`, offered Stop on a run that was not running, gave every button the same weight and drew every step the same. In the sidebar, a run's worktree header put a long folder name, the branch and the status on one row, so the name wrapped a word per line and the status was cut off. A run now says its state in plain words, the next thing to do is the highlighted button, steps are drawn as a connected sequence showing which are done, current and pending, and Stop appears only while the automation is running. A run's worktree is named by its workflow and short id in both the sidebar and the switcher, on one line that fits. No behaviour or data flow changed. This is the second half of the fourth phase.

### Technical Details
* **🛠️ Codebase:**
  * `client/src/utils/pipelineRunStatus.js` — New. `describeRunStatus` (label, tone and the primary action for each run status, only when that action is offered) and `describeStepState` (done, current, failed, stopped, pending).
  * `client/src/utils/worktreeGroups.js` — `describeWorktreeGroup`: `Main checkout`, `<workflow> · <short run id>` for a run's worktree, the folder name otherwise, and a tooltip with the folder, branch and path.
  * `client/src/components/WorktreeGroupHeader.jsx`, `client/src/styles/global.css` — The title on one line with an ellipsis, a status pill that is never cut off, a second line for the phase, latest note or current step; the branch moved to the tooltip.
  * `client/src/components/TerminalArea.jsx` — The worktree switcher uses the same titles, with a tab count and a dot when the run is waiting for the owner, and scrolls instead of wrapping.
  * `client/src/components/pipelines/PipelineRunsBar.jsx`, `client/src/components/pipelines/pipeline-runs.css` — A status pill in plain words; the primary action emphasised; Stop not shown for an interrupted, stopped, failed or complete run; steps as a connected sequence styled by state, with a marker on the step that closes a loop; one panel style; every inline style moved to the new stylesheet.
  * `README.md`, `docs/steering/structure.md` — The status words, the highlighted next action and how a run's worktree is named.
* **🧪 Tests:**
  * `client/src/utils/__tests__/pipelineRunStatus.test.js` — New. Every status row, an action that is not offered, an unknown status, each step state.
  * `client/src/utils/__tests__/worktreeGroups.test.js`, `client/src/components/__tests__/WorktreeGroupHeader.test.jsx`, `client/src/components/__tests__/TerminalAreaWorktreeFilter.test.jsx`, `client/src/components/__tests__/SidebarWaitingCount.test.jsx` — The titles and tooltip, the status pill for every status, the switcher's names, counts and waiting dot. Assertions on the group's visible name and status word were updated to the new text.
  * `client/src/components/pipelines/__tests__/PipelineRunsBar.test.jsx` — The pill for every status, the primary action, where Stop appears, each step's state, the loop marker, and no inline colour or background style; existing assertions on chips, panels, actions and callbacks unchanged.
  * Client suite: 69 files, 1,099 tests passed; the production build succeeds. Not checked in a browser.

## [2026-11-17] - Workflow templates, Duplicate, and a run's own plan as its progress

### Executive Summary
* The only way to get a workflow was a blank editor whose examples described a feature build, and a run showed phase progress only if a Progress file had been configured. "Add workflow" now offers two starting points written in plain prompts, with no skills: Bug fix (analyse, specify, develop, review, test, commit, with the first two read-only and waiting for approval) and Feature build (plan, develop, review, test, commit). An existing workflow can be duplicated. The editor and the Run dialog describe a workflow in general terms. A run whose steps keep a `plan.md` in the run notes shows its phase from it without any setting. A read-only step may write inside the run notes folder, so a planning step can write that plan. This is the first half of the fourth phase.

### Technical Details
* **✨ New Feature:**
  * `shared/workflow-templates.mjs` — New. `WORKFLOW_TEMPLATES` (Bug fix, Feature build) with node names, role hints, prompts, repeat rules and step options, and `buildTemplateDraft`; templates carry no agent ids.
  * `client/src/components/pipelines/WorkflowList.jsx`, `client/src/components/pipelines/pipeline-settings.css` — A chooser behind "Add workflow" (Blank or a template) that pre-fills the editor with a unique name and a role hint beside each agent select; a Duplicate action that opens a copy as a new workflow.
  * `server/pipelines/run-progress.js`, `server/routes/pipelines.js` — With no Progress file on the run or its workflow, `<notes folder>/plan.md` is the progress source, and a run that keeps no plan, or a plan without phase sections, shows nothing. A configured Progress file behaves as before.
  * `server/pipelines/run-notes.js` — The README in the run notes says where to keep the plan and in what form.
* **🐛 Bug Fix:**
  * **Problem:** A read-only step was told to change nothing except its run note, which would stop a read-only planning step writing `plan.md` beside it.
  * **Solution:** `server/pipelines/step-guidance.js` — A read-only step may change files in the run notes folder only; `client/src/components/pipelines/WorkflowEditor.jsx` says the same in the option's caption.
* **🛠️ Codebase:**
  * `client/src/components/pipelines/WorkflowEditor.jsx`, `client/src/components/pipelines/RunWorkflowDialog.jsx` — General placeholders; the Run dialog says what the input is, and that it must be a file path when the workflow's Progress file is built from it.
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md`, `docs/steering/api-standards.md`, `docs/steering/structure.md` — Templates, Duplicate, the plan default and read-only steps.
* **🧪 Tests:**
  * `server/__tests__/workflow-templates.test.js` — New. The two templates as specified, drafts that pass validation once agents are chosen, `{input}` where required, no skill invocation, prompt limits, and files written by read-only steps staying in the run notes folder.
  * `server/__tests__/pipeline-run-progress.test.js`, `server/__tests__/pipeline-run-notes.test.js`, `server/__tests__/pipeline-step-guidance.test.js`, `server/__tests__/pipelines-api.test.js` — The resolution order and its optional flag, the README, the read-only sentence within the instruction budget, and each plan case (none, with phases, without phase sections, a configured file that is missing, an old run without notes).
  * `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx`, `client/src/components/pipelines/__tests__/RunWorkflowDialog.test.jsx` — The chooser, pre-fill and role hints, a unique name, Duplicate, placeholders, the caption and the input hints.
  * Server suite: 81 files, 2,296 tests passed. Client suite: 68 files, 1,064 tests passed.

## [2026-11-17] - Terminals and runs grouped by worktree

### Executive Summary
* Every terminal of a project sat in one flat tab bar. A workflow run opens three or four terminals in its own worktree, and nothing told them apart from the owner's own terminals or from another run's: a run's tab kept only a session id, and the automatic titles hid even that. The sidebar now shows a project's terminals and open runs grouped by worktree, with each worktree's branch, run status and phase, and a marker when the run is waiting for the owner. A switcher above the tabs appears when a project has more than one worktree in use, and the tabs and the run header show the selected worktree only. A project whose terminals are all in its main checkout and that has no open run looks as it did. This is the third phase of making workflows general.

### Technical Details
* **✨ New Feature:**
  * `server/terminal-session-worktree-store.js`, `server/terminal-session-worktree-start.js` — New. `terminal_session_worktree` records the directory a terminal was started in when it is not the project's own path; one wrapper around the session starter sets it for worktree terminals and run steps.
  * `client/src/utils/worktreeGroups.js` — New. `resolveSessionWorktrees` (the recorded worktree; without a record, the worktree of an open run that uses the terminal for a step; otherwise main), `buildWorktreeGroups`, the tab to select after a close, and the stored selection read only for projects with more than the main group.
  * `client/src/components/WorktreeGroupHeader.jsx`, `client/src/components/SidebarSessionRows.jsx`, `client/src/components/Sidebar.jsx` — A selectable header per worktree with label, branch, a plain run status, the phase or latest note summary or current step, and a waiting marker; session rows moved into their own component.
  * `client/src/components/TerminalArea.jsx`, `client/src/components/TerminalTabBar.jsx` — A worktree switcher with tab counts and waiting markers; tabs filtered to the selected worktree at display while hidden panes stay mounted; selection follows the activated tab; closing a tab stays in the worktree; a plain new terminal opens in main; the run header shows the selected worktree's run.
  * `client/src/App.jsx`, `client/src/hooks/usePipelineRunCounts.js` — Groups and selection per project; open runs per project come from the poll that already counted them.
* **🔌 API/Interface:**
  * `server/terminal-session-status-service.js` — `GET /api/sessions` rows gain `worktreePath` (null for the main checkout): the start directory, which does not change when the shell changes directory.
  * `docs/steering/api-standards.md` — The new field.
* **🛠️ Codebase:**
  * `server/index.js`, `server/ws-handler.js`, `server/routes/terminal-delete.js` — The record is cleared when a terminal is deleted, pruned or ends, and when its id is handed out again, because ids are reused.
  * `README.md`, `docs/steering/product.md`, `docs/steering/structure.md` — Worktree groups; terminals opened before this change show under the main checkout until closed, except those of an open run.
* **🧪 Tests:**
  * `server/__tests__/terminal-session-worktree-store.test.js`, `server/__tests__/terminal-session-worktree-start.test.js` — New. Validation, the mapping set for a worktree terminal and a run step and not for the main checkout, cleared on prune, and a reused id starting without a record.
  * `server/__tests__/terminal-delete.test.js`, `server/__tests__/terminal-session-status-service.test.js`, `server/__tests__/ws-handler.test.js`, `server/__tests__/terminal-background-attach.test.js`, `server/__tests__/terminal-worktree-service.test.js` — The clears and the new row field.
  * `client/src/utils/__tests__/worktreeGroups.test.js` — New. The resolution rule, grouping, ordering, the newest run, storage reads and preconditions.
  * `client/src/components/__tests__/TerminalAreaWorktreeFilter.test.jsx`, `client/src/components/__tests__/WorktreeGroupHeader.test.jsx` — New. The switcher, filtering, selection following activation, restore of the last active tab, closing within a worktree, a new terminal from a worktree, and the header's wording for every run status.
  * `client/src/components/__tests__/Sidebar.test.jsx`, `client/src/components/__tests__/SidebarWaitingCount.test.jsx`, `client/src/hooks/__tests__/usePipelineRunCounts.test.jsx` — Headers, a main-only project unchanged, and runs per project.
  * Server suite: 80 files, 2,284 tests passed. Client suite: 68 files, 1,060 tests passed. The grouping was run over the live projects, terminals and open run: 86 of 86 projects grouped, and the run's three terminals fell under its worktree.

## [2026-11-17] - Read-only steps and approval gates in workflows

### Executive Summary
* A workflow could only stop when an agent asked a question or hit a limit, and every step was free to change the code. That is too blunt for work such as analyse → specify → develop → review → test, where the analysis must not touch the code and nothing should be built until the specification has been read. A step can now be marked read-only, and a step can be marked to wait for approval: when it finishes, the run pauses and shows what the step reported, and continues only when the owner approves or sends the step back with a comment. "Let agents decide" does not skip a gate. Workflows and runs that do not use the options behave as before. This is the second phase of making workflows general.

### Technical Details
* **✨ New Feature:**
  * `server/pipelines/run-machine.js` — Run and step status `awaiting_approval` with the events `approval_requested`, `approve` and `send_back`; it can be stopped and is offered `approve` and `sendBack`.
  * `server/pipelines/run-engine.js` — A gated step that finishes raises `approval_requested` instead of advancing; `approve` advances or completes the run; `sendBack` records the comment and reruns the step as a new attempt in its terminal (a closed terminal is replaced). A repeating step is gated only when it completes; at its pass limit the run pauses as before and Continue moves on.
  * `server/pipelines/review-store.js` — New. Append-only `pipeline_run_reviews` (approved or sent back, with the comment).
  * `server/pipelines/run-notes.js` — The owner's send-back comments are written to a feedback file beside the step's note, through the same no-link, replace-by-rename path as the README, which now share one helper for the verified run folder and one for replacing a file.
  * `server/pipelines/step-guidance.js` — A read-only step is told to change nothing in the worktree except its run note; a step that was sent back is pointed to its feedback file.
  * `client/src/components/pipelines/WorkflowEditor.jsx` — "Read-only step" and "Wait for my approval" per node; approval is unavailable, with the reason, on a node that closes a loop.
  * `client/src/components/pipelines/PipelineRunsBar.jsx` — An approval panel showing the step's note with Approve and Send back, and the chip label "awaiting approval".
* **🔌 API/Interface:**
  * `shared/pipeline-definitions.mjs` — Optional booleans `readOnly` and `approval` on workflow nodes (absent means false); `approval` is refused on a node that closes a loop.
  * `server/routes/pipelines.js` — `POST /runs/:id/approve` and `POST /runs/:id/send-back {comment}` (404 for an unknown run, 409 when the run is not awaiting approval); run responses gain `approvalRequest`, `actions.approve` and `actions.sendBack`; workflows return the two node fields.
  * `docs/steering/api-standards.md` — The node fields, the endpoints and the new run fields.
* **🗄️ Database:**
  * `server/pipelines/workflow-store.js`, `server/pipelines/run-store.js` — Stored workflow nodes and run steps are given `readOnly: false` and `approval: false`; `awaiting_approval` is a stored status that a backend restart leaves untouched. Once this has run, older code no longer accepts the stored rows.
* **🛠️ Codebase:**
  * `server/mobile-integration.js`, `server/mobile-notifications.js` — A session whose run is waiting for approval counts as needing input, and when that happens in the same reading as its workflow completing the phone is told "Input requested", not "Work completed".
  * `server/index.js` — Wires the review store, which the engine now requires.
  * `client/src/utils/pipelineRecords.js`, `client/src/utils/pipelineRunRecords.js`, `client/src/utils/pipelinesApi.js`, `client/src/hooks/usePipelineRuns.js`, `client/src/hooks/usePipelineRunCounts.js` — Guards for the new fields and status, the two actions with their toasts, and a run awaiting approval counted as waiting for the owner.
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md`, `docs/steering/structure.md` — Step options and approval.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-machine.test.js` — The three events from every status, and Stop from an approval wait.
  * `server/__tests__/pipeline-run-engine.test.js` — A gate with its note recorded first; approving the last step completes and cleans up; sending back into the same terminal and after it was closed; a gate inside a loop in every round; a repeating step gated only on completion; "Let agents decide" still answering a question but not approving; an ungated workflow unchanged; concurrent approvals advancing once; Stop and Resume during a wait.
  * `server/__tests__/pipeline-review-store.test.js` — New. Every field on write and read.
  * `server/__tests__/pipeline-run-notes.test.js`, `server/__tests__/pipeline-step-guidance.test.js` — The feedback file (order, deterministic rewrite, links and a linked folder refused, nothing without send-backs) and the new sentences within the instruction-length budget.
  * `server/__tests__/pipeline-definitions.test.js`, `server/__tests__/pipeline-definition-store.test.js`, `server/__tests__/pipeline-run-store.test.js`, `server/__tests__/pipelines-api.test.js` — The node fields and where approval is allowed; back-fills; an approval wait kept across a restart; the two endpoints.
  * `server/__tests__/pipeline-run-live.test.js` — With real tmux: a run pauses after Analyse, is sent back with feedback, then approved, and Develop runs.
  * `server/__tests__/mobile-integration.test.js`, `server/__tests__/mobile-notifications.test.js` — The approval wait as a need for input and the notification wording.
  * `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx`, `client/src/components/pipelines/__tests__/PipelineRunsBar.test.jsx`, `client/src/hooks/__tests__/usePipelineRuns.test.jsx`, `client/src/hooks/__tests__/usePipelineRunCounts.test.jsx`, `client/src/utils/__tests__/pipelineRecords.test.js`, `client/src/utils/__tests__/pipelineRunRecords.test.js`, `client/src/utils/__tests__/pipelinesApi.test.js`, `client/src/utils/__tests__/pipelineRunFixture.js` — The checkboxes, the approval panel, counts, guards and fixtures.
  * Server suite: 78 files, 2,263 tests passed. Client suite: 65 files, 1,002 tests passed. The stored-row upgrade was run against a copy of the live database: 11 runs and the stored workflow loaded with both options false.

## [2026-11-17] - Stop workflow runs stalling on a rule that was too strict and a question that was never read

### Executive Summary
* A run set to let its agents decide stalled waiting for its owner, for two reasons. First, the rule added earlier the same day to keep a run inside its worktree told agents not to look anywhere else for what they need; an agent took that to forbid reading a standards file the project's own documents point to, and made no progress for several rounds. Agents may now read outside the worktree what their instructions, skills or the project's documents refer to; they still may not create, change or delete anything outside it, nor go to other repositories for the task's own files. Second, CodeDeck never read the questions of an agent that runs full-screen, such as Codex: it was looking at the shell screen hidden underneath, so it reported that the agent had not said what it needs and "Let agents decide" could never answer for such a step. It now reads the screen the agent is showing.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** The boundary sentence said "If something you need is not in the worktree, do not look for it elsewhere", which also forbade reading. Separately, questions were read through the browser-reconnect snapshot, which for a pane in tmux's alternate screen captures with `-a`, the screen saved underneath, so the question markers were never found.
  * **Solution:** Reword the boundary to forbid changes, not reads; read agent output through a capture of the visible screen.
* **🛠️ Codebase:**
  * `server/pipelines/step-guidance.js` — The boundary sentence for node steps: work in the worktree, change nothing outside it, reading referenced files outside it is allowed, and the task's own files are not sought in other repositories.
  * `server/terminal-runtime.js` — `captureAgentScreen` on the local and host runtimes: the visible screen for a pane in the alternate screen, the visible screen plus scrollback otherwise. `captureSessionSnapshot`, used to rebuild browser attachments, is unchanged.
  * `server/index.js` — The run engine's `readScreen` uses `captureAgentScreen`.
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` — The boundary as it now reads, and the limit that a full-screen CLI shows CodeDeck only its visible screen, so a question list longer than the screen is put to the owner.
* **🧪 Tests:**
  * `server/__tests__/pipeline-step-guidance.test.js`, `server/__tests__/pipeline-run-engine.test.js` — The new sentence, its position and the instruction-length budget.
  * `server/__tests__/terminal-runtime.test.js`, `server/__tests__/host-terminal-runtime.test.js` — The visible screen is captured without `-a` in the alternate screen, with scrollback otherwise, and a tmux failure is reported as not trustworthy.
  * `server/__tests__/pipeline-run-live.test.js` — With real tmux, a stub agent in the alternate screen asks a question: without "Let agents decide" the question is shown to the owner; with it, the decision is recorded and the answer typed.
  * Server suite: 77 files, 2,190 tests passed. Checked against a live Codex terminal showing a question: the new read returned the question, the old one found no marker.

## [2026-11-17] - Run notes: a workflow run carries its own handoff between steps

### Executive Summary
* A workflow run carried nothing from one step to the next. Every agent is cleared before each pass, so the only continuity was whatever files the prompts or skills happened to write, and a workflow made of plain prompts had no handoff at all. Each new run now has a notes folder inside its worktree that git ignores. Every step is pointed to a README listing the steps and each step's note, writes its own note before finishing, and CodeDeck keeps a copy of that note when the pass ends, so what a step reported can be read in the runs bar and survives the worktree being removed. Runs started before this change behave as before. This is the first phase of making workflows independent of any particular skill.

### Technical Details
* **✨ New Feature:**
  * `server/pipelines/run-notes.js` — New. Note file names, the README text, an idempotent `prepare` that creates `.codedeck/runs/<8 hex>` with a self-ignoring `.codedeck/.gitignore` (written only when absent) and fails when git does not ignore the folder, and a contained, size-capped `readNote`. File access does not follow links, because a worktree's contents come from agents and cloned repositories: each folder level is created singly and must be a real directory inside the worktree, the README is written to a temporary file and renamed into place, and notes and the README are read through no-follow handles that reject hard-linked and non-regular files.
  * `server/pipelines/note-store.js` — New. Append-only `pipeline_run_notes` (run, step, attempt, pass, status, summary, content), with the latest row per step read without content.
  * `server/pipelines/run-engine.js` — Prepares the folder at each step start, before any agent is launched; records the step's note once per pass at the three places a pass ends (completion, the pass limit, the reset between passes); sweeps notes before a worktree is removed or released. A recording failure warns once and never changes the run.
  * `server/pipelines/step-guidance.js` — Node steps of a run with notes are told to read the README first and to write their note before the final signal.
  * `client/src/components/pipelines/PipelineRunsBar.jsx` — A Notes panel per run (newest first, paged) and a warning line for a step whose last pass left no note, did not update it, or left one that could not be read.
* **🔌 API/Interface:**
  * `server/routes/pipelines.js` — Run responses gain `notesDir`, `steps[].notePath` and `steps[].note`. New paginated `GET /api/pipelines/runs/:id/notes` with a `stepIndex` filter. Starting a run is refused with a field error on `project` when a step's instructions would exceed the 2,000-character limit for the worktree path.
  * `docs/steering/api-standards.md` — Contract for the new fields and endpoint.
* **🗄️ Database:**
  * `server/pipelines/run-store.js` — `definition.notesDir` is validated on every run; runs stored earlier are given `notesDir: null`. Once this has run, older code no longer accepts the stored rows.
* **🛠️ Codebase:**
  * `server/pipelines/run-progress.js`, `server/pipelines/run-worktree.js` — The stay-inside-the-worktree check and the git runner are shared with run notes; the Setup prompt says not to copy `.codedeck/` from the home checkout.
  * `server/index.js` — Wires the note store into the engine and the router.
  * `client/src/utils/pipelineRunRecords.js`, `client/src/utils/pipelinesApi.js`, `client/src/hooks/usePipelineRuns.js`, `client/src/App.jsx`, `client/src/components/TerminalArea.jsx` — Guards for the new fields, the notes loader with its error toast, and its path to the runs bar.
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md`, `docs/steering/structure.md` — Run notes.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-notes.test.js`, `server/__tests__/pipeline-note-store.test.js` — New. File names, README, `prepare` against real git (status stays clean, an existing `.gitignore` is kept, a tracked or unignored `.codedeck` is refused), note reading limits; store validation, paging and the latest row per step.
  * `server/__tests__/pipeline-run-engine.test.js` — One row per pass for two passes, at the pass limit and for a repeated pass-end event; nothing at the reset before pass 1; a recording failure leaves the run unchanged; the sweep before removal; old runs untouched.
  * `server/__tests__/pipeline-run-live.test.js`, `server/__tests__/pipeline-run-worktree-live.test.js` — With real tmux, a two-step run whose stub agent writes its notes; with real git, a worktree holding the notes folder is removed without force.
  * `server/__tests__/pipeline-step-guidance.test.js`, `server/__tests__/pipeline-run-store.test.js`, `server/__tests__/pipelines-api.test.js` — The notes sentence and the instruction-length budget; `notesDir` validation and back-fill; the new fields, the notes endpoint and the start guard.
  * `client/src/components/pipelines/__tests__/PipelineRunsBar.test.jsx`, `client/src/hooks/__tests__/usePipelineRuns.test.jsx`, `client/src/utils/__tests__/pipelineRunRecords.test.js`, `client/src/utils/__tests__/pipelinesApi.test.js`, `client/src/utils/__tests__/pipelineRunFixture.js` — The panel, the loader's toast, guards and fixtures.
  * `server/__tests__/pipeline-run-notes.test.js` also covers a linked `.codedeck`, `runs` folder, `.gitignore`, README (symbolic and hard link) and note, with the link targets left unchanged and no temporary file left behind.
  * Server suite: 77 files, 2,182 tests passed. Client suite: 65 files, 988 tests passed. The stored-row upgrade was also run against a copy of the live database: all 10 stored runs loaded with `notesDir: null`.

## [2026-11-17] - Keep a workflow run inside its worktree

### Executive Summary
* A run is meant to be self-contained in its Git worktree, but nothing enforced it. A run started from one repository with a todo that only existed in a sibling repository went ahead; its agents found the todo there and edited that other repository's main checkout directly. A run whose workflow names a progress file is now refused at the start when that file is not in the working tree it will use, and every step's agent is told that the run's worktree is the only place it may change and to pause when something it needs is missing there.

### Technical Details
* **✨ New Feature:**
  * `server/routes/pipelines.js` — `POST /runs` checks the composed progress file before anything is created: for a new worktree it must be a file in the project's current commit, for a chosen worktree a regular file inside it. Otherwise 400 with a field error on `input` saying to commit it or start from the project that contains it; no run and no worktree are created. A replayed `requestId` returns the existing run as before.
  * `server/pipelines/step-guidance.js` — `buildStepGuidance` takes the run's worktree path and every node step's guidance starts with the boundary sentence; Setup, which states its own boundary, is unchanged.
  * `server/pipelines/run-engine.js` — Passes the run's worktree path to `buildStepGuidance`.
* **🔌 API/Interface:**
  * `docs/steering/api-standards.md` — The new 400 on `input` for `POST /runs`.
* **🛠️ Codebase:**
  * `server/pipelines/run-worktree.js` — `hasCommittedFile`: whether a path is a file in a repository's `HEAD`, read with `git ls-tree`. `create()` is unchanged: a run's worktree still starts from the project's current commit.
  * `server/pipelines/run-progress.js` — `isProgressFileInWorktree`, sharing the stay-inside-the-worktree check (resolved path and real path) with the progress reader.
  * `README.md` — When a run is refused and what each step's agent is told.
* **🧪 Tests:**
  * `server/__tests__/pipelines-api.test.js` — Present, absent, uncommitted and directory paths for a new worktree; present, absent and symlinked-out paths for a chosen worktree; no check without a progress file; replay after the file was removed; a project that is a linked worktree is checked at its own commit.
  * `server/__tests__/pipeline-run-worktree.test.js`, `server/__tests__/pipeline-run-worktree-live.test.js` — `hasCommittedFile` preconditions and git call; with real git, a file committed only on a linked worktree's branch passes from that worktree and is refused from the home repository.
  * `server/__tests__/pipeline-step-guidance.test.js`, `server/__tests__/pipeline-run-engine.test.js`, `server/__tests__/pipeline-run-live.test.js` — The boundary sentence comes first and carries the run's worktree path; worktree path preconditions; prompts sent to node steps.
  * `server/__tests__/pipeline-run-progress.test.js` — `isProgressFileInWorktree` cases.
  * Server suite: 75 files, 2,125 tests passed.

## [2026-11-17] - Runs already in progress follow the workflow's progress file

### Executive Summary
* The phase line shipped earlier the same day could not be switched on: the setting rejected `docs/{input}`, the example its own helper text recommends, because it required the template itself to end in `.md`. And once set, it would only have applied to runs started afterwards. The setting now accepts a template whose `.md` ending comes from the run's input, and a run that started without a progress file follows the workflow's current setting, so runs already in progress show their phase too.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `PUT /api/pipelines/workflows/:id` with `progressFile: "docs/{input}"` returned 400 on `progressFile`; a stored row with that value would also have failed to load.
  * **Solution:** Validate the template as a path once `{input}` stands for a Markdown file name. The composed path of a run keeps the strict rule.
* **✨ New Feature:**
  * `server/pipelines/run-progress.js` — `resolveRunProgressFile`: a run keeps the progress file it started with; without one it uses the workflow's current setting composed with its own input, and has none when the workflow is gone, has no setting, or the input does not form a valid path. Nothing is written to the run.
  * `server/routes/pipelines.js` — The run view resolves the progress file through `resolveRunProgressFile` before reading it.
* **🛠️ Codebase:**
  * `shared/pipeline-definitions.mjs` — `isProgressFileTemplate`, used for the workflow setting; `isProgressFilePath` is unchanged and still guards composed paths.
  * `server/pipelines/workflow-store.js` — A stored `progress_file` is checked with the template rule when a row is read.
  * `README.md`, `docs/steering/api-standards.md` — A run started without a progress file follows the workflow's current setting; an input that does not form a valid path shows no phase line.
* **🧪 Tests:**
  * `server/__tests__/pipeline-definitions.test.js` — Accepted and rejected templates, including `docs/{input}`, `{input}`, `docs/{input}/notes` and traversal forms.
  * `server/__tests__/pipeline-definition-store.test.js`, `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx` — `docs/{input}` is saved and read back.
  * `server/__tests__/pipeline-run-progress.test.js` — `resolveRunProgressFile` cases and its preconditions.
  * `server/__tests__/pipelines-api.test.js` — Workflow create and update with `docs/{input}`; free-text input refused at run start; a run started before the setting picks it up and drops it when the setting is cleared, with its stored definition unchanged; a run with its own progress file keeps it.

## [2026-11-17] - Show which phase a workflow run is on

### Executive Summary
* The runs bar showed steps and loop rounds but not which phase of the work a run had reached; that lived only in the todo file the agents work from. A workflow can now name that file as its progress file, and the runs bar shows the first phase that still has unticked boxes, for example "Phase 2 of 5: API endpoints · 3/8 tasks". A missing or unreadable file is reported in the bar instead of showing nothing. Workflows without the setting are unchanged.

### Technical Details
* **✨ New Feature:**
  * `server/pipelines/run-progress.js` — New. `parsePhaseProgress` reads `## Phase N` sections and their checkboxes from Markdown, ignoring fenced code and other sections. `createRunProgressReader` reads the file inside the run's worktree asynchronously, refuses paths and symlinks that leave the worktree, non-regular files and files over 1 MiB, and caches the result by modification time and size.
  * `client/src/components/pipelines/PipelineRunsBar.jsx` — One line per run before the step chips: the current phase and its task count, "All N phases ticked", or a warning naming the file when it is missing, unreadable or has no phase sections.
  * `client/src/components/pipelines/WorkflowEditor.jsx` — "Progress file (optional)" field with helper text; an empty value is sent as `null` and the field takes part in dirty-draft detection and field errors.
* **🔌 API/Interface:**
  * `shared/pipeline-definitions.mjs` — `isProgressFilePath` and the optional `progressFile` on workflow bodies: a relative `.md` path of 1–300 characters with no `..`, empty segments, backslashes or control characters; absent or `null` means none.
  * `server/routes/pipelines.js` — Workflows return `progressFile`. Starting a run composes it with the input and stores the result in the run's definition; an input that does not form a valid path is a 400 on `input`. Every run response carries `progress` (`null`, or `file`, `status`, `phaseCount`, `phase`) while the worktree exists.
  * `docs/steering/api-standards.md` — Contract for `progressFile` and `progress`; coverage list updated.
* **🗄️ Database:**
  * `server/pipelines/workflow-store.js` — Nullable `progress_file` column on `pipeline_workflows`, added to existing databases on start-up and checked when a row is read.
  * `server/pipelines/run-store.js` — `definition.progressFile` is validated on every run; runs stored before this change are given `progressFile: null`.
* **🛠️ Codebase:**
  * `client/src/utils/pipelineRecords.js` — A workflow record must carry `progressFile` (null or text).
  * `client/src/utils/pipelineRunRecords.js` — A run must carry `progress`, with a guard for every field and each status combination.
  * `README.md`, `docs/steering/structure.md` — The Progress file setting, what the runs bar shows, and the new module.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-progress.test.js` — New. Parser cases (mixed ticks, all ticked, no phases, non-phase sections, fences, separators, long titles) and reader cases against a real temporary directory (each status, directory, path escape, symlink out of the worktree, the 1 MiB boundary, cache hit and refresh, argument checks).
  * `server/__tests__/pipelines-api.test.js` — Valid, absent, null, wrong-type, boundary, traversal and injection-looking values for `progressFile`; repeated PUT; composed path on run start; `progress` on every run response.
  * `server/__tests__/pipeline-definitions.test.js`, `server/__tests__/pipeline-definition-store.test.js`, `server/__tests__/pipeline-run-store.test.js` — Path rule, column added to an existing database, corrupt rows rejected, old runs back-filled.
  * `server/__tests__/pipeline-run-engine.test.js`, `server/__tests__/pipeline-run-live.test.js` — Fixtures carry `progressFile`.
  * `client/src/components/pipelines/__tests__/PipelineRunsBar.test.jsx`, `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx` — One case per progress status, nothing rendered for `null`; editing, clearing and the field error of the setting.
  * `client/src/utils/__tests__/pipelineRecords.test.js`, `client/src/utils/__tests__/pipelineRunRecords.test.js`, `client/src/utils/__tests__/pipelineRunFixture.js`, `client/src/hooks/__tests__/usePipelineRuns.test.jsx` — Guards for the new fields; fixtures carry them.
  * Server suite: 75 files, 2,040 tests passed. Client suite: 65 files, 963 tests passed.

## [2026-11-17] - Make finished workflow runs read as finished in the runs bar

### Executive Summary
* A finished run looked unfinished. A blocked worktree cleanup printed git's raw "fatal" line followed by a wall of file paths, and step chips such as "Setup complete 1/3" read as one of three done when the second number is only the maximum allowed. The bar now says the worktree was kept because it holds uncommitted work, with the files behind a disclosure, and finished steps say how many passes or rounds they took and carry a tick. (Shipped earlier the same day in `d72b0cc`.)

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** The runs bar showed git's refusal verbatim and used `N/M` fractions for limits, so a completed run read as failed or partial.
  * **Solution:** Describe a blocked cleanup in plain words from the detail the server already sends, and label chips by what a step took (finished) or by its limit as a maximum (unfinished).
* **🛠️ Codebase:**
  * `client/src/utils/pipelineWorktreeCleanup.js` — New. `describeBlockedCleanup` turns the stored cleanup detail into a summary sentence and the list of uncommitted files; git's own message is kept when there is no file list.
  * `client/src/components/pipelines/PipelineRunsBar.jsx` — Summary plus a "Show files" disclosure for a blocked cleanup; chip labels such as "Setup complete · 1 pass" and "Test running · round 3 (max 20)"; a tick on finished steps.
  * `client/src/hooks/usePipelineRuns.js` — The blocked-cleanup toast uses the same summary sentence.
* **🧪 Tests:**
  * `client/src/utils/__tests__/pipelineWorktreeCleanup.test.js`, `client/src/components/pipelines/__tests__/PipelineRunsBar.test.jsx`, `client/src/hooks/__tests__/usePipelineRuns.test.jsx` — Summary and file list, each chip label form, no `N/M` fraction in any chip, and the toast text.

## [2026-11-16] - Keep resource usage visible in the CodeDeck top bar

### Executive Summary
* Memory, CPU, and disk usage now appear directly in CodeDeck's top bar, so the readings remain visible when the installed app shows only its name in the window title. Readings continue to refresh every 30 seconds.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** The installed app's window title did not display the resource readings even though the page title and resource API were working.
  * **Solution:** Render the existing resource summary inside the application, including its high-usage alert indicator.
* **🛠️ Codebase:**
  * `client/src/App.jsx` — Store the formatted polling result and render an accessible local-machine resource region above the workspace.
  * `client/src/styles/global.css` — Add a compact, right-aligned resource bar with tabular numerals.
  * `client/src/App.test.jsx` — Verify the visible readings on the first response and after the next 30-second poll, including the alert state. The regression failed before the fix; all 12 targeted tests passed afterwards, and the client build passed.

## [2026-11-14] - Run workflow steps in the terminal of their agent

### Executive Summary
* Workflow runs filled the tab bar: every node of every run opened its own terminal, and every Resume opened another. The original per-terminal workflow did not work that way; it cleared the agent and reused the terminal. Runs now do the same per agent. A step goes to the terminal where its agent already runs in that worktree, clears it with the agent's reset command and sends its prompt: nodes that use the same agent share one tab, a new run in an existing worktree reuses the tabs an earlier run left, and Resume clears and re-sends in the step's own tab. An agent that has exited is started again in the same tab. A new tab is opened only when the agent has no terminal there, or its terminal was closed. Nodes that use different agents still get different tabs, because a terminal holds one agent CLI.

### Technical Details
* **✨ New Feature:**
  * `server/pipelines/run-engine.js` — `findAgentTerminal`: a step without a terminal takes one where the same agent (same `id` and `launchCommand`) already runs: this run's other steps first, then runs that are not active in the same project and worktree path, most recent first; only terminals the backend can still attach to. Such a step then behaves as one returning to its terminal (wait for the prompt, reset, submit). `waitUntilReady` launches the agent again, once, in a terminal whose agent has exited to the shell, and the loop then starts without a reset. `resume` keeps the step's terminal unless it is gone. New required dependency `terminalAvailable`.
  * `server/pipelines/run-machine.js` — The `resume` event requires `newTerminal` (boolean): `false` keeps the step's session id, `true` moves it to `priorSessionIds`; keeping a terminal the step never had is refused.
  * `server/ws-handler.js` — `backgroundSessionAvailable`: whether `attachBackgroundSession` would find the terminal (a live attachment, or a tmux session that still exists; a released attachment is not a closed terminal).
  * `server/index.js` — Wires `terminalAvailable` to `backgroundSessionAvailable`.
  * `client/src/components/pipelines/PipelineRunsBar.jsx` — The Resume confirmation says the agent in the step's terminal is cleared and the step starts again there, or that the step starts in a new terminal when it has none.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-engine.test.js` — Resume in the same terminal (reset first, nothing launched), a new terminal only when the terminal is gone or the step never had one, relaunch of an exited agent (also for a step returning in a loop), waiting for a busy agent; sharing a terminal between steps of one agent, separate terminals for different agents or launch commands, reuse from an earlier run in the same worktree, and no reuse from another worktree, another project or an active run. Steps of the older multi-step and loop tests now have an agent each.
  * `server/__tests__/pipeline-run-machine.test.js` — `resume` with `newTerminal` true and false, and its preconditions.
  * `server/__tests__/terminal-background-attach.test.js` — `backgroundSessionAvailable` against what `attachBackgroundSession` does in each case.
  * `server/__tests__/pipeline-run-live.test.js` — Real tmux with a stub agent: Resume clears and re-sends in the same terminal; a killed agent is started again in the same terminal; a killed terminal is replaced; two steps of one agent and a second run all work in one terminal.
  * `client/src/components/pipelines/__tests__/PipelineRunsBar.test.jsx` — The two Resume confirmation texts.
* **🛠️ Codebase:**
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` (new §8.15), `docs/steering/product.md` — One terminal per agent, what Resume does, and what a reused terminal loses (the agent's conversation) and keeps (scrollback).

## [2026-11-14] - Pause a workflow run when an agent shows a dialog mid-pass

### Executive Summary
* A workflow run could look as if it were working while its agent sat waiting at a dialog. CodeDeck only looked for dialogs before it sent the prompt; Codex shows "Hooks need review" a moment after its prompt appears, so the prompt went in first and the run stayed "running" until someone happened to look at the terminal. The run now watches the agent's terminal while a step is working: a dialog marks the run as waiting for the owner, the same way a launch dialog does, and the run carries on by itself once the dialog is answered in the terminal. "Let agents decide" never answers such a dialog.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `server/pipelines/run-engine.js` read the terminal's execution state only in the readiness wait before the prompt was sent. A CLI dialog shown afterwards produced no signal, so the run stayed `running` with no pause, no timeout and nothing in the runs bar.
  * **Solution:** `server/pipelines/run-engine.js` — `watchForDialog` reads the same execution state every 2 s (`dialogPollMs`) while a step's loop is running; `agent_needs_input` puts the run in `needs_input` with a `null` input request, and `endDialogPause` returns it to `running` when the dialog is gone or the loop reports anything. A request the agent signalled is left alone; a failure to record the pause fails the run.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-engine.test.js` — Six tests for a dialog during a pass: pause and continue, a step that completes while paused, a signalled request replacing the pause, a signalled request left alone, the watch ending with the step, and a pause that cannot be recorded.
  * `server/__tests__/pipeline-run-live.test.js` — A real tmux run whose stub agent shows a Codex-style dialog after the prompt was submitted: read with the real classifier, the run pauses, stays paused with agents deciding, and completes after Enter in the terminal.
* **🛠️ Codebase:**
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` — A dialog of the agent CLI pauses the run at launch or during a pass, and is answered in the terminal only.

## [2026-11-14] - Loop a group of workflow steps and let agents decide

### Executive Summary
* A workflow run kept stopping for the owner. A step could only repeat by itself, so a build step that needs a test step after every phase stopped once per phase; and every question an agent raised paused the run. A step can now loop back to an earlier step, so a group such as Develop → Test runs round after round in the same terminals until the work is done. A workflow can also be set to **Let agents decide**: its agents are told to go with their own recommendations, CodeDeck answers "Proceed with your recommendations." when one pauses with a list of questions anyway, and every such decision is kept on the run for the owner to read afterwards. Both are off unless the owner sets them on a workflow.

### Technical Details
* **✨ New Feature:**
  * `shared/pipeline-definitions.mjs` — Repeat mode `loop_back` (`to`: the name of an earlier node, `max` rounds); loops may not share a node; required workflow field `agentsDecide`; `loopTargetIndex`; the shared `ACCEPT_RECOMMENDATIONS_ANSWER` text.
  * `server/pipelines/run-machine.js` — Event `loop_back`: counts the finished round on the looping step, makes the loop's steps pending again with their terminals kept, and continues at the loop's first step.
  * `server/pipelines/run-engine.js` — A looping step runs one pass per round and loops back while rounds remain, otherwise pauses at the limit; a step returning to a terminal from an earlier round attaches to it, checks the agent is at its prompt and resets it before the prompt; `decideForOwner` answers a listed request once per pass for workflows whose agents decide, recording it before submitting.
  * `server/pipelines/step-guidance.js` (new) — What a step is told beyond the standard instruction: what the loop is (looping step) and to decide for itself (node steps when agents decide).
  * `server/pipelines/decision-store.js` (new) — Append-only table `pipeline_run_decisions` with per-field checks on write and read, count and paged listing per run.
  * `server/terminal-workflow.js` — `start` accepts `resetFirst` (reset the agent before the first pass) and `guidance` (one more line of instruction on every pass).
* **🔌 API/Interface:**
  * `server/routes/pipelines.js` — Workflows carry `agentsDecide` and `loop_back` repeats; a run's snapshot resolves a loop to `toStepIndex` (past Setup when there is one); run views add `agentsDecide`, `decisionCount` and each step's `roundsCompleted`; new `GET /runs/:id/decisions` (paginated, sort `createdAt`, RFC 9457 errors).
  * `docs/steering/api-standards.md` — The workflow and run rows and the new decisions endpoint.
* **🗄️ Database:**
  * `server/pipelines/workflow-store.js` — Column `agents_decide` (added to existing databases; existing workflows read as off); a loop is stored under the name of the node it returns to.
  * `server/pipelines/run-store.js` — Run snapshots validate `agentsDecide`, `loop_back` with `toStepIndex`, non-overlapping loops and `roundsCompleted`; runs stored before these fields are given `agentsDecide: false` and `roundsCompleted: 0` once, when the store is constructed.
  * `server/index.js` — Creates the decision store and passes it to the run engine and the router.
* **🛠️ Codebase:**
  * `client/src/components/pipelines/WorkflowEditor.jsx` — Repeat choice "Loop back to an earlier node" with its node and maximum rounds (the loop follows its node when that node is renamed or moved); the **Let agents decide** checkbox.
  * `client/src/components/pipelines/WorkflowList.jsx` — The summary shows a loop (`Test ↺ Develop`) and "agents decide".
  * `client/src/components/pipelines/PipelineRunsBar.jsx` — A looping step shows `round k/max`; a run whose agents decide is marked; **N decisions made by agents** opens a paged list of what was asked and answered, reloaded when another decision is made.
  * `client/src/hooks/usePipelineRuns.js` — `loadRunDecisions`; polled and returned runs are checked for the new fields before they are shown.
  * `client/src/utils/pipelineRecords.js`, `client/src/utils/pipelineRunRecords.js`, `client/src/utils/pipelinesApi.js` — Parsers for `agentsDecide`, `loop_back`, `roundsCompleted`, decisions and their page; `listRunDecisions`.
  * `client/src/App.jsx`, `client/src/components/TerminalArea.jsx` — Pass the decisions loader to the runs bar.
  * `README.md`, `docs/steering/product.md`, `docs/steering/structure.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` — Describe loops (§8.13) and agents deciding (§8.14), including what the owner is still asked.
* **🧪 Tests:**
  * `server/__tests__/pipeline-decision-store.test.js`, `server/__tests__/pipeline-step-guidance.test.js` (new); `pipeline-definitions`, `pipeline-definition-store`, `pipeline-run-store`, `pipeline-run-machine`, `terminal-workflow`, `pipeline-run-engine` and `pipelines-api` tests extended.
  * `server/__tests__/pipeline-run-live.test.js` — A real-tmux run of Develop → Test over two rounds in two terminals, with an automatic answer and its record; its stub agent reads the terminal raw, as agent CLIs do.
  * `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx`, `PipelineRunsBar.test.jsx`, `client/src/hooks/__tests__/usePipelineRuns.test.jsx`, `client/src/utils/__tests__/pipelineRecords.test.js`, `pipelineRunRecords.test.js`, `pipelinesApi.test.js`, `pipelineRunFixture.js` — The editor, runs bar, hook and parsers for both features.

## [2026-11-14] - See what a paused agent needs and answer it from the runs bar

### Executive Summary
* When an agent paused a workflow run for input, the run only said `needs_input`; what it needed was buried in the terminal. Agents are now told to list their questions with a recommended answer each before pausing. The runs bar shows that list under the run, with a box to answer and an **Accept recommendations** button, and the answer is typed into the agent's terminal. The sidebar count for a project changes colour while one of its runs waits for the owner.

### Technical Details
* **✨ New Feature:**
  * `server/terminal-workflow.js` — The loop instruction asks for a questions marker and a numbered list with `Recommended:` answers before a NEEDS_INPUT signal; `signalIdentifier()` names the pass the loop waits on.
  * `server/pipelines/input-request.js` (new) — Reads the questions from the terminal screen between the marker and the signal; validates the stored request.
  * `server/pipelines/run-engine.js` — Stores the request when a step signals NEEDS_INPUT; `answer` pastes the owner's answer into the step's terminal, submits it and resumes the loop, refusing a second answer while one is being typed.
  * `client/src/components/pipelines/PipelineRunsBar.jsx` — Panel under a waiting run: the questions, a reply box, Send answer and Accept recommendations; a note when the agent stated nothing, when the list was cut, or when a launch dialog must be answered in the terminal.
  * `client/src/components/Sidebar.jsx`, `client/src/hooks/usePipelineRunCounts.js` — Per-project counts carry how many runs wait for the owner (agent input or a pass limit); the count turns to the warning colour.
* **🔌 API/Interface:**
  * `server/routes/pipelines.js` — Runs carry `inputRequest` and `actions.answer`; `POST /api/pipelines/runs/:id/answer` with `{ answer }` (400 with field errors, 404, 409).
  * `shared/pipeline-definitions.mjs` — `validateRunAnswerBody`: 1–4000 characters, new lines allowed, other control characters refused.
* **🗄️ Database:**
  * `server/pipelines/run-store.js` — Nullable `pipeline_runs.input_request` (JSON), added with `ALTER TABLE` to existing databases; cleared when a waiting run is interrupted by a restart.
* **🐛 Bug Fix:**
  * `server/pipelines/run-engine.js` — A running snapshot that also changed the pass number could write a step's stale status back after the run left `needs_input`; the step is now read again after the transition.
* **🛠️ Codebase:**
  * `server/pipelines/run-machine.js` — `needs_input` events carry the request; leaving `needs_input` clears it; `answer` action flag.
  * `server/index.js` — `readScreen` gives the engine the last 400 lines of a step's terminal.
  * `client/src/utils/pipelineRunRecords.js`, `pipelinesApi.js`, `client/src/hooks/usePipelineRuns.js`, `client/src/App.jsx`, `client/src/components/TerminalArea.jsx` — Guards for the request, `answerRun`, and wiring to the runs bar.
  * `README.md`, `docs/steering/api-standards.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` — Document input requests and Answer.
* **🧪 Tests:**
  * `server/__tests__/pipeline-input-request.test.js` (new), `terminal-workflow.test.js`, `pipeline-run-machine.test.js`, `pipeline-run-store.test.js`, `pipeline-run-engine.test.js`, `pipelines-api.test.js` — Extraction, validation, instruction, transitions, column migration, engine capture and answer, and the endpoint across happy, invalid, boundary, empty, hostile and repeated requests.
  * `server/__tests__/pipeline-run-live.test.js` — With real tmux, a stub agent asks two questions; they are read off the screen, the answer is typed in and the run completes.
  * `client/src/components/pipelines/__tests__/PipelineRunsBar.test.jsx`, `client/src/components/__tests__/SidebarPipelineRuns.test.jsx`, `client/src/hooks/__tests__/usePipelineRuns.test.jsx`, `usePipelineRunCounts.test.jsx`, `client/src/utils/__tests__/pipelineRunRecords.test.js`, `pipelinesApi.test.js`, `pipelineRunFixture.js` — Panel, sidebar mark, answer action and guards.

## [2026-11-14] - Send a workflow step's skill to Codex with $

### Executive Summary
* Codex invokes skills with `$name`, not `/name`, so a step such as `/feature-dev …` did nothing useful when its agent was Codex. A prompt is still written with `/name`; when the CLI running the step is Codex, CodeDeck now sends that leading skill as `$name`. The same workflow therefore works whichever agent a node uses.

### Technical Details
* **✨ New Feature:**
  * `server/pipelines/skill-prefix.js` (new) — `applySkillPrefix` rewrites only a leading `/name` followed by white space or the end; paths, namespaced commands and later text are left as written.
  * `server/agent-profiles/codex.js`, `claude.js`, `cursor.js`, `agy.js`, `muse.js` — Each profile declares its `skillPrefix` (`$` for Codex, `/` for the others).
  * `server/pipelines/run-engine.js` — The step's prompt is sent with the prefix of the profile that matched the screen when the agent became ready; a profile without a valid prefix fails the run.
* **🛠️ Codebase:**
  * `client/src/components/pipelines/WorkflowEditor.jsx` — The prompt caption mentions the rule.
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` — Document the rule.
* **🧪 Tests:**
  * `server/__tests__/pipeline-skill-prefix.test.js` (new), `pipeline-run-engine.test.js`, `pipeline-run-live.test.js` — The rule, each profile's prefix, and the command the engine sends for `$` and `/` CLIs. Full server suite passed (1,564 tests); a run with a real Codex agent was not tested.

## [2026-11-14] - Start preset agents past shell aliases

### Executive Summary
* A workflow run failed at its first step because the Codex agent's launch command went through a shell alias that already added the permission-bypass flag, and Codex refuses the flag twice. Launch commands built from a provider, model and effort now run the CLI itself, so what the agent form shows is what runs.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** With the alias `codex='codex --yolo'`, the built command `codex … --dangerously-bypass-approvals-and-sandbox` exited with "the argument '--dangerously-bypass-approvals-and-sandbox' cannot be used multiple times", and the run reported "The launch command for agent … exited."
  * **Solution:** `shared/agent-presets.mjs` — Built commands start with `command` (`command codex …`), which skips aliases and shell functions. A saved command without it no longer matches a preset and opens as a custom command, unchanged.
* **🛠️ Codebase:**
  * `README.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` — Document that built commands skip aliases.
* **🧪 Tests:**
  * `server/__tests__/agent-presets.test.js`, `client/src/components/pipelines/__tests__/PipelineSettings.test.jsx` — Built and parsed commands with the prefix; a saved command without it stays custom. The built Codex command was also run in an interactive shell that has the alias.

## [2026-11-14] - List a worktree git cannot read instead of failing the worktree list

### Executive Summary
* The Run workflow dialog could not load its worktree list for a project that has a worktree whose link to the repository is broken (found on a live project straight after release). Such a worktree is now shown as one that cannot be chosen, with the reason, and the rest of the list loads.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `GET /api/pipelines/worktrees` returned 500 when `git status` failed with "not a git repository" in one listed worktree; git still lists such a directory and does not mark it prunable.
  * **Solution:** `server/pipelines/run-worktree.js` — `readWorktreeChanges` reports that worktree as unreadable and still throws on any other git failure. `server/routes/pipelines.js` — the list marks it not selectable with reason `unreadable` and `dirty: null`; `POST /api/pipelines/runs` refuses it with 409.
* **🛠️ Codebase:**
  * `client/src/utils/pipelineRecords.js` — Accept the reason code `unreadable`.
  * `README.md`, `docs/steering/api-standards.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` — Document the reason.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-worktree.test.js`, `pipeline-run-worktree-live.test.js`, `pipelines-api.test.js`, `client/src/utils/__tests__/pipelineRecords.test.js` — Clean, dirty and unreadable worktrees (including real git with a broken link), the list and the run refusal.

## [2026-11-14] - Choose a worktree for workflow runs; remove the per-terminal Workflow bar

### Executive Summary
* The Run workflow dialog now lists the repository's worktrees, so a run can use one that already exists instead of always creating a new one. A run in an existing worktree skips Setup and never removes that worktree. The old per-terminal Workflow bar is gone: workflows are started only from the Run workflow dialog, which leaves one way to run them instead of two.

### Technical Details
* **✨ New Feature:**
  * `client/src/components/pipelines/RunWorkflowDialog.jsx` — Worktree list: a new worktree, or an existing one with its branch, uncommitted-changes mark and the reason it cannot be chosen (missing, no branch, in use by an open run).
  * `client/src/components/pipelines/PipelineRunsBar.jsx`, `client/src/hooks/usePipelineRuns.js` — A run in an existing worktree offers **Dismiss run** instead of **Clean up worktree** and reports that the worktree was left in place.
* **🔌 API/Interface:**
  * `server/routes/pipelines.js` — `GET /api/pipelines/worktrees` (paginated, sortable by path); `POST /api/pipelines/runs` accepts `worktreePath`, returning 404 for a path git does not report and 409 for a missing, detached or in-use worktree; such a run needs no Setup agent.
  * `server/ws-handler.js` — The browser messages `workflow_start` and `workflow_stop` are no longer accepted; `workflow_state` is still sent.
* **🛠️ Codebase:**
  * `server/pipelines/run-worktree.js` — `listWorktrees` reads `git worktree list --porcelain` and validates every entry.
  * `server/pipelines/run-store.js`, `run-machine.js`, `run-engine.js` — Worktree states `external` and `released`; cleanup of an external worktree releases it without calling git; Resume checks that the directory still exists.
  * `shared/pipeline-definitions.mjs` — Validate the optional `worktreePath` of a run start.
  * `client/src/utils/pipelinesApi.js`, `pipelineRecords.js`, `pipelineRunRecords.js` — Worktree list request, per-field guards for worktree and preflight records, and the two new worktree states.
  * `client/src/components/Terminal.jsx`, `client/src/hooks/useTerminalWorkflow.js` — The terminal no longer renders the Workflow bar; the hook only receives workflow state for input locks.
  * `client/src/components/TerminalWorkflow.jsx`, `terminal-workflow.css` — Deleted.
  * `README.md`, `docs/steering/product.md`, `structure.md`, `api-standards.md`, `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md` — Document the worktree list and drop the per-terminal Workflow bar.
* **🧪 Tests:**
  * `server/__tests__/pipeline-run-worktree.test.js`, `pipeline-run-worktree-live.test.js`, `pipeline-run-machine.test.js`, `pipeline-run-engine.test.js`, `pipeline-run-store.test.js`, `pipeline-definitions.test.js`, `pipelines-api.test.js` — Worktree listing (including real git), states, run start in an existing worktree, refusals and validation.
  * `server/__tests__/terminal-workflow-ws.test.js`, `ws-handler-remote.test.js` — Loops are started through the background attachment; the removed messages are rejected.
  * `client/src/components/pipelines/__tests__/RunWorkflowDialog.test.jsx`, `PipelineRunsBar.test.jsx`, `PipelineSettings.test.jsx`, `client/src/hooks/__tests__/usePipelineRuns.test.jsx`, `client/src/utils/__tests__/pipelineRecords.test.js`, `pipelineRunRecords.test.js`, `pipelinesApi.test.js` — Worktree choice, dismissal, record guards and a longer timeout for the 32-node test.
  * `client/src/components/__tests__/WorkflowState.test.jsx` (new), `TerminalInputResume.test.jsx`; `TerminalWorkflow.test.jsx` deleted — Terminal input locking without the bar.
  * Regression: 1,520 server tests passed; 744 of 745 client tests passed, and the one failure (a timeout under machine load) passed in its own file after its timeout was raised; the full client suite was not rerun after that. Production frontend build passed. Browser checks used an isolated server with a stub agent; a run with a real agent CLI was not tested.

## [2026-11-13] - Run workflow pipelines in isolated worktrees

### Executive Summary
* Start saved workflows, watch their terminal tabs appear, and stop, resume or continue their steps from the runs bar. Each run uses an isolated Git worktree with a Setup cleanliness guard and explicit cleanup feedback. Agents, Setup selection and ordered workflow nodes are editable in the tabbed Settings modal; sidebar project rows show open-run counts.

### Technical Details
* **✨ New Feature:**
  * Settings tabs and agent/workflow editors with field validation, revision conflict handling and unsaved-draft protection.
  * `shared/agent-presets.mjs`, `client/src/components/pipelines/AgentList.jsx` — Build an agent's launch command from a provider (Claude Code, Codex, Cursor), model, effort and permission choice, or enter a custom command.
  * All-project sidebar run counts with non-overlapping two-second polling and visible request failures.
  * `client/src/components/pipelines/RunWorkflowDialog.jsx`, `PipelineRunsBar.jsx` — Start/preflight dialog and run controls with step, pass-limit and worktree state.
  * `client/src/hooks/usePipelineRuns.js`, `client/src/utils/pipelinesApi.js`, `terminalAdoption.js` — Poll runs, resolve terminal transitions, fence project mutations and adopt background terminals.
* **🔌 API/Interface:**
  * `server/routes/pipelines.js` — Validated, paginated agent/workflow/run APIs, settings, preflight and owner actions.
* **🛠️ Codebase:**
  * `shared/pipeline-definitions.mjs` — Definition validation and literal workflow-input substitution.
  * `server/pipelines/agent-store.js`, `workflow-store.js`, `settings-store.js`, `run-store.js` — Persist definitions, settings and execution snapshots.
  * `server/pipelines/run-machine.js`, `run-engine.js`, `run-worktree.js`, `agent-readiness.js` — Sequential background execution, Setup isolation, action serialization, prompt readiness, recovery and cleanup.
  * `server/index.js`, `server/routes/terminal-delete.js` — Wire pipeline services, sanitized runtime readiness snapshots and terminal closure notifications.
  * `server/ws-handler.js`, `server/mobile-session-start.js`, `server/terminal-workflow.js` — Background terminal attachment, absolute working directories, shared geometry and bounded repeat passes.
  * `server/agent-profiles/agy.js`, `claude.js`, `codex.js`, `cursor.js`, `muse.js`, `index.js` — Expose prompt visibility for readiness.
  * `client/src/App.jsx`, `client/src/components/TerminalArea.jsx`, `TerminalWorkflow.jsx` — Connect run controls and multi-session adoption; validate workflow commands.
  * `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md`, `docs/todos/2026-11-13-134947-workflow-pipelines.md`, `CHANGELOG.md` — Record specification, delivered scope and verification.
* **🐛 Bug Fix:**
  * Catch queued transition failures, settle execution waiters, acknowledge accepted owner actions promptly and revalidate queued actions. Check Setup cleanliness when continuing past its pass limit.
  * Preserve literal replacement tokens, reject stale project mutation responses, report blocked cleanup and retry final-state resolution before dropping completed runs.
  * Stop/Resume/Continue returning a run in error show that error instead of a success toast.
* **🧪 Tests:**
  * `server/__tests__/pipeline-agent-readiness.test.js`, `pipeline-definition-store.test.js`, `pipeline-definitions.test.js`, `pipeline-run-engine.test.js`, `pipeline-run-live.test.js`, `pipeline-run-machine.test.js`, `pipeline-run-store.test.js`, `pipeline-run-worktree-live.test.js`, `pipeline-run-worktree.test.js`, `pipelines-api.test.js` — Pipeline validation, persistence, transition, action, worktree and live tmux coverage.
  * `server/__tests__/terminal-background-attach.test.js`, `terminal-background-attach-live.test.js`, `mobile-session-start.test.js`, `terminal-workflow.test.js`, `ws-handler.test.js` — Background terminal lifecycle and loop regressions.
  * `client/src/components/pipelines/__tests__/RunWorkflowDialog.test.jsx`, `PipelineRunsBar.test.jsx`, `TerminalAreaAdoption.test.jsx`, `client/src/hooks/__tests__/usePipelineRuns.test.jsx`, `client/src/utils/__tests__/pipelinesApi.test.js`, `terminalAdoption.test.js` — UI actions, adoption, polling and feedback regressions.
  * `client/src/App.test.jsx`, `client/src/components/__tests__/SessionSearchApp.test.jsx`, `TerminalAreaRestore.test.jsx`, `TerminalWorkflow.test.jsx` — Existing app/session behavior and workflow validation.
  * Full regression: 1,425 server tests and 502 client tests passed; production frontend build passed. Browser verification used an isolated database/server snapshot and a deterministic agent fixture with real tmux, readiness detection and Git worktrees; live AI provider execution was not tested.

## [2026-11-13] - Search and resume past agent conversations

### Executive Summary
* You can search past Claude Code, Codex, Cursor, and Antigravity conversations for the current project (or all local projects) and resume one in a new terminal tab. Untitled chats show their first prompt so they stay findable.

### Technical Details
* **✨ New Feature:**
  * Session search modal (Cmd/Ctrl+Shift+S or tab-bar search) lists local CLI history, filters by project/CLI/query, and resumes a conversation in its project.
* **🔌 API/Interface:**
  * `GET /api/agent-sessions` — Paginated local conversations with project, CLI, and title/prompt filters; per-CLI source availability.
  * `POST /api/agent-sessions/resume` — Allocate a detached tmux terminal and submit the CLI resume command; concurrent identical resumes return 409.
* **🛠️ Codebase:**
  * `server/agent-history/` — Read-only history readers (Claude, Codex, Cursor, Antigravity), merge/search service, resume command helpers, and detached submit.
  * `server/routes/agent-sessions.js` — RFC 9457 problem-details router for list and resume.
  * `server/index.js` — Wire agent history into the mobile session starter and mount the agent-sessions routes.
  * `client/src/components/SessionSearch.jsx` — Search UI with debounce, scope, keyboard highlight, and resume toasts.
  * `client/src/components/session-search.css` — Modal styling using existing theme tokens.
  * `client/src/App.jsx` — Shortcut, modal mount, and project switch on resume.
  * `client/src/components/TerminalArea.jsx` — Search action and attach a resumed session without allocating a second ID.
  * `client/src/components/ShortcutsOverlay.jsx` — Document Cmd/Ctrl+Shift+S.
  * `README.md`, `docs/steering/product.md`, `docs/steering/structure.md` — Document session search and the API.
  * `CHANGELOG.md` — Record the session search release.
  * `.gitignore` — Ignore `.claude/` tooling worktrees.
* **🧪 Tests:**
  * `server/__tests__/agent-history/` — Cover readers, merge/search, resume submit, and API validation.
  * `client/src/components/__tests__/SessionSearch.test.jsx`, `SessionSearchApp.test.jsx`, `TerminalAreaRestore.test.jsx` — Cover search UI, app wiring, and resumed tab attachment.

## [2026-11-11] - Reliable agent activity detection, Android companion, and verified terminal close

### Executive Summary
* Agent status now reads each CLI’s live prompt/status region instead of scanning the whole transcript, so finished answers no longer stick on “Running.” An Android companion app can watch sessions and receive push notifications when attention is needed, while desktop presence suppresses noisy alerts. Closing a terminal and deleting a project now verify that tmux sessions are actually gone.

### Technical Details
* **✨ New Feature:**
  * Per-CLI live-region activity profiles (Codex, Claude Code, Cursor agent, Antigravity, Muse) with silence veto, sub-agent/background shell reporting, and needs-input detection.
  * Android companion: mobile API, device store, session discovery, attention tracking, FCM pushes, and Capacitor client; hold pushes while the desktop was active in the last two minutes.
* **🐛 Bug Fix:**
  * Problem: transcript lines such as “• Working tree clean.” kept panes marked Running. Solution: classify only the live footer/prompt region per CLI profile.
  * Problem: closing `demo-1` could prefix-match and kill `demo-15`, and failed kills left the UI believing the session was gone. Solution: exact tmux targets, verified close with force-kill fallback, and RFC 9457 errors that keep the session tracked on failure.
  * Problem: deleting a project could orphan live terminals. Solution: close project sessions first and keep the project if any cannot be closed.
* **🔌 API/Interface:**
  * Mobile companion routes, session-attention API, and verified terminal-delete endpoint.
* **🛠️ Codebase:**
  * `server/agent-profiles/` — Pure live-screen readers and shared live-region helpers.
  * `server/terminal-execution-classifier.js` — Combine main pane, sub-agent panes, and silence veto.
  * `server/terminal-runtime.js`, `server/ws-handler.js` — Multiclient attachment, incarnation, and verified close behavior.
  * `server/mobile-*.js`, `server/routes/mobile.js`, `server/session-attention.js`, `server/routes/session-attention.js`, `server/routes/terminal-delete.js`, `server/project-deletion-service.js` — Companion backend and safer teardown.
  * `client/src/mobile/`, `client/android/`, `client/vite.mobile.config.js`, `docs/android-companion.md` — Capacitor Android companion app and docs.
  * `client/src/hooks/useSessionAttention.js`, `client/src/utils/desktopActivity.js`, `client/src/utils/terminalActivity.js`, `client/src/utils/terminalControl.js` — Desktop presence and attention wiring.
  * `CHANGELOG.md` — Record the activity, companion, and close verification release.
* **🧪 Tests:**
  * Agent screen fixtures and classifier/profile tests; mobile API, notifications, attention, terminal-delete, multiclient, and incarnation coverage; companion frontend tests.

## [2026-11-03] - Configure custom CLI providers for session naming

### Executive Summary
* Session naming now supports user-defined CLI providers, including custom executables, arguments, models, effort values and response formats. Editable Claude and Codex profiles preserve existing settings, while Settings can add providers such as Cursor or Kiro.

### Technical Details
* **✨ New Feature:**
  * Save and select custom naming profiles, interpolate explicit argument placeholders without a shell, and validate each profile before execution.
* **🛠️ Codebase:**
  * `shared/naming-providers.mjs` — Define editable defaults and shared per-field provider validation.
  * `server/cli-naming-client.js` — Execute the selected profile and parse its configured response format independently of its name.
  * `client/src/components/SessionNamingSettings.jsx` — Add profile creation, editing, removal and validation to naming settings.
  * `client/src/components/session-naming.css` — Style profile argument editors consistently with existing settings.
  * `server/__tests__/cli-naming.test.js` — Cover custom commands, argument interpolation, output formats and invalid profiles.
  * `server/__tests__/session-naming-api.test.js` — Cover custom profile persistence and rejected settings updates.
  * `client/src/components/__tests__/SessionNaming.test.jsx` — Cover adding, saving, reloading and removing profiles and invalid argument JSON.
  * `README.md` — Document provider configuration, output contracts and Cursor and Kiro examples.
  * `CHANGELOG.md` — Record the custom naming provider release.
* **🧪 Tests:**
  * Validation: 643 server tests and 292 client tests passed; frontend production build passed. Browser settings checks and a live custom Cursor naming call succeeded. Kiro is not installed locally, so its documented configuration has not been verified live.

## [2026-11-03] - Name sessions through local CLIs and improve terminal workflows

### Executive Summary
* Session titles now use the locally authenticated Claude Code or Codex CLI, removing the Conduit connection dependency. Provider, model and effort remain configurable, and rejected model IDs produce an actionable error. Paused workflows resume after an answer, iteration signals are easier to copy, and terminal hyperlinks open directly in a new tab.

### Technical Details
* **✨ New Feature:**
  * `server/cli-naming-client.js` — Run bounded naming requests through Claude Code or Codex with explicit selection, isolated temporary directories, process limits and validated title output; explain rejected case-sensitive model IDs without exposing raw output.
  * `client/src/components/SessionNamingSettings.jsx` — Replace Conduit connection fields with local CLI provider, model and effort settings.
* **🐛 Bug Fix:**
  * Problem: workflows stopped at NEEDS_INPUT or waited indefinitely after a mistyped signal. Solution: keep paused iterations active, resume on an answer, use short identifiers and report unknown identifiers explicitly.
  * `server/terminal-workflow.js` — Implement paused-iteration resumption and shorter, unique iteration identifiers with stale-signal protection.
  * `server/ws-handler.js` — Notify the workflow when terminal input arrives.
  * `client/src/hooks/useTerminalWorkflow.js` — Accept active paused workflows and explain how to resume them.
  * `client/src/components/Terminal.jsx` — Open OSC 8 hyperlinks and plain URLs consistently in a new tab.
  * `server/terminal-runtime.js` — Advertise hyperlink support when attaching local and remote tmux clients.
* **🔌 API/Interface:**
  * `server/routes/session-naming.js` — Save CLI selections and remove the retired Conduit catalog, connection-test and circuit-health endpoints.
* **🛠️ Codebase:**
  * `server/index.js` — Wire the CLI naming client into the background naming service and terminate child processes on exit.
  * `server/session-naming-service.js` — Direct generic naming failures to CLI login and selection checks.
  * `server/session-naming-store.js` — Validate CLI settings and retire legacy connection settings without deleting existing titles or stored connection data.
  * `README.md` — Document resuming a workflow after answering the agent.
  * `CHANGELOG.md` — Record the naming, workflow and hyperlink release.
* **🧪 Tests:**
  * `server/__tests__/cli-naming.test.js` — Cover exact CLI arguments, bounded context, validation, malformed output and safe model rejection errors.
  * `server/__tests__/session-naming-api.test.js` — Cover CLI settings persistence and field validation without Conduit access.
  * `server/__tests__/session-naming.test.js` — Cover model changes during queued work and preservation of titles with legacy settings.
  * `client/src/components/__tests__/SessionNaming.test.jsx` — Cover saving and reverting CLI settings and reporting save failures.
  * `server/__tests__/terminal-workflow.test.js` — Cover pause/resume, short identifiers, mistyped signals and stale output.
  * `server/__tests__/terminal-workflow-ws.test.js` — Cover workflow resumption and mismatch errors over WebSocket.
  * `client/src/components/__tests__/TerminalWorkflow.test.jsx` — Cover paused-workflow controls and transitions back to running.
  * `server/__tests__/terminal-runtime.test.js` — Verify hyperlink capability on local tmux attachment.
  * `server/__tests__/host-terminal-runtime.test.js` — Verify hyperlink capability on remote tmux attachment.
  * `client/src/components/__tests__/TerminalLinks.test.jsx` — Verify direct hyperlink activation without a confirmation dialog.
  * Validation: 619 server tests and 290 client tests passed; frontend build passed. Real Claude and Codex naming calls succeeded, and a failed session was successfully renamed through the running application. Workflow and hyperlink changes have automated coverage; no new live agent workflow or remote hyperlink acceptance check was performed in this release.

## [2026-10-24] - Correct idle status after completed agent turns

### Executive Summary
* Finished agent sessions now show as idle when their final answer contains an ellipsis in a bullet, tree branch, or recap. Active spinner indicators continue to show the session as running.

### Technical Details
* **🐛 Bug Fix:**
  * Problem: punctuation-prefixed transcript lines containing an ellipsis were mistaken for active spinners. Solution: restrict spinner detection to recognized spinner symbols.
* **🛠️ Codebase:**
  * `server/terminal-execution-classifier.js` — Distinguish spinner frames from transcript punctuation.
  * `CHANGELOG.md` — Record the idle-status correction.
* **🧪 Tests:**
  * `server/__tests__/terminal-execution-classifier.test.js` — Add four completed-turn regressions and nine active-spinner cases. All 583 server tests pass; the affected live session reports idle in the API and browser.

## [2026-10-21] - Stabilize terminal copying and workflow interaction

### Executive Summary
* Terminal text stays still while you select and copy it, workflow commands survive reloads, and running agents can receive approval clicks and keyboard input. Resetting a workflow still protects the terminal from conflicting input.

### Technical Details
* **🐛 Bug Fix:**
  * Problem: live redraws interrupted text selection and copying. Solution: hold output during Option-drag selection, copy explicitly with Cmd+C, and resume on Escape, typing, or a click.
  * Problem: running workflows blocked agent approval input and lost edited commands after remounting. Solution: allow input outside reset and control acknowledgement windows, and persist commands per terminal.
* **🛠️ Codebase:**
  * `client/src/utils/terminalSelection.js` — Manage selection gestures, explicit clipboard writes, listener cleanup, and the 4 MiB output limit.
  * `client/src/components/Terminal.jsx` — Integrate selection buffering, block terminal clipboard access through OSC 52, and connect session-specific workflow controls.
  * `client/src/components/TerminalWorkflow.jsx` — Validate and persist edited commands independently for each terminal.
  * `client/src/hooks/useTerminalWorkflow.js` — Separate terminal input locking from workflow form locking.
  * `server/ws-handler.js` — Accept approval input while running and reject it during reset.
  * `README.md` — Explain terminal selection, copying, and display resumption.
  * `CHANGELOG.md` — Record terminal selection and workflow fixes.
* **🧪 Tests:**
  * `client/src/utils/terminalSelection.test.js` — Cover gesture races, clipboard failures, validation, output limits, and cleanup.
  * `client/src/components/__tests__/TerminalSelection.test.jsx` — Cover output buffering, snapshot ordering, resize cancellation, and OSC 52 blocking.
  * `client/src/components/__tests__/TerminalWorkflow.test.jsx` — Cover command persistence, terminal isolation, deliberate clearing, and invalid stored data.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Cover approval input during running workflows and exclusion during resets.
  * `server/__tests__/terminal-workflow-ws.test.js` — Verify keyboard and mouse approval input reaches the terminal only outside reset.
  * `client/e2e/terminal-selection.js` — Exercise exact, reversed, wrapped, and scrollback copying in the browser; acknowledge resume requests in the fake socket so approval checks reflect a ready connection.

## [2026-10-13] - Repeat agent commands with terminal workflows

### Executive Summary
* A terminal can now repeat an agent command, clear its context between passes, and stop when the agent reports completion or needs input. Workflows keep running when you switch projects or disconnect, so navigating CodeDeck no longer strands an unfinished feature. This release also resets generated session names after `/clear`, keeps remote project names readable, and prevents temporary status refreshes from clearing parked tabs.

### Technical Details
* **✨ New Feature:**
  * Start an agent normally, open Workflow, and supply the command and reset command. Each pass uses its own completion signal; Start and Stop report their acknowledged state, and manual typing is locked while automation owns the terminal.
  * Workflow state belongs to the terminal session and is restored on reconnect. Closing the terminal or restarting CodeDeck stops automation; stopping a workflow does not interrupt the agent's current work.
* **🐛 Bug Fix:**
  * Problem: switching projects closed the browser socket and stopped automation. Solution: keep the terminal attachment alive while the workflow runs and release it when automation ends.
  * Problem: `/clear` retained names and pending naming work from the old context. Solution: reset naming state, cancel retries, and ignore stale results.
  * Problem: host metadata squeezed remote project names out of sidebar rows. Solution: place host metadata below the project identity.
  * Problem: a temporary unknown status could clear a parked tab. Solution: require an observed completion at idle or a dead session.
* **🛠️ Codebase:**
  * `server/terminal-workflow.js` — Validate commands, submit bracketed pastes with a separate Enter, match iteration signals, and manage reset timing and idempotent requests.
  * `server/ws-handler.js` — Own workflows per terminal session, preserve them across disconnects, restore state before accepting input, and handle local and remote terminal output.
  * `client/src/hooks/useTerminalWorkflow.js` — Validate server state, track control acknowledgements, lock input, and reconcile state after reconnecting.
  * `client/src/components/TerminalWorkflow.jsx`, `client/src/components/terminal-workflow.css` — Add the Workflow command form, status, Start and Stop controls, and usage guidance.
  * `client/src/components/Terminal.jsx` — Integrate workflow controls and prevent typing or uploads from interfering with automation.
  * `server/session-naming-service.js` — Recognize submitted `/clear` commands without retaining keystroke content and reset naming work.
  * `client/src/components/Sidebar.jsx` — Keep host labels below project names in active, waiting, and shelved sections.
  * `client/src/utils/terminalWaiting.js` — Preserve waiting marks during temporary unknown status refreshes.
  * `README.md` — Document terminal workflow usage, signals, and lifecycle limits.
  * `CHANGELOG.md` — Record the workflow feature and accompanying fixes.
* **🧪 Tests:**
  * `server/__tests__/terminal-workflow.test.js` — Cover command validation, signal parsing, submission timing, reset timeouts, stopping, and idempotency.
  * `server/__tests__/terminal-workflow-ws.test.js` — Cover controls, manual-input exclusion, disconnect continuity, reconnect state, and completion while detached.
  * `server/__tests__/ws-handler.test.js`, `server/__tests__/ws-handler-remote.test.js` — Account for workflow state in local and remote attachment handshakes.
  * `client/src/components/__tests__/TerminalWorkflow.test.jsx` — Cover controls, validation, acknowledgement errors, and disconnect behavior.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Cover input locking and queued-input handling when a workflow resumes.
  * `server/__tests__/session-naming.test.js` — Cover clear detection, generated and manual names, stale results, and retry cancellation.
  * `client/src/components/__tests__/Sidebar.test.jsx` — Verify remote host-label layout in every project section.
  * `client/src/hooks/__tests__/useWaitingSessions.test.jsx`, `client/src/utils/__tests__/terminalWaiting.test.js` — Reproduce temporary status refreshes and verify that parked tabs remain parked.

## [2026-09-25] - Parked tabs stop flashing everywhere, and clear from any project

### Executive Summary
* Parking a tab quieted the tab itself, but the same session kept pulsing in the sidebar, in the pane header, and on its project's dot, so parked work still competed for attention. Parked sessions now go still in every one of those places, while their tooltips keep reporting the real status. Making that safe needed a second fix: parked tabs only cleared when their project was the one on screen, so work that finished elsewhere never lifted the mark, and with the indicators silenced it would never have surfaced at all. Parked work is now watched across every project, so the mark clears and the finished blink returns wherever the work lands.

### Technical Details
* **✨ New Feature:**
  * Parked sessions drop their pulse and blink on the sidebar session dot, the sidebar project dot, and the pane header dot, as well as the tab.
  * Tooltips keep the real status and add "(waiting)". Parked sessions are never reported as muted, so the eye-icon toggle stays honest.
* **🐛 Bug Fix:**
  * Problem: auto-clear ran only over the tabs of the project on screen, so a tab parked in another project never cleared when its work finished. Solution: auto-clear moved into the app-wide waiting state and watches every parked session, keyed on the session each mark belongs to.
* **🛠️ Codebase:**
  * `client/src/utils/terminalWaiting.js` — Replace the tab-scoped auto-clear with `getLandedWaitingSessionIds` over every parked session; add `getQuietStatusSessionIds` and `getParkedPaneSessionIds`.
  * `client/src/hooks/useWaitingSessions.js` — Own auto-clear, observing all polled sessions and finished flags; seeded on first run so loading never reads as a transition.
  * `client/src/App.jsx` — Pass session status and finished flags to the waiting hook; stop handing auto-clear to the terminal area.
  * `client/src/components/TerminalArea.jsx` — Drop its auto-clear effect; quiet the tab and pane dots of every pane in a parked tab.
  * `client/src/components/Sidebar.jsx` — Quiet parked sessions' dots and their project's aggregate, and note "(waiting)" in the session tooltip.
  * `README.md`, `docs/steering/product.md`, `docs/steering/structure.md` — Describe the quieted indicators and app-wide auto-clear.
* **🧪 Tests:**
  * `client/src/utils/__tests__/terminalWaiting.test.js` — Auto-clear watches every parked session, not only the project on screen; quiet-set union leaves the mute set untouched; parked split tabs quiet all panes.
  * `client/src/hooks/__tests__/useWaitingSessions.test.jsx` — A parked session in another project clears silently when it finishes; a finish that predates the mark does not.
  * `client/src/components/__tests__/TerminalAreaWaiting.test.jsx` — Parked pane dots stop pulsing, keep truthful tooltips, and are not reported as muted; the terminal area no longer clears marks itself.
  * `client/src/components/__tests__/SidebarWaitingCount.test.jsx` — Parked sidebar dots stop pulsing, tooltips say "waiting", and the project dot does not blink for a parked session.


## [2026-09-24] - Parking a tab no longer silently undoes itself

### Executive Summary
* Clicking the hourglass to park a tab showed the success message but the tab stayed exactly as it was, and parking only worked after reloading the page. Tabs are usually parked right after their previous task finished, and the app mistook that earlier finish for the new work landing, so it cleared each mark the instant it was set. Parking now only lifts when work finishes while the tab is parked, so it sticks when you set it and still clears itself when the agent is done.

### Technical Details
* **🐛 Bug Fix:**
  * Problem: auto-clear checked whether a tab's session was finished at the moment the mark arrived. A finished flag left over from the previous task, which stays set until the session is busy again and only resets on page reload, cleared every fresh mark immediately and silently.
  * Solution: auto-clear now fires only on a transition seen while the tab is parked (a pane newly finishing, or its session newly dying), comparing each poll against the previous one.
* **🛠️ Codebase:**
  * `client/src/utils/terminalWaiting.js` — Compare previous and current finished state and session status, so only new completions or deaths count as work landing.
  * `client/src/components/TerminalArea.jsx` — Remember the activity observed on the previous poll, seeded from the first render so mounting never reads as a transition.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalAreaWaiting.test.jsx` — Reproduce the report: a new mark on a tab whose earlier work had finished must not be cleared.
  * `client/src/utils/__tests__/terminalWaiting.test.js` — Pin transition semantics: new finishes and deaths clear the mark; a finish or death that predates the mark does not.


## [2026-09-22] - Park a tab as waiting while an agent works in it

### Executive Summary
* Handing a task to a coding agent used to leave its tab shouting for attention for as long as the agent worked. A tab can now be parked as waiting: it shrinks, dims and moves to the left of the tab bar so the tabs still being worked in keep their space, and the sidebar shows how many tabs are parked in each project — the signal that matters most for projects not currently on screen. Parking is deliberately temporary. The moment the work finishes, or its session dies, the mark lifts on its own and the tab returns to full size with its usual finished styling and notification, so nothing is missed by having asked for quiet.

### Technical Details
* **✨ New Feature:**
  * Mark a tab waiting from the hourglass beside its close button, or with Cmd/Ctrl+Shift+U on the active tab.
  * Parked tabs render compact and dimmed, drop their busy animation, and group to the left while keeping their relative order.
  * The mark clears automatically when any pane in the tab finishes or its session dies; manual clearing is always available on the parked tab.
  * Each sidebar project row shows a count of its parked tabs.
* **🔌 API/Interface:**
  * `GET /api/terminal-waiting` — paginated marks with an exact `sessionId` filter and `sessionId`/`waitingAt` sorting, using `sessionId` as the stable tiebreaker.
  * `PUT /api/terminal-waiting/:sessionId` — set or clear a mark; marking is idempotent and preserves the original timestamp. Unknown sessions return 404, and errors follow RFC 9457 with a `traceId` matched by `X-Trace-Id`.
* **🗄️ Database:**
  * New `terminal_waiting` table holding `session_id` and an ISO-8601 `waiting_at`, validated per field on read as well as write. Deleting a terminal clears its mark, because session ids are reused and a stale mark would silence a brand-new terminal.
* **🐛 Bug Fix:**
  * Problem: the first implementation used the tab's status dot as the toggle, turning an indicator into a control and leaving the feature with no visible resting appearance at all. Solution: give the toggle its own hourglass button beside the close X, mirroring the affordance project rows already use, and return the dot to reporting status only.
  * Problem: a parked tab's tooltip replaced the real terminal status with the waiting note, hiding what the terminal was actually doing. Solution: report both.
* **🛠️ Codebase:**
  * `server/terminal-waiting-store.js` — SQLite store for waiting marks with per-field guards on read and write.
  * `server/routes/terminal-waiting.js` — Paginated collection and mark/clear endpoint with its own JSON parser and Problem Details handler.
  * `server/index.js` — Wire the store and router, and clear a session's mark when the terminal is deleted.
  * `client/src/utils/terminalWaiting.js` — Tab waiting identity, left-grouping order, auto-clear rules, and per-project counts.
  * `client/src/hooks/useWaitingSessions.js` — Mirror marks only after the backend confirms the write; auto-clear stays silent while user actions toast.
  * `client/src/components/TerminalArea.jsx` — Render the waiting button, compact parked tabs, the left grouping, the shortcut, and the auto-clear effect.
  * `client/src/components/Sidebar.jsx` — Show a waiting count on each project row.
  * `client/src/components/ShortcutsOverlay.jsx` — Document Cmd/Ctrl+Shift+U.
  * `client/src/App.jsx` — Hold waiting state and pass it to the workspace and sidebar.
  * `README.md`, `docs/steering/product.md`, `docs/steering/structure.md`, `docs/steering/api-standards.md` — Document the feature, its terminology, the new files, and the endpoint contract.
* **🧪 Tests:**
  * `server/__tests__/terminal-waiting-store.test.js` — Marking, idempotency, clearing, ordering, reopen, and per-field rejection.
  * `server/__tests__/terminal-waiting-api.test.js` — Round trip, pagination, filtering, sorting, 404, field errors, and malformed JSON.
  * `client/src/utils/__tests__/terminalWaiting.test.js` — Identity, ordering, auto-clear conditions, and project counts.
  * `client/src/hooks/__tests__/useWaitingSessions.test.jsx` — Load, confirmed writes, failure surfacing, and silent auto-clear.
  * `client/src/components/__tests__/TerminalAreaWaiting.test.jsx` — Grouping, compactness, the visible toggle, the inert status dot, truthful tooltips, the shortcut, and auto-clear.
  * `client/src/components/__tests__/SidebarWaitingCount.test.jsx` — Per-project counts, singular and plural labels, and compact mode.
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — Extend the icon mock now that the hourglass always renders.


## [2026-09-19] - Automatic session titles with reliable naming settings

### Executive Summary
* Sessions can now receive short descriptive titles through a configured Conduit model, making tabs easier to distinguish without interrupting terminal work. Titles persist, manual names take precedence, and failures retry in the background for a bounded period. The main settings Save button now also saves the selected naming effort.

### Technical Details
* **✨ New Feature:**
  * Agent-agnostic naming follows submitted input and terminal activity; up to two background requests run concurrently.
  * Manual rename and automatic retries preserve existing labels on failure and keep session identities unchanged.
* **🐛 Bug Fix:**
  * Problem: changing naming effort and using the main Save button left the old naming selection persisted. Solution: integrate naming settings with Save, Revert, and unsaved-change indicators; verify persistence across reloads.
  * Empty Enter presses no longer arm naming; failures retry every ten seconds for up to one minute after the first failure.
* **🛠️ Codebase:**
  * `README.md` — Document configuration, title behavior, bounded retries, and context retention.
  * `client/src/App.jsx` — Poll title metadata independently and pass titles to the workspace.
  * `client/src/components/SettingsPanel.jsx` — Include naming fields in the main Save, Revert, and unsaved-state controls.
  * `client/src/components/SessionNamingSettings.jsx` — Add connection testing and catalog-driven provider, model, and effort selection.
  * `client/src/components/SessionTitleActions.jsx` — Add manual rename, failure details, and retry actions.
  * `client/src/components/Sidebar.jsx` — Display descriptive titles while retaining session IDs in tooltips.
  * `client/src/components/TerminalArea.jsx` — Display pane titles and use the first pane title for split tabs.
  * `client/src/components/session-naming.css` — Style naming settings, status, and rename dialogs.
  * `client/src/hooks/useSessionTitles.js` — Poll persisted metadata with cancellation and no overlapping requests.
  * `client/src/utils/sessionNamingApi.js` — Provide naming requests and paginated metadata retrieval.
  * `client/src/utils/terminalActivity.js` — Use descriptive titles in completion notifications.
  * `client/src/utils/terminalTabLabel.js` — Resolve a tab label from its first pane title.
  * `client/src/components/__tests__/SessionNaming.test.jsx` — Cover settings save/reload/revert/failure, catalog choices, titles, retry, and polling.
  * `client/src/components/__tests__/Sidebar.test.jsx` — Verify title display and update theme mocks for regression coverage.
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — Verify restored titles preserve terminal identity.
  * `client/src/test-setup.js` — Supply the media-query browser contract in jsdom.
  * `client/vitest.config.js` — Register shared browser test setup.
  * `server/index.js` — Wire naming routes, persistence, terminal snapshots, input observations, and deletion.
  * `server/conduit-naming-client.js` — Send the exact configured selection through bounded Conduit requests with circuit breakers.
  * `server/session-naming-service.js` — Coordinate submission eligibility, background generation, revision protection, and bounded retries.
  * `server/session-naming-store.js` — Persist title metadata and settings; mark interrupted jobs retryable on restart.
  * `server/session-naming-credentials.js` — Store credentials separately in a private file.
  * `server/session-naming-validation.js` — Validate settings, catalog fields, persisted metadata, and generated titles.
  * `server/routes/session-naming.js` — Expose validated settings, catalog, title, retry, and health APIs with pagination and problem details.
  * `server/terminal-runtime.js` — Expose existing local and remote classification snapshots through callbacks.
  * `server/terminal-session-status-cache.js` — Observe activity without exposing terminal snapshots in status responses.
  * `server/ws-handler.js` — Observe submitted input independently of immediate terminal writes.
  * `server/__tests__/session-naming.test.js` — Cover eligibility, state transitions, persistence, concurrency, revision safety, and retry timing.
  * `server/__tests__/session-naming-api.test.js` — Cover API validation, private credentials, exact effort transport, failures, and breaker recovery.
  * `server/__tests__/terminal-session-status-cache.test.js` — Verify local and remote snapshots stay out of public status.
  * `server/__tests__/ws-handler.test.js` — Verify naming observation cannot block terminal input.
  * `server/package.json` — Add the opossum circuit-breaker dependency.
  * `package-lock.json` — Lock the circuit-breaker dependency.
  * `docs/steering/api-standards.md` — Document naming API contracts, limits, errors, and persistence.


## [2026-07-19] - node-pty upgrade with PTY descriptor leak regression test

### Executive Summary
* The native terminal layer (node-pty) was upgraded from 1.0.0 to 1.2.0-beta.12 to pick up upstream fixes in how PTY file descriptors are managed. Every terminal pane opens a PTY "master" descriptor in the server process; if those aren't released when terminals close, the server slowly accumulates dead descriptors until the OS refuses to open new terminals. A new regression test now proves the descriptor lifecycle is clean: it spawns and shuts down 20 terminals in a row and asserts the process ends with exactly as many open PTY masters as it started with.

### Technical Details
* **🛠️ Codebase:**
  * `server/package.json` — pinned `node-pty` to `1.2.0-beta.12` (was `^1.0.0`).
  * `package-lock.json` — lockfile update for the node-pty version bump.
* **🧪 Tests:**
  * `server/__tests__/pty-descriptor-lifecycle.test.js` — new macOS-only Vitest suite that counts open `/dev/ptmx` masters via `lsof`, spawns and kills 20 short-lived PTYs, and asserts the open-master count returns to baseline — guarding against PTY master descriptor leaks on terminal shutdown. Verified passing against the upgraded version.

## [2026-07-19] - Light mode with a dark / light / system theme toggle

### Executive Summary
* CodeDeck is no longer dark-only. A new theme button in the sidebar footer cycles between dark, a warm "paper terminal" light theme, and system mode that follows the OS appearance (including live OS switches). Everything re-themes instantly — panels, modals, toasts, and open terminals, which repaint with a matching light ANSI palette without reconnecting. New users default to system mode; the choice persists across sessions.

### Technical Details
* **✨ New Feature:**
  * `client/src/theme.js` — new theme module: persists the selected mode (`dark`/`light`/`system`) in localStorage, resolves system mode via `prefers-color-scheme` (re-resolving on OS changes), stamps the resolved theme on `<html data-theme>`, broadcasts a `codedeck-theme-change` event, and exports light/dark xterm ANSI palettes.
  * `client/src/components/Sidebar.jsx` — footer toggle button cycling dark → light → system with Moon / Sun / Monitor icons.
  * `client/src/styles/global.css` — full light-theme variable override block under `:root[data-theme="light"]` (warm parchment surfaces, ink text, deepened green accent for contrast) plus `color-scheme` hints.
  * `client/src/components/Terminal.jsx` — xterm theme now comes from the resolved theme and updates live on theme-change events, so open terminals switch palettes without reconnecting.
* **🛠️ Codebase:**
  * `client/src/styles/global.css` — introduced semantic tokens (`--glass-*`, `--overlay-scrim*`, `--tooltip-bg`, `--code-bg`, `--term-bg`, `--shell-bg`, `--toast-*`, `--accent-contrast`, `--glow-*`, `--empty-card-bg`, `--table-header-bg`) and converted the stylesheet's hardcoded dark-glass values to them.
  * `client/src/components/{DirectoryBrowser,FileBrowserPanel,FileTree,HostsSection,PreviewPage,SettingsPanel,TerminalArea,TerminalInspector,ToastContext}.jsx` — swept ~50 hardcoded dark colors (white-glow glass fills, dark scrims, the `#09090b` terminal frame, toast palettes, warning ambers, black-on-accent button text) to the new tokens so both themes render coherently.
  * `client/src/main.jsx` — initializes the theme before React renders to avoid a flash of the wrong theme.

## [2026-07-13] - Terminal copy that actually reaches the clipboard

### Executive Summary
* Copying text out of a terminal was a lottery with three different selection behaviours — a yellow tmux highlight that never copied, an Option-drag green highlight where Cmd+C only sometimes worked, and TUI apps whose copies died in a tmux buffer with a "paste with prefix + ]" hint. The root causes were that the browser terminal silently ignored the OSC 52 clipboard escape sequence tmux emits, and tmux's default `set-clipboard external` rejects clipboard writes from programs running inside panes. All three paths now land on the system clipboard: plain drag-select in tmux copy-mode, Option-drag browser selections (with a working Cmd+C), and copies initiated by full-screen apps like agent CLIs. The tmux copy-mode highlight also now matches the app's green selection colour instead of rendering yellow. Verified end-to-end against a remote SSH host: an OSC 52 emitted inside a remote pane arrived on the macOS clipboard.

### Technical Details
* **🐛 Bug Fix:**
  * `client/src/components/Terminal.jsx` — Problem: tmux forwarded copied selections to the browser as OSC 52 sequences, but xterm.js drops OSC 52 without the clipboard addon, so tmux drag-copies never reached the clipboard. Solution: load `@xterm/addon-clipboard` on every terminal.
  * `server/terminal-runtime.js` — Problem: the default `set-clipboard external` makes tmux reject OSC 52 from programs inside panes (TUIs copying a selection fall back to a tmux paste buffer). Solution: both the local and remote runtimes set the server option `set-clipboard on` during session-option alignment, so inner-app copies are accepted and forwarded to the browser.
  * `client/src/components/Terminal.jsx` — Problem: Cmd+C on a browser-side selection only worked while xterm's hidden textarea had focus, and the copy-on-select fallback swallowed `navigator.clipboard.writeText` rejections silently. Solution: a custom key handler copies the active selection explicitly on Cmd+C, and clipboard writes fall back to an `execCommand('copy')` textarea with a console warning plus an error toast (Cmd+C path) when both fail.
* **🛠️ Codebase:**
  * `server/terminal-runtime.js` — tmux `mode-style` is set to `bg=#26443a,fg=#e4e4e8` (the green accent blended over the terminal background) in both runtimes so copy-mode selections match the xterm selection colour instead of tmux's default yellow.
  * `client/package.json` / `package-lock.json` — added `@xterm/addon-clipboard` 0.2.x.

## [2026-07-13] - SSH connection pressure hardening and truthful detached terminals

### Executive Summary
* Remote terminals no longer leak SSH connections and the sidebar stays honest while you work elsewhere. Closing a browser terminal now releases its live SSH/tmux attachment (the durable tmux session survives), yet the sidebar cockpit keeps showing real running/idle status for projects left in the background instead of greying them out. One-shot SSH traffic is bounded below OpenSSH's per-connection limits so bursts of status polls can no longer fail with "Session open refused by peer". A follow-up code review of this work fixed several reconnection races: keystrokes typed during a remote reconnect were silently dropped, a browser close during recovery could spawn an orphaned SSH process, and a session that died mid-reconnect could leave a frozen pane with no error.

### Technical Details
* **✨ New Feature:**
  * `server/command-runner.js` — One-shot ssh/scp commands share a per-host limiter (8 concurrent, below OpenSSH's MaxSessions) keyed by ControlPath + target so independently created runners share one budget; the limiter registry self-evicts when idle. Interactive PTYs use dedicated `ControlMaster=no` transports so long-lived tmux attachments cannot exhaust the shared master.
  * `server/terminal-runtime.js` — Remote status refresh collapses cwd + pane state + snapshot tail into one aggregate SSH command (`getSessionStatusAsync`); removed the superseded two-round-trip `getSessionExecutionStateAsync` from the host runtime.
  * `server/host-reachability.js` — A full ControlMaster ("Session open refused by peer") is classified as capacity pressure, keeping the host's reachability state intact instead of marching it toward unreachable.
  * `server/ws-handler.js` — Browser close releases only the tmux attachment PTY (`detachTmuxClient`), preserving the durable tmux session for reconnect.
* **🐛 Bug Fix:**
  * `server/terminal-session-status-service.js` & `server/terminal-session-status-cache.js` — Problem: detached sessions were frozen on a static `unknown` status and reported `alive: false`, so backgrounded projects rendered dead in the cockpit. Solution: client-detached durable sessions report `alive: true` and keep polling live execution state from tmux by session name (no PTY required).
  * `server/ws-handler.js` — Problem: a browser close landing during the async exit-recovery probe respawned an SSH attachment nobody was connected to. Solution: the exit handler re-checks detach state after the probe and after spawn, killing any freshly spawned attachment.
  * `server/ws-handler.js` — Problem: if the durable session died while a replacement browser was hydrating, the new socket was bound to a dead PTY with a normal handshake (silently frozen pane). Solution: the attach fails with a `spawn_error` and the socket is closed.
  * `client/src/components/Terminal.jsx` — Problem: keystrokes buffered during a reconnect were flushed at socket open, before the remote server had registered its message handlers, and were silently dropped. Solution: all input (live typing, Ctrl-key passthrough, and the reconnect buffer) is gated on the `session` handshake and flushed there in order.
* **🛠️ Codebase:**
  * `server/command-runner.js` — Removed the capacity-triggered direct-connection retry (unrequested fallback logic); capacity errors now propagate to the reachability classifier as designed.
  * `server/ws-handler.js` — `detachTmuxClient` logs `pty.kill()` failures to the session timeline instead of swallowing them.
  * `docs/specifications/2026-07-06-195021-remote-host-connectors-spec.md` & `docs/todos/2026-07-06-195021-remote-host-connectors.md` — Spec §5 updated for bounded multiplexing + dedicated PTY transports; Phase 3A and code-review session notes recorded.
* **🧪 Tests:**
  * `server/__tests__/ws-handler-remote.test.js` — New regression tests for the detach-during-probe, detach-during-spawn, and died-while-hydrating races.
  * `server/__tests__/command-runner.test.js`, `server/__tests__/host-reachability.test.js` — Limiter sharing across runners, PTY argv isolation, and capacity errors propagating without a side-connection retry while leaving reachability neutral.
  * `server/__tests__/terminal-session-status-service.test.js`, `server/__tests__/terminal-session-status-cache.test.js`, `server/__tests__/host-terminal-runtime.test.js`, `server/__tests__/ws-handler.test.js` — Detached sessions keep truthful live status; aggregate status probe failure fallback; detach-on-close lifecycle.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Input buffers past socket open and flushes in order at the session handshake.

### Executive Summary
* CodeDeck now fully supports interacting with remote project environments over SSH. You can define remote hosts and their SSH targets through the UI Settings, and create projects bound to those hosts. Remote terminals run transparently via SSH, complete with reliable `tmux` session persistence, durable recovery for network drops, remote file browsing, dragging-and-dropping remote file uploads, and native VS Code remote editor launching.

### Technical Details
* **✨ New Feature:**
  * `client/src/components/SettingsPanel.jsx` & `client/src/components/HostsSection.jsx` — Added UI for adding, modifying, testing, and deleting remote hosts alongside the default `local` host.
  * `server/routes/hosts-routes.js` — Introduced CRUD endpoints for managing host configurations in SQLite, including `POST /api/hosts/:name/test` to validate SSH reachability and `tmux` availability.
  * `server/command-runner.js` — Built a robust async command runner for `execFile` and SSH with POSIX-compliant argument quoting, `BatchMode=yes`, and `ControlMaster` connection multiplexing.
  * `server/host-reachability.js` — Implements continuous reachability polling to intelligently suppress network traffic during remote disconnects and restore detached terminal sessions upon recovery.
  * `server/terminal-runtime.js` & `server/host-terminal-runtime.js` — Centralizes terminal runtime functionality for both local `pty` and remote SSH targets, enabling polymorphic backend `tmux` management.
* **🛠️ Codebase:**
  * `server/file-tree.js` & `server/file-preview.js` — Refactored to execute remote host commands (`ls -1pA`, `wc -c`, `head -c`) instead of local Node `fs` methods when exploring directories.
  * `server/index.js` — Rebuilt `/api/open` and `/api/upload` to automatically spawn `code --remote ssh-remote+<target>` locally and `scp` dropped files to `/tmp/codedeck-drops/` remotely.
  * `client/src/components/Sidebar.jsx`, `Terminal.jsx`, & `App.jsx` — Updated core components to propagate host contexts, track unreachable states, and display compact host badges.
* **🧪 Tests:**
  * `server/__tests__/command-runner.test.js`, `server/__tests__/ws-handler-remote.test.js`, `server/__tests__/host-reachability.test.js`, `server/__tests__/hosts-routes.test.js`, and more — Added comprehensive test suites running against shimbed executables to verify end-to-end POSIX quoting, timeout boundaries, and multi-host websocket hydration logic.

## [2026-06-29] - Keyboard shortcut for pane status mute

### Executive Summary
* Pane status noise can now be quieted without reaching for the mouse: **Cmd/Ctrl+Shift+M** toggles the active pane's eye/eye-off status mute control. The shortcut uses the same per-session mute path as the header button, so it only changes visual status colors and leaves the real running/idle/finished state intact.

### Technical Details
* **✨ New Feature:**
  * `client/src/components/TerminalArea.jsx` — Added Cmd/Ctrl+Shift+M to the capture-phase pane shortcut handler and advertised it in the status mute button tooltip.
  * `client/src/components/ShortcutsOverlay.jsx` — Added "Mute status colors" to the terminal shortcuts reference.
* **📝 Documentation:**
  * `README.md` — Documented the active-pane status mute shortcut in the usage flow.
  * `docs/specifications/keyboard-shortcuts-spec.md` and `docs/todos/keyboard-shortcuts.md` — Updated the shortcut map and implementation notes with the status mute shortcut.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — Added coverage for the keyboard shortcut and shortcut-enhanced status mute tooltip.

## [2026-06-21] - Show system resources in the browser tab

### Executive Summary
* The browser tab now doubles as a lightweight system monitor, showing live memory, CPU, and disk usage without switching back to the dashboard. CodeDeck collects these resources itself, so open-source installs do not need a separate dev-scripts service. When any resource reaches 90% or higher, the tab becomes more attention-grabbing with an urgent title marker and red warning favicon so pressure is visible even while CodeDeck is in the background.

### Technical Details
* **✨ New Feature:**
  * `server/index.js` — Added `GET /api/system/resources` so CodeDeck serves its own structured CPU, memory, and disk snapshot.
  * `server/system-resources.js` — Added structured resource collection for CPU, memory, and disk, ported from the dev-scripts implementation with command-failure fallbacks.
  * `server/memory-stats.js` — Added cross-platform memory collection using macOS `vm_stat`, Linux `/proc/meminfo`, and a Node `os` fallback.
  * `client/src/App.jsx` — Added a 30-second same-origin poll against `/api/system/resources`, updates `document.title` with resource percentages, and switches the favicon to a red warning badge when CPU, memory, or disk reaches the 90% alert threshold.
  * `client/src/utils/systemResourceTitle.js` — Added resource title formatting, alert threshold detection, percent formatting, and red SVG favicon generation for alert states.
* **🛠️ Codebase:**
  * `client/src/App.jsx` — Keeps resource polling out of preview tabs, avoids overlapping resource fetches, and restores the default title/favicon on cleanup.
* **🧪 Tests:**
  * `server/__tests__/memory-stats.test.js` — Added coverage for macOS `vm_stat` parsing and Linux `/proc/meminfo` parsing.
  * `server/__tests__/system-resources.test.js` — Added coverage for CPU parsing, disk parsing, structured resource snapshots, and command-failure fallback fields.
  * `client/src/App.test.jsx` — Added app-level coverage for immediate resource title updates, 30-second polling, and alert favicon switching when a resource reaches 90%.
  * `client/src/utils/__tests__/systemResourceTitle.test.js` — Added formatter coverage for normal values, CPU display strings, fallback behavior, invalid percentages, threshold detection across CPU/memory/disk, and red favicon generation.

## [2026-06-20] - Quiet muted terminal indicators and PTY preflight

### Executive Summary
* Terminal status attention is now easier to control: individual panes can mute their status colors so busy or finished work elsewhere does not keep blinking while you focus on the active pane. The muted state stays visually quiet across the pane header, tab bar, and sidebar while preserving the real running/idle/finished status text. The terminal runtime also reports a clearer blocked state when tmux is present but the PTY helper cannot spawn processes, so startup failures are surfaced before opening a broken terminal.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Muting a terminal status removed the busy dot animation but still left green attention styling on the muted control and active pane frame, so the muted pane could continue drawing focus.
  * **Solution:** Muted panes now use neutral visual status, neutral frame styling, no dot animation class, no status glow, and a subdued toggle button while keeping the real status label visible.
  * **Problem:** `getTerminalRuntimeStatus()` treated tmux availability as sufficient for terminal creation, even when `node-pty` could not spawn its helper process.
  * **Solution:** The tmux runtime now runs and caches a PTY spawn probe; health/status responses block terminal creation with a `pty_spawn_failed` reason and the captured spawn error when the probe fails.
* **✨ New Feature:**
  * `client/src/App.jsx` — Added persistent `mutedStatusSessionIds` state in localStorage and passed the preference through to the sidebar and terminal area.
  * `client/src/components/TerminalArea.jsx` — Added a pane-header control to mute/show status colors per terminal. Tabs and pane chrome now render from muted-aware visual status while preserving actual status labels and tooltips.
  * `client/src/components/Sidebar.jsx` — Sidebar project/session indicators now use muted-aware visual status so muted terminals do not keep their project row active or finished-colored.
  * `client/src/utils/terminalActivity.js` — Added visual-status helpers that neutralize muted sessions for rendering without changing the underlying display status or notification logic.
* **🛠️ Codebase:**
  * `client/src/styles/global.css` — Added amber warning styling and finished-state blink support with reduced-motion handling.
  * `server/terminal-runtime.js` — Added PTY spawn status constants, spawn-probe caching, health/status reporting for `ptySpawnAvailable`, and spawn-time blocking when the probe fails.
* **🧪 Tests:**
  * `client/src/components/__tests__/Sidebar.test.jsx` — Added coverage proving muted running terminals render neutral in the project list.
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — Added coverage for the mute/show control, neutral muted pane styling, and unchanged status labels.
  * `client/src/utils/__tests__/terminalActivity.test.js` — Added coverage proving muted running and finished sessions are neutralized only for visual status aggregation.
  * `server/__tests__/terminal-runtime.test.js` — Added coverage for tmux-present/PTY-spawn-failed health status.

## [2026-05-12] - Accessibility tooltips and sidebar/terminal layout improvements

### Executive Summary
* Every interactive button across the UI now has a `title` attribute with a descriptive tooltip — from refresh/copy/download buttons in the preview panel, to terminal tabs and pane controls, to folder search and tree controls in the file browser. Sidebar project rows were restructured so inline action buttons (copy path, move-to-waiting, shelve, context menu) now render on their own line below the project name instead of competing for space inline. The TerminalArea gained a dedicated project name row above the tab bar, and shortcut keys are now shown in button titles (e.g. "Split right (⌘⇧E)").

### Technical Details
* **🛠️ Codebase:**
  * `client/src/components/DirectoryBrowser.jsx` — Added `title` attributes to Cancel and Select Folder buttons.
  * `client/src/components/FileBrowserPanel.jsx` — Added `title` attributes to Expand all and Fold all buttons.
  * `client/src/components/FileContextMenu.jsx` — Added `title` attributes to Copy relative path and Copy path menu items.
  * `client/src/components/FileTree.jsx` — Added `title` attributes to Expand and Fold buttons.
  * `client/src/components/PreviewPage.jsx` — Added `title` attributes to Refresh, Copy, Download, Open in editor, Zoom controls, and Close diagram buttons.
  * `client/src/components/SettingsPanel.jsx` — Added `title` attributes to Close and Save buttons with contextual save state messaging.
  * `client/src/components/Sidebar.jsx` — Extracted `project-inline-actions` from inside the "Row 1" name div to a sibling div on its own line. Applied same restructuring to Waiting and Shelved sections. Added `title` to project menu items. Project name spans are now verified to contain no nested buttons in tests.
  * `client/src/components/TerminalArea.jsx` — Extracted the project name into a new dedicated row (`data-testid="terminal-project-row"`) above the tab bar with a full project path tooltip. Added `formatShortcutTitle()` helper that appends keyboard shortcut to button titles. Applied to Split right, New terminal, Clear terminal, and Close pane buttons. Added `aria-label` attributes to all pane header buttons. Added `title` to the empty-state CTA, close-tab X, and project menu item buttons.
  * `client/src/components/TerminalInspector.jsx` — Added `title` to the Copy debug snapshot button.
  * `client/src/components/ToastContext.jsx` — Added `title` to the dismiss notification button.
  * `client/src/styles/global.css` — `.project-inline-actions` gains `justify-content: flex-end`, `width: 100%`, `margin-top: 3px`, and `padding-left: 16px` to right-align action buttons on their own line below the project name.
* **🧪 Tests:**
  * `client/src/components/__tests__/Sidebar.test.jsx` — New assertions verifying project-inline-actions is a sibling div (not nested inside the name span), and name spans contain no buttons.
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — New test verifying the project name renders in its own row (separate from tab controls). New assertions for shortcut-enhanced button titles and aria-labels on pane header buttons.

## [2026-05-11] - Waiting state for projects and sidebar action menus

### Executive Summary
* Projects now have a third state — **Waiting** — between active and shelved. Waiting projects appear in a dimmed section below active projects with their own controls (activate, shelve, copy path, and a context menu). This lets users park projects they aren't actively working on without archiving them. The sidebar's row actions were also redesigned: the most-used actions (copy path, move-to-waiting, shelve) stay visible as inline buttons, while secondary actions (rename, mute, browse files, remove) were consolidated into a portal-based `MoreVertical` dropdown menu to reduce visual clutter.

### Technical Details
* **✨ New Feature:**
  * `server/project-config.js` — New `normalizeProject()` and `normalizeProjects()` helpers that default every project to `{ shelved: false, shelvedAt: null, waiting: false, waitingAt: null }`. Used by `loadProjects()` in `server/index.js` to replace inline defaults.
  * `server/index.js` — PUT `/api/projects/:name` now accepts and persists `waiting` and `waitingAt` fields alongside the existing `shelved`/`shelvedAt` pair.
  * `client/src/App.jsx` — Added `markWaitingProject()`, `activateWaitingProject()` handlers that call the PUT endpoint with the appropriate waiting fields. `unshelveProject()` and `shelveProject()` now also clear waiting state to avoid a project landing in two states at once. `activeProjects` derivation excludes waiting projects; a new `waitingProjects` derivation filters for `!shelved && waiting`, sorted by `waitingAt` desc. `ProjectSwitcher` receives both active and waiting projects, and selecting a waiting project activates it before switching.
  * `client/src/components/Sidebar.jsx` — New `waitingProjects` prop renders a collapsible "Waiting (N)" section between active projects and the shelf. Each waiting row shows a status dot, project name, inline Play/Copy/Shelve buttons, and a `MoreVertical` menu (rename, remove). Active project rows gained inline Copy, Hourglass (move-to-waiting), and Archive (shelve) buttons, while Rename, Mute, Browse Files, and Remove moved into a `renderProjectMenu()` portal dropdown. Shelved rows now offer inline Copy and page-up menus (rename, remove) instead of flat action buttons. Rename is now an inline input on the row itself for all three sections. `copyProjectPath()` uses `navigator.clipboard.writeText()` with a toast on success/failure.
  * `client/src/components/ProjectSwitcher.jsx` — Waiting projects appear in the switcher list with a muted "Waiting" badge. `scrollIntoView` call now guarded with a typeof check. Rows gain a `.waiting` CSS class for muted styling.
* **🛠️ Codebase:**
  * `client/src/styles/global.css` — Added `.waiting-row`, `.project-inline-actions` (opacity reveal on row hover), `.project-menu-wrap`, `.project-menu`, `.project-menu-fixed`, `.project-menu-up`, `.project-menu-item` (with `.danger` variant), and `.project-switcher-state` badge styles. Project/waiting/shelf rows gain `z-index: 80` when focused or menu-open to prevent z-fighting. `.project-actions` got `overflow: visible`.
* **🧪 Tests:**
  * `client/src/components/__tests__/ProjectSwitcher.test.jsx` — New test file verifying waiting projects render with a "Waiting" badge and fire `onSelect` with the full project object.
  * `client/src/styles/__tests__/global-css.test.js` — New test asserting `.project-menu` uses `background: var(--bg-surface)` (opaque) so rows don't bleed through the dropdown.
  * `server/__tests__/project-config.test.js` — New test file covering `normalizeProject` defaults and preserving existing waiting metadata.
  * `client/src/App.test.jsx` — New test: "activates a waiting project before selecting it" — verifies the PUT call clears waiting fields and triggers a session fetch.
  * `client/src/components/__tests__/Sidebar.test.jsx` — New tests: "renders waiting projects as compact muted rows below active projects" and "keeps copy path visible and moves rename/delete into the project actions menu." Added `cleanup()` to afterEach.
  * `client/src/utils/__tests__/terminalActivity.test.js` — New test: "skips completion notification for waiting projects that are outside the active set."

### Executive Summary
* Three terminal improvements shipped together. Terminals now turn solid red when a busy command finishes, making it easy to spot which panes need attention without reading every tab label. A reset button acknowledges the red state and fades it back to grey. Separately, tmux mouse mode was re-enabled so wheel scrolling drives tmux history directly (fixing the no-scrollback ArrowUp fallback), and copy-on-select was added so text selected by dragging is automatically copied to the clipboard despite tmux mouse mode blocking normal browser selection.

### Technical Details
* **✨ New Feature:**
  * Terminals now latch into a client-side `finished` state when they transition from `busy` (green) to `idle`/`unknown`. The status dot, tab underline, and sidebar indicators all turn solid red. The red state persists across re-renders until explicitly reset or until the terminal starts running again.
  * Each pane header now shows a **↺ Reset status** button (only when red) that removes the session from `finishedSessionIds` and restores the grey idle appearance.
  * `App.jsx` tracks `finishedSessionIds` in app-level state, detects busy→idle transitions via `sessionStatus` polling, auto-clears finished sessions that become busy again, and prunes dead sessions from the set.
* **🛠️ Codebase:**
  * `client/src/utils/terminalActivity.js` — Added `getDisplayTerminalStatus()`, `getDisplayAggregateTerminalStatus()`, and `getDisplayTabTerminalStatus()` which overlay the client-side `finished` state on top of the server-reported status.
  * `client/src/App.jsx` — Added `finishedSessionIds` state, transition-detection effect, and `resetFinishedSession` callback passed to both `Sidebar` and `TerminalArea`.
  * `client/src/components/TerminalArea.jsx` — Added `finished` entry to `TAB_STATUS_STYLES`, `PANE_STATUS_LABELS`, and `PANE_STATUS_TITLES`. Tabs and panes now use the display-status helpers. Added conditional `RotateCcw` reset button in the pane header.
  * `client/src/components/Sidebar.jsx` — `getProjectStatus()` now accepts `finishedIds` and uses `getDisplayAggregateTerminalStatus()`. Per-session dots turn red for `finished` status. `STATUS_COLORS` gained `finished: 'var(--danger)'`.
  * `client/src/styles/global.css` — Added `.terminal-tab-finished::after` red underline rule matching the existing busy green underline.
* **🛠️ Codebase:**
  * `server/terminal-runtime.js` — Changed tmux session option from `mouse off` to `mouse on` so wheel events scroll tmux history natively instead of falling through to the ArrowUp shell-history fallback.
  * `client/src/components/Terminal.jsx` — Added `macOptionClickForcesSelection: true` to xterm options. Added copy-on-select via `term.onSelectionChange()` with a 150ms debounce that writes selection text to `navigator.clipboard`, compensating for tmux mouse mode preventing normal browser drag-selection/copy.
* **🧪 Tests:**
  * `server/__tests__/terminal-runtime.test.js` — Updated tmux mouse-mode assertion to expect `mouse on`.

## [2026-05-07] - Detect launcher crashes and browse beyond the project root in the file tree

### Executive Summary
* Two unrelated quality-of-life fixes shipped together. The launcher (`start.sh` + `server.sh`) used to silently appear "running" when one of its child npm processes crashed — `wait` blocked on whichever child was still alive, the PID file claimed success, and `status` reported green even with no listener on the port. The launcher now supervises each service in its own subshell, writes the first exit event to a shared temp file, and tears down the survivor immediately; `server.sh start` watches the launcher PID during the readiness loop and aborts with the recent logs if it dies, and `server.sh status` reports a degraded state (and exits non-zero) when the listener ports are unbound. Separately, the file tree gained a clickable breadcrumb of the current root plus a folder-search button that opens the existing `DirectoryBrowser`, so you can pivot the file panel to any directory on disk without changing the active project; failed `/api/files` calls now render a visible error message instead of a blank pane.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `./start.sh` ran the backend and frontend as plain `npm run dev` background jobs and then `wait`ed on both. If one child crashed (e.g. backend EADDRINUSE, frontend Vite stdin-EOF shutdown when launched detached by `server.sh`), `wait` returned for that child but the script kept blocking on the other one. From `server.sh`'s perspective the launcher PID was still alive, so it printed "Server is running" and `check_status` reported green even though one of the two listeners was gone. There was no way to notice without manually `lsof -i :43001`.
  * **Solution:** Each service now runs inside a supervisor subshell that captures the npm child PID, traps INT/TERM to forward the signal, waits on the child, and appends a single `label:status:child_pid` line to a temp `EXIT_EVENT_FILE`. The main shell calls `wait_for_first_exit`, which polls that file and reads the first event; as soon as either service exits the script logs which one died and runs `cleanup`, killing the survivor and propagating the failed status. `run_service` also sets `CI=true` for the frontend so Vite treats stdin EOF as a normal shutdown when invoked from the detached launcher rather than crashing on it.
* **🐛 Bug Fix:**
  * **Problem:** `server.sh start` waited up to 30 seconds for both ports to bind, but never checked whether the detached launcher was still alive. If `start.sh` exited within that window (e.g. an immediate npm failure), the loop kept polling, eventually printed a generic timeout, and left a stale PID file behind.
  * **Solution:** The readiness loop now `ps -p "$DETACHED_PID"` each iteration; if the launcher is gone it prints the last 20 log lines, removes the PID file, and returns failure. `check_status` was tightened in parallel: when the PID file exists but one of the two listener PIDs is missing, it labels the run "degraded" (yellow), prints the missing port in red, and returns exit 1 so callers/CI can tell.
* **✨ New Feature:**
  * The file tree side panel now exposes the current root as a clickable breadcrumb and a folder-search button next to Expand/Collapse. Clicking any segment of the breadcrumb sets that ancestor as the new root; clicking the folder-search button opens the existing `DirectoryBrowser` modal so you can pick any directory on disk. The browser-picked path becomes the file tree's root without changing the active project. Failed `/api/files` responses are surfaced inline (red error text) instead of leaving the panel blank.
* **🛠️ Codebase:**
  * `start.sh` — Added `EXIT_EVENT_FILE` temp file plumbing, `run_service` supervisor subshell with INT/TERM forwarding and `CI=true` for the frontend, and `wait_for_first_exit` to block until either service emits an exit event. Replaced the trailing bare `wait` with `wait_for_first_exit && cleanup && exit "$EXIT_STATUS"`. `cleanup` now also removes the temp file.
  * `server.sh` — `start_server` readiness loop now checks `ps -p "$DETACHED_PID"` and bails with logs + PID-file cleanup on launcher death. `check_status` tracks a `missing` flag, downgrades to "Server is degraded" when either listener PID is empty, prints per-port red diagnostics, and returns the missing flag (so the offline branch also returns 1).
  * `client/src/components/FileTree.jsx` — Imported `FolderSearch` and `DirectoryBrowser`. Added `currentRoot` state (synced from the `root` prop via effect), `error` state, and `showBrowser` state. Refactored the fetch effect to use cancellation, parse `{ error }` payloads on non-OK responses, and key on `currentRoot`. Added a `buildBreadcrumb` helper, a breadcrumb strip with per-segment click-to-navigate buttons, an inline error renderer, the folder-search button, and the `DirectoryBrowser` overlay. Context menu now uses `currentRoot` instead of the original `root` prop so right-click actions stay anchored to the active view.



### Executive Summary
* Fixed a focus-stealing bug in multi-pane tabs. When you navigated away from the CodeDeck tab/window and came back, focus jumped to the last-mounted pane regardless of which pane you clicked — typing then went into the wrong terminal. Every Terminal component registers its own `visibilitychange`/`focus`/`pageshow` listeners and four separate code paths could call `term.focus()`. With multiple panes in the active tab, every pane refocused on recovery and the last-mounted one won. Terminal now receives an `isActivePane` prop and gates each focus path on it so only the user-selected pane refocuses; the bug fix has parity for terminal-tab switches and for resume/replay round-trips.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** With two panes side-by-side in the same tab, after switching browser tabs and coming back the user would click pane 1, watch focus appear there briefly, then watch focus jump to pane 2. Cause: every mounted Terminal listens to global `document.visibilitychange`, `window.focus`, and `window.pageshow`. Each handler scheduled a 50ms `term.focus()` via `scheduleViewportRecovery`, the React-level `isVisible` useEffect did the same on tab activation, the snapshot message handler called `term.focus()` on hydrate, and the replay handler called `term.focus()` unconditionally. Timers fired in mount order, so the last pane won. Verified live in the browser against `Beta-21` / `Beta-38`.
  * **Solution:** Added a new `isActivePane` prop to `Terminal` (default `true`, preserves single-pane semantics for existing tests), tracked via `isActivePaneRef`, and gated all four focus call sites on it. `TerminalArea` now passes `isActivePane={isActive && activePaneId === pane.id}` so only the active pane in the active tab refocuses on recovery. Inactive siblings still resize, request replay, and catch up — they just don't yank focus away from the user's clicked pane.
* **🛠️ Codebase:**
  * `client/src/components/Terminal.jsx` — added `isActivePane = true` prop and `isActivePaneRef` plus a sync useEffect; gated the four refocus paths: `scheduleViewportRecovery`, the `isVisible` tab-switch useEffect, the snapshot-message handler, and the replay-message handler.
  * `client/src/components/TerminalArea.jsx` — passes `isActivePane={isActive && activePaneId === pane.id}` to each `Terminal`.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalMultiPaneFocus.test.jsx` — new file with two regression tests. The first mounts two panes (active + inactive), asserts that after a `window.focus` event past the 50ms recovery timer the inactive sibling's `term.focus` was not called. The second feeds a `replay` message to the inactive pane's WebSocket and asserts the same — covering the path that scheduled-recovery resume requests round-trip through.

## [2026-04-27] - Stop Codex transcript-truncation markers from misclassifying idle panes as busy

### Executive Summary
* Follow-up fix to the streaming-busy classifier. After the previous loosening, Codex's transcript-truncation markers — lines like `… +48 lines (ctrl + t to view transcript)` and the pipe-continuation variant `│ … +16 lines` — were tripping the spinner-shape rule and pinning idle Codex panes to busy. The classifier now requires the typographic ellipsis to follow a word character (matching real spinners like `Smooshing…` / `Tests…` where `…` sits next to letters) and excludes a leading `…` glyph (which only appears in transcript markers, never in spinners).

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Codex prints transcript-truncation lines such as `    … +48 lines (ctrl + t to view transcript)` and `  │ … +16 lines` while it sits at its idle `›` prompt. After `normalizeSnapshotLines` trims leading whitespace, the first variant begins with `…` and the second begins with `│ ` followed by `…`. Both passed the loose shape check `/^[^\w\s⏺❯›]\s/u` plus `line.includes('…')`, so the classifier returned `running/agent_streaming` for an idle Codex pane.
  * **Solution:** Added `…` to the leading-character exclusion class (`/^[^\w\s⏺❯›…]\s/u`) so a line that starts with the ellipsis itself is rejected, and tightened the ellipsis presence check from `line.includes('…')` to `/\w…/.test(line)` so the ellipsis must come right after a word character — which is the actual structural difference between a spinner (`Verb…`) and a truncation marker (`<glyph?> … +N lines`).
* **🛠️ Codebase:**
  * `server/terminal-execution-classifier.js` — Two surgical changes inside `hasAgentInterruptIndicator`: extended the leading-glyph exclusion to drop `…`, and replaced `line.includes('…')` with `/\w…/.test(line)`.
* **🧪 Tests:**
  * `server/__tests__/terminal-execution-classifier.test.js` — Added two regression tests captured from the live `Alpha-13` Codex session: a tail containing `… +48 lines (ctrl + t to view transcript)` plus the `›` prompt must classify idle, and a tail containing the pipe-continuation `│ … +16 lines` plus the `›` prompt must also classify idle.

## [2026-04-27] - Match Claude Code spinners with multi-token text before the ellipsis

### Executive Summary
* Follow-up fix to the streaming-busy classifier. The first cut required the typographic ellipsis to come immediately after a single capitalised verb, which missed Claude Code spinners that include phase or task labels — for example `✽ Phase 3.10: Tests… (7m 54s · ↓ 17.3k tokens · thought for 3s)` from a long-running agent. The classifier now keys on the spinner's structural shape (a non-word, non-prompt, non-summary glyph plus space, and a `…` somewhere on the line) so any current Claude Code spinner verb wording is recognised as busy. Tool-call summaries (`⏺ … (ctrl+o to expand)`) and chevron lines that happen to contain a typed-in `…` are explicitly excluded so finished panes still return to idle.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `hasAgentInterruptIndicator`'s pattern `/^\S\s+[A-Z]\w+…/u` required `…` to come directly after the first capitalised word. Real spinners frequently insert phase or step labels between the verb and the ellipsis (e.g. `✽ Phase 3.10: Tests…`), so the regex missed them and the pane fell through to the idle-prompt rule and was reported idle while actively streaming.
  * **Solution:** Switched to a shape-based check: `/^[^\w\s⏺❯›]\s/u` plus `line.includes('…')`. This accepts any glyph-led spinner, regardless of how many tokens come between the glyph and the ellipsis, while excluding tool-call summary glyphs (`⏺`), input chevrons (`❯`/`›`), and prose lines that happen to start with a letter or digit.
* **🛠️ Codebase:**
  * `server/terminal-execution-classifier.js` — Replaced the verb-immediately-before-ellipsis regex with a shape-based glyph + `…` check, keeping the `esc to interrupt` short-circuit and the explicit exclusions for tool-call summaries and idle chevrons.
* **🧪 Tests:**
  * `server/__tests__/terminal-execution-classifier.test.js` — Added a regression test reproducing the live `✽ Phase 3.10: Tests…` spinner from `tool-runner-3` (must classify `running/agent_streaming`) and a regression test asserting that a chevron line carrying typed-in `…` text stays `idle/agent_prompt_idle`.

## [2026-04-27] - Recognize streaming Claude Code panes as busy

### Executive Summary
* Fixed the busy indicator misreporting actively-streaming Claude Code panes as idle. The execution classifier previously recognized only Codex's "Working" verb with `[•✳✱*]` glyphs, so Claude Code's many spinner verbs (`Smooshing`, `Orchestrating`, `Precipitating`, …) under their `✻`/`·`/`✢` glyphs fell through to the idle-prompt rule — which then matched the input chevron Claude Code keeps visible during streaming. The classifier now treats any glyph + capitalized verb followed directly by a typographic ellipsis (`…`) as a streaming indicator (alongside the existing `esc to interrupt` phrase) and reports `executionReason: agent_streaming` so the sidebar dot turns busy mid-turn and returns to idle the moment the turn completes.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** A streaming Claude Code pane was classified `idle/agent_prompt_idle` because `hasAgentWorkingMarker` only matched Codex's "Working" verb. The active spinner line slipped past every snapshot rule, and the always-visible `❯` input chevron then triggered `hasAgentIdlePrompt` and pinned the pane to idle even though the model was actively generating.
  * **Solution:** Added a new `hasAgentInterruptIndicator` predicate ahead of the idle-prompt check. It matches both the literal `esc to interrupt` phrase (for short Claude turns and Codex parity) and a tightened glyph-plus-verb spinner pattern (`/^\S\s+[A-Z]\w+…/u`) where the ellipsis must come directly after the verb. Past-tense completion lines (`✻ Worked for 7m 21s`, `✻ Crunched for 37s`) and tool-call summary lines with mid-line ellipsis (`⏺ Calling bash-server, kube-mcp 11 times… (ctrl+o to expand)`) are correctly excluded so finished panes return to idle.
* **🛠️ Codebase:**
  * `server/terminal-execution-classifier.js` — Added `hasAgentInterruptIndicator(line)` and a new `running/agent_streaming/high` branch in `classifySnapshotTail`, slotted between the background-terminal check and the idle-prompt check so Codex's specific reasons (`agent_working`, `agent_background_terminal`) remain authoritative for those cases.
* **🧪 Tests:**
  * `server/__tests__/terminal-execution-classifier.test.js` — Added four regression tests using real captured tmux bytes from a streaming Claude Code session: the spinner-with-visible-chevron case, a long-running `Orchestrating…` variant that lacks `esc to interrupt`, a past-tense completion staying idle, and a stale tool-call summary line that must not be mistaken for an active spinner.

## [2026-04-25] - Survive cold tmux sockets and respect detached terminal viewport on replay

### Executive Summary
* Fixed two terminal truthfulness bugs. New durable sessions now succeed even when the tmux server has not started yet, instead of crashing on a global option write against a missing socket. And when a user has scrolled up to read older output, transport-replay catch-up no longer yanks the viewport back to the bottom — it only restores follow-mode if the user had not intentionally detached.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** The first durable terminal of a session called `tmux set-window-option -g` before any tmux server existed, which failed with `error connecting to /private/tmp/tmux-*/default (No such file or directory)` and aborted the spawn.
  * **Solution:** Treat "no server running" / missing-socket errors from the global option write as benign during cold start; the per-session option pass below still pins the snapshot history-limit on the new window.
* **🐛 Bug Fix:**
  * **Problem:** When focus recovery replayed buffered output, the client unconditionally re-enabled auto-scroll and snapped to the bottom, stealing the user's reading position.
  * **Solution:** Only restore bottom-follow on replay when `userScrolledUpRef` is false; otherwise write the chunks but leave the viewport detached and the Latest indicator visible.
* **🛠️ Codebase:**
  * `server/terminal-runtime.js` — Added `getCommandErrorText` / `isTmuxMissingServerError` helpers and wrapped `ensureTmuxGlobalWindowOptions()` so cold-socket failures fall through to `new-session` instead of throwing.
  * `client/src/components/Terminal.jsx` — Guarded the replay-handler's `setAutoScrollEnabled(true)` + `term.scrollToBottom()` behind the user-detached check.
* **🧪 Tests:**
  * `server/__tests__/terminal-runtime.test.js` — Added a regression test that simulates the cold-socket error from `set-window-option -g` and asserts `new-session` and the PTY attach still happen with the expected args.
  * `client/src/components/__tests__/TerminalAutoScroll.test.jsx` — Added a regression test that detaches the viewport, fires a replay message, and asserts the chunk is written, Latest stays visible, and `scrollToBottom` is not called.

## [2026-04-24] - Plan terminal bake-off decision gate and VS Code parity work

### Executive Summary
* Added planning artifacts that frame the next terminal investment as an evidence-driven decision rather than a speculative rewrite. A new bake-off spec and phased todo define how CodeDeck will compare its current terminal against a minimal xterm/node-pty control and mature contenders (`ttyd`, `Wetty`) before committing to hardening, refactoring, integrating, or deferring. A parallel VS Code terminal parity todo captures the downstream implementation plan the bake-off will ultimately route work into.

### Technical Details
* **🛠️ Codebase:**
  * `docs/specifications/terminal-bakeoff-spec.md` — New feature spec defining candidate list, torture-suite evaluation dimensions, pass/minor/major/fail scoring model, adoption-risk notes, decision rules (`current-hardening`, `current-core-refactor`, `external-integration`, `defer`), default bias toward keeping the current stack, and explicit non-goals so the bake-off does not change production behavior.
  * `docs/todos/terminal-bakeoff.md` — New phased todo covering harness setup, current CodeDeck baseline scoring, minimal xterm/node-pty control, mature contender evaluation, VS Code-like reference calibration, and the final decision report.
  * `docs/todos/vscode-terminal-parity.md` — New phased todo for VS Code terminal parity work: shell fidelity baseline on the tmux path, deliberate keyboard shortcut contract, reconnect/snapshot hardening, feature parity UX decisions, component simplification, and final verification.

## [2026-04-24] - Make CodeDeck installable as a live-runtime shell

### Executive Summary
* CodeDeck can now be installed from Chrome on macOS and launched as a standalone app while preserving the live-runtime truth model. The installed shell improves launch ergonomics, caches only the UI shell, and avoids showing stale projects, sessions, or terminals when the backend is unavailable.

### Technical Details
* **✨ New Feature:**
  * `client/index.html` — Added manifest, app-name, and install icon metadata using relative shell asset URLs.
  * `client/public/manifest.webmanifest` — Added Chrome installability metadata with standalone display mode, relative app identity, and live-runtime description.
  * `client/public/pwa-icon-192.png` — Added a 192px install icon for Chrome and macOS install surfaces.
  * `client/public/pwa-icon-512.png` — Added a 512px install icon for Chrome and macOS install surfaces.
  * `client/public/pwa-maskable-icon-512.png` — Added a maskable 512px install icon for adaptive launch surfaces.
  * `client/src/registerServiceWorker.js` — Added a root-scoped service-worker registration helper with visible registration failure logging.
* **🐛 Bug Fix:**
  * **Problem:** A previously saved terminal layout could be rendered as if it were live truth when `/api/sessions` was unavailable.
  * **Solution:** Suspended layout rendering and persistence after failed live session restore, while keeping the saved layout intact for later backend recovery.
* **🛠️ Codebase:**
  * `client/public/notification-sw.js` — Added shell-only fetch handling, network-first navigation fallback, cache-first static shell assets, live-only API/WebSocket bypass, and an inline fallback classifier for cold service-worker startup.
  * `client/public/pwa-cache-policy.js` — Added shared request classification for shell assets, Vite dev modules, live-only routes, mutating requests, websockets, and cross-origin traffic.
  * `client/src/main.jsx` — Replaced inline service-worker setup with the reusable registration helper.
  * `client/src/components/TerminalArea.jsx` — Kept persisted terminal layouts non-authoritative until live session data is available.
  * `client/src/utils/terminalLayout.js` — Added an explicit persistence-suspension guard for unverified restores.
  * `docs/todos/installable-pwa-shell.md` — Marked all phases complete and recorded final browser, build, and test verification.
* **🧪 Tests:**
  * `client/src/__tests__/registerServiceWorker.test.js` — Added coverage for root-scoped registration, immediate loaded-document registration, unavailable service workers, failure logging, and exported registration contract.
  * `client/src/__tests__/pwaCachePolicy.test.js` — Added cache-policy coverage for navigation, static shell assets, Vite dev modules, API routes, WebSocket paths, cross-origin requests, mutating requests, and index normalization.
  * `client/src/__tests__/notificationServiceWorker.test.js` — Added coverage proving the fetch handler remains available when imported cache-policy loading fails.
  * `client/src/components/__tests__/TerminalArea.test.js` — Added layout-persistence guard coverage for suspended backend-truth restores.
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — Updated restore coverage so saved layouts are preserved but not rendered when `/api/sessions` fails.

## [2026-04-23] - Define the installable PWA shell rollout

### Executive Summary
* Added the planning artifacts for making CodeDeck installable from Chrome on macOS without pretending it is an offline desktop terminal. The new spec and phased todo plan keep the feature tightly scoped around a truthful installed shell: users can launch CodeDeck like an app, but live backend, session, and terminal state remain authoritative and online-only.

### Technical Details
* **✨ New Feature:**
  * `docs/specifications/installable-pwa-shell-spec.md` — New feature specification for an installable Chrome PWA shell, including manifest requirements, shell-only caching rules, authority boundaries, and explicit non-goals around offline terminal behavior.
* **🛠️ Codebase:**
  * `docs/todos/installable-pwa-shell.md` — New phased implementation plan covering installability metadata, truthful shell-only caching, launch-behavior polish, and final verification steps.

## [2026-04-23] - Keep tmux pane width truthful across restore and resize

### Executive Summary
* Hardened CodeDeck’s terminal rendering so pane resizes no longer leave stale wrapped gutters or right-edge corruption behind. Durable tmux sessions now correct both restored history and live output against the current pane geometry, while the browser adds a one-shot post-font-settle recovery pass so terminals repaint cleanly without asking the user to manually redraw or reconnect.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Durable tmux terminals could keep rendering against stale pane geometry after reconnect recovery, late font settling, or ordinary live pane resizes. That left restored rows wider than the visible pane, undercounted some emoji-heavy graphemes, and let live tmux output continue wrapping at the old width.
  * **Solution:** Added grapheme-aware terminal-cell truncation for tmux snapshots, introduced a delayed post-hydration viewport re-fit with a one-shot in-place rehydrate when geometry actually shifts, and made normal browser resize messages update the underlying tmux session as well as the PTY wrapper.
* **🛠️ Codebase:**
  * `client/src/components/Terminal.jsx` — Added delayed post-snapshot viewport sync, one-shot geometry tracking, and targeted rehydrate behavior so late font/pane settling fixes stale columns without turning ordinary user resizes into destructive redraws.
  * `server/terminal-runtime.js` — Added grapheme-aware terminal cell measurement and truncation so restored tmux rows respect pane width even with wide CJK, VS16 emoji, keycaps, flags, and fallback no-`Intl.Segmenter` environments.
  * `server/ws-handler.js` — Ensured live resize messages resize the authoritative tmux session during normal interaction instead of only resizing the browser-facing PTY attachment.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalFontSync.test.jsx` — Added regression coverage for delayed re-fit, one-shot tmux rehydrate, and the guard that prevents later user-driven resizes from replaying the full viewport.
  * `server/__tests__/terminal-runtime.test.js` — Added regression coverage for pane-width row clamping, emoji/keycap width accounting, and fallback grapheme grouping when `Intl.Segmenter` is unavailable.
  * `server/__tests__/ws-handler.test.js` — Added regression coverage proving live resize events resize the underlying tmux session as well as the PTY wrapper.

## [2026-04-22] - Stop reconnects from lying about terminal history

### Executive Summary
* CodeDeck terminals now reconnect with a truthful recent-history model instead of stitching together stale browser state, replay buffers, and best-effort redraws. The terminal runtime now requires tmux, every durable reattach reseeds from a fresh snapshot of tmux’s recent window, degraded restores warn visibly when history cannot be guaranteed, and follow-on fixes hardened redraw recovery so refreshes, browser closes, backend restarts, and scrollback inspection behave much more like a trustworthy local terminal.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Durable tmux terminals could reconnect with stale or duplicated visible history, lose output during bootstrap recovery, redraw against stale geometry, misrestore modeful sessions, and corrupt restored scrollback while scrolling through snapshot-seeded history.
  * **Solution:** Made tmux the only supported runtime, moved browser reattach to a snapshot-first tmux restore contract, buffered reconnect output correctly, restored tmux-reported terminal state, resized tmux before snapshot capture, and serialized snapshot rows as CRLF-delimited terminal rows instead of newline-only logical text.
* **🛠️ Codebase:**
  * `README.md` — Documented the tmux-required runtime contract, truthful reconnect semantics, and the new distinction between transport replay and preserved-history authority.
  * `client/src/components/Terminal.jsx` — Rebuilt reconnects around authoritative tmux snapshots, added visible history-warning/failure states, kept wheel scrolling local to xterm, improved paste/font/layout recovery, and exposed a manual redraw hook for pane re-measurement.
  * `client/src/components/TerminalArea.jsx` — Fetched runtime health, blocked terminal creation when tmux is unavailable, surfaced a tmux-required empty state, and added a pane-level redraw action.
  * `client/src/components/TerminalInspector.jsx` — Surfaced snapshot-window and history-guarantee diagnostics for durable tmux sessions.
  * `client/src/utils/terminalAutoScroll.js` — Switched to VS Code-style local scroll authority and removed ordinary tmux-history wheel routing from the viewport model.
  * `client/src/utils/terminalResume.js` — Prevented snapshot-backed reconnects from asking replay to impersonate preserved history.
  * `client/src/utils/terminalSnapshotRestore.js` — New snapshot restore helper that reapplies tmux-reported terminal state, including forward-compatible bracketed-paste restore when tmux exposes it.
  * `docs/plans/2026-04-21-truthful-terminal-scrollback-design.md` — Added the implementation design for the snapshot-first truthful scrollback architecture.
  * `docs/specifications/truthful-terminal-scrollback-spec.md` — Added the product/spec contract for tmux-required truthful scrollback and reconnect behavior.
  * `docs/steering/product.md` — Updated product steering to describe truthful scrollback behavior and tmux-required terminals.
  * `docs/steering/structure.md` — Updated structure steering to reflect the new terminal runtime, reconnect, and test surfaces.
  * `docs/steering/tech.md` — Updated technical steering with the tmux-required runtime and snapshot-first reconnect model.
  * `docs/todos/tmux-reconnect-review-fixes.md` — Tracked and closed the tmux reconnect review findings, including the residual stock-tmux bracketed-paste limitation and the upstream investigation notes.
  * `docs/todos/truthful-terminal-scrollback.md` — Recorded phase-by-phase implementation, manual verification, and final completion notes for the truthful scrollback feature.
  * `server/index.js` — Blocked terminal creation when tmux is unavailable and exposed runtime/guarantee metadata through health and diagnostic APIs.
  * `server/terminal-runtime.js` — Enforced tmux-only terminals, added snapshot capture/state probing, direct tmux window resizing before reconnect snapshots, CRLF row snapshots, and forward-compatible bracketed-paste probing.
  * `server/terminal-session-status-service.js` — Added snapshot-window and history-guarantee metadata to terminal session summaries.
  * `server/ws-handler.js` — Replaced hybrid history hydration with snapshot-first attach/reconnect sequencing, added guarantee metadata, fixed bootstrap/replay boundary bugs, restored geometry before snapshot capture, and hardened durable recovery ordering.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — Added restore coverage for manual redraw actions and updated terminal-area restore behavior around durable panes.
  * `client/src/components/__tests__/TerminalAutoScroll.test.jsx` — Added coverage for detached viewport stability, Latest behavior, and local-only wheel semantics.
  * `client/src/components/__tests__/TerminalFileDrop.test.jsx` — Updated paste/drop coverage to match xterm’s native paste path and file-handling behavior.
  * `client/src/components/__tests__/TerminalFontSync.test.jsx` — New regression coverage for late font measurement recovery and terminal re-fit.
  * `client/src/components/__tests__/TerminalHistoryRestore.test.jsx` — Expanded reconnect coverage for authoritative snapshots, warning states, and modeful terminal-state restore.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Added coverage for visibility/focus recovery and reconnect-safe input handling.
  * `client/src/components/__tests__/TerminalRuntimeBlocked.test.jsx` — New coverage for the tmux-required runtime gate in the terminal UI.
  * `client/src/components/__tests__/terminalResume.test.js` — Updated session-handshake coverage so snapshot-backed reconnects no longer request replay.
  * `client/src/utils/__tests__/terminalAutoScroll.test.js` — Expanded unit coverage for the revised auto-follow and wheel-blocking semantics.
  * `client/src/utils/__tests__/terminalSnapshotRestore.test.js` — New unit coverage for tmux terminal-state replay, including forward-compatible bracketed paste.
  * `server/__tests__/terminal-runtime.test.js` — Added coverage for tmux runtime gating, snapshot capture modes, direct window resize before reconnect capture, and CRLF row snapshot output.
  * `server/__tests__/terminal-session-status-service.test.js` — Added coverage for session summary runtime and history-guarantee metadata.
  * `server/__tests__/ws-handler.test.js` — Added and updated regression coverage for snapshot-first reconnect sequencing, bootstrap buffering, geometry-safe captures, modeful snapshots, and durable recovery ordering.

## [2026-04-20] - Prevent new terminals from dropping input during metadata sync

### Executive Summary
* Fixed a follow-on regression where freshly opened terminals could briefly ignore typing right after they appeared. The terminal now keeps its initial browser connection alive while backend runtime metadata catches up, so new panes stay interactive immediately instead of rebuilding themselves during that handoff.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Newly opened panes initially mounted before their backend runtime metadata was fully hydrated, so a late `runtimeType` change from `pty` to `tmux` could tear down and recreate the terminal WebSocket just as the user started typing.
  * **Solution:** Stopped treating `runtimeType` as a terminal-effect dependency, stored it in a mutable ref instead, and updated the tmux wheel-routing logic to read the latest runtime metadata without rebuilding the live terminal connection.
* **🛠️ Codebase:**
  * `client/src/components/Terminal.jsx` — Kept the main terminal/WebSocket lifecycle keyed to the session identity instead of transient runtime metadata, while still updating tmux-specific wheel behavior from the latest runtime type through a ref.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalAutoScroll.test.jsx` — Added regression coverage proving tmux wheel routing updates correctly after runtime metadata arrives without recreating the terminal instance.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Added a regression test proving a mounted terminal does not create a second WebSocket when runtime metadata changes after first render.

## [2026-04-20] - Hydrate durable tmux history without breaking text selection

### Executive Summary
* Improved CodeDeck’s durable terminal experience so browser-attached tmux sessions behave much more like a native developer terminal. Existing tmux history is now restored into the browser on reconnect, mouse-wheel scrolling can drive tmux history even when the browser has no local scrollback yet, and the earlier regression that broke drag selection/copy has been fixed by preserving normal browser text selection while routing history scrolling through the backend instead of tmux mouse mode.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Durable tmux-backed terminals could reconnect with missing browser scrollback, and the first scrolling fix depended on `tmux mouse on`, which activated xterm mouse mode and caused drag selection to collapse immediately instead of remaining copyable.
  * **Solution:** Restored durable tmux history into the browser on attach, kept xterm’s own large local scrollback available, and replaced tmux mouse-mode scrolling with an explicit backend-driven `scroll_history` path that enters tmux copy mode, scrolls history, and exits copy mode at the live bottom without disabling normal browser selection.
* **🛠️ Codebase:**
  * `client/src/components/Terminal.jsx` — Added durable tmux history hydration, explicit xterm scrollback sizing, and tmux-specific wheel routing that asks the backend to scroll tmux history instead of enabling tmux mouse mode.
  * `client/src/components/TerminalArea.jsx` — Passed each pane’s backend runtime type into `Terminal` so wheel behavior can differ correctly between raw PTY and tmux-backed sessions.
  * `client/src/utils/terminalAutoScroll.js` — Added helpers for deciding when wheel input should route to tmux history and how many tmux history lines each wheel gesture should scroll.
  * `server/terminal-runtime.js` — Added durable tmux scrollback capture, server-driven tmux history scrolling via copy-mode commands, raw-PTY no-op history helpers, and enforced tmux session options that keep history large while leaving tmux mouse mode off.
  * `server/ws-handler.js` — Added durable tmux history hydration on reconnect, introduced `scroll_history` handling for tmux sessions, and guarded scroll-history failures so bad scroll commands do not corrupt terminal input handling.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalAutoScroll.test.jsx` — Added regression coverage proving tmux-backed wheel gestures are converted into backend `scroll_history` messages and that xterm keeps the configured large scrollback.
  * `client/src/components/__tests__/TerminalHistoryRestore.test.jsx` — New regression test proving durable tmux history snapshots are written into xterm before live output resumes.
  * `client/src/components/__tests__/TerminalFileDrop.test.jsx` — Updated terminal auto-scroll mocks to cover the new tmux wheel-routing helpers.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Updated terminal auto-scroll mocks so reconnect/input coverage still reflects the expanded terminal wheel logic.
  * `client/src/components/__tests__/hard-refresh-race.test.jsx` — Updated terminal auto-scroll mocks to preserve replay-race coverage with the new tmux history helpers in place.
  * `client/src/utils/__tests__/terminalAutoScroll.test.js` — Added unit coverage for tmux history routing decisions and wheel-delta to tmux-line conversion.
  * `server/__tests__/terminal-runtime.test.js` — Added coverage for keeping tmux mouse mode off, capturing durable tmux history, and driving tmux copy-mode scrolling from the runtime.
  * `server/__tests__/ws-handler.test.js` — Added regression coverage proving `scroll_history` routes to the tmux runtime instead of PTY stdin and that durable tmux history is sent to newly attached browsers.

## [2026-04-20] - Fix durable terminal session discovery and identity drift

### Executive Summary
* Fixed a cluster of terminal reliability issues that all stemmed from the browser and backend disagreeing about which durable tmux sessions existed. Detached terminals now appear in the sidebar immediately after refresh, new terminals get backend-issued IDs that cannot collide with hidden historical sessions, intentionally deleted terminals are tombstoned so stale hidden tabs cannot resurrect them, and project layouts now preserve or clear terminal state more predictably across refreshes and restarts. Mouse-wheel scrolling also no longer falls back to shell history navigation when there is no local scrollback.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Durable tmux sessions could disappear from the sidebar until their project was clicked, “new” terminals could silently reconnect to old historical sessions because session IDs were still minted in the frontend, deleted sessions could be resurrected by stale hidden reconnecting clients, saved layouts could drift from backend truth after refreshes, and xterm could translate wheel-up into ArrowUp when no local scrollback existed.
  * **Solution:** Moved terminal session ID allocation to a backend `POST /api/terminal` endpoint, taught `/api/sessions` to include detached durable tmux sessions for configured projects, tombstoned deleted session IDs server-side, hardened layout persistence/hydration so empty and saved states are preserved correctly, and installed an xterm custom wheel handler that blocks the no-scrollback ArrowUp fallback.
* **🔌 API/Interface:**
  * `server/index.js` — Added `POST /api/terminal` so the backend allocates collision-safe terminal IDs, updated `GET /api/sessions` to surface detached durable tmux sessions, and strengthened terminal deletion to tombstone session IDs and close live sockets with an explicit `session_deleted` code.
  * `server/ws-handler.js` — Exported explicit close codes/reasons for session takeover and session deletion, rejected reconnects for tombstoned session IDs, and cleared reserved IDs when a WebSocket successfully claims a backend-issued session ID.
* **🛠️ Codebase:**
  * `client/src/components/Terminal.jsx` — Added xterm custom wheel handling to block wheel→ArrowUp fallback without scrollback, and stopped reconnecting when the backend closes a socket for session takeover or intentional deletion.
  * `client/src/components/TerminalArea.jsx` — Removed frontend-authored terminal ID minting, requested fresh session IDs from the backend when opening tabs/splits, preserved empty-state restores until live session hydration arrives, and persisted closed-terminal layout changes immediately so refreshes do not resurrect removed panes.
  * `client/src/utils/terminalAutoScroll.js` — Added `shouldBlockXtermWheelViewportFallback()` for the no-scrollback mouse-wheel guard.
  * `client/src/utils/terminalLayoutState.js` — Preserved saved layouts when live session snapshots are temporarily empty and stopped inventing a synthetic `project-1` terminal as the fallback restore state.
  * `server/terminal-runtime.js` — Added durable tmux session enumeration via `listSessionIds()` and hardened runtime kill paths so deleting a session still works when the in-memory PTY wrapper is already gone.
  * `server/terminal-session-service.js` — New pure service that allocates the next collision-free terminal session ID across active, deleted, reserved, and recoverable durable sessions.
  * `server/terminal-session-status-service.js` — New pure service that merges attached in-memory sessions with detached durable tmux sessions for configured projects so the sidebar can reflect backend truth before any project click.
  * `start.sh` — Added argument validation and explicit child PID cleanup so local start/stop behavior is more predictable during terminal debugging.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalArea.test.js` — Added restore coverage for preserving saved tabs across empty live-session snapshots after server restarts.
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — Added regression tests for backend-issued terminal IDs, hydrating live sessions into an initially empty terminal area, and persisting an empty layout immediately after the last terminal is closed.
  * `client/src/components/__tests__/TerminalAutoScroll.test.jsx` — Added coverage proving the custom xterm wheel handler blocks ArrowUp fallback when the normal buffer has no scrollback.
  * `client/src/components/__tests__/TerminalFileDrop.test.jsx` — Updated terminal mocks to cover the added xterm wheel handler API.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Added regressions proving the terminal does not reconnect after session takeover or explicit session deletion.
  * `client/src/components/__tests__/hard-refresh-race.test.jsx` — Updated terminal mocks to include the custom wheel handler while preserving replay-race coverage.
  * `client/src/utils/__tests__/terminalAutoScroll.test.js` — Added unit coverage for the new wheel-fallback blocking helper.
  * `server/__tests__/terminal-runtime.test.js` — Added coverage for durable tmux session enumeration.
  * `server/__tests__/ws-handler.test.js` — Added regression coverage for session-takeover close codes and server-side rejection of reconnects to deleted session IDs.
  * `server/__tests__/terminal-session-service.test.js` — New service-level tests for collision-safe backend terminal ID allocation.
  * `server/__tests__/terminal-session-status-service.test.js` — New service-level tests for surfacing detached durable sessions while excluding deleted or orphaned tmux sessions.

## [2026-04-18] - Filter focus-tracking escape sequences from terminal input

### Executive Summary
* Fixed a bug where xterm.js focus-in/focus-out escape sequences (`ESC[I` / `ESC[O`) were being forwarded to the PTY as user input when a terminal pane regained focus. This could produce unexpected shell output or confuse interactive programs. The existing inline regex that filtered Device Attribute and Cursor Position Report replies has been extracted into a standalone, tested utility and expanded to also catch focus-tracking replies.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** When a terminal pane regained focus, xterm.js emitted `\x1b[I` (focus-in) and `\x1b[O` (focus-out) control sequences via `onData`. The inline regex in Terminal.jsx only matched DA/CPR responses, so focus-tracking replies passed through and were sent to the PTY as if the user had typed them.
  * **Solution:** Extracted protocol reply detection into `isTerminalProtocolReply()` with an expanded regex covering DA, CPR, and focus-tracking sequences, then used it in Terminal.jsx's `onData` handler.
* **🛠️ Codebase:**
  * `client/src/utils/terminalProtocolReplies.js` — New utility exporting `isTerminalProtocolReply()` with a single regex matching DA primary/secondary responses, CPR replies, and focus-in/focus-out sequences.
  * `client/src/components/Terminal.jsx` — Replaced inline `TERMINAL_RESPONSE_RE` regex with imported `isTerminalProtocolReply`, updated comment to mention focus tracking.
* **🧪 Tests:**
  * `client/src/utils/__tests__/terminalProtocolReplies.test.js` — Unit tests covering known protocol replies (DA, CPR, focus-in, focus-out) and legitimate user input that must pass through.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Added integration test verifying focus-tracking replies are dropped and never forwarded to the PTY.

## [2026-04-17] - Upgrade markdown preview tables and Mermaid inspection

### Executive Summary
* Improved document previews so technical specs are much easier to read and inspect in-browser. Markdown tables now render as real responsive tables instead of dense pipe-delimited text, and Mermaid diagrams embedded inside Markdown can now be opened in a focused lightbox with zoom, pan, and modifier-wheel controls for dense architecture and sequence diagrams.

### Technical Details
* **✨ New Feature:**
  * `client/src/utils/markdownPreview.js` — Added Markdown table parsing with header/body detection, alignment support, and responsive `data-label` metadata so pipe tables render as structured HTML tables instead of plain paragraphs.
  * `client/src/components/PreviewPage.jsx` — Added Mermaid diagram lightbox support for both embedded Markdown diagrams and standalone Mermaid previews, including click-to-open inspection, toolbar zoom controls, drag-to-pan navigation, and Cmd/Ctrl+scroll zoom anchored to the pointer.
* **🛠️ Codebase:**
  * `client/src/styles/global.css` — Added polished Markdown table styling with sticky headers, zebra striping, mobile card layout, and zoom affordance cursor styling for Mermaid diagrams.
* **🧪 Tests:**
  * `client/src/utils/__tests__/markdownPreview.test.js` — Added regression coverage for Markdown table rendering, alignment handling, and inline formatting inside table cells.

## [2026-04-16] - Fail loudly when frontend/backend ports are taken

### Executive Summary
* Previously, `./server.sh start` only checked that the backend port (43001) was free before launching — if the frontend port (43000) was already held by a stale Vite process, the backend would come up but the frontend would silently pick a random port, and the user would end up with a broken workspace at the expected URL. Now both ports are checked upfront, both listeners must come up for the start to be considered successful, and Vite is configured with `strictPort` so it refuses to silently switch ports. Status output also now reports both frontend and backend separately.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** `./server.sh start` only guarded the backend port, so a stale process on port 43000 would leave the frontend silently bound to a different port — the app at `http://localhost:43000` would be whatever was already there, not CodeDeck.
  * **Solution:** `server.sh` — Added a `FRONTEND_PORT` variable (default 43000), generalized `port_in_use`/`listener_pid` to take a port argument, and made `start_server` refuse to launch if either port is in use. The startup readiness loop now waits for both backend and frontend listeners before declaring success.
  * **Solution:** `client/vite.config.js` — Added `strictPort: true` so Vite fails fast if 43000 is taken instead of falling back to a random port.
* **🛠️ Codebase:**
  * `server.sh` — Start output and `status` now print frontend and backend URLs and PIDs separately. `status` also warns when either port is held by a foreign process while CodeDeck is not running.

## [2026-04-16] - Instant sidebar refresh on project switch and clearer server PID reporting

### Executive Summary
* Two small but visible polish items. Switching projects used to wait up to 2 seconds for the sidebar cockpit to reflect the new project's live sessions — now the refresh fires immediately on selection (from both the sidebar click and the ⌘⇧P project switcher). Separately, `./server.sh start` and `status` now clearly distinguish the launcher process from the backend listener process, so it's obvious which PID does what when debugging a stuck server.

### Technical Details
* **✨ New Feature:**
  * `client/src/App.jsx` — Extracted the session-status poll into a reusable `fetchSessionStatus` callback guarded by an in-flight ref. Selecting a project (sidebar or project switcher) now triggers an immediate refresh instead of waiting for the next 2s poll tick.
  * `client/src/components/TerminalArea.jsx` — Added an `onSessionStatusRefresh` prop; after the restore-time `/api/sessions` fetch, the fresh snapshot is pushed up to the app shell so the sidebar reflects it immediately.
* **🛠️ Codebase:**
  * `server.sh` — Stopped overwriting the PID file with the backend listener PID (the file now keeps the launcher PID it was created with). Start output and `status` now print both the launcher PID and the backend listener PID on separate, aligned lines.
* **🧪 Tests:**
  * `client/src/App.test.jsx` — Added a test asserting that `/api/sessions` is re-fetched immediately when a project is selected. Upgraded the Sidebar mock to render clickable project buttons so the selection path can be exercised.
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — Added a test asserting that `onSessionStatusRefresh` is called with the live sessions fetched during restore.

## [2026-04-16] - Preserve terminal layout on backend hiccups and keep tmux sessions alive

### Executive Summary
* Made durable terminal sessions feel truly durable. Previously, a transient backend blip during startup would wipe the user's saved tab/pane layout, and recoverable tmux sessions were being pruned after 30 minutes detached — so walking away from the workspace for an hour could lose terminals that tmux had every right to keep running. Now the saved layout is preserved whenever `/api/sessions` fails to respond, and recoverable tmux sessions are never pruned by the session garbage collector.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** When `/api/sessions` failed during `TerminalArea` restore (e.g., backend momentarily unreachable), the client cleared the project's saved layout from localStorage and started fresh — erasing the user's tabs and panes for a temporary network hiccup.
  * **Solution:** `client/src/components/TerminalArea.jsx` — On fetch failure, fall back to the saved layout in localStorage when one exists; only start fresh if there is no saved layout to restore from.
  * **Problem:** Recoverable tmux-backed sessions were pruned after 30 minutes of being detached, defeating the whole point of durable sessions — walk away for lunch, lose your terminals.
  * **Solution:** `server/session-gc.js` — Removed `DETACHED_RECOVERABLE_TTL_MS` entirely. Recoverable sessions now stay alive indefinitely while detached; only dead sessions and unrecoverable detached sessions are pruned.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalAreaRestore.test.jsx` — New test verifying that a saved layout in localStorage is preserved (not cleared) when `/api/sessions` rejects during restore.
  * `server/__tests__/session-gc.test.js` — New test verifying that recoverable tmux sessions are not pruned even after multiple days detached.

## [2026-04-16] - Prevent overlapping session polls and fix sidebar config 404

### Executive Summary
* Fixed two subtle reliability issues in the sidebar cockpit. The app was firing a new `/api/sessions` poll every 2 seconds even when the previous request had not yet returned, which could pile up in-flight requests under slow network conditions. The sidebar was also requesting a single config key from an endpoint that does not exist (`/api/config/terminalFinishCooldownSeconds`), causing a 404 on every load and silently swallowing the error. Both are now fixed and covered by tests.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** The session status polling loop in `App.jsx` started a new `/api/sessions` fetch every 2 seconds regardless of whether the previous request was still in flight, so slow responses could stack overlapping requests.
  * **Solution:** `client/src/App.jsx` — Added an in-flight guard (`polling` flag) around the session fetch so a new poll is skipped while the previous one is still pending.
  * **Problem:** Sidebar bootstrap called `/api/config/terminalFinishCooldownSeconds`, which the backend does not serve — it 404'd on every mount, and the failure was silently swallowed with an empty `catch(() => {})`.
  * **Solution:** `client/src/components/Sidebar.jsx` — Switched to `/api/config` (returns the full config object) and read `terminalFinishCooldownSeconds` from the response. Replaced the empty catch with a visible `console.warn` so load failures are no longer hidden.
* **🧪 Tests:**
  * `client/src/App.test.jsx` — New test asserting that `/api/sessions` is not re-requested while the previous poll is still in flight.
  * `client/src/components/__tests__/Sidebar.test.jsx` — New test asserting the sidebar loads the terminal finish cooldown from `/api/config` (not the 404-prone single-key endpoint).

## [2026-04-16] - Fix terminal project mix-ups and mouse scrolling

### Executive Summary
* Fixed two terminal usability issues that made the workspace feel unreliable: terminals from similarly named projects could appear under the wrong project, and mouse-wheel scrolling could feel jerky or get stuck in follow-mode while output was streaming. The update makes project-to-terminal matching exact, improves mouse takeover of terminal scrollback, and tunes terminal wheel sensitivity for a smoother browsing experience.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Terminal sessions were matched to projects with a loose `startsWith()` check, so hyphen-prefixed sibling projects with similar names could be mixed together in the UI.
  * **Solution:** `client/src/utils/terminalProjectMatch.js` — Added shared helpers for exact project session matching using the `project-name-<number>` pattern and cwd fallback.
  * **Solution:** `client/src/utils/terminalLayoutState.js` — Switched initial terminal hydration and session number parsing to the shared exact-match helpers so only the selected project's sessions restore into tabs.
  * **Solution:** `client/src/utils/terminalActivity.js` — Updated notification/project lookup logic to use exact session-to-project matching.
  * **Solution:** `client/src/components/Sidebar.jsx` — Replaced sidebar project session filtering with the shared matcher so cockpit status no longer pulls in sibling-project terminals.
  * **Problem:** Mouse-wheel takeover of terminal scrollback depended on wheel delta direction, which made follow-mode pause inconsistently on some devices/settings and could feel like one-line nudges.
  * **Solution:** `client/src/utils/terminalAutoScroll.js` — Changed auto-scroll pausing to trigger on any non-zero wheel gesture while pinned at the bottom and scrollback exists.
  * **Solution:** `client/src/components/Terminal.jsx` — Added explicit xterm wheel tuning (`scrollSensitivity`, `fastScrollSensitivity`, `smoothScrollDuration`) for more usable terminal scrolling.
* **🧪 Tests:**
  * `client/src/components/__tests__/TerminalArea.test.js` — Added regression coverage for hyphen-prefixed sibling projects so the wrong sessions do not hydrate into the selected project.
  * `client/src/utils/__tests__/terminalActivity.test.js` — Added coverage proving project lookup prefers the exact matching sibling project.
  * `client/src/utils/__tests__/terminalAutoScroll.test.js` — Added regression coverage for pausing follow-mode on any wheel gesture while pinned at the bottom.
  * `client/src/components/__tests__/TerminalAutoScroll.test.jsx` — Added component-level tests for wheel-driven "Latest" button behavior and explicit xterm wheel sensitivity options.
* **🛠️ Codebase:**
  * `client/src/components/Terminal.jsx` — Kept terminal behavior aligned with the new auto-scroll and wheel-sensitivity expectations.

## [2026-04-14] - Fix shelved projects not visible beyond first five

### Executive Summary
* Expanding the shelved projects section only showed the first 5 projects with a "+ N more" label — but there was no way to browse the rest without searching by exact name. Projects beyond the top 5 were effectively hidden. Now expanding the shelf shows all shelved projects in a scrollable list, with search available to filter.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Shelved projects list was hard-capped to `slice(0, 5)` regardless of whether the section was expanded, making projects beyond the first 5 unreachable unless the user typed the exact name in search.
  * **Solution:** `client/src/components/Sidebar.jsx` — Show all shelved projects when expanded (no search filter), removed the misleading "+ N more" overflow message.
* **✨ New Feature:**
  * `client/src/components/Terminal.jsx` — Terminal web links now open in a new browser tab via explicit click handler instead of relying on xterm.js default behavior.

## [2026-04-14] - Keyboard shortcuts, project switcher, and terminal fixes

### Executive Summary
* Added a project quick-switcher (⌘⇧P), keyboard shortcuts overlay (⌘/), and active pane tracking with visual highlight. Remapped four keyboard shortcuts that conflicted with Chrome's reserved shortcuts (close window, DevTools console, bookmarks bar, bookmark all tabs) — the close-pane shortcut was closing the entire browser window. Fixed terminal garbage characters (DA response leak) appearing on project switch, and fixed pane focus not following keyboard selection.

### Technical Details
* **🐛 Bug Fix:**
  * **Problem:** Switching projects displayed garbage characters (`^[[?1;2c^[[>0;276;0c`) in the terminal — DA responses from xterm.js leaked to the PTY as stdin during resize.
  * **Solution:** `client/src/components/Terminal.jsx` — Added `TERMINAL_RESPONSE_RE` filter in `onData` handler to suppress DA1, DA2, and CPR responses before they reach the PTY.
  * **Problem:** Keyboard shortcut ⌘⌥1-9 (select pane) did not move cursor focus to the selected pane.
  * **Solution:** `client/src/components/Terminal.jsx` — Exposed `focus()` method via `useImperativeHandle` so `TerminalArea` can focus the xterm instance.
  * **Problem:** ⌘⇧W (close pane) closed the entire Chrome window; ⌘⇧J/⌘⇧D/⌘⇧B conflicted with Chrome DevTools, bookmarks bar, and bookmark-all-tabs.
  * **Solution:** Remapped: close pane → ⌘⇧X, new terminal → ⌘⇧T, split right → ⌘⇧E, toggle file tree → ⌘⇧F.
* **✨ New Feature:**
  * `client/src/components/ProjectSwitcher.jsx` — New fuzzy project quick-switcher modal (⌘⇧P) with arrow-key navigation, Enter to select, Escape to dismiss.
  * `client/src/components/ShortcutsOverlay.jsx` — New keyboard shortcuts reference overlay (⌘/) showing all shortcuts grouped by category with platform-aware key labels.
  * `client/src/components/TerminalArea.jsx` — Added `activePaneId` state with visual border highlight on the focused pane. Clicking a pane or using ⌘⌥1-9 updates active pane. Auto-selects adjacent pane on close.
* **🛠️ Codebase:**
  * `client/src/App.jsx` — Integrated ProjectSwitcher, ShortcutsOverlay, and new shortcut handlers (⌘⇧P, ⌘/, ⌘⇧F). Passes `onShowShortcuts` prop to Sidebar.
  * `client/src/components/Sidebar.jsx` — Added keyboard icon button in footer linking to shortcuts overlay. Updated file tree tooltip to ⌘⇧F.
  * `client/src/styles/global.css` — Added styles for project switcher modal and shortcuts overlay.

## [2026-04-13] - Resizable file tree panel and keyboard shortcut tooltips

### Executive Summary
* The file browser panel (FILES) can now be resized by dragging its right edge, making it much easier to browse projects with long filenames or deep directory trees. The width persists across sessions. Additionally, the sidebar header buttons now show keyboard shortcut hints on hover so users can discover shortcuts without checking documentation.

### Technical Details
* **✨ New Feature:**
  * `client/src/App.jsx` — Added `fileTreeWidth` state with localStorage persistence (default 260px). Renders a `PaneDivider` between the file tree and terminal area for drag-to-resize (min 180px, max 600px). Double-click resets to default width.
  * `client/src/components/FileTree.jsx` — Accepts `width` prop instead of hardcoded 240px. Set `minWidth: 180` and `flexShrink: 0` for correct flex layout during resize.
* **🛠️ Codebase:**
  * `client/src/components/Sidebar.jsx` — Added platform-aware modifier key detection (`⌘` on Mac, `Ctrl+` elsewhere). Updated sidebar toggle tooltip to show `⌘B` shortcut and file tree toggle to show `⌘⇧B` shortcut.

## [2026-04-13] - Add package-lock.json to gitignore

### Executive Summary
* Added `package-lock.json` to the project's `.gitignore` to prevent it from being tracked in version control. This keeps the repository clean since the project uses npm workspaces and the lock file is not needed for contributors.

### Technical Details
* **🛠️ Codebase:**
  * `.gitignore` — Added `package-lock.json` to the ignored files list under build artifacts section.

## [2026-04-13] - Terminal File Drop & Paste Support

### Executive Summary
* Added drag-and-drop and clipboard paste support for files on terminal panes. Dropping or pasting a file uploads it to a temp directory on the backend and injects the quoted file path into the focused terminal — enabling agentic CLI tools (like Claude Code) that accept image/file paths as input to receive screenshots and files seamlessly, without leaving the browser.

### Technical Details
* **✨ New Feature:**
  * `server/index.js` — Added `POST /api/upload` endpoint using multer for multipart file handling. Saves files to `/tmp/codedeck-drops/` with timestamp-prefixed sanitized filenames. Enforces 20MB size limit with proper error responses (400/413/500).
  * `client/src/components/Terminal.jsx` — Added drag-and-drop event handlers (dragover/dragenter/dragleave/drop) with a counter-based approach for nested element correctness. Added clipboard paste handler that detects file paste vs text paste. Drop zone overlay with dashed accent border appears during drag. Files are uploaded via fetch and quoted paths injected as WebSocket input messages.
* **🐛 Bug Fix:**
  * `client/src/components/Terminal.jsx` — Fixed replay input corruption: moved `resumeInFlightRef.current = false` after chunk writes so xterm.js terminal query responses during replay are correctly dropped. Added auto-scroll reset and focus after replay completes.
* **🛠️ Codebase:**
  * `client/vitest.config.js` — New client-side vitest config with jsdom environment and React plugin.
  * `package.json` — Added `@testing-library/react` and `jsdom` as dev dependencies.
  * `server/package.json` — Added `multer` dependency for multipart uploads.
* **🧪 Tests:**
  * `server/__tests__/upload.test.js` — 11 integration tests for upload endpoint: valid upload, size rejection, missing file, filename sanitization.
  * `client/src/components/__tests__/TerminalFileDrop.test.jsx` — 9 component tests for drag-drop and paste: file upload + path injection, error handling, drop zone overlay, directory rejection, text paste passthrough.
  * `client/src/components/__tests__/TerminalInputResume.test.jsx` — Tests for replay input dropping behavior.
  * `client/src/components/__tests__/hard-refresh-race.test.jsx` — Tests for hard refresh race condition handling.
* **📝 Documentation:**
  * `docs/specifications/terminal-file-drop-spec.md` — Full feature specification.
  * `docs/todos/terminal-file-drop.md` — Implementation tracking (all phases complete).

## [2026-04-13] - Enhanced Keyboard Shortcuts for Sidebar and File Browser

### Executive Summary
* Added a dedicated keyboard shortcut for toggling the file browser panel: **Cmd/Ctrl + Shift + B**. The existing **Cmd/Ctrl + B** shortcut now correctly works with both Cmd (Mac) and Ctrl (Windows/Linux) to toggle the project sidebar. This improves cross-platform keyboard navigation and provides quick access to both major UI panels without reaching for the mouse.

### Technical Details
* **🛠️ Codebase:**
  * `client/src/App.jsx` — Refactored keyboard event handling to support both Cmd and Ctrl modifiers consistently across platforms. Split shortcut logic: Cmd/Ctrl+B toggles sidebar compact mode, Cmd/Ctrl+Shift+B toggles file browser panel. Improved modifier key detection to prevent false triggers.

## [2026-04-13] - Browser Notifications and Terminal Resilience Enhancements

### Executive Summary
* This update introduces browser notifications for long-running terminal tasks, allowing you to get an alert (with sound) when a command finishes while you're in another tab. It also adds several under-the-hood improvements to terminal autoscroll behavior, automatic cleanup of abandoned terminal sessions, and a new configuration setting to customize notification timing.

### Technical Details
* **✨ New Feature:**
  * `client/public/notification-sw.js` — Service worker to handle background notification clicks and focus.
  * `client/src/utils/browserNotifications.js` — Utilities for managing notification permissions, showing notifications via Service Worker, and playing completion audio cues.
  * `client/src/components/SettingsPanel.jsx` — Added `terminalFinishCooldownSeconds` setting to control how long a task must run before it triggers a notification.
* **🛠️ Codebase:**
  * `client/src/utils/terminalActivity.js` — Implemented notification payload generation logic and project-aware session detection.
  * `client/src/components/Sidebar.jsx` — Integrated browser notification orchestration, permission request flows, and audio "warming" on user interaction.
  * `client/src/utils/terminalAutoScroll.js` — Added helpers to detect viewport position and pause autoscroll on scroll-up.
  * `server/session-gc.js` — Implemented GC logic for pruning dead or long-detached terminal sessions to prevent memory leaks.
  * `client/src/main.jsx` — Added Service Worker registration.
* **🧪 Tests:**
  * `client/src/utils/__tests__/browserNotifications.test.js` — Unit tests for notification permission and display logic.
  * `client/src/utils/__tests__/terminalActivity.test.js` — Updated tests for new completion notification logic.
  * `client/src/utils/__tests__/terminalAutoScroll.test.js` — Tests for autoscroll viewport detection.
  * `server/__tests__/session-gc.test.js` — Integration tests for terminal session garbage collection.

## [2026-04-11] - Right-Click Context Menu for Copy Path in File Trees

### Executive Summary
* Right-clicking any file or directory in the sidebar file tree or the file browser panel now shows a context menu with "Copy relative path" and "Copy path" options. This makes it easy to grab a file's path for use in terminals, scripts, or other tools without manually constructing it. Also includes terminal focus reliability improvements and WebSocket URL construction cleanup.

### Technical Details
* **✨ New Feature:**
  * `client/src/components/FileContextMenu.jsx` — new shared context menu component with "Copy relative path" (relative to project root) and "Copy path" (absolute) options, toast confirmation, dismiss on click-outside or Escape
  * `client/src/components/FileTree.jsx` — added right-click handler to file and directory rows, renders FileContextMenu with project root for relative path calculation
  * `client/src/components/FileBrowserPanel.jsx` — same context menu integration for the modal file browser panel
* **🛠️ Codebase:**
  * `client/src/components/Terminal.jsx` — extracted WebSocket URL construction to `terminalWsUrl.js` utility, moved focus handling outside try/catch in `syncTerminalViewport()` so focus isn't blocked by fit() errors, added direct focus fallback on mouseDown
  * `client/src/utils/terminalWsUrl.js` — new utility for building terminal WebSocket URLs with proper protocol detection (ws/wss)
  * `client/src/components/__tests__/terminalWsUrl.test.js` — unit tests for WebSocket URL builder
  * `.gitignore` — added `playwright-*` pattern to ignore playwright artifacts

## [2026-04-11] - Fix Sidebar Activity Dot Stuck Green Due to Tmux Status Noise

### Executive Summary
* The sidebar's green activity dot for each terminal stayed permanently lit even when no real work was happening. The root cause was tmux's default status bar refreshing every 15 seconds, which generated PTY output that reset the activity timer. This fix suppresses the tmux status bar in CodeDeck-managed sessions and introduces a separate `lastSubstantialOutputAt` timestamp that only updates on meaningful terminal output (content containing newlines), so the sidebar correctly shows idle status when terminals are inactive.

### Technical Details
* **Bug Fix:**
  * Problem: tmux's `status-interval` (default 15s) sends periodic ANSI escape sequences through the PTY, updating `lastOutputAt` continuously. The sidebar checks this timestamp against a 45-second activity window, so the terminal never appeared idle.
  * Solution (two-pronged):
    * `server/terminal-runtime.js` — added `set-option status off` when creating new tmux sessions, eliminating the periodic noise at the source.
    * `server/ws-handler.js` — added `isSubstantialOutput()` heuristic (strips ANSI, checks for newlines) and `lastSubstantialOutputAt` field that only updates on real command output.
    * `server/index.js` — exposed `lastSubstantialOutputAt` in the `GET /api/sessions` response.
    * `client/src/components/Sidebar.jsx` — switched `getTerminalStatus()` and `getProjectStatus()` to use `lastSubstantialOutputAt` for activity classification.
* **Codebase:**
  * `client/src/components/Terminal.jsx` — refactored viewport sync into a unified `syncTerminalViewport()` helper, added output buffering for hidden panes via `bufferOrWriteChunk()`/`flushPendingOutput()`, added input buffering during WebSocket reconnection, replaced reconnection banner with a centered overlay spinner.
  * `client/src/components/TerminalArea.jsx` — `disconnectPane()` now sends `DELETE /api/terminal/:sessionId` to kill the PTY, `reconnectPane()` extracted as a separate action.
  * `client/src/utils/terminalLayoutState.js` — reworked `filterLayoutByLiveSessions()` to preserve split-pane widths when all panes are still live, merge missing live sessions into new tabs, and preserve intentionally disconnected panes.
  * `client/src/utils/terminalVisibility.js` — added `shouldWriteTerminalViewport()` guard for suppressing writes to hidden panes.
  * `client/src/styles/global.css` — added `.reconnect-spinner` animation for the new reconnect overlay.
* **Tests:**
  * `server/__tests__/ws-handler.test.js` — 4 new tests covering `lastSubstantialOutputAt` initialization, ANSI-only output filtering, newline-bearing output tracking, and `lastOutputAt` preservation for diagnostics.
  * `client/src/components/__tests__/TerminalArea.test.js` — 4 new tests for layout reconciliation: live session merging, split-pane width preservation, width renormalization on pane loss, and disconnected pane preservation.
  * `client/src/components/__tests__/terminalVisibility.test.js` — 3 new tests for `shouldWriteTerminalViewport()`.

## [2026-04-11] - Durable Tmux Defaults and Terminal View Recovery

### Executive Summary
* Hardened CodeDeck’s terminal behavior for long-running work by making durable `tmux` sessions the default runtime and fixing two recovery regressions that could leave a pane looking blank or stale after reconnecting or switching tabs. This reduces the chance that active builds or noisy log streams appear to vanish when the terminal process is still alive.

### Technical Details
* **🐛 Bug Fix:**
  * Problem: reattaching to an existing session could inject a literal `^L` into the live process and fail to request replay after a pane remounted.
  * Solution:
    * `server/ws-handler.js` — stopped sending `Ctrl+L` into the PTY on reconnect and kept the session handshake focused on replay-aware recovery.
    * `client/src/components/Terminal.jsx` — now requests replay when the server reports an `existing` session, centralizes resume requests, and refreshes the xterm viewport when a tab becomes visible again.
    * `client/src/utils/terminalResume.js` — extracted replay-handshake decision logic for a focused regression point.
    * `client/src/utils/terminalVisibility.js` — extracted visibility and size guards so hidden tabs do not send invalid resize/fitting updates.
* **🛠️ Codebase:**
  * `server/index.js` — changed terminal runtime resolution to default to `tmux` instead of raw PTY when no override is configured.
  * `server/terminal-runtime.js` — updated the runtime factory default and inline documentation to reflect `tmux` as the preferred durable backend.
  * `docs/steering/product.md` — updated the product-level description to treat durable sessions as the normal runtime behavior.
  * `docs/todos/terminal-resilience-hardening.md` — corrected implementation notes so the recorded default runtime matches the current behavior.
  * `README.md` — documented `tmux` as the default runtime, explicit override commands, and the relationship between durable sessions and the bounded replay buffer.
* **🧪 Tests:**
  * `server/__tests__/ws-handler.test.js` — added coverage proving reconnect no longer writes `Ctrl+L` into the PTY.
  * `client/src/components/__tests__/terminalResume.test.js` — added regression coverage for replay requests on existing-session handshakes.
  * `client/src/components/__tests__/terminalVisibility.test.js` — added regression coverage for suppressing resize/reflow work while a terminal tab is hidden.

## [2026-04-11] - Terminal Resilience Hardening

### Executive Summary
* Implemented a full terminal resilience layer for CodeDeck across six phases. Terminals now have a pane-local debug inspector with health classification, explicit recovery actions (Reconnect, Resync, Redraw), visibility-aware refocus recovery, a heartbeat/sequence-tracked transport with bounded replay, and optional durable sessions via tmux. The backend grew from 23 to 90 unit tests. These changes address the core pain of misbehaving panes that silently stall when a browser tab is backgrounded or a WebSocket reconnects.

### Technical Details
* **✨ New Feature:**
  * `server/terminal-runtime.js` — New runtime abstraction factory; supports raw node-pty (default) and tmux-backed sessions. Both expose `spawn`, `kill`, and `isSessionRecoverable`. Uses `execFileSync` for shell-injection safety in tmux commands.
  * `client/src/components/TerminalInspector.jsx` — New modal debug inspector panel; polls `/api/debug/terminal-health` every 3s, renders health dot + label, state snapshot table, reverse-chronological event timeline, Copy Snapshot action, and Recovery Actions (Reconnect / Resync / Redraw).
* **🛠️ Codebase:**
  * `server/ws-handler.js` — Session entries extended with `wsAttached`, `lastAttachAt`, `lastDetachAt`, `lastClientAckAt`, `lastReplayAt`, `lastSeq`, `stallReason`, `events[]`, `replayBuffer`, `runtimeType`. Added `pushTimelineEvent`, `computeSessionHealth`, `computeStallReason` exports. Handles `heartbeat`, `resume`, `replay`, `visibility_change`, and `recovery_action` WebSocket messages. Monotonic `seq` assigned to each output chunk and stored in a bounded 1000-entry replay buffer. Tmux-aware PTY exit handler with capped re-attach logic.
  * `server/index.js` — `GET /api/sessions` extended with health summary fields. `GET /api/debug/terminal-health` added with per-session diagnostics and last 20 timeline events. Runtime resolved from `CODEDECK_TERMINAL_RUNTIME` env var → SQLite config → `'pty'` default. Health endpoint returns active `terminalRuntime` type.
  * `client/src/components/Terminal.jsx` — Added `lastSeenSeqRef`, `reconnectCountRef`, `resumeInFlightRef`, `heartbeatRef`, and browser-view diagnostic refs. `document.visibilitychange` listener triggers refit + resize sync + replay request on refocus. Heartbeat sends client diagnostics every 5s. `useImperativeHandle` extended with `reconnect()`, `resync()`, `redraw()` recovery methods.
  * `client/src/components/TerminalArea.jsx` — Added Bug icon button per pane to trigger the inspector; renders `TerminalInspector` with session lookup and `onAction` dispatch across tabs/panes.
  * `start.sh` — Optional `CODEDECK_CAFFEINATE=1` wraps startup under macOS `caffeinate -i` to prevent idle sleep.
* **🧪 Tests:**
  * `server/__tests__/ws-handler.test.js` — Expanded from 23 to 90 tests. Added coverage for diagnostic metadata, health classification, stall detection (3 tiers), visibility change handling, seq assignment, replay buffer bounds, resume/replay correctness (exact, overflow, empty, caught-up), recovery action handling, tmux-aware exit and reconnect, and runtimeType storage.
* **📝 Docs:**
  * `README.md` — Added Terminal Resilience section documenting inspector, recovery actions, replay buffer, tmux mode, and caffeinate.
  * `CLAUDE.md`, `docs/steering/product.md`, `docs/steering/structure.md` — Updated to reflect new components, backend patterns, message types, and test count.
  * `docs/specifications/terminal-resilience-hardening-spec.md` — Status updated from Draft to Implemented.
  * `docs/todos/terminal-resilience-hardening.md` — All 34 tasks marked complete across 6 phases with full session notes.
  * `client/dist/index.html` — Rebuilt client bundle.
