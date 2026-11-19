# Multi-repository Tasks

**Spec**: `docs/specifications/multi-repository-tasks.md`
**Status**: Built, merged into `main` (`793fee5`) and running on the live instance. Not pushed
**Last completed**: Phase 7: Phone, Documentation and Final Verification (the live check and the migration check on a copy of the live database wait for the owner's go-ahead)
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
- [x] With the owner's go-ahead only: run the migration against a copy of `~/.codedeck.db` and record the row counts before and after

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

- [x] `server/pipelines/run-worktree.js`: `planTaskFolder({ taskId, title, ownHomePath, repositories })` returns the task folder and one path and branch per repository; `planNames` is unchanged for a project without other repositories (Spec §3.3)
- [x] `server/tasks/task-service.js`: `plan` takes `repositories` (first is where the task starts; absent means the own repository) and runs the Git check for each; it changes nothing (Spec §3.2)
- [x] `server/tasks/task-service.js`: `createPlanned` creates the worktrees one after another; when one fails, the ones made for this task are removed without force and their branches deleted with `git branch -d`; the error names the repository; when the undo is refused the task is kept with what exists (Spec §3.2)
- [x] `server/routes/tasks.js`: `POST /api/tasks` accepts `repositories`; `POST /api/tasks/:id/terminals` accepts `{ worktreeId }`; both stay valid without the new fields (Spec §7)
- [x] `server/tasks/task-landing.js`: Close task checks every open worktree first, closes all or none, reports a removal refused midway, and removes the empty task folder with a plain `rmdir` (Spec §3.5, §3.3)
- [x] `server/tasks/task-terminals.js`: closes terminals by any of the task's worktree paths
- [x] `client/src/utils/tasksApi.js`: `parseTask` reads `worktrees` and `folder` with a guard per field; `createTask` and `openTaskTerminal` take the new fields
- [x] `client/src/components/tasks/NewTaskDialog.jsx`: the project's repositories as checkboxes when it has others; unchanged otherwise
- [x] `client/src/utils/worktreeGroups.js`: a path that is any worktree of a task belongs to that task's group; the group key is the task id; groups carry their worktrees (Spec §3.6)
- [x] `client/src/components/TerminalArea.jsx`, `TerminalTabBar.jsx`: new terminal, split and Cmd/Ctrl+Shift+T open in the active pane's repository; "+" offers the task's open repositories; the repository's name on tabs and pane headers of a task with several worktrees
- [x] `client/src/components/WorktreeGroupHeader.jsx`: tooltip lists each repository's folder, branch and path
- [x] Main reaches every repository (Spec §3.6, §10 answer 5). Done for terminals through `POST /api/projects/:name/terminals`; a run in Main starting in another repository is in Phase 5. Read first how a Main terminal gets its directory today (`server/ws-handler.js`, `client/src/components/Terminal.jsx`, `client/src/utils/terminalPaneCwd.js`). Then: the backend accepts a Main terminal only in the checkout of one of the project's repositories; "+" in Main offers them; such a terminal belongs to the Main group in `worktreeGroups.js` and shows the repository's name on its tab

## Phase 4: Landing per Repository
> Status, commit, merge and close for one repository of a task, and a task that finishes with its last repository.
> **Inputs:** Phase 3
> **Outputs:** landing functions that take a task worktree; the worktree endpoints; one bar row per repository
> **Closed when:** in a task with two repositories one can be committed and merged while the other is dirty, the task stays open until the second is merged or closed, and a task with one worktree lands exactly as before

- [x] `server/tasks/task-landing.js`: `inspect(taskId, worktreeId)` reads the worktree's path, branch and base, and its repository's checkout and remotes; messages name the repository when the task has several; red tests for each blocker per repository (Spec §3.5)
- [x] `server/tasks/task-landing.js`: `commit`, `merge`, `close` per worktree; a working run blocks every worktree of its task; finishing one worktree closes its terminals and releases a finished run that worked in it; the task finishes with its last worktree (`merged` if any was merged, else `closed`)
- [x] `server/index.js`: `onTaskFinished` and a per-worktree release of runs; `closeTerminals` per worktree
- [x] `server/routes/tasks.js`: `GET /api/tasks/:id/worktrees` (paged, with landing status) and `POST /api/tasks/:id/worktrees/:worktreeId/commit`, `/merge`, `/close`; the task-level endpoints keep acting on the first worktree; six test dimensions each (Spec §7)
- [x] `client/src/utils/tasksApi.js`: the worktree landing calls with validated responses
- [x] `client/src/components/tasks/TaskLandingBar.jsx`: one row per repository with its facts and buttons; refusals and conflicts shown on the row they belong to; a task with one worktree in a project without other repositories renders as today (existing tests unchanged)

## Phase 5: Runs Across Repositories
> A run starts in one of the task's repositories and is told about the others.
> **Inputs:** Phase 4
> **Outputs:** `startIn` and `newTask.repositories` on run start; guidance, notes and Setup that cover every repository; the Run dialog
> **Closed when:** a run started in `mobile-app` of a task that also has `backend` has `mobile-app` as its directory, finds its progress file there, is told it may change `backend`, and its Setup prepares both; a run in a project without other repositories gets today's guidance character for character

- [x] `shared/pipeline-definitions.mjs`: the start body accepts `startIn` and `newTask.repositories`; red tests for each field (Spec §7)
- [x] `server/routes/pipelines.js` `POST /runs`: the run's worktree is the task's worktree in `startIn`; the progress file of a new task is checked in that repository's checkout; a task with another unfinished run is refused; the request replay check covers the new fields (Spec §3.4)
- [x] `server/routes/pipelines.js`: when the progress path made from the input is absolute and inside one of the project's repositories, the refusal names the repository and the relative path to type
- [x] `server/pipelines/step-guidance.js`: the worktree sentence for a task with several worktrees or a project with other repositories; the read-only sentence over all worktrees; today's sentence unchanged otherwise (Spec §3.4)
- [x] `server/terminal-workflow.js`: guidance limit 4000; `server/routes/pipelines.js`: the refusal for guidance that is still too long names the repositories
- [x] `server/pipelines/run-notes.js`: `buildReadme` gets the "Repositories" section
- [x] `server/pipelines/run-worktree.js`: `buildSetupPrompt` takes a list of home checkout and worktree pairs; `server/pipelines/run-engine.js`: the guard after Setup checks every worktree of the task and names the dirty one; guidance and notes read the task's places at each step start through a `listTaskPlaces` dependency wired in `server/index.js`
- [ ] `server/routes/pipelines.js`: `GET /worktrees` accepts `repository`; the prompt preview shows placeholder repositories (not built; see Deviations)
- [x] `client/src/components/pipelines/RunWorkflowDialog.jsx`, `client/src/utils/pipelinesApi.js`: for a new task, repository checkboxes and "Start in"; for an open task, "Start in" among its open worktrees
- [x] `server/routes/pipelines.js` and `RunWorkflowDialog.jsx`: a run in Main may start in the own checkout of any of the project's repositories; it writes there only, the others are named as readable, and it has no Setup (Spec §3.4)
- [x] `client/src/components/tasks/TaskView.jsx`: the header names the repository the run works in when the task has several; "Open a terminal here" opens in the run's worktree

## Phase 6: Adding a Repository, and Pull Requests per Repository
> What a task needs after it has started: one more repository, and a pull request for each.
> **Inputs:** Phase 5
> **Outputs:** `POST /api/tasks/:id/worktrees`; `POST …/worktrees/:worktreeId/pull-request`; the bar's Add repository
> **Closed when:** a run that stopped for lack of `backend` continues after the owner adds it from the bar, and each repository of a task can have its own pull request

- [x] `server/tasks/task-service.js`: `addRepository(taskId, repository)`; refused while a run of the task is `pending` or `running`, for a finished task, for a repository already in the task, and for one that was merged or closed in it (Spec §3.2)
- [x] `server/routes/tasks.js`: `POST /api/tasks/:id/worktrees` with the six test dimensions; a repeated request does not make a second worktree
- [x] `server/tasks/task-landing.js`: `pullRequest` per worktree with that repository's remotes; the worktree's own `pr_url`; the task shows `pr_open` while any open worktree has one
- [x] `server/routes/tasks.js`: `POST /api/tasks/:id/worktrees/:worktreeId/pull-request`
- [x] `client/src/components/tasks/TaskLandingBar.jsx`: Add repository (lists the project's repositories not in the task, says that no Setup runs for it); Open a pull request and its link on each row

## Phase 7: Phone, Documentation and Final Verification
> **Inputs:** Phases 1–6
> **Outputs:** the phone's task screen; README and steering files; a verified whole
> **Closed when:** both suites and the client build pass, the documents describe what was built, and the owner has seen a task across two repositories created, run and landed

- [x] `client/src/mobile/TaskScreen.jsx`: lists the task's repositories and where the run works; `client/src/mobile/nowView.js` rows unchanged
- [x] `README.md` (Tasks, Workflow pipelines), `docs/steering/product.md`, `docs/steering/structure.md`, `docs/steering/api-standards.md`: describe repositories of a project, tasks across them, landing per repository
- [x] Full server suite, full client suite, `cd client && npx vite build`
- [ ] Live check with the owner's go-ahead: link the repositories of one group project, create a task in two of them, run a workflow that starts in the second, commit and merge each, close the task. Read the memory note on why a worktree cannot run a second full instance before choosing how to do this
- [x] Record what was left for a later release: dropping the old `tasks` columns (Spec §6, §8); see the last session note

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

### Session — 2026-11-19 (Phases 3 and 4)
**Completed**: Phases 3 and 4, commits `e20af13`, `80880fb`, `7dbe3bb`, `c81b640`, `8843527`. The server halves of the two phases were built together, because Close task over several worktrees needs each worktree inspected on its own.
**Server**: `planTaskFolder`; `task-service.js` plans and creates one worktree per repository with undo; `task-landing.js` acts on one worktree (`status`, `worktrees`, `commit`, `merge`, `pullRequest`, `closeWorktree`, `close`); `task-terminals.js` closes one worktree's terminals or the task's; `routes/tasks.js` adds `GET /:id/worktrees` and `POST /:id/worktrees/:worktreeId/commit|merge|pull-request|close`; `POST /api/projects/:name/terminals`.
**Client**: `parseTask` with `folder` and `worktrees`; `parseTaskSummary` for the phone; grouping by task and by project repositories; the repository chooser and tab label in `TerminalArea.jsx`; `NewTaskDialog.jsx` with checkboxes; `TaskRepositoriesLanding.jsx`.
**Evidence**: `cd client && npx vitest run --maxWorkers=1` → Test Files 85 passed, Tests 1559 passed; `npx vite build` → built. Server: the task and project files pass (`task-*.test.js`, `tasks-api.test.js`, `project-repositories*.test.js`, `pipelines-api.test.js`); the full server suite result is recorded in the next session note.
**Key decisions**: a merged branch is deleted from the checkout it was merged into (Git deletes a branch only when it is merged into the branch checked out where it is asked; with a checkout that is a worktree, asking in the home repository kept the branch); a worktree-creation failure of a task with one worktree is reported as before, with several it is a 409 that names the repository.
**Quirks**:
- In component tests, `mockRejectedValue` on a hoisted mock that `beforeEach` resets failed the test with the rejection itself; `mockRejectedValueOnce` does not. Seen in `NewTaskDialog.test.jsx`.
- A fixture with three repositories and a worktree takes a few seconds; `task-service-repositories.test.js` and `task-landing-repositories.test.js` set a 30 s timeout.
- `findProject` given to the task service must return a stored project with `repositories` (as `loadProjects` does); test projects need `repositories: []`.

### Deviations
- **[Phase 3 / group key] — a task's group keeps a path as its key**
  - **Planned**: the group key becomes the task id (Spec §3.6).
  - **Found**: `TerminalArea.jsx` uses the key as a path in many places and stores it in `localStorage`.
  - **Did**: the key of a task's group is the path of the worktree it started in, which a task always reports; every other worktree path of the task resolves to it (`groupKeyForPath` in `worktreeGroups.js`). Stored selections stay valid.
  - **Follow-up**: none.
- **[Phase 3 / Main terminals] — an endpoint instead of a check on the terminal socket**
  - **Planned**: the backend accepts a Main terminal only in a checkout of one of the project's repositories.
  - **Found**: the terminal socket accepts any absolute directory today (`server/ws-handler.js:914-921`) and other features rely on it.
  - **Did**: a terminal in another repository is opened by `POST /api/projects/:name/terminals`, which accepts only the project's repositories; the socket is unchanged.
  - **Follow-up**: none.
- **[Phase 3 / pane header] — the repository name is on the tab only**
  - **Planned**: tab and pane header both name the repository.
  - **Found**: the pane header already shows the terminal's directory.
  - **Did**: the label is on the tab.
  - **Follow-up**: add it to the pane header if the owner misses it.
- **[Phase 4 / phone] — the phone reads tasks with `parseTaskSummary`**
  - **Planned**: `parseTask` reads `worktrees` everywhere.
  - **Found**: a phone build is installed separately and also talks to an instance older than itself.
  - **Did**: the phone keeps reading the fields every backend release sends; the desktop requires `folder` and `worktrees`.
  - **Follow-up**: Phase 7 shows a task's repositories on the phone when the instance sends them.

### Session — 2026-11-19 (Phases 5, 6 and 7)
**Completed**: Phase 5 (`220aa54`), Phase 6 (`428cbde`), Phase 7 apart from the live check.
**Server**: `validateRunStartBody` takes `startIn` and `newTask.repositories`; `POST /runs` starts in the repository named, refuses a second unfinished run in a task (`task_in_use`), looks for a new task's progress file in the checkout of the repository it starts in, and answers a full path inside one of the project's repositories with the repository to start in; `step-guidance.js` names the task's worktrees and the project's other repositories; `run-places.js` reads them when a step starts; `run-notes.js` adds the Repositories section; `buildSetupPromptForRepositories`; the Setup guard checks every worktree; guidance limit 4000; `taskService.addRepository` and `POST /api/tasks/:id/worktrees`.
**Client**: Start in and the repository ticks in `RunWorkflowDialog.jsx`; the task view names the repository a run works in; `AddRepositoryDialog.jsx` and the Add repository button on both landing bars; the phone's task screen lists a task's repositories (`parseTaskForPhone`, `nowView.js`, `TaskScreen.jsx`).
**Evidence**: Node v22.22.0. Before Phase 6: `cd server && npx vitest run --maxWorkers=1` → Test Files 1 failed | 96 passed (97), Tests 8 failed | 2996 passed (3004); the 8 are the live-tmux tests of `pipeline-run-live.test.js` that fail without this work (Phase 1 note). `cd client && npx vitest run --maxWorkers=1` → Test Files 86 passed, Tests 1581 passed. `cd client && npx vite build` → built. After Phase 6 and the phone work: `cd server && npx vitest run --maxWorkers=1` → Test Files 1 failed | 96 passed (97), Tests 8 failed | 3016 passed (3024), the same 8 live-tmux tests.
**Bug found and fixed**: worktrees recorded in the same millisecond were read in the order of their random ids. They are now read in the order they were written (`rowid`); `task-store.test.js` has a test with a clock that does not move.
**Not done**:
- The live check (Phase 7) and the migration check against a copy of `~/.codedeck.db` (Phase 1): both need the owner's go-ahead.
- Nothing is merged into `main` and nothing was run against the live instance.
- Left for a later release: dropping `worktree_path`, `branch`, `base_branch`, `base_commit` and `pr_url` from `tasks` (kept filled for one release).
**Next**: the owner's go-ahead for the live check; then merge.

### Deviations
- **[Phase 5 / `GET /worktrees?repository=`] — not built**
  - **Planned**: the Run dialog asks whether a task's worktree in another repository can take a run.
  - **Found**: the start request already refuses such a worktree with the reason.
  - **Did**: for a task that started in another repository the dialog offers it and the backend answers; no filter was added.
  - **Follow-up**: add the filter if the owner wants the option greyed out before starting.
- **[Phase 5 / prompt preview] — unchanged**
  - **Planned**: the workflow builder's preview shows placeholder repositories.
  - **Found**: the preview has no project, so it cannot know whether there are several.
  - **Did**: the preview shows the sentence of a run with one repository, as before.
  - **Follow-up**: none unless the owner asks.
- **[Phase 6 / `isRunWorking`] — a required dependency of the task service**
  - **Planned**: `addRepository` is refused while a run is pending or running.
  - **Found**: the service had no way to know about runs.
  - **Did**: `createTaskService` takes `isRunWorking`; `server/index.js` reads the run store.
  - **Follow-up**: none.
- **[Phase 7 / phone] — `parseTaskForPhone`**
  - **Planned**: the phone lists a task's repositories.
  - **Found**: an installed phone build also talks to an instance that does not send them.
  - **Did**: `worktrees` is null when the instance does not say, and checked when it does; the list appears only for a task with several.
  - **Follow-up**: none.

### Session — 2026-11-19 (migration on a copy of the live database; `main` has moved)
**Completed**: the migration check of Phase 1, with the owner's go-ahead ("Yes, try it").
**How**: the live `~/.codedeck.db` was copied with SQLite's backup through a read-only connection into the session scratchpad; the live file's size and modification time were the same afterwards. `createTaskStore` was then run on the copy with `findProject` reading the copy's own `projects`.
**Evidence** (Node v22.22.0, branch tip `396cd50`):
- Before: 12 `tasks` rows (6 `closed`, 6 `merged`), naming 3 projects, all 3 still stored; 86 projects stored; no `task_worktrees` table; index `tasks_open_worktree` present.
- A start without `findProject` stopped with `tasks: findProject is required to carry over stored tasks` and left the copy as it was: no `task_worktrees` table, the old index still there.
- The migration took 1 ms and wrote 12 `task_worktrees` rows (6 `closed`, 6 `merged`). The 14 old columns of every `tasks` row were byte for byte what they had been; `tasks_open_worktree` was gone and `task_folder` was there.
- All 12 tasks read back through the store with one worktree each, first and own, carrying the task's path, branch, base branch, base commit, state, pull request address and times: 0 mismatches. Each repository was named after its project's folder.
- A second start changed nothing; `PRAGMA integrity_check` answered `ok` before and after.
**Not covered by this check**: the live database holds no open task at the moment, so `active` and `pr_open` rows were migrated only in the fixture tests of `task-store.test.js`.

**`main` has moved.** `git log 26380fc..main`: `3d1a8d1` (pipeline starts reserved once, replay by original parameters, the task row written before Git), `778f776` and `dbcdd5c` (closing a task: a copied settings folder, build output in `target`), and the merge `d9f7c2d`. `git merge-tree --write-tree HEAD main` reports conflicts in `server/tasks/task-store.js`, `task-service.js`, `task-landing.js`, `server/routes/pipelines.js`, `shared/pipeline-definitions.mjs`, their three test files and `docs/steering/api-standards.md`.
**What that means for this work**:
- `3d1a8d1` writes the task row first and creates the worktree at the recorded commit, removing the row again if no folder was made (`taskStore.remove`). Creating several worktrees here still creates them first and records them after; it must follow the new order, row by row, with the same undo.
- `POST /runs` on `main` reserves a request before its first wait (`server/pipelines/request-store.js`) and compares a replay with the parameters it recorded; the new `startIn` and `newTask.repositories` have to be part of what is recorded.
- The two closing fixes change the ignored-files guard that `task-landing.js` here applies per worktree.
**Next**: merge `main` into this branch, resolve the nine files, run both suites again. Only then the live check and the merge into `main`.

### Session — 2026-11-19 (`main` merged in; an input typed as the progress file's whole path)
**Completed**: the merge of `main` (`dbcdd5c`) into this branch, with the owner's go-ahead ("Yes, update it"), as `ba8867b`; then, at the owner's request ("make it work, be flexible"), a run start that accepts the progress file's whole path as its input.
**How the nine conflicts were settled**:
- `task-store.js`: `create` takes the first worktree and an optional list of the others and writes the task and all its worktree rows in one transaction. `remove(id)` deletes a task that is still active at revision 1, with its worktree rows; `removeWorktree(id, worktreeId)` deletes an active worktree that is not the first.
- `task-service.js`: rows first, then Git, as `3d1a8d1` does for one worktree. Every worktree is created at the commit recorded for it. When one fails the earlier ones are taken back; no folder left removes the row; a refused undo keeps the task with the copies on disk and removes the rows of the others (not the first one's). `addRepository` records before Git and removes the row when Git left no folder.
- `task-landing.js`: `sameFolder` and `sameFile` of `778f776` compare a worktree with the checkout it is listed with; `target` is disposable.
- `routes/pipelines.js`: the reservation and replay of `3d1a8d1` around the start in a repository. A start interrupted after its task was recorded is finished in that task, in the repository named, with Setup for each of its open repositories.
- `request-store.js`: `startIn` and `newTask.repositories` are part of the recorded parameters, written only when sent, so a request recorded on `main` reads the same.
**The whole path as input**: `inputFromProgressFilePath` in `shared/pipeline-definitions.mjs`; `POST /runs` looks for the file as composed first, then for the input itself as the path, and records the run with the part that replaces `{input}`. The file as typed wins when both exist; the refusal names both paths when neither does. A full path from disk is still refused, as before.
**Evidence** (Node v22.22.0):
- On the merge `ba8867b`: server `npx vitest run --maxWorkers=1` → 3076 passed, 5 failed, all in `pipeline-run-live.test.js` (live tmux; the same file failed 8 tests with `server/` at `603362f`, before any of this; the 5 were not rerun on `main`'s tip). Client → 86 files, 1581 passed; `npx vite build` built.
- With the whole-path input: `pipeline-definitions.test.js` and `pipelines-api.test.js` → 434 passed; client → 86 files, 1581 passed; `npx vite build` built. Full server suite → 3096 passed, 5 failed, the same 5 live-tmux tests as on the merge.
**Not done**: the live check, the merge into `main` and a push, all waiting for the owner. The changelog has no entry for multi-repository tasks themselves yet; it belongs with shipping.

### Session — 2026-11-19 (merged into `main`; first look at the live instance)
**Completed**: the merge into `main`, with the owner's go-ahead ("Yes, merge it"), as `793fee5`.
**Before**: the main checkout was clean and on `main` at `dbcdd5c`; the live instance had no open run and no open task; the live database was copied to `~/.codedeck.db.before-multi-repository-2026-11-19` (integrity `ok`, 12 tasks, old index present).
**Evidence after the reload**:
- The backend log shows one `Restarting 'index.js'`, then `[companion] phone access is on through …; push notifications are configured` and `CodeDeck server running on http://localhost:43001`; `./server.sh status` reports backend and frontend listening.
- The live database has `task_worktrees` with 12 rows (6 `closed`, 6 `merged`) and no `tasks_open_worktree` index; `GET /api/tasks?size=50` returns 12 tasks, each with one worktree that is first, own, and carries the task's path and state.
- `GET /api/projects/mlondolozi/repositories` → 200 with `backend` (own); `GET …/repository-candidates` → 200 with `frontend` and `mobile-app`. The Repositories dialog opened in the running app and showed the same; nothing was added.
**Not checked live**: adding a repository, a task across repositories, landing per repository, a run with `startIn`, and the phone. They are covered by the suites only. Nothing was pushed.
**Worth knowing**: the dialog offers a repository's home folder. Where the home is on a feature branch and `main` lives in a `<repo>-main` worktree (mlondolozi's `frontend` is on `feat/whatsapp-setup`, `main` is in `worktrees/frontend-main`), add that worktree with **Add another folder…** instead, because tasks start from and merge into the folder listed.
