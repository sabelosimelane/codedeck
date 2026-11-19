# Multi-repository tasks: specification

**Date:** 2026-11-19
**Status:** Built on branch `claude/competent-hamilton-c07651`, not merged. The owner answered the questions on 2026-11-19 (§10); the rest is decided in §4. Where the build departs from this text, §11 says how.
**Todo:** `docs/todos/multi-repository-tasks.md`
**Read at:** commit `26380fc` of this repository. Every file and line cited below was read at that commit.

## 1. Summary

Most of the owner's projects are one repository among sibling repositories in a group folder
(§2.8). Today a CodeDeck project is one Git repository, a task owns one worktree and one branch of
it, and a workflow run is told to change files only in that one worktree. Work that spans siblings
cannot be done in one task, and a run started with a file from a sibling stops.

This specification makes several repositories the normal case:

1. **A project has one or more repositories.** Its path stays its own repository; the others are
   listed on the project. A lone repository is a project whose list is empty, and every rule below
   reduces to today's behaviour for it.
2. **A task owns one worktree and one branch per repository it includes.** It includes the
   repository it starts in and the ones ticked when it is created; more can be added while it is
   open.
3. **A task of a project with several repositories lives in one folder**, with each worktree under
   its repository's own folder name, so a reference such as `../../backend/docs/…` resolves inside
   the task as it does in the group folder.
4. **A run has one working directory**, one of the task's worktrees, chosen at start. Notes, the
   brief and the progress file are relative to it. The step guidance names the task's other
   worktrees as writable and the project's remaining repositories as readable only.
5. **Landing is per repository.** Status, commit, merge, pull request and close each act on one
   repository. The task is finished when its last repository is merged or closed. Nothing is forced
   and nothing is atomic across repositories.

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
  `finished_at` is set exactly when the task is finished (`:72`). A title records where it came from
  (`title_source`, `:18-21`, `:112`); only a title made from a run's input is ever replaced, once
  (`:129-131`, `:186-194`).
- A task's folder and branch are named by `planNames`: the folder is
  `<parent of the home repository>/worktrees/<home folder>-<slug>-<first 8 hex of the id>` and the
  branch is `task/<slug>-<same 8 hex>` (`server/pipelines/run-worktree.js:46-59`, called from
  `server/tasks/task-service.js:58-60`).
- The worktree starts from the HEAD commit of the project path (`run-worktree.js:193-196`) and
  records that checkout's current branch as its base branch (`run-worktree.js:149-154`,
  `task-service.js:70`).
- The worktree is created before the task row is written (`task-service.js:86-87`). Creations run
  one at a time (`:106-114`).
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
  it with `newTask` (`:823-829`). Only a worktree CodeDeck has just created gets the Setup step
  (`:826`, `:904`).
- A worktree is refused when another open run that is not complete already uses the same path
  (`server/routes/pipelines.js:219-227`), and the check is repeated just before the run is stored
  (`:935-940`).
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
- A task started by a run without a typed title is named from the run's input
  (`server/routes/pipelines.js:866-871`) and later from the run's first step note
  (`server/index.js:931-942`).

### 2.5 Landing

- Status is read from Git for `task.worktreePath` and for the project path (Main): uncommitted
  files, commits ahead and behind, the checkout's branch, ignored files at risk, Main's branch and
  dirtiness, and the project's remotes (`server/tasks/task-landing.js:123-148`, `:81-90`).
- Blockers are computed per action (`:150-183`), including a task folder that is no longer on its
  own branch (`:158`, `:182`) and ignored files that exist nowhere else (`:110-120`, `:183`). Commit
  runs `git add --all` and `git commit` in the worktree (`:245-260`). Merge runs
  `git merge --no-edit <branch>` in the project path, aborts on conflict and lists the conflicting
  files (`:262-277`), then removes the worktree without force and deletes the branch with
  `git branch -d` only if removal succeeded (`:279-290`). Pull request pushes the branch and calls
  `gh` or `glab` (`:298-335`). Close removes a clean worktree and keeps the branch (`:337-350`).
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

### 2.7 One group folder, observed 2026-11-19 (read-only)

`git worktree list` and `git rev-parse` in `/Users/sabside/git/mlondolozi`:

| Folder | Kind | Branch checked out |
| --- | --- | --- |
| `backend/` | repository | `main` |
| `frontend/` | repository | `feat/whatsapp-setup` |
| `mobile-app/` | repository | `main` |
| `worktrees/frontend-main` | worktree of `frontend` | `main` |
| `worktrees/backend-docs-todos-2026-11-17-182751-com-8ea2fe43` | worktree of `backend` | `task/docs-todos-…` |
| `worktrees/backend-users-sabside-git-mlondolozi-mob-b5c0667a` | worktree of `backend` | `task/users-sabside-git-mlondolozi-mob-b5c0667a` |

A repository's own folder is not always on its main branch (`frontend/`); the branch a task should
start from may be checked out in a `<repo>-main` worktree instead.

### 2.8 The owner's projects (reported by the session that started this work; not re-counted here)

- 68 local projects (87 in all, 19 on remote hosts). 31 are a repository inside a group folder that
  holds other repositories beside it; 7 of those groups already have a `worktrees/` folder. 30 are a
  lone repository directly under `~/git`. 3 are folders that are not repositories, 3 point at paths
  that no longer exist, 1 is alone in its group folder. No project is registered at a group folder.
- The case that exposed the gap: only `backend` of `/Users/sabside/git/mlondolozi/` was a project. A
  Bug fix run started there with a todo that lives in `mobile-app` got a worktree of `backend`, and
  its Develop step stopped to ask for a restart from `mobile-app`.
- Workaround applied by hand: `mobile-app` was added as a separate project. This design should make
  that unnecessary.
- That todo refers to the backend's spec as `../../backend/docs/…`. From the main checkout the path
  resolves. From a task worktree under `mlondolozi/worktrees/` it does not.
- The phone app released as 1.8 reads `GET /api/tasks?open=true` and
  `GET /api/pipelines/runs?open=true` with `parseTask` and `parseRun`. Fields it reads must not be
  removed or change meaning in one release.

## 3. Design

### 3.1 A project's repositories

A project has its **own repository** (its `path`, unchanged) and a list of **other repositories**:

```json
{ "name": "mlondolozi", "path": "/Users/sabside/git/mlondolozi/backend",
  "repositories": [
    { "name": "mobile-app", "path": "/Users/sabside/git/mlondolozi/mobile-app" },
    { "name": "frontend",   "path": "/Users/sabside/git/mlondolozi/worktrees/frontend-main" }
  ] }
```

The owner lists them per project (§10, answer 1). The dialog offers the repositories found beside the
project's own (direct children of its parent folder that are Git repositories, `worktrees` excepted)
to add with one click. Nothing is guessed: 30 of the owner's projects sit directly under `~/git`
beside hundreds of unrelated repositories, so "everything in the parent folder" cannot be a rule.

The grouping is virtual (§10, answer 2): it is a list in CodeDeck's own configuration. No repository
is moved, re-registered or changed to belong to a group, no existing project is linked
automatically, and a project with other repositories is still one project on screen.

Rules for an entry, each a field error when broken:

- `path`: an absolute path that exists and passes the Git check a project path passes today (top
  level of a working tree). It is **the checkout a task starts from and merges into**, so it may be a
  `<repo>-main` worktree. Reading the code, this needs nothing new: `preflight` accepts any working
  tree's top level, and `create` takes HEAD of the given path (`run-worktree.js:138-146`,
  `:193-196`, `:218-223`). For `worktrees/frontend-main`, `git rev-parse --show-toplevel` printed the
  worktree itself and `--git-common-dir` printed `frontend/.git`. No task was run against it.
- `name`: the folder name of the repository the path belongs to (`frontend` for
  `worktrees/frontend-main`). It is derived, not typed, and must be unique among the project's
  repositories including its own.
- The path's repository (its Git common directory) differs from the project's own and from every
  other entry's.
- Local projects only, as tasks are today.
- At most 8 other repositories per project.

A project without the field has no other repositories and behaves exactly as today. Removing an entry
does not touch open tasks that have a worktree in it (§6). A repository may be listed on several
projects and may also be a project of its own.

**Files:** `server/project-config.js` (default `repositories: []`), new
`server/project-repositories.js` (validation, the Git check, the neighbour scan), new
`server/routes/project-repositories.js` (§7), `server/index.js` (wiring), new
`client/src/components/ProjectRepositoriesDialog.jsx` and `client/src/utils/projectRepositoriesApi.js`,
`client/src/components/Sidebar.jsx` (entry on the project row), `client/src/App.jsx`.

### 3.2 What a task owns

- **One worktree and one branch per repository it includes**, each with its own base branch, base
  commit and landing state.
- **Which repositories:** the one the task starts in, plus the ones ticked when it is created; none
  is ticked by default (§10, answer 4). The rest stay readable and can be added later. A task
  made by hand starts in the project's own repository unless that is unticked; a task made for a run
  starts in the run's "Start in" repository (§3.4).
- **The first worktree** of a task is the one it started in. It supplies the task's top-level
  `worktreePath`, `branch`, `baseBranch`, `baseCommit` and `prUrl` for clients that read only those
  (§7), and is where a terminal opens when no repository is named.
- **Start point:** each worktree starts from the HEAD commit and current branch of its repository's
  declared checkout, the rule the project's own repository has today.
- **Creation:** everything is planned first, which changes nothing, as `plan` does today
  (`task-service.js:40-72`). Worktrees are then created one after another. If one
  `git worktree add` fails, the ones already created for this task are removed without force (they
  are new and clean), their new branches deleted with `git branch -d`, and the error names the
  repository that failed. If that undo is itself refused, the task is kept with the worktrees that
  exist and the message says which.
- **Adding a repository later:** "Add repository" on an open task creates a worktree and branch in
  one of the project's repositories from its current commit. It is refused while a run of the task
  is `pending` or `running`, and allowed in every other state, so that a step that stopped with
  "this needs backend" can be answered by adding it. No Setup runs for it; the bar says so. A
  repository that was already part of the task and was merged or closed there cannot be added again.
- **Removing a repository from a task** is closing that worktree (§3.5).
- **Limit:** a task takes one unfinished run at a time (§3.4).

**Files:** `server/tasks/task-store.js` (§6), `server/tasks/task-service.js` (`plan` and
`createPlanned` per repository, `addRepository`, `openTerminal` takes a worktree),
`server/routes/tasks.js` (§7), `server/tasks/task-adoption.js` (`findOpenByWorktreePath` reads the
new table; adoption stays limited to the project's own repository, because it lists only that
repository's worktrees, `task-adoption.js:52-66`), `client/src/components/tasks/NewTaskDialog.jsx`,
`client/src/utils/tasksApi.js`.

### 3.3 Where the worktrees live, and how references resolve

**One folder per task, for projects with several repositories** (§10, answer 3). This departs, for
these tasks only, from the owner's written rule `worktrees/<repo>-<purpose>`.

```
/Users/sabside/git/mlondolozi/
  backend/  frontend/  mobile-app/
  worktrees/
    whatsapp-replies-1a2b3c4d/          the task's folder: <slug>-<first 8 hex of the task id>
      backend/                          worktree of backend,    branch task/whatsapp-replies-1a2b3c4d
      mobile-app/                       worktree of mobile-app, branch task/whatsapp-replies-1a2b3c4d
```

- The task's folder is `<parent of the project's own repository>/worktrees/<slug>-<id8>`. Each
  worktree is `<task folder>/<repository name>`. All of a task's branches have the same name.
- Inside the task, `mobile-app/docs/todos/x.md` reaching for `../../backend/docs/…` finds the task's
  own copy of `backend`, exactly as it finds `backend` from the main checkout. The same holds for
  build files and scripts that use a sibling by relative path.
- The folder is used for every task of a project that has other repositories, also when the task
  includes one repository, so that one added later lands beside it.
- A project with only its own repository keeps today's folder,
  `worktrees/<repo>-<slug>-<id8>`: there is nothing beside it to refer to.
- Existing tasks keep the folders they have. Paths are stored per worktree; nothing is moved.
- When a task's last worktree is removed its empty folder is removed with a plain `rmdir`. A folder
  that still holds something is kept and reported.

**References to a repository that is not part of the task.** A project's repository that the task
does not include has no worktree, so `../../frontend` finds nothing in the task's folder. The run is
told where each such repository's own checkout is and that it may be read there and never changed
(§3.4). No symbolic links are created: a write through a link would change a main checkout unseen.

**Files:** `server/pipelines/run-worktree.js` (`planTaskFolder` beside `planNames`),
`server/tasks/task-service.js`, `server/tasks/task-landing.js` (removing the empty folder).

### 3.4 What a workflow run is told

**One working directory.** A run keeps a single `worktreePath`. For a task with several worktrees
the owner chooses the repository the run **starts in**; the default is the project's own when the
task has it, else the task's first worktree. That worktree is the current directory of every step's
terminal, the place of the run notes (`.codedeck/runs/<id8>`), the brief and `plan.md`, and what the
progress file path is relative to. Nothing in the engine that reads `run.worktreePath` changes
meaning. The working directory is a repository's worktree and not the task's folder, because agent
CLIs read their instructions, skills and settings from the repository they start in.

With this, the 2026-11-19 run starts in `mobile-app`, finds `docs/todos/<file>.md` there, and reads
or changes `backend` beside it.

**Start checks.**

- The progress file of a run in a new task must be committed in the checkout of the repository the
  run starts in, not in the project path (today `server/routes/pipelines.js:914-916`).
- When the path made from the run's input is absolute and lies inside the checkout of one of the
  project's repositories, the refusal names that repository and the relative path to type. Today the
  message says only that it is not a path inside the project (`pipelines.js:318-322`).
- A task takes one unfinished run at a time, whichever worktree it starts in. Today the refusal is
  per worktree path (`pipelines.js:219-227`); two runs in two worktrees of one task could change the
  same files.
- **A run in Main** may start in the own checkout of any of the project's repositories ("Start in",
  §10 answer 5). It changes that one checkout only: the project's other repositories are named as
  readable, never writable, because main checkouts have no isolation. It has no Setup step, as a run
  in Main has none today. A run in a worktree named by path is unchanged.

**Step guidance.** For a run in a task of a project with other repositories, the first sentence
(`step-guidance.js:31`) is built from the task's open worktrees and the project's repositories, read
at each step start:

> Work only inside this task's worktrees: `<repository>` at `<path>` [, `<repository>` at `<path>`].
> Your current directory is the `<repository>` one. Each is a separate Git repository on its own
> branch: run Git inside the worktree it concerns, commit each separately and switch no branch. Do
> not create, change or delete files anywhere else. [These repositories of the project are not part
> of this task: `<repository>` at `<path>`. Read them there when a document refers to them and never
> change them.] If a repository that is not part of this task must change, or the files of the task
> are in none of these places, use NEEDS_INPUT and say what is missing.

A read-only step is told to change nothing in any of the task's worktrees except its notes folder. A
run in a project without other repositories gets today's sentence, character for character.

The lists are read live, not kept in the run's definition snapshot, so a worktree closed before a
Resume is not named and one added during a pause is.

**Guidance limit.** Raised from 2000 to 4000 characters (`server/terminal-workflow.js:21`). Today's
worst case is 1444 (§2.4); the new sentence is about 500 characters longer than the old one before
paths, and each repository adds its path. A run whose guidance is still too long is refused at
start, as today (`pipelines.js:910`), and the message names the repositories.

**Run notes.** `README.md` in the notes folder gains a "Repositories" section: for each repository
of the project, its name, whether it is part of the task, its worktree path and branch or its own
checkout, and the checkout it started from (`run-notes.js:103-114`). No `.codedeck` folder is created
in the other worktrees.

**Setup.** For a task created for the run, the Setup prompt lists every pair of home checkout and
worktree and applies its existing rules to each (`run-worktree.js:339-356`). The guard after Setup
checks every worktree of the task and names the repository whose worktree is not clean
(`run-engine.js:231-244`).

**Files:** `server/pipelines/step-guidance.js`, `server/terminal-workflow.js`,
`server/pipelines/run-worktree.js` (`buildSetupPrompt` takes a list), `server/pipelines/run-notes.js`
(`buildReadme`), `server/pipelines/run-engine.js` (a `listTaskPlaces` dependency for guidance, notes
and the Setup guard), `server/index.js`, `server/routes/pipelines.js` (`POST /runs`: `startIn`,
`newTask.repositories`, the progress file check and hint, one run per task; the prompt preview at
`:599-633` gets placeholder repositories), `shared/pipeline-definitions.mjs` (start body validation),
`client/src/components/pipelines/RunWorkflowDialog.jsx`, `client/src/utils/pipelinesApi.js`.

### 3.5 Landing per repository

Every worktree of a task has its own state: `active`, `pr_open`, `merged` or `closed`. Everything
`inspect` reads today (§2.5) is read per worktree, with that worktree's path, branch, base branch
and declared checkout in place of the task's and the project path.

| Action | Acts on | Rule, unchanged from today |
| --- | --- | --- |
| Status | one repository | read from Git when asked, never stored |
| Commit changes | one worktree | its own message |
| Merge into `<base>` | one repository, in its declared checkout | that checkout must be clean and on the base branch; a conflict is aborted and its files listed; then the worktree is removed without force and the merged branch deleted |
| Open a pull request | one repository, with its own remotes | pushes that branch only; asks first |
| Close | one repository | refused with uncommitted changes, a switched branch or ignored files at risk; the branch is kept |

Rules for a task with several repositories:

- **One clean, one not.** Each repository's buttons follow its own blockers. A committed `backend`
  can be merged while `mobile-app` still has uncommitted files. Messages name the repository.
- **A working run blocks every repository of its task**, because it may be writing in any of them.
- **The task stays open until its last repository is merged or closed.** It then becomes `merged`
  if any repository was merged, otherwise `closed`. While open it is `pr_open` if any open
  repository has a pull request, otherwise `active`.
- **Finishing one repository** closes the terminals in that worktree and releases a finished run
  that worked in it, as finishing the task does today. The rest of the task is untouched.
- **Close task** closes every open repository. All are checked first; if any is blocked, nothing is
  closed and the refusal lists each blocking repository with its reason. If a removal is refused
  after the checks passed, the ones already closed stay closed, the task stays open, and the result
  says which.
- **No "merge all", and nothing atomic.** Git has no transaction across repositories. The bar shows
  which repositories are merged and which are not.

**Files:** `server/tasks/task-landing.js` (`inspect`, `commit`, `merge`, `pullRequest`, `close` take
a task worktree; `finish` per worktree and per task), `server/tasks/task-terminals.js` (close by one
worktree path), `server/index.js` (`onTaskFinished` and a per-worktree release),
`server/routes/tasks.js` (§7), `client/src/components/tasks/TaskLandingBar.jsx`,
`client/src/utils/tasksApi.js`.

### 3.6 Terminals, sidebar, task view and phone

A task stays **one thing** on screen. Its repositories are detail inside it.

- **Grouping.** A terminal, run or path that belongs to any worktree of a task is grouped under that
  task. The group key becomes the task id for tasks and stays the path for a worktree without a task
  (`worktreeGroups.js:126-133`, `:170-182`). A stored selection that used a path falls back to Main
  once, as an unknown key does today (`:55-58`).
- **Terminals.** In a task with several worktrees, a new terminal, a split and Cmd/Ctrl+Shift+T open
  in the repository of the active pane; the "+" button offers the task's open repositories. Each tab
  and pane header of such a task shows the repository's name, because session ids keep the project's
  name (`backend-7` may be a terminal in `mobile-app`). A task with one worktree looks as it does now.
- **Main reaches every repository** (§10, answer 5). In Main, the "+" button offers the project's
  repositories, and a terminal opens in the own checkout of the one chosen; a split and
  Cmd/Ctrl+Shift+T follow the active pane's repository. A terminal in another repository's checkout
  belongs to the Main group and shows that repository's name on its tab. The backend accepts such a
  terminal only for a directory that is the checkout of one of the project's repositories. With
  this, no repository needs a project of its own.
- **Sidebar and switcher.** One row per project and, under it, one row per task, as now. A
  repository is never a row
  (`client/src/components/WorktreeGroupHeader.jsx:5-28`). A task's tooltip lists each repository's
  folder, branch and path.
- **Landing bar.** The task's title and Rename, then one row per repository with its name, its facts
  and its buttons, then Add repository and Close task. A task with one worktree in a project without
  other repositories renders exactly as today.
- **Task view.** The header says which repository the run works in when the task has more than one.
  "Open a terminal here" on a step opens in the run's worktree. Steps, notes, questions and approvals
  are unchanged (`client/src/components/tasks/TaskView.jsx:177-236`).
- **Phone.** A run row is still named after its task (`mobile/nowView.js:49`), and the task record
  keeps every field the released parser requires (§7). The task screen lists the task's repositories
  and where the run works. Landing stays a desktop action, as it is today.

**Files:** `client/src/utils/worktreeGroups.js`, `client/src/App.jsx` (`:102-119`),
`client/src/components/TerminalArea.jsx` (`:689`, `:765-770`, `:1172-1179`, `:1433`),
`client/src/components/TerminalTabBar.jsx`, `client/src/components/WorktreeGroupHeader.jsx`,
`client/src/components/tasks/TaskLandingBar.jsx`, `client/src/components/tasks/TaskView.jsx`,
`client/src/mobile/TaskScreen.jsx`. `TerminalArea.jsx`, `App.jsx` and `Sidebar.jsx` were read only at
the lines a search for tasks and worktree paths returned; `MobileApp.jsx` and `TerminalTabBar.jsx`
were not read. Their part of this list is an estimate.

## 4. Decisions made here, and why

| Topic | Decision | Why |
| --- | --- | --- |
| Project path | Stays the project's own repository | Main, the default terminal directory, the file panel and merge all use it (`worktreeGroups.js:126`, `mobile-session-start.js:11`, `task-landing.js:267`); the 68 local projects keep working untouched |
| Working directory of a run | One repository's worktree, not the task's folder | Agent CLIs load instructions, skills and settings from the repository they start in |
| Start point of a worktree | HEAD and branch of the repository's declared checkout | The rule the own repository has today; a `<repo>-main` worktree can be declared where the repository's own folder is on another branch |
| A repository not in the task | Readable at its own checkout, never writable, no symbolic link | A write there would have no isolation and nothing to land |
| Adding a repository to an open task | Allowed unless a run is `pending` or `running` | Lets a paused run be answered by adding what it lacks |
| Setup for a repository added later | None | Setup is a run's first step; the owner or the next step prepares it. Stated on the bar |
| Runs per task | One unfinished run | Two runs could write the same worktrees |
| Runs in Main | Start in any repository's own checkout; change that one only | The owner wants no project per repository (§10, answer 5); main checkouts have no isolation, so one run writes in one of them |
| Merge | Per repository, no "merge all" | Not atomic; undoing half would be forcing |
| Pull requests | Per repository, in the build (phase 6) | Each repository has its own remotes |
| Task state | Derived from its worktrees and stored on the task row | Existing filters on `tasks.state` keep working (`routes/tasks.js:72`) |
| Old columns on `tasks` | Kept for one release, filled at insert, no longer read | The API standard's two-release removal rule; and if the change is reverted the previous code still finds its columns |
| Guidance limit | 4000 characters | Measured 1444 today plus the longer sentence and one path per repository |
| Repositories per project | At most 8 others | Bounds the guidance and the dialogs |
| Repository name | The repository's folder name, derived | It is the folder name inside a task, so references resolve |
| Remote projects | Not covered | Tasks are local only today (`task-service.js:36`) |

## 5. Rejected alternatives

| Alternative | Why not |
| --- | --- |
| **A project registered at the group folder** | The project path is assumed to be a Git top level and to be Main in every layer (`run-worktree.js:144-146`, `task-landing.js:267`, `worktreeGroups.js:126`). All 31 group projects would be re-registered and their terminals would start in a folder with no agent instructions. |
| **Everything in the parent folder is related, automatically** | 30 projects sit directly under `~/git`; their parent holds hundreds of unrelated repositories. |
| **Linking separate CodeDeck projects** so a task spans projects | Sessions, tasks and runs are keyed and filtered by one project name (`mobile-session-start.js:50-53`, `task-store.js:100`, `pipelines.js:800`). Every repository would have to be a project in the sidebar. |
| **One task per repository with a link between them** | Nothing is shared: a run still has one worktree and the guidance still forbids the other. |
| **The task's folder as the run's working directory** | The agent would start outside any repository and miss its instructions, skills and settings. |
| **Symbolic links to main checkouts for repositories not in the task** | References would resolve, but a write through the link changes a main checkout with no trace in the task. |
| **Letting a step change sibling main checkouts** | No isolation and nothing to land or close. |
| **One run per repository, coordinated** | Needs a protocol between runs. One run with several writable worktrees needs none. |
| **Submodules or a meta-repository** | Changes the owner's repositories and how they are cloned and built. |

## 6. Data changes in SQLite and migration

**Projects.** `repositories` is a field of the project object in the `projects` config row. No schema
change. `normalizeProject` (`server/project-config.js:1-9`) supplies `[]`.

**`tasks`** gains `task_folder TEXT`: the folder that holds the task's worktrees, or NULL for a task
whose worktrees are named one by one (every existing task, and tasks of projects without other
repositories).

**New table `task_worktrees`**, one row per repository of a task:

```sql
CREATE TABLE IF NOT EXISTS task_worktrees (
  id TEXT PRIMARY KEY,               -- UUID v4
  task_id TEXT NOT NULL,             -- tasks.id
  is_first INTEGER NOT NULL,         -- 1 for the worktree the task started in, else 0
  repository TEXT NOT NULL,          -- repository name when the worktree was created
  repository_path TEXT,              -- declared checkout when created; NULL for the project's own repository
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
CREATE UNIQUE INDEX IF NOT EXISTS task_worktrees_first ON task_worktrees (task_id) WHERE is_first = 1;
CREATE UNIQUE INDEX IF NOT EXISTS task_worktrees_repository ON task_worktrees (task_id, repository);
CREATE INDEX IF NOT EXISTS task_worktrees_task ON task_worktrees (task_id);
```

- A worktree of the project's own repository has no stored checkout (`repository_path` is NULL): its
  checkout is the project's path when asked, as today (`task-landing.js:76-77`). Another repository's
  checkout is stored, so the task keeps working after the project's list is edited.
- Every column gets its own check when a row is read, in the style of `hydrate`
  (`task-store.js:56-89`), including the `finished_at` rule. Reading a task also checks that it has exactly one first worktree
  and that its stored state is the one its worktrees give.
- `tasks.state` stays and is written in the same transaction as a worktree's state change, by the
  rule in §3.5. `findOpenByWorktreePath` reads `task_worktrees`.
- The task row and its first worktree row are written in one transaction.

**Migration of existing tasks**, once at startup in one transaction, with no Git call: for every
`tasks` row that has no `task_worktrees` row, insert one with `is_first = 1`, no `repository_path`, the task's
`worktree_path`, `branch`, `base_branch`, `base_commit`, `state`, `pr_url` and timestamps, and
`repository` set to the folder name of the project's path, or to the task's project name when that
project is no longer stored. Running it again inserts nothing.

**Old columns on `tasks`** (`worktree_path`, `branch`, `base_branch`, `base_commit`, `pr_url`) are
kept for one release, filled at insert with the first worktree's values and not read again. The
index `tasks_open_worktree` is dropped. A later change drops the columns.

**Unchanged:** `pipeline_runs` (a run keeps one `worktree_path` and its `task_id`,
`server/pipelines/run-store.js:434-456`) and `terminal_session_worktree`.

## 7. API changes

All new endpoints follow `~/.claude/standards/api-design.md` and the project mapping in
`docs/steering/api-standards.md`: paged `data` + `page` lists with an allow-listed sort and a stable
tiebreaker, RFC 9457 errors with `traceId` and an `errors` array on every 400, and the six test
dimensions. Every change to an existing endpoint is additive, and the recorded requests of the
released phone are replayed against it.

| Endpoint | Change |
| --- | --- |
| `GET /api/projects/:name/repositories` | New, paged. The own repository and the others: `name`, `path`, `own`, and read from Git `branch`, `head`, `dirty`, `usable`, `reason`. |
| `GET /api/projects/:name/repository-candidates` | New, paged. Git repositories that are direct children of the own repository's parent folder and not yet listed; the folder `worktrees` is skipped. |
| `POST /api/projects/:name/repositories` | New. `{ path }`. 409 for a repository already listed or a name already used. |
| `DELETE /api/projects/:name/repositories/:repository` | New. |
| `POST /api/tasks` | Optional `repositories: [name]`, first one is where the task starts. Absent means the own repository only, as today. |
| `GET /api/tasks`, `GET /api/tasks/:id` | Each task gains `worktrees: [{ id, repository, own, first, worktreePath, branch, baseBranch, baseCommit, state, prUrl }]` and `folder`. The top-level `worktreePath`, `branch`, `baseBranch`, `baseCommit` and `prUrl` stay and carry the first worktree's values, because the parser the desktop and the phone share requires them (`client/src/utils/tasksApi.js:17-21`) and an installed phone build may be older than the server. |
| `GET /api/tasks/:id/worktrees` | New, paged. Each worktree with the landing status that `GET /api/tasks/:id/landing` returns today (`task-landing.js:189-209`). |
| `POST /api/tasks/:id/worktrees` | New. `{ repository }`: add one of the project's repositories to an open task. |
| `POST /api/tasks/:id/worktrees/:worktreeId/commit`, `/merge`, `/pull-request`, `/close` | New. Same bodies and refusals as the task-level actions today. |
| `GET /api/tasks/:id/landing`, `POST …/commit`, `/merge`, `/pull-request` | Kept. They act on the task's first worktree. |
| `POST /api/tasks/:id/close` | Kept. Closes the task: every open repository, all or none (§3.5). |
| `POST /api/tasks/:id/terminals` | Optional body `{ worktreeId }`. Absent means the first worktree, or the oldest open one if that is finished. |
| `POST /api/pipelines/runs` | `newTask.repositories: [name]` and `startIn: <repository name>`, both optional. |
| `GET /api/pipelines/worktrees` | Optional `repository` filter, so the Run dialog can tell whether a task's worktree in another repository can take a run. |

## 8. Phases

The phased todo is `docs/todos/multi-repository-tasks.md`. In order, riskiest first:

1. Task worktrees in the database: the table, the migration and every reader switched, with no
   change in behaviour.
2. A project's repositories: storage, endpoints, dialog.
3. A task across repositories: planning, folder layout, creation with undo, terminals, grouping,
   Close task over all worktrees.
4. Landing per repository.
5. Runs across repositories: start in, guidance, notes, Setup, the Run dialog.
6. Adding a repository to an open task; pull requests per repository.
7. Phone, documentation and final verification.

**Not in this work:** choosing a start branch per repository; cross-links between a task's pull
requests; browsing another repository in the file panel; other repositories for remote projects;
a run in Main changing more than the repository it starts in; preparing (Setup) a repository added to a task later;
re-adding a repository that was merged or closed in the same task; dropping the old `tasks` columns
(a later release).

## 9. Not verified

- No task or run was created against a `<repo>-main` worktree as a repository path. The claim in
  §3.1 comes from reading the functions cited there and two `git rev-parse` outputs.
- The project counts in §2.8 were reported by the session that started this work.
- The character figures in §3.4 other than the measured 1444 are estimates.
- `server/project-deletion-service.js`, `server/pipelines/run-machine.js`,
  `client/src/components/TerminalTabBar.jsx` and `client/src/mobile/MobileApp.jsx` were not read. What
  deleting or renaming a project does to its open tasks is not covered here.
- Whether released phone build 1.8 bundles its client code or loads it from the instance was not
  checked; the design assumes the stricter case and removes no field.

## 10. The owner's answers (2026-11-19)

1. **How a project's repositories are declared.** Listed per project, with the repositories beside
   it offered to add in one click.
2. **The 31 existing projects that sit in a group folder.** In the owner's words: "no actual changes,
   codedeck wraps the view as one project", and, asked which reading was meant, "grouping should be
   virtual not the actual repos". Read here as: nothing is linked or changed automatically, the
   grouping exists only in CodeDeck's configuration, and a project with other repositories is one
   project on screen with its repositories inside its tasks, runs and landing bar. Not built on this
   reading: merging two separately registered projects of one group into one sidebar row; answer 5
   makes the second project unnecessary instead.
3. **Folder layout for tasks of projects with several repositories.** One folder per task,
   `worktrees/<task>/<repo>`.
4. **Which repositories a new task includes.** The one it starts in plus the ones ticked; the rest
   stay readable and can be added later.
5. **What the sidebar shows, and how another repository's own checkout is reached.** The owner does
   not want every repository loaded as its own project. Chosen: one row per group; in Main the "+"
   button and Run workflow also offer the project's other repositories, so a terminal or a run can
   start in any repository's own checkout, and the tab shows the repository's name. This also settles
   the point left open under answer 2: repositories never become sidebar rows, and a project added
   by hand for one repository of a group can be removed once the group's project lists it.

## 11. Where the build departs from this specification

- **Group key (§3.6).** A task's group is still known by a path, the worktree the task started in;
  every other worktree of the task resolves to it. Stored selections stay valid.
- **Main terminals (§3.6).** A terminal in another repository is opened by
  `POST /api/projects/:name/terminals`, which accepts only the project's repositories. The terminal
  socket itself is unchanged and still accepts any absolute directory, as it did.
- **Pane header (§3.6).** The repository's name is on the tab; the pane header shows the directory.
- **`is_own` (§6).** Not a column: a worktree of the project's own repository is the one with no
  stored checkout. Worktrees are read in the order they were written.
- **`GET /api/pipelines/worktrees?repository=` and the prompt preview (§3.4, §7).** Not built. The
  start request refuses a worktree that cannot take a run, with the reason.
- **Phone (§3.6).** Reads tasks by the fields every backend release sends, and a task's
  repositories when the instance sends them.
- **A run in Main in another repository (§3.4).** Asked for with `worktreePath` set to that
  repository's checkout, not with `startIn`.
- **Creation order (§3.2).** `main` changed creation while this was built (`3d1a8d1`): a task's row
  is written first, and each worktree is then created at the commit recorded for it. This build
  follows that order for every repository: the task and all its worktrees are recorded in one
  transaction, then created one after another. When one fails, the ones already created are taken
  back as described; if no folder is left, the row is removed again; if the undo is refused, the
  task stays with the copies still on disk and the rows of the others are removed (the row of the
  repository the task started in cannot be, and then says its files are missing). Adding a
  repository records its row before Git too, and removes it again when Git left no folder.
- **Replaying a start (§3.4).** `startIn` and `newTask.repositories` are part of what a `requestId`
  is recorded with (`server/pipelines/request-store.js`); a request recorded before they existed
  reads the same. A start that was interrupted after its task was recorded is finished in that
  task, in the same repository, with Setup for each of its open repositories.
