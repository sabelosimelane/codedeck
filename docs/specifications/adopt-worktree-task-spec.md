# Make an existing worktree a task

## Problem

A spec can be written anywhere: by hand, by an agent session, or by a skill that runs
`git worktree add` itself. Such a worktree is not a CodeDeck task, so the Run workflow dialog
cannot offer it. **Where to work** lists a new task, the open tasks and Main. A new task starts
from the repository's last commit, so specs that are not committed in that worktree never
reach it. Worktrees are adopted only once, at startup (`server/tasks/task-adoption.js`), and
only ones a run or a terminal already uses. The owner then has to move files by hand to get
back to a workflow.

## What the owner gets

- **Run workflow → Where to work** offers **An existing worktree** when the project has one
  that is not a task. The owner picks it, may type a title, and clicks Start. CodeDeck makes
  that worktree a task and starts the run in it, uncommitted files included. No Setup step
  runs, as for any open task.
- **New task** offers the same choice, **Use an existing worktree**, without starting a run.
  It opens a terminal in the new task, as a new task does today.
- From then on the worktree is an ordinary task: listed by title in the sidebar and the
  switcher, landed with Commit / Merge / Pull request / Close, and its folder is removed only
  by Merge or Close under the existing rules (uncommitted work is never removed; ignored files
  only it holds need **Delete files and close**).

## Rules

1. **Candidates.** A candidate is a worktree that Git lists for one of the project's
   repositories (its own `path` and every `repositories[].path`). The following are never
   listed:
   - any project checkout (the own path or a listed repository's path);
   - the main worktree of any of those repositories (Git's first entry, the home repository);
     it can never be a task's folder;
   - a worktree an open task already holds (any open `task_worktrees` row with that path).
2. A candidate is listed but **not selectable** with a reason when:
   - `missing`: Git lists it but the folder is gone (prunable);
   - `detached`: no branch is checked out;
   - `unreadable`: `git status` failed in it;
   - `in_use`: an unfinished run without a task works in it, or another start holds it
     (same meaning as `worktreeRefusal` in `server/routes/pipelines.js`);
   - `base_unknown`: the repository's checkout has no branch checked out, so there is no base
     branch to merge into.
3. Each candidate says: `path`, `name` (folder name), `repository` (name as tasks record it:
   the basename of the project path for its own repository, `repositories[].name` otherwise),
   `own`, `branch`, `head`, `uncommittedCount` (changed plus untracked files, from Git; null
   when unreadable), `selectable`, `reason` (`{code, message}` or null).
4. **Making a task** records exactly what a task created by CodeDeck records:
   - `repository` and `repositoryPath` (null for the own repository, the listed checkout
     path otherwise), `worktreePath`, `branch`;
   - `baseBranch`: the branch checked out at that repository's checkout;
   - `baseCommit`: `git merge-base <baseBranch> <branch>`. No merge base means `409`
     (`unrelated`);
   - `folder`: null; no further worktrees.
   - Title: when typed, it is the owner's (`titleSource: 'owner'`). When left out, it is made
     from the branch (last `/` segment, `-` and `_` as spaces, trimmed to `TASK_TITLE_MAX`)
     with `titleSource: 'input'`, so a run's step note may rename it like any untitled task.
5. Making a task **changes nothing on disk and runs no Git command that writes**. It does not
   commit, copy, check out, or run Setup.
6. The path is re-checked against the candidate list at the moment of the request. Only a
   path Git itself listed for the project ever reaches a Git command. A path that is not a
   current selectable candidate is refused (`404` when not listed, `409` with its reason when
   listed but not selectable, `409` when a task holds it by then).
7. Local projects only. A remote project gets `409`, as other task endpoints do.

## API

Both endpoints follow `~/.claude/standards/api-design.md` and use the tasks router's existing
RFC 9457 problem details, field errors and `X-Trace-Id`.

### `GET /api/tasks/worktree-candidates`

- `project` (required, exact match). Unknown project: `404`. Remote project: `409`.
- `page` (zero-based, default 0), `size` (default 20, max 100), `sort` allow-list: `path`
  (default `path,asc`) with the path as its own stable tiebreaker.
- `200 { data: [candidate…], page: {currentPage, size, totalElements, totalPages, hasNextPage} }`.

### `POST /api/tasks` with `worktreePath`

The existing create endpoint takes a second form:
`{ project, worktreePath, title? }`. `worktreePath` and `repositories` cannot both be given
(`400` naming both). `worktreePath` must be an absolute path string (`400` otherwise).
`201` returns the task in the existing `taskView` shape.

## Run workflow dialog

- **Where to work** gets a fourth choice, **An existing worktree**, shown only when the project
  has at least one candidate. Choosing it shows the candidates (folder name · repository ·
  branch · "N uncommitted"); ones that are not selectable are shown disabled with their reason.
  An optional title input uses the title the backend would make as its placeholder.
- **Start**: first `POST /api/tasks` with `worktreePath`. On success, toast
  "Task “<title>” made from <folder>". Then start the run exactly as for an open task:
  `{ taskId, startIn }` with `startIn` the candidate's repository when the project has several.
- If the run then fails to start, the task stays (it is a real task). The dialog shows the run
  error with a toast and switches to **An open task** with that task chosen, so Start retries.
- The "Also start a run in…" boxes filled from a todo's `**Repositories**` line apply to a new
  task only, as today.

## New task dialog

A **Use an existing worktree** choice beside the title input lists the same candidates. Its
button **Make task** calls the same endpoint, toasts success or failure, and then does what
creating a new task does today (the task opens with a terminal in it).

## Out of scope

- Adding an existing worktree to an open task as a further repository.
- Making one task from several worktrees (e.g. the same branch in two repositories).
- Finding an uncommitted todo in a candidate worktree from the Run dialog's input.
- Any change to startup adoption.
