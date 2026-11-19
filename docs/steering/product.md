# Product Overview

## What This Is
CodeDeck is a lightweight multi-project terminal workspace for developers who work across 3-5 projects simultaneously. It replaces the need for multiple IDE windows by providing terminal multiplexing, project switching, and file browsing in a single browser-based UI. Built as a personal tool — single user, local machine, no auth.

## Target Users
Developers who juggle multiple codebases daily. The core pain points are:
- Machine performance degradation from 5-6 open IDEs
- Losing track of what's running and where across projects
- Context-switching friction between project terminals

## Key Features

**Implemented:**
- Project management — add, rename, delete projects (directories on disk)
- Terminal multiplexing — multiple terminal tabs per project, N side-by-side panes with draggable dividers
- Tasks — a titled piece of work with its own Git worktree and branch, created from a title alone; listed by title under its project beside Main, in the sidebar and the tab switcher. Terminals, splits and workflow runs open in the task being looked at
- Several repositories in one project — a project lists the repositories that belong with its own; Main reaches all of them, a task has one worktree per repository it includes, kept in one folder, and each repository is landed on its own
- Landing — each task shows live from Git its uncommitted files and commits not yet in its base branch, and offers Commit changes, Merge (aborted and reported on conflict), Open a pull request (`gh`/`glab`), Close task and Rename; nothing is forced
- File tree browsing — view project files, click to open in system editor (VS Code, etc.)
- Per-project file browsing — scoped file tree panel decoupled from active project
- Directory browser — filesystem navigator for adding projects
- Settings panel — General, Session naming, Hosts and Workflows tabs; agents, Setup selection and ordered workflow editors
- PTY session persistence — terminals survive WebSocket reconnects, layout restored from localStorage
- Session search — search each agent CLI's local conversation history and resume a conversation in a terminal tab in its project
- Live sidebar cockpit — per-project status (active/idle/dead), terminal count, elapsed time
- Waiting tabs — manually park a tab whose work has been delegated to an agent; it renders compact and dimmed at the left of the tab bar, its status indicators stop pulsing everywhere, it is counted per project in the sidebar, and the mark auto-clears when the work finishes — whichever project is on screen
- Toast notification system — success/error feedback on all actions
- Connection awareness — detect backend unreachable, show reconnection banner with exponential backoff
- Keyboard shortcut passthrough — Ctrl+R/W/T/N forwarded to PTY instead of browser
- Terminal resilience — pane-local debug inspector, visibility-aware refocus recovery, heartbeat/sequence-tracked transport replay, explicit recovery actions (reconnect/resync/redraw)
- Truthful durable terminals — tmux is required, reconnects reseed from fresh snapshots, and degraded preserved history is warned explicitly instead of silently bluffing
- Optional sleep prevention — `CODEDECK_CAFFEINATE=1` wraps startup under macOS `caffeinate`

- Workflow pipelines — runs work inside a task (a new one, an open one, or Main), with a Setup cleanliness guard for a new task, Setup cleanliness guard, ordered agent steps, bounded repeat passes, one terminal per agent (steps with the same agent share it, a new run reuses the ones an earlier run left in the worktree, and the agent is cleared before each prompt), loops over a group of steps, an optional per-workflow "let agents decide" with a record of every decision, Stop/Resume/Continue and safe cleanup. The per-terminal Workflow bar was removed; only pipeline runs use the loop engine.
- Task view — a run is shown as its task: status in words, the steps as a rail, and the selected step's questions, approval, notes, decisions and reviews above its terminal
- Workflow builder — a full screen with workflows, a draggable step rail, a large prompt editor and a backend-composed preview of what the agent is sent; workflow kinds, step roles, built-in templates (Bug fix, Feature build, Troubleshoot, Review only), owner-saved templates and reusable saved steps
- Run progress and sidebar counts — persisted run progress with automatic terminal-tab adoption; backend restarts require explicit Resume

## Domain Model
- **Project**: a named directory on disk. Stored as `{ name, path, repositories }` in SQLite config. `path` is its own repository; `repositories` lists the others that belong with it (`{ name, path }`, the path being the checkout tasks start from and merge into). The grouping exists only in CodeDeck.
- **Task**: a titled piece of work in a project, stored in SQLite with its title and state (`active`, `pr_open`, `merged`, `closed`) and one worktree per repository it includes, each with its path, branch, base branch and commit, its own state and pull request URL. A task is open while any of its worktrees is. Its Git facts are read live, never stored. A workflow run may belong to one task.
- **Terminal session**: a tmux-backed PTY attachment keyed by `${projectName}-N`. Live browser attachments are tracked in server memory, while the underlying tmux session survives WebSocket reconnects, browser closes, and server restarts.
- **Config**: generic key-value store in SQLite. Currently holds `projects` list and `defaultPath` setting.

## Domain Terminology
- **PTY**: pseudo-terminal — the OS-level terminal emulator that runs the user's shell
- **Session**: a single PTY process identified by sessionId, tied to a project
- **Pane**: a visible terminal within a tab (multiple panes = side-by-side split)
- **Tab**: a group of panes within a project's terminal area
- **Cockpit**: the sidebar view showing ambient status across all projects
- **Main**: the project's own checkout, as opposed to a task's copy of it
- **Landing**: getting a task's work back into the project: commit, merge, pull request or close
- **Waiting (tab)**: a user-set mark on a tab, keyed to its first pane's session, meaning "an agent is working here — stay quiet until it lands". Distinct from project waiting (which parks a whole project) and from status muting (which is permanent until undone).

## Business Rules
- Projects are directories — they must exist on disk when added
- Project paths are unique (no duplicates)
- Deleting a project closes all of its terminal sessions before removing it from the saved list
- Terminal durability depends on tmux — when tmux is unavailable, the UI must block terminal creation and ask the user to install it
- A tab's waiting mark is cleared by the backend when its session is deleted — session ids are reused, and a stale mark would silence a new terminal
- A task with uncommitted work is never removed, and merging requires Main to be clean and on the task's base branch
- In a task with several repositories each is landed on its own, against the checkout it is listed with; a working run blocks all of them, and Close task closes every repository or none
- A run has one working directory, a worktree of one repository; it may change the other worktrees of its task and only read the project's remaining repositories. A task takes one unfinished run at a time
- Merging or closing a task closes its terminals — the ones opened in it and the ones its runs used — because their folder is removed
- The backend is the source of truth for all state — frontend never holds authoritative state
- Every user action that modifies state must round-trip through the backend

Pipeline definitions and run snapshots are persisted in SQLite. A task owns its worktree: a
run never removes it. The folder goes when the task is merged or closed, never by force;
a merged branch is deleted, an unmerged one is kept. Finishing a task closes its runs.
