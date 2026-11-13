# Workflow Pipelines

**Spec**: `docs/specifications/2026-11-13-134947-workflow-pipelines-spec.md`
**Status**: Complete
**Last completed**: Phase 6: Sidebar Indicator, Documentation and Final Verification
**Created**: 2026-11-13

> Working rules for every phase: strict TDD (red test first), Vitest with `--maxWorkers=1`, per-field
> guards on everything crossing an edge including rows read back from SQLite, no fallback logic, no
> silent error swallowing, toasts for every mutating client call. Read `docs/steering/api-standards.md`
> and `~/.claude/standards/api-design.md` before touching an endpoint.
> Server tests: `cd server && npx vitest run __tests__/<file> --maxWorkers=1`.
> Client tests: `cd client && npx vitest run <path> --maxWorkers=1`.

## Phase 1: Background Attachment and Pass Limit
> The riskiest piece: the backend must drive a terminal with no browser attached, and the loop engine
> must stop at a maximum pass count. Nothing else can be built until this holds.
> **Inputs:** an existing tmux session id; the existing `createTerminalWorkflow`
> **Outputs:** `attachBackgroundSession` + `ensureSessionWorkflow` in `server/ws-handler.js`; `maxIterations`, `iteration`, `limitReached` in `server/terminal-workflow.js`; optional `cwd` on the session starter
> **Closed when:** with no browser, a detached session can be written to and its output observed; the full existing server suite still passes

- [x] `server/terminal-workflow.js`: accept optional `maxIterations` (integer 1–100) in `validateStart`; count passes; on the Nth CONTINUE finish `stopped` with `limitReached: true`; add `iteration` and `limitReached` to `snapshot()`; include `maxIterations` in the idempotency comparison (Spec §8.6)
- [x] Unit tests — extend `server/__tests__/terminal-workflow.test.js`: limit on pass N, no reset timer left armed at the limit, COMPLETE before the limit, bounds 0/1/100/101 and non-integers rejected, absent `maxIterations` behaves as today, replay with a different `maxIterations` throws
- [x] `server/ws-handler.js`: extract the lazy loop-engine creation into `ensureSessionWorkflow(entry, …)` with unchanged `write`/`notify` plus `entry.workflowObservers`; `registerSessionSocketHandlers` calls it (Spec §8.10)
- [x] `server/ws-handler.js`: export `attachBackgroundSession(…)` covering no entry / live entry / dead recoverable entry, rejecting tombstoned ids, returning `{ entry, workflow, write, observe, release }` (Spec §8.10)
- [x] `server/ws-handler.js`: `entry.backgroundHolds` counter honoured by `detachTmuxClient`; `release()` decrements and detaches only when no browser is attached (Spec §8.10)
- [x] `server/mobile-session-start.js`: optional validated absolute `cwd` on `start`, reflected in the returned descriptor; export the initial geometry constants (Spec §8.10)
- [x] `server/index.js`: hoist the WebSocket handler's options object into a const shared with the future run engine
- [x] Unit tests — new `server/__tests__/terminal-background-attach.test.js`: entry created with no socket, later browser reuses the same loop engine and receives `workflow_state`, hold survives a browser attaching and leaving, `release` detaches, dead-entry respawn, tombstoned id rejected, observers called
- [x] Unit tests — extend `server/__tests__/mobile-session-start.test.js`: `cwd` override used, relative or empty `cwd` rejected, default unchanged
- [x] Integration test — new `server/__tests__/terminal-background-attach-live.test.js` on real tmux with a private `TMUX_TMPDIR` (pattern of `terminal-incarnation-live.test.js`): create detached in a temp directory, attach in the background, write `echo`, observe the output, release, session still exists
- [x] Client: `TerminalWorkflow.jsx` label "Pass limit reached" when `limitReached`; extend `client/src/components/__tests__/TerminalWorkflow.test.jsx` (Spec §8.11)
- [x] Regression: `cd server && npx vitest run --maxWorkers=1` green, including `terminal-workflow-ws.test.js` and `ws-handler*.test.js`

## Phase 2: Definitions, Worktree Creation and a Single-Step Run (API only)
> The first end-to-end run: stored definitions, a worktree, one agent launched and driven to completion.
> **Inputs:** Phase 1 attachment and pass limit
> **Outputs:** `shared/pipeline-definitions.mjs`; stores for agents, workflows, settings, runs; `server/pipelines/run-worktree.js`, `agent-readiness.js`, `run-machine.js`, `run-engine.js`; `server/routes/pipelines.js`
> **Closed when:** a POSTed run on a local git project creates its worktree, opens a terminal in it, launches a stub agent, submits the prompt and reaches `complete`; every failure is a problem document

- [x] `shared/pipeline-definitions.mjs` — pure validators returning `[{ field, message }]` for agent, workflow (nodes), settings and run-start bodies; prompt composition with single-pass `{input}` replacement and the 16384 limit (Spec §4, §8.1)
- [x] Unit tests — `server/__tests__/pipeline-definitions.test.js`: every rule in Spec §4 with boundary values (0, 1, max, max+1), control characters, unknown fields, duplicate node names, `max` with `once`, missing `max` with `until_complete`, input containing `{input}` not re-expanded
- [x] Stores: `server/pipelines/agent-store.js`, `workflow-store.js`, `settings-store.js`, `run-store.js` — own table each, `revision` handling, per-field read guards that throw naming table/row/field (Spec §4)
- [x] Unit tests — `pipeline-definition-store.test.js` and `pipeline-run-store.test.js`: CRUD, case-insensitive uniqueness, stale revision, corrupted rows for every guarded field throw, `error`/`stop_reason` consistency rules
- [x] `server/pipelines/run-worktree.js` — `preflight`, `planNames` (slug/shortId, empty-slug rule, home repository from `--git-common-dir`), `create`; injected `execFile`, argument arrays, explicit timeouts (Spec §8.1, §8.2)
- [x] Unit tests — `pipeline-run-worktree.test.js`: name planning permutations, argv assertions with a fake `execFile`, git failure surfaced
- [x] Integration test — `pipeline-run-worktree-live.test.js` on a temp git repository: create adds the worktree and branch at `base_commit`; project that is a subdirectory or not a repository is ineligible; dirty checkout reported
- [x] `server/agent-profiles/*.js`: add `promptVisible(lines)` to each profile and `findAgentProfileById`; `server/pipelines/agent-readiness.js` pure classifier returning `ready | needs_input | exited | closed | waiting` (Spec §8.4)
- [x] Unit tests — `pipeline-agent-readiness.test.js` using `server/__tests__/fixtures/agent-screens`: each result row of Spec §8.4 per profile, idle-before-prompt is `waiting`
- [x] `server/pipelines/run-machine.js` — pure reducer for run and step statuses (Spec §5); unit tests `pipeline-run-machine.test.js` for the transitions needed by a single step
- [x] `server/pipelines/run-engine.js` — per-run promise chain: create worktree, start session with `cwd`, background attach, type launch command, readiness poll (1 s, 120 s of `waiting`), start the loop engine, persist progress, release (Spec §8.3, §8.4)
- [x] Unit tests — `pipeline-run-engine.test.js` with fake starter/attachment/runtime and fake timers: happy path, readiness timeout message, launch exited, terminal closed, worktree failure, never advancing inside `notify`
- [x] `server/routes/pipelines.js` — agents, workflows, settings, preflight, `POST /runs`, `GET /runs`, `GET /runs/:id` with pagination, allow-listed filters/sorts, trace id, single problem handler, 512 KB parser; add the prefix to the JSON bypass in `server/index.js`; wire stores and engine (Spec §6, §7, §8.1)
- [x] Integration tests — `pipelines-api.test.js` (supertest) across all six verification dimensions: happy paths with full envelope, sad paths with `errors` arrays, boundaries, null/empty, oversized and hostile payloads, duplicate POST and `requestId` replay/conflict; start preconditions 404/409; sort stability across a page boundary
- [x] Integration test — `pipeline-run-live.test.js` on real tmux + temp git repository with a stub agent script that draws a recognised agent screen and prints the signal: run reaches `complete`, its terminal's cwd is the worktree
- [x] Until Phase 3, a run's steps are only the workflow's nodes; the Setup step and cleanup arrive in Phase 3 (state this in the session notes so Phase 3 changes the snapshot shape deliberately)

## Phase 3: Multi-Step Runs, Setup, Owner Actions and Cleanup
> Everything that makes a run a pipeline: several steps, repeats, pauses, stops, restarts, the automated Setup step and worktree removal.
> **Inputs:** Phase 2 single-step run
> **Outputs:** full run state machine; Setup step; `stop`/`resume`/`continue`/`cleanup` endpoints; restart handling; session-closed notifications
> **Closed when:** every transition in Spec §5.1 and every row of Spec §8.6–§8.8 is covered by a passing test and persisted

- [x] Run machine: remaining transitions — next step, `limit_paused`, `needs_input` round trip, `stopped` (user/terminal), `interrupted`, Resume, Continue; computed `actions` (Spec §5, §8.6–§8.8)
- [x] Unit tests — extend `pipeline-run-machine.test.js`: exhaustive transition table including every refused action
- [x] Engine: advance through steps with a new terminal each; `once` vs `until_complete` mapping; pass-limit pause; unsolicited loop-engine `stopped` → `stop_reason = terminal` (Spec §8.3, §8.6, §8.7)
- [x] Setup step: snapshot step 0 from the setup agent with the fixed prompt and `until_complete` max 3; post-step `git status --porcelain` guard (Spec §8.5)
- [x] Worktree cleanup: automatic on `complete`, `removed` / `removal_blocked` with git's message plus up to 20 paths, `not_created` shortcut, never `--force`, branch untouched (Spec §8.2)
- [x] Session closed: notify the engine from `server/routes/terminal-delete.js` and from GC `onPruned` in `server/index.js` (Spec §8.7)
- [x] Restart: run store marks `pending`/`running`/`needs_input` runs and their current step `interrupted` at construction; `limit_paused` untouched (Spec §8.9)
- [x] Endpoints: `POST /runs/:id/stop|resume|continue|cleanup`; `open` filter on `GET /runs`; Resume 409 when the worktree directory is missing (Spec §6, §8.8)
- [x] Unit tests — extend `pipeline-run-engine.test.js`: three-step run, repeat until COMPLETE, limit pause then Continue (middle and last step), NEEDS_INPUT at launch and mid-step, Stop in each allowed state, terminal deleted mid-step, Setup leaving changes → error, Resume with `attempt + 1` and `priorSessionIds`
- [x] Integration tests — extend `pipelines-api.test.js`: each action in each state (allowed and 409), idempotent Stop, `actions` matches; store rebuilt mid-run → `interrupted` → Resume
- [x] Integration test — extend `pipeline-run-worktree-live.test.js`: remove succeeds with only ignored files; refuses with untracked, modified and staged files and reports paths; succeeds after resolving; branch still exists; unmerged commits do not block
- [x] Integration test — extend `pipeline-run-live.test.js`: two-step run with a repeating stub agent, Setup step first, worktree removed at the end

## Phase 4: Run Dialog, Runs Bar and Tab Adoption
> The owner can start, watch and steer a run from the UI. Definitions are still created through the API in this phase.
> **Inputs:** Phase 3 API
> **Outputs:** `utils/pipelinesApi.js`, `hooks/usePipelineRuns.js`, `RunWorkflowDialog.jsx`, `PipelineRunsBar.jsx`, `utils/terminalAdoption.js`; `adoptSessions` in `App.jsx`/`TerminalArea.jsx`
> **Closed when:** each step's tab appears within one poll with no reload, and Stop/Resume/Continue/Cleanup work from the bar; browser-verified through `./server.sh`

- [x] `client/src/utils/pipelinesApi.js` — fetch helpers with `res.ok` checks returning the API's `message` and `errors` (Spec §8.11)
- [x] `client/src/hooks/usePipelineRuns.js` — 2 s poll of `runs?open=true&size=100` with an in-flight guard, refetch after actions, backend-confirmed `startRun`/`stopRun`/`resumeRun`/`continueRun`/`cleanupRun`, toasts on each result and on status transitions
- [x] Unit tests — `client/src/hooks/__tests__/usePipelineRuns.test.jsx`: polling, no overlapping requests, failure toasts, no optimistic state
- [x] `client/src/utils/terminalAdoption.js` — pure planner; replace `resumedSessionId`/`onResumedAttached` with `adoptSessions` in `App.jsx` and `TerminalArea.jsx`; only the first step of a run started in this browser activates (Spec §8.11)
- [x] Unit tests — `client/src/utils/__tests__/terminalAdoption.test.js`; component test `TerminalAreaAdoption.test.jsx`; existing session-resume tests stay green
- [x] `client/src/components/pipelines/RunWorkflowDialog.jsx` — workflow select, input, preflight reasons blocking Start, uncommitted-changes warning, Start; button beside Session search in `TerminalArea.jsx`
- [x] `client/src/components/pipelines/PipelineRunsBar.jsx` — step chips with status and pass `k/N`, branch, error / blocked-cleanup detail, buttons from `actions`, chip click activates the tab, Resume confirmation naming the previous terminal
- [x] Component tests — `RunWorkflowDialog.test.jsx`, `PipelineRunsBar.test.jsx`
- [x] Browser check on owner-authorized unused port (replaces `./server.sh restart`): create an agent, setup agent and a two-node workflow through the API, start a run from the dialog, watch tabs appear, exercise Stop and Resume

## Phase 5: Settings Tabs and Editors
> Agents, the setup agent and workflows become manageable in the UI; the settings modal gets tabs.
> **Inputs:** Phase 2 definition API
> **Outputs:** tabbed `SettingsPanel.jsx`; `PipelineSettings.jsx`, `AgentList.jsx`, `WorkflowList.jsx`, `WorkflowEditor.jsx`
> **Closed when:** every definition operation is possible from the UI with toasts, and the existing settings behaviour is unchanged

- [x] `client/src/components/SettingsPanel.jsx` — 880 px wide, fixed height, tab strip (General, Session naming, Hosts, Workflows), all panels mounted, footer only on General and Session naming, confirm on close when dirty (Spec §8.11)
- [x] Component tests — new `SettingsPanelTabs.test.jsx`; update `SessionNaming.test.jsx` to select its tab first; footer Save still saves naming and config together
- [x] `client/src/components/pipelines/AgentList.jsx` — list, inline add/edit/delete, reset command pre-filled with `/clear`, 409-on-delete message shown
- [x] Setup agent select, saved on change with `revision`
- [x] `WorkflowList.jsx` + `WorkflowEditor.jsx` — draft of name and nodes, add/remove/move, agent select, prompt textarea, repeat mode and maximum, shared-validator field errors plus API `errors`, stale-revision reload
- [x] Component tests — `PipelineSettings.test.jsx`: each mutation's success and failure toast, validation errors rendered per field, stale revision flow
- [x] Browser check on owner-authorized unused port (replaces `./server.sh restart`): build the agents and a workflow entirely in the UI, then run it

## Phase 6: Sidebar Indicator, Documentation and Final Verification
> Local verification only.

- [x] Sidebar project row shows the count of open runs (Spec §8.11); component test `SidebarPipelineRuns.test.jsx`
- [x] Update `docs/steering/api-standards.md` (pipelines mapping), `docs/steering/structure.md`, `docs/steering/product.md`, `README.md` (replace the Terminal workflows section's scope, keep the per-terminal bar), `CHANGELOG.md`
- [x] Full regression of the final tree (earlier phases 1–4 snapshot passed): `cd server && npx vitest run --maxWorkers=1` and `cd client && npx vitest run --maxWorkers=1`
- [x] End-to-end browser pass on isolated unused port (replaces `./server.sh`): a real two-node workflow on a scratch git project, including a pass-limit pause, a Stop + Resume, a backend restart mid-run, and a blocked then successful cleanup
- [x] Code review pass against the pre-commit checklists in `docs/guidelines/instructions.txt`

## Session Notes

- Decisions and their rationale are in the spec's §1.1; the known limits are in §11. Do not reopen them without the owner.
- Verified on 2026-11-13 with a throwaway repository: `git worktree remove` without `--force` exits 0 and discards ignored files when only ignored files remain; exits 128 with "contains modified or untracked files" for an untracked file, a modified tracked file and a staged-only new file; exits 0 and keeps the branch for a clean worktree with unmerged commits.
- Not verified, confirm in Phase 1 before relying on it: the exact entry-creation line ranges in `server/ws-handler.js` cited during design (the functions are named in Spec §8.10).
- This work lives in the worktree `../worktrees/codedeck-workflow-pipelines` on branch `feature/workflow-pipelines`. `./server.sh start` fails there while the main checkout's instance is running: `client/vite.config.js` pins port 43000 with `strictPort` and proxies to `localhost:43001`, and `server/db.js` takes its database path from `$HOME`. Backend-only checks can run from the worktree with `HOME=<scratch> PORT=<spare> run node index.js` in `server/`. The browser checks in Phases 4–6 need the full UI, which means the owner must decide how to free the default ports (stop the main instance, or check this branch out in the main checkout) — ask before doing either.

### Session — 2026-11-13 (Phase 1)
**Completed**: Phase 1: Background Attachment and Pass Limit
**Key files**: `server/terminal-workflow.js`, `server/ws-handler.js`, `server/mobile-session-start.js`, `server/index.js`, `client/src/components/TerminalWorkflow.jsx`, `server/__tests__/terminal-background-attach.test.js`, `server/__tests__/terminal-background-attach-live.test.js`, `.workflow/2026-11-13-134947-workflow-pipelines.md`
**Next**: Phase 2: Definitions, Worktree Creation and a Single-Step Run (API only) — shared validators, stores, run-worktree, agent readiness, run machine/engine, pipelines routes
**Architecture**: Loop engine gains pass limit; background attach shares `ensureSessionWorkflow` with browser sockets via `backgroundHolds` + observers
**Quirks**: `release()` must be idempotent; background cwd must be absolute; snapshot always exposes `iteration`/`limitReached` (ws-handler deep-equal fixtures updated)

### Deviations
- **[Phase 1 / attachBackgroundSession] — absolute cwd + shared geometry**
  - **Planned**: Spec silent on relative cwd for background attach; todo exported INITIAL_* for reuse
  - **Found**: First cut hardcoded 120×32 and accepted relative cwd
  - **Did**: Require absolute cwd; reuse `INITIAL_COLS`/`INITIAL_ROWS` from `mobile-session-start.js` (review fix)
  - **Follow-up**: none

### Session — 2026-11-13 (Phase 2)
**Completed**: Phase 2: Definitions, Worktree Creation and a Single-Step Run (API only)
**Key files**: `shared/pipeline-definitions.mjs`, `server/pipelines/{agent,workflow,settings,run}-store.js`, `run-worktree.js`, `agent-readiness.js`, `run-machine.js`, `run-engine.js`, `server/routes/pipelines.js`, `server/index.js`, `server/__tests__/pipeline-*.test.js`, `pipelines-api.test.js`, `pipeline-run-live.test.js`
**Next**: Phase 3: Multi-Step Runs, Setup, Owner Actions and Cleanup — advance between steps, Setup step, stop/resume/continue/cleanup, worktree remove, restart interrupt
**Quirks**: Engine must use `attachment.workflow` (PTY feeds `entry.workflow.output`); snapshot prompts are composed once at POST /runs — do not re-compose in the engine

### Deviations
- **[Phase 2 / snapshot] — no Setup step yet**
  - **Planned**: Todo: steps are workflow nodes only until Phase 3
  - **Found**: Spec §4.4/§8.5 include Setup as step 0
  - **Did**: Snapshot is node-only; Phase 3 must prepend Setup and change the snapshot shape deliberately
  - **Follow-up**: Phase 3 Setup + cleanup
- **[Phase 2 / POST /runs] — single-node only**
  - **Planned**: Spec allows 1–32 nodes; Phase 2 title is single-step
  - **Found**: Engine/`applyStepComplete` do not advance to the next node yet
  - **Did**: Reject `workflow.nodes.length !== 1` with 400 on `workflowId` until Phase 3 advance exists
  - **Follow-up**: Remove the guard when multi-step advance ships
- **[Phase 2 / live readiness] — faked classifier**
  - **Planned**: Stub agent draws a recognised screen for real readiness
  - **Found**: Full execution-classifier readiness needs a real agent CLI foreground
  - **Did**: Live test fakes `classifyReadiness → ready` and uses a stub that emits `[[CDW:…:COMPLETE]]` after the paste; worktree/tmux/cwd/loop engine are real
  - **Follow-up**: none for Phase 2; production wiring uses real classifier
- **[Phase 2 / terminal stop] — interim failRun**
  - **Planned**: Spec §8.7 `stop_reason=terminal` (Phase 3 owner actions)
  - **Found**: Non-limit `stopped` left the run `running` in SQLite
  - **Did**: `failRun('The terminal workflow stopped unexpectedly.')` until Phase 3 stop_reason=terminal
  - **Follow-up**: Phase 3 replace with proper stopped/terminal

### Session — 2026-11-13 (Phase 3)
**Completed**: Phase 3: Multi-Step Runs, Setup, Owner Actions and Cleanup
**Key files**: `server/pipelines/run-machine.js`, `run-engine.js`, `run-worktree.js`, `server/routes/pipelines.js`, `server/index.js`, `server/routes/terminal-delete.js`, `server/__tests__/pipeline-run-*.test.js`, `pipelines-api.test.js`
**Next**: Phase 4: Run Dialog, Runs Bar and Tab Adoption — client API helpers, poll hook, dialog, runs bar, terminal adoption
**Bug fixes**: Stop no longer deadlocks behind `runStep` (settles workflow out-of-band); Stop during worktree create still records `present` then exits before session start; Resume resets `iteration` to 0

### Deviations
- **[Phase 3 / notifySessionClosed] — limit_paused excluded**
  - **Planned**: Spec §8.7 terminal deleted → run error for the step's terminal
  - **Found**: At `limit_paused` Continue starts a fresh terminal for the next step and does not need the paused step's session
  - **Did**: Keep notify filter on `pending`/`running`/`needs_input` only
  - **Follow-up**: none unless product wants pause-state terminal delete to force error
- **[Phase 3 / API action tests] — engine mocks**
  - **Planned**: Integration tests exercise each action
  - **Found**: Fast slice tests inject store-updating engine fakes for HTTP contract
  - **Did**: Real reducer/engine covered in `pipeline-run-machine` / `pipeline-run-engine` unit tests; API tests assert status/actions/409 envelopes
  - **Follow-up**: none

### Session — 2026-11-13 (Phase 4)
**Completed**: Phase 4 client implementation (browser check still open)
**Key files**: `client/src/utils/pipelinesApi.js`, `terminalAdoption.js`, `hooks/usePipelineRuns.js`, `components/pipelines/RunWorkflowDialog.jsx`, `PipelineRunsBar.jsx`, `App.jsx`, `TerminalArea.jsx`
**Next**: Finish Phase 4 browser check (needs free 43000/43001), then Phase 5 settings tabs/editors
**Quirks**: `actions` is a boolean object; adoptSessions replaces resumedSessionId; poll failure toasts once until success

### Deviations
- **[Phase 4 / browser check] — ports held by main checkout**
  - **Planned**: `./server.sh restart` browser pass on this worktree
  - **Found**: 43000/43001 in use by main checkout PIDs; session notes require asking before stopping or swapping checkouts
  - **Did**: Left the browser checkbox open; unit/component suite green (58 tests)
  - **Follow-up**: Owner chooses stop main instance, check out this branch in main, or defer browser check


### Session — 2026-11-13 (Review, live verification and merge)
**Verified**: Full regression passed: server 67 files / 1,425 tests; client 53 files / 502 tests. Both used Node 22.22.0 with `../node_modules/vitest/vitest.mjs run --maxWorkers=1`. Frontend production build passed.
**Review fixes**: Immediate validation and queued revalidation for owner actions; final-state fetch failures preserve observed runs/statuses for retry. Targeted regression tests went red before fixes, then passed.
**Browser evidence**: Isolated server/database snapshot on port 43121, scratch Git project and private tmux socket, deterministic agent fixture with the real readiness classifier. Verified Start/tab adoption, project names with spaces/dots/Unicode, literal `$&`/`$$`, Stop/Resume, pass-limit Continue, backend restart/interruption/resume, completion feedback with failed-final-fetch retry, project-switch mutation fencing, Setup dirty-worktree rejection, and blocked then successful cleanup. Continue acknowledged in 22 ms while execution remained active. Temporary server processes and tmux server were stopped.
**Known P2 retained**: `usePipelineRuns.js` action success toast still says “continued” when Continue returns HTTP 200 with a Setup guard `error`; the runs bar correctly reports the error and no user step starts. Owner requested merge/cleanup/restart after this finding was reported. Follow up with a failing hook test and status-aware action feedback.
**Scope**: Phases 5–6 remain unfinished. The browser pass used an isolated snapshot, not the managed main instance or a live AI provider; the explicit `./server.sh` checks above remain open. Main restart is authorized for the merge handoff.

### Session — 2026-11-13 (Phase 5)
**Completed**: Phase 5: Settings Tabs and Editors (code and component tests; the "then run it" half of the browser check is still open)
**Key files**: `client/src/components/SettingsPanel.jsx`, `HostsSection.jsx`, `client/src/components/pipelines/{PipelineSettings,AgentList,WorkflowList,WorkflowEditor,definitionForm}.jsx`, `pipeline-settings.css`, `client/src/utils/pipelinesApi.js`, `client/src/utils/pipelineRecords.js`
**Tests**: `SettingsPanelTabs.test.jsx`, `HostsSectionDirty.test.jsx`, `SessionNaming.test.jsx` (selects its tab), `pipelines/__tests__/PipelineSettings.test.jsx`, `pipelines/__tests__/definitionForm.test.js`, `utils/__tests__/pipelinesApi.test.js`, `utils/__tests__/pipelineRecords.test.js`. Targeted run only (11 files, 150 tests, including `usePipelineRuns.test.jsx`); the full client and server suites were not re-run this session.
**Browser evidence**: built client served by an isolated backend (`HOME`/`TMUX_TMPDIR` in a scratch directory, `PORT=43121`). Four tabs render at the new size; added an agent, chose it as setup agent, saw the missing-maximum error on a repeating node, then saved a one-node workflow, all from the UI with toasts and no console errors; `GET /api/pipelines/{agents,workflows,settings}` on that instance returned what the UI showed. The instance was stopped afterwards. Not done: starting a run from those definitions with a real agent CLI, and the same check on the managed `./server.sh` instance.
**Next**: Phase 6: Sidebar Indicator, Documentation and Final Verification. Also still open: the Phase 4 and Phase 5 browser checks on the real instance.
**Bug fixes**: the retained P2 is fixed. Stop/Resume/Continue that return a run already in `error` now toast that run's error instead of "continued"; a hook test went red first (`usePipelineRuns.test.jsx`, "reports an action that leaves the run in error as a failure, once").
**Review fixes**: one independent review of the diff (not the three the skill asks for). Applied, each with a test that failed first: field errors are cleared when nodes are moved or removed (they are keyed by position); opening another agent or workflow over an unsaved form asks first; the footer names an incomplete Session naming panel when that is what disables Save; `createdAt`/`updatedAt` are guarded on agent and workflow responses.
**Quirks**: this worktree was recreated on the existing `feature/workflow-pipelines` branch after the first one was removed at merge; `.workflow/` is git-ignored and was restored from the home checkout's `.workflow/archives/workflow-pipelines-238c90a/ignored-files.tar.gz`.

### Deviations
- **[Phase 5 / SettingsPanel] — Hosts reports unsaved edits**
  - **Planned**: Todo lists only `SettingsPanel.jsx` for the close confirmation; `HostsSection.jsx` is not named
  - **Found**: Spec §8.11 says closing with unsaved changes "anywhere" asks first, and Hosts keeps a half-typed new host and an edit form in local state
  - **Did**: Added an optional `onDirtyChange` prop to `HostsSection` (new host fields non-blank, or an edit form that differs from the host); no other Hosts behaviour changed
  - **Follow-up**: none
- **[Phase 5 / client edge] — response guards added**
  - **Planned**: Todo names no client-side validation of API responses
  - **Found**: The working rules require per-field guards on everything crossing an edge
  - **Did**: `client/src/utils/pipelineRecords.js` checks every field of agent, workflow (with nodes and repeat) and settings responses and fails the load naming the record and field. Its tests were written together with the module rather than red first
  - **Follow-up**: `RunWorkflowDialog` still reads workflows unguarded (Phase 4 code, not changed here)
- **[Phase 5 / stale revision] — conflict told apart by reading the item back**
  - **Planned**: "a 409 tells the owner the item changed and reloads it"
  - **Found**: The API answers 409 for a stale revision and for a taken name, with only the message text differing
  - **Did**: On a 409 from PUT the editor GETs the item: a different revision means stale (toast, latest loaded into the form); the same revision means another conflict (API message shown, draft kept); a 404 closes the form. Agents get the same handling as workflows
  - **Follow-up**: none
- **[Phase 5 / editor] — choices the spec leaves open**
  - **Planned**: Spec silent on a default maximum, on removing the last node, and on adding a workflow with no agents
  - **Found**: —
  - **Did**: Maximum passes starts empty and must be typed (no invented default); Remove is disabled on the only node and Add node at 32; Add workflow is disabled with a hint until an agent exists; deleting an agent or workflow asks for confirmation
  - **Follow-up**: say if a pre-filled maximum is wanted
- **[Phase 5 / scope] — retained P2 fixed in this session**
  - **Planned**: The merge session left the Continue toast bug as a follow-up; it is not a Phase 5 task
  - **Found**: `runAction` in `usePipelineRuns.js` always toasted success when the request returned 200
  - **Did**: An action whose returned run is in `error` now toasts that run's error; Stop, Resume and Continue share the path
  - **Follow-up**: none
- **[Phase 5 / browser check] — isolated instance instead of `./server.sh restart`**
  - **Planned**: Build the agents and a workflow in the UI on the managed instance, then run it
  - **Found**: Ports 43000/43001 belong to the owner's live instance on `main`; a run needs a real agent CLI
  - **Did**: Checked the definition UI on an isolated instance (see Browser evidence); left the checkbox open because nothing was run
  - **Follow-up**: owner to run a workflow from UI-built definitions once this branch is on the live instance


### Session — 2026-11-13 (Phase 6, iteration 89f0b7c5-2)
**Completed this pass**: Sidebar indicator, documentation, three reviews and final browser verification. Phase 6 remains incomplete until feature-test runs full regression of this tree.
**Rules**: Count every project's backend-open runs across all pages; show counts on active/waiting/shelved rows and compact active rows; no badge at zero; poll every 2 seconds without overlap; retain last counts and toast failures once until recovery; ignore late responses after unmount.
### Deviations
- **[Phase 6 / polling] — separate all-project counts poll**
  - **Planned**: Sidebar project rows show their open-run counts; source unspecified.
  - **Found**: `usePipelineRuns.js` polls only the active project and clears state on project changes.
  - **Did**: Reuse paginated `listOpenRuns()` in a separate counts hook so inactive projects remain visible without changing run adoption or action semantics.
  - **Follow-up**: none
- **[Phase 6 / verification] — broad regression deferred to feature-test**
  - **Planned**: Todo includes full regression; it has an earlier passing snapshot.
  - **Found**: Invoked feature-dev explicitly prohibits a full regression sweep in this pass.
  - **Did**: Run focused count/sidebar/app tests and browser checks; leave current-tree full regression for feature-test.
  - **Follow-up**: feature-test must verify this final tree.

**Review issue resolved**: Full run response guards added in `pipelineRunRecords.js` after the conventions review rejected project-only validation. Every run/step/repeat/worktree/action field has missing-field rejection coverage; malformed identifiers, statuses, paths, timestamps, session IDs and bounds are covered. Three reviewers finished; the guard fix was re-reviewed cleanly.
**Targeted evidence**: Initial sidebar tests failed on absent badges and hook import; after implementation 24 tests across sidebar/hook/app passed. Full response-guard tests first failed on missing parser import; final guard/hook/sidebar run passed 68 tests across 3 files. `npx vite build` passed 3446 modules (large chunk warning).

**Browser evidence**: `http://localhost:59629`, disposable HOME/SQLite and private TMUX_TMPDIR under `/tmp/cd-phase6-v0AFFR`. Created agent, Setup selection and two-node workflow entirely in Settings; started from dialog. Real Git/tmux/readiness classifier with deterministic Codex fixture (no live AI provider). Observed automatic tabs, expanded/compact count 1, pass-limit pause, Stop + Resume, backend restart → interrupted, Resume attempt 3, Continue → Review complete. Untracked `cleanup-proof.txt` blocked automatic cleanup and left count 1; removed the test file then UI cleanup returned state removed; badge and runs bar disappeared. Branch retained. Browser closed; run PIDs 23548/65949 and private tmux stopped. Main instance untouched.
**Key files**: `App.jsx`, `Sidebar.jsx`, `usePipelineRunCounts.js`, `pipelineRunRecords.js`, new count/sidebar/response tests, README, CHANGELOG and three steering docs.
**Next**: feature-test final-tree full server/client regression; Phase 6 last checkbox remains open. No commit, push, merge or deployment in this pass.
- **[Phase 6 / browser lifecycle] — unused-port instance and Playwright**
  - **Planned**: Browser pass via managed lifecycle, without disrupting the owner's active instance.
  - **Found**: Owner previously authorized unused ports; Chrome DevTools failed reading DevToolsActivePort with EPERM.
  - **Did**: Built UI served by PATH `run` on unused port 59629, isolated HOME and tmux; Playwright completed the browser pass. Closed all test processes afterward.
  - **Follow-up**: none; live AI-provider behavior remains unverified.

## Exit Report

**Feature**: Workflow Pipelines
**Todo file**: `docs/todos/2026-11-13-134947-workflow-pipelines.md`
**Phases**: 5 of 6 complete
**Tasks**: 60 of 61 complete (98%)

### This session
- **Completed**: Phase 6 implementation, documentation, code review and browser verification; final regression pending.
- **Built**: All-project sidebar counts and full run response guards, with red/green targeted tests.
- **Key decisions**: Use separate all-project poll; preserve active-project action/adoption behavior.
- **Deviations**: 3 — separate count poll; regression reserved for feature-test; unused-port Playwright verification. Details above.

### Next
- **Phase**: Phase 6: final-tree regression via feature-test.
- **What it involves**: Run full server and client suites with --maxWorkers=1; update completion if green.
- **Blockers**: none.

### Status
- 🔄 In progress — final regression remains.

### Session — 2026-11-13 (Phase 6 final regression)
**Completed**: Phase 6: Sidebar Indicator, Documentation and Final Verification — feature complete.
**Evidence**: Node v22.22.0. `cd server && npx vitest run --maxWorkers=1` → Test Files 67 passed (67), Tests 1425 passed (1425). `cd client && npx vitest run --maxWorkers=1` → Test Files 61 passed (61), Tests 680 passed (680). No code changes this session.
**Next**: none in this todo. Changes remain uncommitted on `feature/workflow-pipelines` in `/Users/sabside/git/worktrees/codedeck-workflow-pipelines`; commit/merge/ship awaits the owner. Preserve ignored `.workflow/2026-11-13-134947-workflow-pipelines.md` on worktree cleanup.

### Deviations
- **[Phase 6 / full regression] — run inside feature-dev**
  - **Planned**: feature-dev defers full sweeps to feature-test.
  - **Found**: the regression was the only remaining todo task, and this CodeDeck workflow loop runs only `/feature-dev`.
  - **Did**: ran both full suites with `--maxWorkers=1` so the todo could close.
  - **Follow-up**: none.
