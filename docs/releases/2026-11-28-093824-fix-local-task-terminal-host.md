## [2026-11-28] - Keep local task terminals on their selected worktree

### Executive Summary
* Terminals opened from a local task now reserve and start on the local host, even when the project’s default host is remote. This prevents a local worktree path from being sent to remote tmux and the shell appearing in the remote home directory. Explicitly remote tasks continue to start on their selected remote host.

### Technical Details
* `server/tasks/task-service.js` — pass the task host (defaulting legacy tasks without a host to `local`) and `skipSync: true` to the terminal starter for both the task’s initial terminal and a selected repository terminal.
* `server/__tests__/task-service.test.js` and `server/__tests__/task-service-repositories.test.js` — update the starter option expectations and add cross-host regressions covering local and remote tasks, recorded host/worktree, and the runtime receiving the start request.

### Tests and Verification
* Server targeted checks passed: task service, repository task service, mobile session start and live terminal respawn suites (4 files, 102 tests).
* Client terminal worktree/repository checks passed (2 files, 32 tests).
* Disposable live verification passed for initial and additional terminals: local host reservation, canonical worktree cwd before and after reconnect, tmux pane path, session API data, and rendered browser cwd label after refresh/reload.
* Full suites reported 13 failures; the run notes record the same failures on the clean base commit, so they were identified as pre-existing. No owner checks remain for this fix.
