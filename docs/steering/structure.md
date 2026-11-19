# Project Structure & Conventions

## Coding Guidelines
This project follows the shared coding guidelines in `docs/guidelines/`.
Those guidelines define architectural principles including:
- Backend as single source of truth — no authoritative state in the frontend
- Fail visibly — no silent error swallowing, toast feedback on every action
- Thin route handlers — validate input, delegate to services, return response
- Structured error responses: `{ error: string, detail?: string }`
- Vertical slice development — each feature built end-to-end before moving on

Key guideline files:
- `docs/guidelines/instructions.txt` — core rules, anti-patterns, checklists (always read)
- `docs/guidelines/approach.txt` — implementation layer order within each slice (always read)
- `docs/guidelines/well-architected-framework.md` — full patterns with code examples (read when building features)
- `docs/guidelines/testing.md` — test generation strategy for Vitest + supertest (read when writing tests)

The sections below cover how THIS project applies those standards.

## Architecture Overview
```
client/ (React + Vite)               server/ (Express + node-pty)
┌──────────────────────┐            ┌──────────────────────────┐
│ App.jsx              │            │ index.js                 │
│  ├─ Sidebar          │  REST     │  ├─ REST routes (/api/*) │
│  ├─ TerminalArea     │◄────────►│  ├─ WebSocket server     │
│  │   ├─ Terminal(s)  │  WS       │  │   └─ ws-handler.js    │
│  │   └─ tabs/panes   │◄────────►│  │       └─ PTY pool     │
│  └─ FileTree         │            │  └─ file tree reads      │
│  └─ FileBrowserPanel │            │                          │
│  └─ ToastContext     │            │ db.js                    │
└──────────────────────┘            │  └─ SQLite (~/.codedeck) │
                                    └──────────────────────────┘
```

The backend is an Express app in `server/index.js` with WebSocket connection handling extracted to `server/ws-handler.js`. Route handlers remain in `index.js`. If it grows past ~400 lines, extract route groups into `server/routes/`.

## Directory Layout
```
codedeck/
├── server/
│   ├── index.js          # REST routes, WebSocket server, PTY spawn factory
│   ├── ws-handler.js     # WebSocket connection handler, snapshot-first attach, diagnostics, transport replay
│   ├── terminal-runtime.js # tmux-required terminal runtime + snapshot capture helpers
│   ├── terminal-execution-classifier.js # Combines main pane, sub-agent panes, and silence
│   ├── agent-profiles/  # Pure live-screen readers for Codex, Claude, Cursor, agy, Muse
│   ├── agent-history/   # Read-only CLI history readers, merge/search, and resume command/service
│   ├── terminal-waiting-store.js # SQLite store for per-tab waiting marks
│   ├── terminal-session-worktree-store.js # Durable spawn-worktree mapping per session id
│   ├── terminal-session-worktree-start.js # Shared detached-session start wrapper
│   ├── terminal-worktree-service.js # Older endpoint's service: branch + worktree + terminal (the client now uses tasks)
│   ├── tasks/
│   │   ├── task-store.js     # SQLite store for tasks: title, worktree, branch, base, state, PR URL
│   │   ├── task-service.js   # Plans and creates a task's worktree; opens terminals in it; renames
│   │   ├── task-landing.js   # Live Git status and commit, merge, pull request and close; nothing forced
│   │   ├── task-terminals.js # Closes a finished task's terminals: those opened in it and those its runs used
│   │   ├── task-naming.js    # Names a task started without a title from its run's first step note, with the session-naming CLI
│   │   └── task-adoption.js  # At startup, worktrees already in use become tasks
│   ├── routes/
│   │   ├── terminal-waiting.js   # Paginated waiting collection + PUT mark/clear (RFC 9457 errors)
│   │   ├── terminal-worktrees.js # POST new worktree terminal (kept for older clients)
│   │   ├── tasks.js              # Tasks: list, create, rename, terminals, landing of the task and of one repository (RFC 9457 errors)
│   │   ├── project-repositories.js # A project's repositories: list, candidates, add, remove, terminal (RFC 9457 errors)
│   │   ├── collection-query.js   # Shared page/size/sort/filter parsing and the page envelope
│   │   └── agent-sessions.js     # Paginated local agent conversations + resume API
│   ├── project-repositories.js # A project's other repositories: rules, Git check, the repositories beside it, terminals in them
│   ├── launch-settings.js # Companion settings read from ~/.codedeck/launch.env at startup
│   ├── db.js             # SQLite connection, schema, WAL mode
│   ├── vitest.config.js  # Server-side test configuration
│   └── __tests__/
│       └── ws-handler.test.js  # Unit tests for WebSocket handler (90 tests)
├── client/
│   ├── index.html        # Vite entry
│   ├── vite.config.js    # Dev server, proxy config
│   └── src/
│       ├── main.jsx      # React root
│       ├── App.jsx       # Top-level state, project CRUD, layout
│       ├── components/
│       │   ├── Sidebar.jsx           # Project list, status cockpit, file browse trigger
│       │   ├── TerminalArea.jsx      # Tab bar, N-pane layout, localStorage persistence
│       │   ├── TerminalTabBar.jsx    # Tab row container and actions
│       │   ├── SidebarSessionRows.jsx # Per-project session details
│       │   └── WorktreeGroupHeader.jsx # Sidebar row for Main or a task: title, run status and progress
│       │   ├── tasks/
│       │   │   ├── NewTaskDialog.jsx  # Title input for a new task
│       │   │   ├── TaskLandingBar.jsx # How a task stands in Git, and Commit / Merge / PR / Close / Rename
│       │   │   ├── TaskRepositoriesLanding.jsx # The same for a task with several repositories: one row per repository
│       │   │   └── TaskView.jsx       # A run as its task: header, step rail, step detail above the terminals
│       │   ├── Terminal.jsx          # xterm.js + WebSocket per session, snapshot hydration, transport replay, visibility recovery
│       │   ├── TerminalInspector.jsx # Debug inspector: health, timeline, recovery actions, snapshot copy
│       │   ├── PaneDivider.jsx       # Draggable vertical divider between terminal panes
│       │   ├── ShortcutsOverlay.jsx  # Keyboard shortcut reference modal
│       │   ├── SessionSearch.jsx     # Agent conversation history search and resume modal
│       │   ├── FileTree.jsx          # Directory tree renderer
│       │   ├── FileBrowserPanel.jsx  # Modal overlay for per-project file browsing
│       │   ├── DirectoryBrowser.jsx  # Modal filesystem navigator (project picker)
│       │   ├── ToastContext.jsx      # Toast notification context, hook, and container
│       │   └── SettingsPanel.jsx     # Settings modal
│       ├── hooks/
│       │   ├── useTasks.js           # Open tasks from the backend, polled every two seconds
│       │   └── useWaitingSessions.js # Backend-confirmed waiting marks (no optimistic dimming) + app-wide auto-clear
│       ├── utils/
│       │   ├── terminalWaiting.js    # Waiting tab identity, left grouping, auto-clear rules, quiet indicator sets
│       │   ├── worktreeGroups.js    # Pure grouping of a project into Main and its tasks, display name and session edge guard
│       │   ├── tasksApi.js          # Validated client for tasks and landing
│       │   ├── workflowBuilder.js   # Window event that asks the app to open the workflow builder
│       │   ├── pipelineRunStatus.js # Pure run and step display states
│       └── styles/
│           └── global.css            # CSS custom properties theme
├── docs/
│   ├── guidelines/       # Shared coding standards
│   ├── specifications/   # Feature specs
│   ├── steering/         # These files
│   └── todos/            # Implementation tracking
├── start.sh              # Foreground launcher; starts backend + frontend, traps Ctrl-C/TERM for cleanup
├── server.sh             # Detached service manager; port checks, PID/log files, status/logs/restart
└── package.json          # Workspace root (devDependencies: vitest, supertest)
```

## Component Conventions

### React Components
- Functional components with hooks, no class components
- State management via `useState`/`useEffect` in `App.jsx`, passed down as props
- No state management library (Redux, Zustand) — prop drilling is fine at this scale
- Inline styles using CSS custom properties from `global.css` (no CSS modules, no Tailwind)
- Icons from lucide-react, sized 12-16px depending on context

### Styling
- Dark theme with green accent (`--accent: #6ee7b7`)
- All colors via CSS custom properties in `:root`
- Fonts: JetBrains Mono (monospace), Outfit (sans-serif)
- Modals: overlay with `backdrop-filter: blur(4px)`, `slideUp` animation
- Consistent border radius: 4px for small elements, 6px for inputs, 8-12px for panels

### Backend Patterns
- REST routes in `server/index.js` — grouped by concern with comment headers
- WebSocket connection handling extracted to `server/ws-handler.js` — receives `(ws, req, sessions, runtime)` for testability via dependency injection
- Terminal runtime contract in `server/terminal-runtime.js` — exported factory always enforces tmux-backed sessions, captures authoritative reconnect snapshots, and is injected into `ws-handler.js`
- Synchronous SQLite via better-sqlite3 (no async/await needed for DB calls)
- PTY sessions stored in a `Map<sessionId, { pty, ws, cwd, startedAt, lastOutputAt, alive, wsAttached, lastSeq, replayBuffer, events[], ... }>` in memory
- PTY listeners (onData, onExit) registered ONCE per PTY at creation — they read `entry.ws` to route to the current WebSocket, avoiding stale closure references on reconnect
- Output sequencing: each PTY output chunk gets a monotonic `seq`, stored in a bounded replay buffer (1000 entries) for transport catch-up and loss-aware recovery
- WebSocket messages are JSON: `{ type: 'input'|'output'|'resize'|'session'|'snapshot'|'history_warning'|'spawn_error'|'heartbeat'|'resume'|'replay'|'visibility_change'|'recovery_action', ... }`
- File tree reads are depth-limited (3 levels) and skip: `node_modules`, `.git`, `.next`, `dist`, `build`, `target`, `.idea`, `__pycache__`, `.DS_Store`
- Process orchestration is shell-script based rather than npm-root-script based: `start.sh` owns foreground lifecycle, while `server.sh` handles detached launch, port checks, PID tracking, and log tailing

## API Conventions
- Base path: `/api/` (no versioning — single-user tool)
- REST semantics: GET (read), POST (create), PUT (update), DELETE (remove)
- Request bodies: JSON with `Content-Type: application/json`
- Success responses: resource object directly (no envelope)
- Error responses: `{ error: "human-readable message" }` with status 400/404/409/500
- WebSocket path: `/ws/terminal` with query params `cwd`, `sessionId`, `cols`, `rows`

## Error Handling Pattern
- Backend: validate input in route handler → return `{ error }` with appropriate status
- Frontend: every `fetch()` wrapped in try/catch, check `res.ok`, show toast on success/failure
- WebSocket: handle `onclose`/`onerror`, reconnect with exponential backoff
- No `catch(() => {})` or `catch {}` — errors must be handled or surfaced

## Testing Conventions
- Framework: Vitest + supertest (installed as devDependencies at workspace root)
- Server test config: `server/vitest.config.js` with `maxWorkers: 1`
- Run server tests: `cd server && npx vitest --maxWorkers=1`
- Existing tests: `server/__tests__/ws-handler.test.js` — 23 unit tests covering listener registration, WebSocket reference tracking, PTY output routing, exit handling, input forwarding, and spawn failure
- Client tests: Vitest + React Testing Library for component tests (not yet set up)
- See `docs/guidelines/testing.md` for full testing strategy

## Architectural Rules
- NEVER let the frontend hold authoritative state — SQLite is the source of truth
- NEVER swallow errors silently — every catch must handle or surface the error
- NEVER pass unsanitized paths to shell commands — validate existence first
- ALWAYS show toast feedback for mutating actions (success and failure)
- ALWAYS handle WebSocket disconnect/reconnect visibly
- ALWAYS start normal local sessions via `./server.sh start` — it provides detached launch, port conflict checks, logs, and PID management
- ONLY use `./start.sh` when you intentionally want a foreground dev session that dies with the terminal
- NEVER document `node server/index.js` as the normal startup path — the supported backend dev entrypoint is `cd server && npm run dev`
- ALWAYS use the existing CSS custom properties for colors — no hardcoded hex values in components (except in the theme definition itself)

## Agent session history API

`GET /api/agent-sessions` lists local project conversations from Claude Code, Codex, Cursor agent, and Antigravity. Optional `project`, `cli`, and `q` filters use exact project/CLI matches and a case-insensitive title/prompt substring. Zero-based `page` defaults to 0; `size` defaults to 20 and is limited to 100. The only sort is `-updatedAt`, with CLI and conversation UUID as stable ties. The response has `data`, `page`, and per-CLI `sources` availability. A named remote project returns 409; unknown projects return 404.

`POST /api/agent-sessions/resume` takes `{cli, conversationId, project}`, checks that the UUID exists for that local project, allocates a new detached tmux terminal through the mobile session starter, and submits the fixed CLI resume command. It returns 201 with `{sessionId, project, cli, conversationId}`. Concurrent identical requests return 409. Both endpoints use RFC 9457 problem details and `X-Trace-Id`; 400 responses contain field errors. The readers open external SQLite stores read-only.

## Workflow pipelines

The per-terminal Workflow bar and browser control messages were removed. Only pipeline runs use the loop engine through background terminal attachments.

- `shared/pipeline-definitions.mjs`: shared definition validation and prompt composition.
- `shared/workflow-templates.mjs`: immutable Bug fix and Feature build starting points, shared by client and server without saved template state.
- `shared/todo-repositories.mjs`: reads a todo's `**Repositories**:` line (which repositories its work touches, and how). `POST /api/pipelines/run-plans` uses it to say, before a run starts, where its todo is and what that line asks for; the Run workflow dialog fills its choices in from the answer.
- `server/pipelines/`: revisioned SQLite stores, Git worktree operations, readiness
  classification, pure run state transitions and serialized background execution.
  `step-guidance.js` builds what a looping or self-deciding step is told beyond the
  standard instruction; `decision-store.js` keeps the append-only record of requests
  agents settled themselves (`pipeline_run_decisions`).
- `server/pipelines/run-progress.js`: asynchronously reads and caches a run's Markdown phase and task progress inside its worktree.
- `server/pipelines/run-notes.js`: prepares an ignored per-run notes folder and safely reads each step's note inside the worktree.
- `server/pipelines/request-store.js`: reserves run start IDs with their original parameters before
  provisioning. A replay can resume an unfinished reservation using its recorded task.
- `server/pipelines/run-terminal-muting.js`: pure plan for which of a run's step terminals show live status; `terminal-muting-adapter.js` applies it after the attention tracker observes a session.
- `server/pipelines/note-store.js`: append-only SQLite copies of step notes and their pass outcomes (`pipeline_run_notes`).
- `server/pipelines/review-store.js`: append-only owner approval and send-back reviews (`pipeline_run_reviews`); `run-notes.js` writes their comments to the step feedback file.
- `server/routes/pipelines.js`: definitions, settings, preflight and owner actions;
  transport validation and RFC 9457 errors. See `api-standards.md` for the contract.
- `client/src/components/pipelines/`: definition editors and the Run dialog. `PipelineRunsBar.jsx`
  is no longer rendered; its question and approval panels are used by the task view.
- `client/src/components/pipelines/builder/WorkflowsScreen.jsx`: the full-screen workflow builder.
  It renders `WorkflowList` and `WorkflowEditor` with `variant="builder"`: a step rail with drag
  reorder, one open step, and a preview from `POST /api/pipelines/prompt-previews`. The same two
  components with `variant="form"` are the older editor still shown in Settings → Workflows.
- `server/pipelines/answer-store.js`: append-only owner answers (`pipeline_run_answers`). With the run's input
  and the agents' decisions they make up the run's brief, which `run-notes.js` `writeBrief` writes to
  `brief.md` in the run notes whenever a question is answered. `shared/workflow-templates.mjs` also exports
  `BUILT_IN_STEPS` (Clarify), offered beside the owner's saved steps.
- `server/pipelines/library-store.js`: owner-saved workflow templates (`pipeline_workflow_templates`)
  and saved steps (`pipeline_step_presets`); both are copied when used and never referenced by a run.
- `shared/pipeline-definitions.mjs` also holds the workflow kinds, the template mode of the
  workflow validator and the saved-step validator.
- `client/src/components/pipelines/pipeline-runs.css`: run status, actions, connected step sequence and panels.
- `client/src/hooks/usePipelineRuns.js`: active-project runs and action feedback.
- `client/src/hooks/usePipelineRunCounts.js`: all-project open-run counts, polled
  every two seconds without overlapping requests; pagination uses `pipelinesApi`.
- `client/src/utils/terminalAdoption.js`: plan step tabs without stealing focus.
- `SettingsPanel.jsx` keeps tab panels mounted; Hosts/Workflows save per item and
  report dirty drafts for close confirmation. Sidebar renders counts for active,
  waiting and shelved project rows, including compact active rows.

## Tasks

A task owns a Git worktree and a branch; a workflow run only works in one. `pipeline_runs.task_id`
links a run to its task (null for a run in Main or in a worktree named by path). To the run
engine a task's worktree is one that already existed (`worktreeState: 'external'`), so the engine
never creates or removes it; a run in a task created for it still gets the Setup step.

- `server/tasks/task-service.js` splits creation into `plan` (validates and names, changes
  nothing) and `createPlanned`, so `POST /api/pipelines/runs` can refuse a run before any
  worktree exists. Creation writes the task row before adding the worktree at the recorded
  commit. If Git fails and leaves no folder, creation deletes the initial row.
- `server/tasks/task-landing.js` reads everything from Git when asked. Merge runs in the
  project's own checkout and aborts on conflict. Finishing a task releases its runs
  (`onTaskFinished` in `server/index.js`).
- `server/tasks/task-adoption.js` runs once at startup; a failure is logged and does not stop
  the server.
- The client groups a project into Main and its open tasks by worktree path
  (`utils/worktreeGroups.js`); a worktree with sessions or a run but no task still appears, by
  folder name, and terminals cannot be opened in it from the UI.
- A step whose pass or round limit the owner continued past has the status `limit_accepted`.

### Several repositories

A project's `path` is its own repository; `repositories` on the project lists the others
(`server/project-repositories.js`). A task has one row in `task_worktrees` per repository it
includes (`server/tasks/task-store.js`): the worktree it started in is its first, and supplies
the task's `worktreePath`, `branch`, `baseBranch`, `baseCommit` and `prUrl` for callers that read
one worktree. The task's state is derived from its worktrees and stored with them in one
transaction. A worktree of the project's own repository has no stored checkout (it is the
project's path when asked); another repository's checkout is stored on the row.

- `planTaskFolder` (`server/pipelines/run-worktree.js`) puts the worktrees of a task of a project
  with other repositories in one folder, each under its repository's name; a project with only its
  own repository keeps `worktrees/<repo>-<slug>-<id>`.
- `server/tasks/task-landing.js` acts on one worktree against the checkout it is listed with;
  the task finishes with its last one. A merged branch is deleted from that checkout, because Git
  deletes a branch only when it is merged into the branch checked out where it is asked.
- `server/pipelines/run-places.js` says, when a step starts, where a run may work (the open
  worktrees of its task, or the one checkout it runs in) and read (the project's other
  repositories). The step guidance, the run notes and the Setup guard all use it.
- The client keeps every worktree of a task in the task's one group and every repository of the
  project in Main (`groupKeyForPath` in `utils/worktreeGroups.js`); a group's key is still a path.
- The phone reads tasks with `parseTaskSummary`, the fields every backend release sends, because
  an installed phone build also talks to an instance older or newer than itself.
