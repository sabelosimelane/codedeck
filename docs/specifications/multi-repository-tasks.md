# Multi-repository tasks: design proposal

**Date:** 2026-11-19
**Status:** Proposal. No code has been changed. Waiting for the owner's decision on the open questions in §9.
**Read at:** commit `26380fc` of this repository. Every file and line cited below was read at that commit.

## 1. Summary

Today a CodeDeck project is one Git repository, a task owns one worktree and one branch of it, and a
workflow run is told to change files only in that one worktree. Work that spans sibling repositories
(`backend`, `frontend`, `mobile-app`) cannot be done in one task.

Recommended design, in five sentences:

1. A project keeps its own repository (its path, unchanged) and may **name related repositories**.
   Existing projects need no change.
2. A task owns **one worktree and one branch per repository it includes**: the project's own
   repository always, and the related ones ticked when the task is created.
3. A run still has **one working directory**, which is one of the task's worktrees, chosen when the
   run starts. Notes, the brief and the progress file stay relative to it. The step guidance names
   the task's other worktrees as places the agent may also change.
4. **Landing is per repository**: status, commit, merge, pull request and close each act on one
   repository. The task is finished when its last repository is merged or closed. Nothing is forced
   and nothing is atomic across repositories.
5. The first slice leaves out pull requests for related repositories, adding a repository to an open
   task, and phone changes (§7).

## 2. What happens today

### 2.1 Projects

- Projects are a JSON list stored under the config key `projects` (`server/index.js:134-140`). A
  stored project is `{ name, path }` plus `host` for a remote one (`server/routes/projects.js:131-134`).
- Tasks and runs require the project path to be the top level of a Git working tree. The check is
  `preflight` (`server/pipelines/run-worktree.js:138-146`, reason `not_git_toplevel`), called when a
  task is planned (`server/tasks/task-service.js:48-53`) and when a run starts
  (`server/routes/pipelines.js:690-709`, `:847`).
- Tasks are refused for remote projects (`server/tasks/task-service.js:36`).

### 2.2 Tasks

- A `tasks` row holds exactly one `worktree_path`, `branch`, `base_branch`, `base_commit`, `pr_url`
  and `state` (`server/tasks/task-store.js:98-113`). A partial unique index allows one open task per
  worktree path (`:114-115`). The states are `active`, `pr_open`, `merged`, `closed` (`:10`), and
  `finished_at` is set exactly when the task is finished (`:72`).
- A task's folder and branch are named by `planNames`: the folder is
  `<parent of the home repository>/worktrees/<home folder>-<slug>-<first 8 hex of the id>` and the
  branch is `task/<slug>-<same 8 hex>` (`server/pipelines/run-worktree.js:46-59`, called from
  `server/tasks/task-service.js:58-60`). This is already the layout `worktrees/<repo>-<purpose>`.
- The worktree starts from the HEAD commit of the project path (`run-worktree.js:193-196`) and
  records that checkout's current branch as its base branch (`run-worktree.js:149-154`,
  `task-service.js:70`).
- Worktree creations run one at a time (`task-service.js:106-114`).
- A terminal for a task opens in `task.worktreePath` (`task-service.js:131-145`); the endpoint takes
  no body (`server/routes/tasks.js:91-94`).

### 2.3 Terminals

- A session may start in any absolute directory: `resolveStartCwd` checks only that `cwd` is an
  absolute path (`server/mobile-session-start.js:10-22`). There is no rule that it is inside the
  project.
- A session started outside the project path is recorded with its directory in
  `terminal_session_worktree` (`server/terminal-session-worktree-start.js:13-17`,
  `server/terminal-session-worktree-store.js:23`).
- Session ids are `<project name>-N` whatever directory they start in
  (`server/mobile-session-start.js:50-53`).

### 2.4 Workflow runs

- A run has one `worktreePath` and one `worktreeBranch` (`server/routes/pipelines.js:944-966`). It
  works in a new worktree of its own, a worktree named by path, an open task, or a task created for
  it (`:825-829`). Only a worktree CodeDeck has just created gets the Setup step (`:826`, `:904`).
- A worktree is refused when another open run that is not complete already uses the same path
  (`server/routes/pipelines.js:219-227`).
- The engine starts each step's terminal with `cwd: run.worktreePath`
  (`server/pipelines/run-engine.js:661-664`, `:675`), prepares the run notes in that worktree
  (`:631-632`), builds the step guidance at each step start (`:711`), and finds a terminal to reuse
  by project and worktree path (`:387-389`).
- The guidance sentence given to every node step is: work only inside the run's worktree, do not
  create, change or delete files outside it, reading outside is allowed when instructions refer to
  it, and if the task's own files are not in the worktree use NEEDS_INPUT instead of looking in other
  repositories (`server/pipelines/step-guidance.js:31`). A read-only step is told to change nothing
  in the worktree except its notes (`:34-36`).
- Guidance is limited to 2000 characters (`server/terminal-workflow.js:21-22`); a run whose guidance
  would be longer is refused at start (`server/routes/pipelines.js:907-911`). Measured with
  `buildStepGuidance` on a worst-case step (agents decide, read-only, sent back, closing a loop, an
  88-character worktree path): 1444 characters.
- The Setup prompt names one home checkout and one worktree (`server/pipelines/run-worktree.js:339-356`,
  composed at `server/routes/pipelines.js:326-336`). After Setup the engine fails the run if that one
  worktree has uncommitted changes (`server/pipelines/run-engine.js:231-244`).
- Run notes live in `.codedeck/runs/<first 8 hex of the run id>` (`server/routes/pipelines.js:906`)
  inside the run's worktree; every write checks that the folder has not left the worktree
  (`server/pipelines/run-notes.js:124-142`) and that Git ignores it (`:167-196`).
- A progress file is a relative `.md` path with no leading `/` and no `..`
  (`shared/pipeline-definitions.mjs:8-12`). It is resolved against the run's worktree
  (`server/pipelines/run-progress.js:51-65`, `:126-153`). At start it must be in the chosen worktree,
  or, for a new worktree, committed in the repository at the **project path**
  (`server/routes/pipelines.js:913-923`, `server/pipelines/run-worktree.js:101-106`).

### 2.5 Landing

- Status is read from Git for `task.worktreePath` and for the project path (Main): uncommitted
  files, commits ahead and behind, the checkout's branch, ignored files at risk, Main's branch and
  dirtiness, and the project's remotes (`server/tasks/task-landing.js:123-148`, `:81-90`).
- Blockers are computed per action (`:150-183`). Commit runs `git add --all` and `git commit` in the
  worktree (`:245-260`). Merge runs `git merge --no-edit <branch>` in the project path, aborts on
  conflict and lists the conflicting files (`:262-277`), then removes the worktree without force and
  deletes the branch with `git branch -d` only if removal succeeded (`:279-290`). Pull request pushes
  the branch and calls `gh` or `glab` (`:298-335`). Close removes a clean worktree and keeps the
  branch (`:337-350`).
- Finishing a task releases its runs (`server/index.js:905-909`) and closes its terminals: those
  recorded in its worktree path and those its runs used (`server/tasks/task-terminals.js:19-29`).
- A run counts as still working in a task while its status is `pending`, `running`, `needs_input`,
  `limit_paused` or `awaiting_approval` (`server/index.js:896`, `:903`).

### 2.6 Client and phone

- The client groups a project's terminals, runs and tasks by worktree path: a group key is `main` or
  a worktree path (`client/src/utils/worktreeGroups.js:126-133`), and each open task becomes the
  group of its `worktreePath` (`:170-182`). A group's title is the task title and its tooltip is the
  folder, branch and path (`:29-34`). The selected group is remembered per project in
  `localStorage` and falls back to Main when the stored key is no longer a group (`:55-58`).
- The landing bar shows one row of facts and buttons for the task (`client/src/components/tasks/TaskLandingBar.jsx:131-149`)
  and reads the landing status every five seconds (`:37-44`).
- The New task dialog asks for a title only (`client/src/components/tasks/NewTaskDialog.jsx:7-44`).
  The Run workflow dialog offers a new task, an open task or Main
  (`client/src/components/pipelines/RunWorkflowDialog.jsx:15`, `:96-98`, `:137-141`).
- The task record parser requires `worktreePath`, `branch`, `baseBranch`, `baseCommit` and `prUrl`
  on every task (`client/src/utils/tasksApi.js:9-31`). The phone uses the same parser
  (`client/src/mobile/runsApi.js:6`, `:56`) and names a run's row after its task's title
  (`client/src/mobile/nowView.js:49`). The phone's run and task API has no call to a landing
  endpoint (`client/src/mobile/runsApi.js:52-63`).

### 2.7 The owner's repositories (observed 2026-11-19, read-only)

`git worktree list` and `git rev-parse` in `/Users/sabside/git/mlondolozi`:

| Folder | Kind | Branch checked out |
| --- | --- | --- |
| `backend/` | repository | `main` |
| `frontend/` | repository | `feat/whatsapp-setup` |
| `mobile-app/` | repository | `main` |
| `worktrees/frontend-main` | worktree of `frontend` | `main` |
| `worktrees/backend-docs-todos-2026-11-17-182751-com-8ea2fe43` | worktree of `backend` | `task/docs-todos-…` |
| `worktrees/backend-users-sabside-git-mlondolozi-mob-b5c0667a` | worktree of `backend` | `task/users-sabside-git-mlondolozi-mob-b5c0667a` |

The last row is the worktree of the run described in the background: a copy of `backend`, named after
an input that was a path under `mobile-app`. A task's title is made from the run's input when none is
typed (`server/routes/pipelines.js:869`).

Two facts from this table shape the design. A repository's own folder is not always on its main
branch (`frontend/`), and the branch a task should start from may be checked out in a `<repo>-main`
worktree instead.

## 3. Recommended design

### 3.1 Declaring related repositories

A project gets an optional list of **related repositories**. The project's path stays what it is and
is called the project's **own repository** below.

```json
{ "name": "mlondolozi", "path": "/Users/sabside/git/mlondolozi/backend",
  "repositories": [
    { "name": "mobile-app", "path": "/Users/sabside/git/mlondolozi/mobile-app" },
    { "name": "frontend",   "path": "/Users/sabside/git/mlondolozi/worktrees/frontend-main" }
  ] }
```

Rules, each checked when an entry is added and failing with a field error:

- `name`: 1–40 characters, letters, digits, `.`, `_`, `-`, starting with a letter or digit; unique
  in the project. It defaults to the folder name of the repository the path belongs to.
- `path`: an absolute path that exists and passes the same Git check as a project path today (top
  level of a working tree). It is **the checkout a task starts from and merges into**, so it may be
  a `<repo>-main` worktree. Reading the code, this needs nothing new: `preflight` accepts any working
  tree's top level, `planNames` names the task folder after the home repository, and `create` takes
  HEAD of the given path (`run-worktree.js:138-146`, `:46-59`, `:193-196`, `:218-223`). For
  `worktrees/frontend-main`, `git rev-parse --show-toplevel` printed the worktree itself and
  `--git-common-dir` printed `frontend/.git`. I did not run a task against it.
- The path's repository (its Git common directory) must differ from the project's own and from every
  other entry's.
- Local projects only, as tasks are today.
- At most 4 related repositories per project (see the guidance budget in §3.3).

Existing single-repository projects: nothing changes. A project without the field has no related
repositories, and every dialog and bar renders as it does now.

Removing a repository from the list does not touch open tasks that have a worktree in it; each task
worktree records the checkout it came from (§5).

A repository may be related to several projects and may also be a project of its own.

**Files:** `server/project-config.js` (default `repositories: []`), a new
`server/project-repositories.js` (pure validation and the Git check), `server/routes/projects.js` or
a new `server/routes/project-repositories.js` (endpoints in §6), `client/src/components/Sidebar.jsx`
and a new dialog under `client/src/components/` (list, add with the directory browser, remove),
`client/src/App.jsx` (projects carry the list), `docs/steering/api-standards.md`.

### 3.2 What a task owns

- **One worktree and one branch per repository it includes.** The project's own repository is always
  included. Related repositories are ticked in the New task dialog and in the Run workflow dialog's
  "A new task"; none is ticked by default.
- **Where:** each worktree is created beside its own repository, as today:
  `<parent of that repository>/worktrees/<repository folder>-<slug>-<id8>`, on branch
  `task/<slug>-<id8>`. `planNames` uses only the task id and title for the suffix
  (`run-worktree.js:46-59`), so all of a task's folders and branches share one suffix:

  ```
  /Users/sabside/git/mlondolozi/worktrees/backend-whatsapp-replies-1a2b3c4d      task/whatsapp-replies-1a2b3c4d
  /Users/sabside/git/mlondolozi/worktrees/mobile-app-whatsapp-replies-1a2b3c4d   task/whatsapp-replies-1a2b3c4d
  ```

- **Start point:** each worktree starts from the HEAD commit and current branch of its repository's
  declared checkout, the same rule the project's own repository has today.
- **Creation:** all worktrees are planned first, which changes nothing, as `plan` does today
  (`task-service.js:40-72`). They are then created one after another. If one `git worktree add`
  fails, the ones already created for this task are removed again without force (they are new and
  clean) and their new branches deleted with `git branch -d`; the error names the repository that
  failed. If that undo is itself refused, the task is kept with the worktrees that exist and the
  message says which.
- **After creation the repositories are equal.** The own repository is special only in being always
  included. Each can be landed in any order.
- **Adding a repository later** (second slice): "Add repository" on an open task creates a worktree
  and branch in a related repository from its current commit. It is refused while a run is working in
  the task, and allowed while a run waits for input, so that "the files are in mobile-app" can be
  answered by adding it. No Setup runs for it.
- **Removing a repository from a task** is closing that worktree (§3.4).

**Files:** `server/tasks/task-store.js` (new table and store methods, §5),
`server/tasks/task-service.js` (`plan` and `createPlanned` per repository, `openTerminal` takes a
worktree), `server/routes/tasks.js` (§6), `client/src/components/tasks/NewTaskDialog.jsx`
(repository checkboxes), `client/src/utils/tasksApi.js` (parser gains `worktrees`),
`server/tasks/task-adoption.js` (`findOpenByWorktreePath` reads the new table; adoption itself stays
limited to the project's own repository, because it lists only that repository's worktrees,
`task-adoption.js:52-66`).

### 3.3 What a workflow run is told

**One working directory.** A run keeps a single `worktreePath`. In a task with several repositories
the owner chooses which repository the run **starts in**; the default is the project's own. That
worktree is the current directory of every step's terminal, the place of the run notes
(`.codedeck/runs/<id8>`), the brief and `plan.md`, and what the progress file path is relative to.
Nothing in the engine that reads `run.worktreePath` changes meaning.

This is what resolves the 2026-11-19 case: the task includes `mobile-app`, the run starts in
`mobile-app`, the progress file `docs/todos/<file>.md` is found there, and the agent may still change
`backend`.

**Start checks.**

- The progress file of a run in a new task must be committed in the checkout of the repository the
  run starts in, not in the project path (today `server/routes/pipelines.js:914-916`).
- A task takes one unfinished run at a time, whichever worktree it starts in. Today the refusal is
  per worktree path (`pipelines.js:219-227`); two runs in two worktrees of one task could otherwise
  change the same files.
- Runs in Main and in a worktree named by path stay single-repository.

**Step guidance.** For a task with other open worktrees the first sentence (`step-guidance.js:31`)
becomes, with the list read from the task at each step start:

> Work only inside this task's worktrees. Your current directory is `<path>`, the worktree of
> `<repository>`. This task also has a worktree of `<repository>` at `<path>` [and of … at …]; you may
> create, change and delete files there too. Each is a separate Git repository on its own branch: run
> Git inside the worktree it concerns, commit each separately and switch no branch. Do not create,
> change or delete files anywhere else. Where a document refers to one of these repositories by
> another path, use its worktree here. If the files of the task are in none of these worktrees, do
> not look for them elsewhere: use NEEDS_INPUT and say what is missing.

A read-only step is told to change nothing in any of the task's worktrees except its notes folder. A
task with one repository gets today's sentence unchanged.

The list is read live, not kept in the run's definition snapshot, so a worktree that was closed
before a Resume is not named, and one added later (second slice) is.

**Guidance budget.** Today's worst case is 1444 of 2000 characters (§2.4). Each extra worktree adds
about 110 characters with the owner's path lengths, and the new sentences about 300. Four related
repositories do not fit in 2000. Recommended: raise the limit in `server/terminal-workflow.js:21` to
3000 and keep refusing a run whose guidance is longer (`pipelines.js:910`), naming the repositories
in the message.

**Run notes.** `README.md` in the notes folder gains a "Repositories" section: each repository's
name, worktree path, branch and the checkout it started from (`run-notes.js:103-114`). No `.codedeck`
folder is created in the other worktrees.

**Setup.** For a task created for the run, the Setup prompt lists every pair of home checkout and
worktree and applies its existing rules to each (`run-worktree.js:339-356`). The guard after Setup
checks every worktree of the task and names the repository whose worktree is not clean
(`run-engine.js:231-244`).

**Files:** `server/pipelines/step-guidance.js`, `server/terminal-workflow.js` (limit),
`server/pipelines/run-worktree.js` (`buildSetupPrompt` takes a list), `server/pipelines/run-notes.js`
(`buildReadme`), `server/pipelines/run-engine.js` (a `listTaskWorktrees` dependency for guidance and
the Setup guard), `server/index.js` (wiring), `server/routes/pipelines.js` (`POST /runs`: repositories
of a new task, `startIn`, the progress file check, one run per task; the prompt preview at `:599-633`
gets placeholder worktrees), `shared/pipeline-definitions.mjs` (start body validation),
`client/src/components/pipelines/RunWorkflowDialog.jsx` (checkboxes and "Start in"),
`client/src/utils/pipelinesApi.js`.

### 3.4 Landing per repository

Every repository of a task has its own state: `active`, `pr_open`, `merged` or `closed`. Everything
`inspect` reads today (§2.5) is read per repository, with that repository's worktree, branch, base
branch and declared checkout in place of the task's and the project path.

| Action | Acts on | Unchanged rule |
| --- | --- | --- |
| Status | one repository | read from Git when asked, never stored |
| Commit changes | one worktree | own message per repository |
| Merge into `<base>` | one repository, in its declared checkout | that checkout must be clean and on the base branch; a conflict is aborted and its files listed; then the worktree is removed without force and the merged branch deleted |
| Open a pull request | one repository, with its own remotes | pushes that branch only; asks first |
| Close | one repository | refused with uncommitted changes, a switched branch or ignored files at risk; the branch is kept |

Rules for a task with several repositories:

- **One clean, one not.** Each repository's buttons follow its own blockers. A clean, committed
  `backend` can be merged while `mobile-app` still has uncommitted files. The messages name the
  repository ("mobile-app's checkout is on `feat/x`, but this task started from `main`").
- **A working run blocks every repository of its task**, because it may be writing in any of them.
- **The task stays open until its last repository is merged or closed.** It then becomes `merged`
  if any repository was merged, otherwise `closed`. While open it shows `pr_open` if any open
  repository has a pull request, otherwise `active`.
- **Finishing one repository** closes the terminals in that worktree and releases a finished run
  that worked in it, the way finishing the task does today. The rest of the task is untouched.
- **Close task** closes every open repository. All are checked first; if any is blocked, nothing is
  closed and the refusal lists each blocking repository with its reason. If a removal is refused
  after the checks passed, the ones already closed stay closed, the task stays open, and the result
  says which.
- **No "merge all", and nothing atomic.** Git has no transaction across repositories. The bar shows
  exactly which repositories are merged and which are not.

**Files:** `server/tasks/task-landing.js` (`inspect`, `commit`, `merge`, `pullRequest`, `close` take
a task worktree; `finish` per worktree and per task), `server/tasks/task-terminals.js` (close by one
worktree path), `server/index.js` (`onTaskFinished` and a per-worktree release),
`server/routes/tasks.js` (§6), `client/src/components/tasks/TaskLandingBar.jsx` (one row per
repository), `client/src/utils/tasksApi.js`.

### 3.5 Terminals, sidebar, task view and phone

A task stays **one thing** on screen. Its repositories are detail inside it.

- **Grouping.** A terminal, run or path that belongs to any worktree of a task is grouped under that
  task. The group key becomes the task id for tasks and stays the path for a worktree without a task
  (`worktreeGroups.js:126-133`, `:170-182`). A stored selection that used a path falls back to Main
  once, as an unknown key does today (`:55-58`).
- **Terminals.** In a task with several repositories, a new terminal, a split and Cmd/Ctrl+Shift+T
  open in the repository of the active pane; the "+" button offers the task's open repositories.
  Each tab and pane header of such a task shows the repository's name, because session ids keep the
  project's name (`backend-7` may be a terminal in `mobile-app`). Single-repository tasks look as
  they do now.
- **Sidebar and switcher.** One row per task, as now (`client/src/components/WorktreeGroupHeader.jsx:5-28`).
  The tooltip lists each repository's folder, branch and path.
- **Landing bar.** The task's title and Rename, then one row per repository with its name, its facts
  and its buttons, then Close task. A task with one repository renders exactly as today.
- **Task view.** The header says which repository the run works in when the task has more than one.
  "Open a terminal here" on a step opens in the run's worktree. Steps, notes, questions and approvals
  are unchanged (`client/src/components/tasks/TaskView.jsx:177-236`).
- **Phone.** No change in the first slice. A run row is still named after its task
  (`mobile/nowView.js:49`), and the task record keeps the fields the phone's parser requires (§6).
  Second slice: the task screen lists the repositories and where the run works.

**Files:** `client/src/utils/worktreeGroups.js`, `client/src/App.jsx` (`:102-119`),
`client/src/components/TerminalArea.jsx` (`:689`, `:765-770`, `:1172-1179`, `:1433`),
`client/src/components/TerminalTabBar.jsx`, `client/src/components/WorktreeGroupHeader.jsx`,
`client/src/components/tasks/TaskLandingBar.jsx`, `client/src/components/tasks/TaskView.jsx`; second
slice `client/src/mobile/TaskScreen.jsx`. I read `TerminalArea.jsx`, `App.jsx` and `Sidebar.jsx` only
at the lines a search for tasks and worktree paths returned, and did not read `MobileApp.jsx` or
`TerminalTabBar.jsx`; their part of this list is an estimate.

## 4. Rejected alternatives

| Alternative | Why not |
| --- | --- |
| **A project that is a folder of repositories** (`/Users/sabside/git/mlondolozi`) | The project path is assumed to be a Git top level and to be Main in every layer: preflight (`run-worktree.js:144-146`), merge (`task-landing.js:267`), the Main group (`worktreeGroups.js:126`), the default terminal directory (`mobile-session-start.js:11`). Existing projects would have to be converted. It can come later as a shortcut that fills the related list from a folder. |
| **Linking separate CodeDeck projects** so a task spans projects | Sessions, tasks and runs are keyed and filtered by one project name (`mobile-session-start.js:50-53`, `task-store.js:100`, `pipelines.js:800`). One task would have to appear under several projects, and every related repository would have to be a project in the sidebar. |
| **One task per repository with a link between them** | Nothing is shared: a run still has one worktree and the guidance still forbids the other. It is today's situation with a label. |
| **One folder per task** (`worktrees/<task>/backend`, `worktrees/<task>/mobile-app`) | It would keep `../mobile-app` references working inside a task, but it contradicts the owner's naming rule `worktrees/<repo>-<purpose>` and what `planNames` already produces. Listed as open question 2 because the benefit is real. |
| **Letting a step change the sibling repositories' own checkouts** | No isolation: two tasks would write in the same `mobile-app` folder, and there would be nothing to land or close. |
| **A task in one repository of the owner's choice** (related or own, still one worktree) | Smaller, but it gives little that adding `mobile-app` as a project does not, and it does not let one run change two repositories. |
| **One run per repository, coordinated** | Agents would need a protocol to hand work across runs. One run with several writable worktrees needs none. |
| **Merge all as one action** | Not atomic. A failure halfway leaves some repositories merged; undoing a merge is forcing. |
| **Submodules or a meta-repository** | Changes the owner's repositories and how they are cloned and built. |

## 5. Data changes in SQLite and migration

**Projects.** `repositories` is a field of the project object in the `projects` config row. No schema
change. `normalizeProject` (`server/project-config.js:1-9`) supplies `[]`.

**New table `task_worktrees`**, one row per repository of a task, including the own repository:

```sql
CREATE TABLE IF NOT EXISTS task_worktrees (
  id TEXT PRIMARY KEY,               -- UUID v4
  task_id TEXT NOT NULL,             -- tasks.id
  own INTEGER NOT NULL,              -- 1 for the project's own repository, else 0
  repository TEXT,                   -- related repository's name when created; NULL exactly when own = 1
  repository_path TEXT,              -- its declared checkout when created; NULL exactly when own = 1
  worktree_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_branch TEXT,
  base_commit TEXT NOT NULL,
  state TEXT NOT NULL,               -- active | pr_open | merged | closed
  pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT                   -- set exactly when state is merged or closed
);
CREATE UNIQUE INDEX IF NOT EXISTS task_worktrees_open_path
  ON task_worktrees (worktree_path) WHERE state IN ('active', 'pr_open');
CREATE UNIQUE INDEX IF NOT EXISTS task_worktrees_own
  ON task_worktrees (task_id) WHERE own = 1;
```

- The own repository's checkout is not stored: it is the project's path when asked, as today
  (`task-landing.js:76-77`). A related repository's name and checkout are stored, so the task keeps
  working after the project's list is edited.
- Every column gets its own check when a row is read, in the style of `hydrate`
  (`task-store.js:56-89`), including the two "NULL exactly when" rules and the `finished_at` rule.
- `tasks.state` stays and is written in the same transaction as a worktree's state change, by the
  rule in §3.4. `findOpenByWorktreePath` reads `task_worktrees`.

**Migration of existing tasks**, once at startup in one transaction, with no Git call: for every
`tasks` row that has no `task_worktrees` row, insert one with `own = 1` and the task's
`worktree_path`, `branch`, `base_branch`, `base_commit`, `state`, `pr_url` and timestamps. Running it
again inserts nothing.

**Old columns on `tasks`** (`worktree_path`, `branch`, `base_branch`, `base_commit`, `pr_url`):
recommended to keep them for one release, filled at insert with the own repository's values and not
read again, and to drop the index `tasks_open_worktree` now. Reason: the live backend reloads when
the main checkout changes, and if the feature is reverted the previous code still finds its columns;
it would show a multi-repository task as its own repository only and delete nothing. A later change
drops the columns. The alternative is open question 7.

**Unchanged:** `pipeline_runs` (a run keeps one `worktree_path` and its `task_id`,
`server/pipelines/run-store.js:434-456`) and `terminal_session_worktree`.

## 6. API changes

All new endpoints follow `~/.claude/standards/api-design.md` and the project mapping in
`docs/steering/api-standards.md`: paged `data` + `page` lists with an allow-listed sort and a stable
tiebreaker, RFC 9457 errors with `traceId` and an `errors` array on every 400. All changes to existing
endpoints are additive.

| Endpoint | Change |
| --- | --- |
| `GET /api/projects/:name/repositories` | New, paged. The own repository and the related ones: `name`, `path`, `own`, and read from Git `branch`, `head`, `dirty`, `usable`, `reason`. |
| `POST /api/projects/:name/repositories` | New. `{ name?, path }`. 409 for a duplicate name or repository. |
| `DELETE /api/projects/:name/repositories/:repository` | New. |
| `POST /api/tasks` | Optional `repositories: [name]`. Absent means the own repository only, as today. |
| `GET /api/tasks`, `GET /api/tasks/:id` | Each task gains `worktrees: [{ id, repository, own, worktreePath, branch, baseBranch, baseCommit, state, prUrl }]`. The top-level `worktreePath`, `branch`, `baseBranch`, `baseCommit` and `prUrl` stay and carry the own repository's values, because the parser the desktop and the phone share requires them (`client/src/utils/tasksApi.js:17-21`) and an installed phone build may be older than the server. |
| `GET /api/tasks/:id/worktrees` | New, paged. Each worktree with the landing status that `GET /api/tasks/:id/landing` returns today (`task-landing.js:189-209`). |
| `POST /api/tasks/:id/worktrees/:worktreeId/commit`, `/merge`, `/close` | New (first slice). Same bodies and refusals as the task-level actions today. |
| `POST /api/tasks/:id/worktrees/:worktreeId/pull-request` | New (second slice). |
| `POST /api/tasks/:id/worktrees` | New (second slice): add a related repository to an open task. |
| `GET /api/tasks/:id/landing`, `POST …/commit`, `/merge`, `/pull-request` | Kept. They act on the own repository's worktree. |
| `POST /api/tasks/:id/close` | Kept. Closes the task: every open repository, all or none (§3.4). |
| `POST /api/tasks/:id/terminals` | Optional body `{ worktreeId }`. Absent means the own repository's worktree, or the first open one if that is finished. |
| `POST /api/pipelines/runs` | `newTask.repositories: [name]` and `startIn: <repository name>`, both optional. |
| `GET /api/pipelines/worktrees` | Optional `repository` filter, so the Run dialog can tell whether a task's worktree in a related repository can take a run. |

## 7. Smallest first slice

**Slice 1: a task with worktrees in related repositories, and a run that can start in any of them.**

1. Related repositories on a project: storage, the three endpoints, the dialog.
2. `task_worktrees`, the migration, and creating a task with ticked repositories from the New task
   dialog and from the Run workflow dialog.
3. Runs: "Start in", the progress file check against that repository, one unfinished run per task,
   the new guidance and its limit, the "Repositories" section in the run notes, Setup and its guard
   over every worktree.
4. Terminals: open in a chosen repository of a task, grouped under the task, with the repository's
   name on the tab.
5. Landing: status, Commit changes, Merge and Close per repository; Close task over all of them; the
   task finishing with its last repository.

This is useful by itself: the 2026-11-19 run would have started in `mobile-app` with `backend`
writable, and everything it produced could be committed and merged from the bar.

**Deliberately left out of slice 1:**

- Pull requests for related repositories. The own repository keeps its button. A related repository's
  branch can be pushed from a terminal until slice 2.
- Adding a repository to an open task. A task's repositories are fixed when it is created.
- Phone changes. The phone shows the task and its run as now.
- A hint when the run input is an absolute path inside a related repository ("this file is in
  mobile-app: start the run there and type `docs/todos/…`").
- Choosing a start branch per repository; cross-links between a task's pull requests; "merge all";
  browsing a related repository in the file panel; related repositories for remote projects; runs in
  Main changing related repositories; a folder-of-repositories shortcut; dropping the old `tasks`
  columns.

**Slice 2:** pull requests per repository, adding a repository to an open task, the phone's task
screen, the absolute-path hint. **Slice 3:** drop the old columns.

Each slice follows the project's order (data, service, API, unit tests, client, integration tests)
with tests first, and every new or changed endpoint is verified in the six dimensions of the API
standard.

## 8. Not verified

- No task or run was created against a `<repo>-main` worktree as a repository path. The claim in
  §3.1 comes from reading the four functions cited there and two `git rev-parse` outputs.
- The 110 and 300 character figures in §3.3 are estimates from the owner's path lengths. Only the
  1444 was measured.
- `server/project-deletion-service.js`, `server/pipelines/run-machine.js`,
  `client/src/components/TerminalTabBar.jsx` and `client/src/mobile/MobileApp.jsx` were not read. What
  deleting or renaming a project does to its open tasks is therefore not covered here.
- Whether a fix that writes the task row before `git worktree add` (audit item R01) has landed
  elsewhere is unknown; at `26380fc` the worktree is created first (`task-service.js:86-87`). The
  creation order in §3.2 should follow whatever that fix settles.

## 9. Open questions for the owner

Each has a recommendation; the design above assumes it.

1. **How repositories are declared.** Related repositories named on a project (recommended), or a
   project that is a folder of repositories?
2. **Folder layout.** Flat, `worktrees/<repo>-<task>`, which is your rule and what CodeDeck creates
   today (recommended), or one folder per task, `worktrees/<task>/<repo>`, which keeps references
   like `../mobile-app` working inside a task?
3. **Which repositories a new task includes.** Only the project's own unless you tick others
   (recommended), or all of them unless you untick?
4. **Where a related repository's worktree starts from.** The current branch and commit of the
   checkout you declare (recommended; for `frontend` you would declare `worktrees/frontend-main`,
   since `frontend/` is on `feat/whatsapp-setup`), or a branch chosen per repository each time a task
   is created?
5. **Pull requests for related repositories.** Second slice (recommended), or in the first? And
   should the pull requests of one task mention each other?
6. **Runs in Main.** Stay single-repository (recommended), or may a run in Main also change the
   related repositories' own checkouts?
7. **Old columns on `tasks`.** Keep for one release and drop later (recommended), or drop in the same
   migration after copying `~/.codedeck.db` aside?
8. **Limits.** At most 4 related repositories per project and a guidance limit raised from 2000 to
   3000 characters (recommended), or other numbers?
9. **Adding a repository to an open task while its run waits for input** (second slice): allowed, so
   you can answer "the files are in mobile-app" by adding it (recommended), or only between runs?
