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
- File tree browsing — view project files, click to open in system editor (VS Code, etc.)
- Per-project file browsing — scoped file tree panel decoupled from active project
- Directory browser — filesystem navigator for adding projects
- Settings panel — configurable default path for project picker
- PTY session persistence — terminals survive WebSocket reconnects, layout restored from localStorage
- Live sidebar cockpit — per-project status (active/idle/dead), terminal count, elapsed time
- Toast notification system — success/error feedback on all actions
- Connection awareness — detect backend unreachable, show reconnection banner with exponential backoff
- Keyboard shortcut passthrough — Ctrl+R/W/T/N forwarded to PTY instead of browser
- Terminal resilience — pane-local debug inspector, visibility-aware refocus recovery, heartbeat/sequence-tracked replay, explicit recovery actions (reconnect/resync/redraw)
- Durable sessions by default — tmux-backed terminal runtime is the default when available; raw PTY remains available via explicit override
- Optional sleep prevention — `CODEDECK_CAFFEINATE=1` wraps startup under macOS `caffeinate`

**Future (not yet specified):**
- Workflow panel for orchestrating tasks across projects

## Domain Model
- **Project**: a named directory on disk. Stored as `{ name, path }` in SQLite config.
- **Terminal session**: a PTY process (node-pty or tmux-backed) keyed by `${projectName}-N`. Lives in server memory. Survives WebSocket reconnects; tmux-backed sessions also survive server restarts.
- **Config**: generic key-value store in SQLite. Currently holds `projects` list and `defaultPath` setting.

## Domain Terminology
- **PTY**: pseudo-terminal — the OS-level terminal emulator that runs the user's shell
- **Session**: a single PTY process identified by sessionId, tied to a project
- **Pane**: a visible terminal within a tab (multiple panes = side-by-side split)
- **Tab**: a group of panes within a project's terminal area
- **Cockpit**: the sidebar view showing ambient status across all projects

## Business Rules
- Projects are directories — they must exist on disk when added
- Project paths are unique (no duplicates)
- Terminal sessions are ephemeral — they don't persist across server restarts
- The backend is the source of truth for all state — frontend never holds authoritative state
- Every user action that modifies state must round-trip through the backend
