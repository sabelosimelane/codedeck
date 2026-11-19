# Multi-repository Tasks

**Spec**: `docs/specifications/multi-repository-tasks.md`
**Status**: In Progress
**Last completed**: Phase 2: A Project's Repositories (Phase 1 has one task left for the owner's go-ahead)
**Created**: 2026-11-19

> Working rules for every phase: strict TDD (red test first), Vitest with `--maxWorkers=1`, per-field
> guards on everything crossing an edge including rows read back from SQLite, no fallback logic the
> spec does not state, no silent error swallowing, toasts for every mutating client call. Read
> `docs/steering/api-standards.md` and `~/.claude/standards/api-design.md` before touching an
> endpoint; every new or changed endpoint is tested in the six dimensions of that standard.
> Server tests: `cd server && npx vitest run __tests__/<file> --maxWorkers=1`.
> Client tests: `cd client && npx vitest run <path> --maxWorkers=1`.
> Work only in a worktree of this repository based on `main`. Do not edit `/Users/sabside/git/codedeck`,
> do not merge into `main`, and do not restart or reload the live instance without the owner's
> explicit go-ahead: a change under `server/` in that checkout reloads the live backend and
> interrupts working runs.

## Phase 1: Task Worktrees in the Database
> The riskiest piece: it changes where every existing task keeps its worktree, in the live database,
> under a backend that reloads when `server/` changes. Nothing visible changes in this phase.
> **Inputs:** the `tasks` table and its readers as they are at `26380fc`
> **Outputs:** `task_worktrees` and `tasks.task_folder`; a migration; a store that reads and writes worktrees; every reader switched to it
> **Closed when:** the full server suite passes with no behaviour change, the migration is proven idempotent on a database holding tasks in all four states, and the released phone's task request still parses

- [x] `server/__tests__/task-store.test.js` (red): a database with `tasks` rows in `active`, `pr_open`, `merged` and `closed` gets exactly one `task_worktrees` row each (`is_first = 1`, no `repository_path`, values copied, `repository` from the project's folder name or the task's project name), and a second start inserts nothing (Spec §6)
- [x] `server/tasks/task-store.js`: create `task_worktrees` and its indexes, add `tasks.task_folder`, drop `tasks_open_worktree`, run the migration in one transaction; it takes a `findProject` so the migration needs no Git call (Spec §6)
- [x] `server/tasks/task-store.js`: `hydrateWorktree` with one guard per column, including "`finished_at` is set exactly when finished"; a task must have exactly one first worktree and the state its worktrees give; a red test per guard
- [x] `server/tasks/task-store.js`: a task is returned with `worktrees` (first one first) and `folder`; its top-level `worktreePath`, `branch`, `baseBranch`, `baseCommit` and `prUrl` come from the first worktree (Spec §3.2, §7)
- [x] `server/tasks/task-store.js`: `create` writes the task row and its first worktree row in one transaction and still fills the old `tasks` columns; `addWorktree`; `setWorktreeState(taskId, worktreeId, { state, prUrl })` writes the worktree and the derived `tasks.state` in one transaction (Spec §3.5, §6)
- [x] `server/tasks/task-store.js`: `findOpenByWorktreePath` reads `task_worktrees`; the "worktree already belongs to an open task" refusal comes from the new index
- [x] Switch the readers with no change in behaviour: `server/tasks/task-service.js`, `server/tasks/task-landing.js` (state changes go through `setWorktreeState`), `server/tasks/task-terminals.js`, `server/tasks/task-adoption.js`, `server/routes/tasks.js` (`taskView` adds `worktrees` and `folder`), `server/routes/pipelines.js` (`POST /runs` in a task)
- [x] `server/__tests__/tasks-api.test.js`: a fixture of what the released phone and desktop send and read (`GET /api/tasks?open=true&page=0&size=100`) replays unchanged; `parseTask` in `client/src/utils/tasksApi.js` accepts the new response
- [x] Run the full server suite and the client suite; record the counts in the session notes
- [ ] With the owner's go-ahead only: run the migration against a copy of `~/.codedeck.db` and record the row counts before and after

## Phase 2: A Project's Repositories
> A project names the repositories that belong to it. One vertical slice: storage, endpoints, dialog.
> **Inputs:** Phase 1; the `projects` config list
> **Outputs:** `repositories` on a project; four endpoints; a dialog that lists, adds and removes them and offers the neighbours
> **Closed when:** the owner can open a project's Repositories dialog, add the repositories beside it with one click, and see each one's branch and state; a project without the field behaves as before

- [x] `server/project-repositories.js` (new, pure where possible): validate an entry (absolute path, exists, top level of a working tree, a repository different from the own and from the others, derived unique `name`, at most 8, local project only); red tests first for each rule (Spec §3.1)
- [x] `server/project-repositories.js`: `listCandidates` scans the direct children of the own repository's parent folder for Git repositories, skips `worktrees` and the ones already listed, and never recurses
- [x] `server/project-config.js`: `normalizeProject` supplies `repositories: []`; a guard for every field of a stored entry when the list is read
- [x] `server/routes/project-repositories.js` (new): `GET /api/projects/:name/repositories` and `GET …/repository-candidates` (paged, sort `name`, stable tiebreaker), `POST …/repositories`, `DELETE …/repositories/:repository`; RFC 9457 errors with `traceId`; all six test dimensions (Spec §7)
- [x] `server/index.js`: mount the router; `docs/steering/api-standards.md`: a section for these endpoints
- [x] `client/src/utils/projectRepositoriesApi.js` (new): validated client, one guard per field read
- [x] `client/src/components/ProjectRepositoriesDialog.jsx` (new): the project's repositories with branch and state, Remove, "Add the repositories beside it" from the candidates, Add by folder with `DirectoryBrowser`; toasts for success and failure
- [x] `client/src/components/Sidebar.jsx`: an entry on the project row that opens the dialog; `client/src/App.jsx` carries the list; nothing is linked automatically (Spec §10, answer 2)

## Phase 3: A Task Across Repositories
> A task is created with worktrees in several repositories, in one folder, and its terminals open in any of them.
> **Inputs:** Phases 1 and 2
> **Outputs:** planning and creation per repository with undo; the task folder layout; terminals per worktree; grouping by task; Close task over every worktree
> **Closed when:** from the New task dialog the owner creates a task in two repositories, sees one task with terminals in each, and Close task removes both worktrees or neither

- [ ] `server/pipelines/run-worktree.js`: `planTaskFolder({ taskId, title, ownHomePath, repositories })` returns the task folder and one path and branch per repository; `planNames` is unchanged for a project without other repositories (Spec §3.3)
- [ ] `server/tasks/task-service.js`: `plan` takes `repositories` (first is where the task starts; absent means the own repository) and runs the Git check for each; it changes nothing (Spec §3.2)
- [ ] `server/tasks/task-service.js`: `createPlanned` creates the worktrees one after another; when one fails, the ones made for this task are removed without force and their branches deleted with `git branch -d`; the error names the repository; when the undo is refused the task is kept with what exists (Spec §3.2)
- [ ] `server/routes/tasks.js`: `POST /api/tasks` accepts `repositories`; `POST /api/tasks/:id/terminals` accepts `{ worktreeId }`; both stay valid without the new fields (Spec §7)
- [ ] `server/tasks/task-landing.js`: Close task checks every open worktree first, closes all or none, reports a removal refused midway, and removes the empty task folder with a plain `rmdir` (Spec §3.5, §3.3)
- [ ] `server/tasks/task-terminals.js`: closes terminals by any of the task's worktree paths
- [ ] `client/src/utils/tasksApi.js`: `parseTask` reads `worktrees` and `folder` with a guard per field; `createTask` and `openTaskTerminal` take the new fields
- [ ] `client/src/components/tasks/NewTaskDialog.jsx`: the project's repositories as checkboxes when it has others; unchanged otherwise
- [ ] `client/src/utils/worktreeGroups.js`: a path that is any worktree of a task belongs to that task's group; the group key is the task id; groups carry their worktrees (Spec §3.6)
- [ ] `client/src/components/TerminalArea.jsx`, `TerminalTabBar.jsx`: new terminal, split and Cmd/Ctrl+Shift+T open in the active pane's repository; "+" offers the task's open repositories; the repository's name on tabs and pane headers of a task with several worktrees
- [ ] `client/src/components/WorktreeGroupHeader.jsx`: tooltip lists each repository's folder, branch and path
- [ ] Main reaches every repository (Spec §3.6, §10 answer 5). Read first how a Main terminal gets its directory today (`server/ws-handler.js`, `client/src/components/Terminal.jsx`, `client/src/utils/terminalPaneCwd.js`). Then: the backend accepts a Main terminal only in the checkout of one of the project's repositories; "+" in Main offers them; such a terminal belongs to the Main group in `worktreeGroups.js` and shows the repository's name on its tab

## Phase 4: Landing per Repository
> Status, commit, merge and close for one repository of a task, and a task that finishes with its last repository.
> **Inputs:** Phase 3
> **Outputs:** landing functions that take a task worktree; the worktree endpoints; one bar row per repository
> **Closed when:** in a task with two repositories one can be committed and merged while the other is dirty, the task stays open until the second is merged or closed, and a task with one worktree lands exactly as before

- [ ] `server/tasks/task-landing.js`: `inspect(taskId, worktreeId)` reads the worktree's path, branch and base, and its repository's checkout and remotes; messages name the repository when the task has several; red tests for each blocker per repository (Spec §3.5)
- [ ] `server/tasks/task-landing.js`: `commit`, `merge`, `close` per worktree; a working run blocks every worktree of its task; finishing one worktree closes its terminals and releases a finished run that worked in it; the task finishes with its last worktree (`merged` if any was merged, else `closed`)
- [ ] `server/index.js`: `onTaskFinished` and a per-worktree release of runs; `closeTerminals` per worktree
- [ ] `server/routes/tasks.js`: `GET /api/tasks/:id/worktrees` (paged, with landing status) and `POST /api/tasks/:id/worktrees/:worktreeId/commit`, `/merge`, `/close`; the task-level endpoints keep acting on the first worktree; six test dimensions each (Spec §7)
- [ ] `client/src/utils/tasksApi.js`: the worktree landing calls with validated responses
- [ ] `client/src/components/tasks/TaskLandingBar.jsx`: one row per repository with its facts and buttons; refusals and conflicts shown on the row they belong to; a task with one worktree in a project without other repositories renders as today (existing tests unchanged)

## Phase 5: Runs Across Repositories
> A run starts in one of the task's repositories and is told about the others.
> **Inputs:** Phase 4
> **Outputs:** `startIn` and `newTask.repositories` on run start; guidance, notes and Setup that cover every repository; the Run dialog
> **Closed when:** a run started in `mobile-app` of a task that also has `backend` has `mobile-app` as its directory, finds its progress file there, is told it may change `backend`, and its Setup prepares both; a run in a project without other repositories gets today's guidance character for character

- [ ] `shared/pipeline-definitions.mjs`: the start body accepts `startIn` and `newTask.repositories`; red tests for each field (Spec §7)
- [ ] `server/routes/pipelines.js` `POST /runs`: the run's worktree is the task's worktree in `startIn`; the progress file of a new task is checked in that repository's checkout; a task with another unfinished run is refused; the request replay check covers the new fields (Spec §3.4)
- [ ] `server/routes/pipelines.js`: when the progress path made from the input is absolute and inside one of the project's repositories, the refusal names the repository and the relative path to type
- [ ] `server/pipelines/step-guidance.js`: the worktree sentence for a task with several worktrees or a project with other repositories; the read-only sentence over all worktrees; today's sentence unchanged otherwise (Spec §3.4)
- [ ] `server/terminal-workflow.js`: guidance limit 4000; `server/routes/pipelines.js`: the refusal for guidance that is still too long names the repositories
- [ ] `server/pipelines/run-notes.js`: `buildReadme` gets the "Repositories" section
- [ ] `server/pipelines/run-worktree.js`: `buildSetupPrompt` takes a list of home checkout and worktree pairs; `server/pipelines/run-engine.js`: the guard after Setup checks every worktree of the task and names the dirty one; guidance and notes read the task's places at each step start through a `listTaskPlaces` dependency wired in `server/index.js`
- [ ] `server/routes/pipelines.js`: `GET /worktrees` accepts `repository`; the prompt preview shows placeholder repositories
- [ ] `client/src/components/pipelines/RunWorkflowDialog.jsx`, `client/src/utils/pipelinesApi.js`: for a new task, repository checkboxes and "Start in"; for an open task, "Start in" among its open worktrees
- [ ] `server/routes/pipelines.js` and `RunWorkflowDialog.jsx`: a run in Main may start in the own checkout of any of the project's repositories; it writes there only, the others are named as readable, and it has no Setup (Spec §3.4)
- [ ] `client/src/components/tasks/TaskView.jsx`: the header names the repository the run works in when the task has several; "Open a terminal here" opens in the run's worktree

## Phase 6: Adding a Repository, and Pull Requests per Repository
> What a task needs after it has started: one more repository, and a pull request for each.
> **Inputs:** Phase 5
> **Outputs:** `POST /api/tasks/:id/worktrees`; `POST …/worktrees/:worktreeId/pull-request`; the bar's Add repository
> **Closed when:** a run that stopped for lack of `backend` continues after the owner adds it from the bar, and each repository of a task can have its own pull request

- [ ] `server/tasks/task-service.js`: `addRepository(taskId, repository)`; refused while a run of the task is `pending` or `running`, for a finished task, for a repository already in the task, and for one that was merged or closed in it (Spec §3.2)
- [ ] `server/routes/tasks.js`: `POST /api/tasks/:id/worktrees` with the six test dimensions; a repeated request does not make a second worktree
- [ ] `server/tasks/task-landing.js`: `pullRequest` per worktree with that repository's remotes; the worktree's own `pr_url`; the task shows `pr_open` while any open worktree has one
- [ ] `server/routes/tasks.js`: `POST /api/tasks/:id/worktrees/:worktreeId/pull-request`
- [ ] `client/src/components/tasks/TaskLandingBar.jsx`: Add repository (lists the project's repositories not in the task, says that no Setup runs for it); Open a pull request and its link on each row

## Phase 7: Phone, Documentation and Final Verification
> **Inputs:** Phases 1–6
> **Outputs:** the phone's task screen; README and steering files; a verified whole
> **Closed when:** both suites and the client build pass, the documents describe what was built, and the owner has seen a task across two repositories created, run and landed

- [ ] `client/src/mobile/TaskScreen.jsx`: lists the task's repositories and where the run works; `client/src/mobile/nowView.js` rows unchanged
- [ ] `README.md` (Tasks, Workflow pipelines), `docs/steering/product.md`, `docs/steering/structure.md`, `docs/steering/api-standards.md`: describe repositories of a project, tasks across them, landing per repository
- [ ] Full server suite, full client suite, `cd client && npx vite build`
- [ ] Live check with the owner's go-ahead: link the repositories of one group project, create a task in two of them, run a workflow that starts in the second, commit and merge each, close the task. Read the memory note on why a worktree cannot run a second full instance before choosing how to do this
- [ ] Record what was left for a later release: dropping the old `tasks` columns (Spec §6, §8)

## Session Notes

### Session — 2026-11-19 (specification and todo)
**Completed**: the specification and this todo. No code.
**Key decisions** (Spec §4): the project path stays the project's own repository; a run's directory is one repository's worktree; a repository not in the task is readable only; one unfinished run per task; landing per repository with no "merge all"; old `tasks` columns kept for one release; guidance limit 4000.
**Owner's answers** (Spec §10): repositories are listed per project; the grouping is virtual and nothing is linked automatically; one folder per task; a new task includes the repository it starts in plus the ones ticked. One sidebar row per group; Main reaches every repository's own checkout, so no repository needs a project of its own (answer 5).
**Key files read**: `server/tasks/*.js`, `server/routes/tasks.js`, `server/routes/pipelines.js` (`POST /runs`, `:812-996`), `server/pipelines/step-guidance.js`, `run-worktree.js`, `run-notes.js`, `run-progress.js`, `run-engine.js` (`:226-280`, `:375-398`, `:605-719`), `client/src/utils/worktreeGroups.js`, `client/src/components/tasks/`, `client/src/mobile/nowView.js`.
**Not read**: `server/project-deletion-service.js`, `server/pipelines/run-machine.js`, `client/src/components/TerminalTabBar.jsx`, `client/src/mobile/MobileApp.jsx`, most of `TerminalArea.jsx`, `Sidebar.jsx` and `App.jsx`. Read them before Phase 3.
**Quirks**:
- `tr` is aliased in this shell; do not use bare `tr` in commands.
- A session may already start in any absolute directory (`server/mobile-session-start.js:10-22`), so terminals in another repository's worktree need no transport change.
- At `26380fc` the worktree is created before the task row (`server/tasks/task-service.js:86-87`). An audit fix that writes the row first (item R01) may land on `main` from another branch; rebase and follow its order in Phase 1.
- `planNames` uses only the id and the title for a folder's suffix (`server/pipelines/run-worktree.js:46-59`).
**Next**: Phase 1.

### Session — 2026-11-19 (Phase 1)
**Completed**: Phase 1, commit `95fa6d8`. `task_worktrees` and `tasks.task_folder`; the migration runs in the same transaction as the schema change and stops, leaving the database untouched, when it has tasks to carry over and no way to look up their projects; `create`, `addWorktree`, `setWorktreeState`; readers switched; the tasks API adds `folder` and `worktrees`.
**Evidence**: Node v22.22.0. `cd server && npx vitest run --maxWorkers=1` → Tests 8 failed | 2789 passed (2797), Test Files 1 failed | 91 passed. All 8 failures are in `__tests__/pipeline-run-live.test.js` (live tmux, timeouts waiting for a run to leave `launching`); the same 8 fail with `server/` checked out at `603362f`, before this phase (`Tests 8 failed | 6 passed (14)`), and that file does not use the task store. `cd client && npx vitest run --maxWorkers=1` → Test Files 80 passed, Tests 1415 passed.
**Not done**: the migration has not been run against a copy of `~/.codedeck.db`; it needs the owner's go-ahead.
**Key decisions**: a worktree of the project's own repository is the one with no stored checkout (`repository_path` NULL), so no separate flag column; a stored task state that is not what its worktrees give fails loudly on read; the store takes `findProject` only to name the repository of carried-over tasks.

### Deviations
- **[Phase 1 / `is_own` column] — not created**
  - **Planned**: an `is_own` column beside `repository_path`.
  - **Found**: the two always say the same thing.
  - **Did**: `own` is `repository_path IS NULL`; spec §6 updated.
  - **Follow-up**: none.
- **[Phase 1 / `setState`] — replaced, not kept beside the new method**
  - **Planned**: state changes go through `setWorktreeState`.
  - **Found**: tests in five files called `taskStore.setState` to finish a task.
  - **Did**: removed `setState`; tests use `__tests__/helpers/task-state.js`, which sets the first worktree's state.
  - **Follow-up**: none.

### Session — 2026-11-19 (Phase 2)
**Completed**: Phase 2. `server/project-repositories.js` (rules, Git check, neighbour scan), `server/routes/project-repositories.js` (four endpoints), `client/src/utils/projectRepositoriesApi.js`, `client/src/components/ProjectRepositoriesDialog.jsx`, the "Repositories…" entry in the project menu of local active and waiting projects, `docs/steering/api-standards.md`.
**Key decisions**: a stored entry's path is the real path of the checkout; an added repository is refused when its repository (not only its folder) is already listed, so `frontend/` and `worktrees/frontend-main` cannot both be listed; additions run one at a time, so the same request twice stores one entry; a neighbour is a direct child folder with a `.git` directory (no Git process per folder, since `~/git` has hundreds); "Add all" is offered only when every neighbour fits in the limit of 8.
**Evidence**: `cd server && npx vitest run --maxWorkers=1` → Tests 9 failed | 2873 passed (2882): the 8 live-tmux failures of Phase 1, and `mobile-session-start.test.js` "restores a shelved project", whose expected stored project lacked the new `repositories: []`; that test was corrected and its file passes, the full server suite was not run again after that one-line change. `cd client && npx vitest run --maxWorkers=1` → Test Files 82 passed, Tests 1468 passed. `cd client && npx vite build` → built. Commit `9019024`.
**Quirks**: three sidebar test files mock `lucide-react` with a fixed icon list, so a new icon import in `Sidebar.jsx` breaks them; the menu entry reuses `FolderTree`. The global JSON parser in `server/index.js` skips these paths so the router's own 4 KB limit applies.
**Next**: Phase 3. Read `server/ws-handler.js`, `client/src/components/Terminal.jsx`, `TerminalArea.jsx`, `TerminalTabBar.jsx` and `client/src/utils/terminalPaneCwd.js` first.
