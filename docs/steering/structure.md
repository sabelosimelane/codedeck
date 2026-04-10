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
│   ├── ws-handler.js     # WebSocket connection handler (extracted for testability)
│   ├── db.js             # SQLite connection, schema, WAL mode
│   ├── vitest.config.js  # Server-side test configuration
│   └── __tests__/
│       └── ws-handler.test.js  # Unit tests for WebSocket handler (23 tests)
├── client/
│   ├── index.html        # Vite entry
│   ├── vite.config.js    # Dev server, proxy config
│   └── src/
│       ├── main.jsx      # React root
│       ├── App.jsx       # Top-level state, project CRUD, layout
│       ├── components/
│       │   ├── Sidebar.jsx           # Project list, status cockpit, file browse trigger
│       │   ├── TerminalArea.jsx      # Tab bar, N-pane layout, localStorage persistence
│       │   ├── Terminal.jsx          # xterm.js + WebSocket per session, keyboard shortcuts
│       │   ├── PaneDivider.jsx       # Draggable vertical divider between terminal panes
│       │   ├── FileTree.jsx          # Directory tree renderer
│       │   ├── FileBrowserPanel.jsx  # Modal overlay for per-project file browsing
│       │   ├── DirectoryBrowser.jsx  # Modal filesystem navigator (project picker)
│       │   ├── ToastContext.jsx      # Toast notification context, hook, and container
│       │   └── SettingsPanel.jsx     # Settings modal
│       └── styles/
│           └── global.css            # CSS custom properties theme
├── docs/
│   ├── guidelines/       # Shared coding standards
│   ├── specifications/   # Feature specs
│   ├── steering/         # These files
│   └── todos/            # Implementation tracking
├── start.sh              # Launches both servers (foreground)
├── server.sh             # Service manager (background start/stop/status)
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
- WebSocket connection handling extracted to `server/ws-handler.js` — receives `(ws, req, sessions, spawnPty)` for testability via dependency injection
- Synchronous SQLite via better-sqlite3 (no async/await needed for DB calls)
- PTY sessions stored in a `Map<sessionId, { pty, ws, cwd, startedAt, lastOutputAt, alive }>` in memory
- PTY listeners (onData, onExit) registered ONCE per PTY at creation — they read `entry.ws` to route to the current WebSocket, avoiding stale closure references on reconnect
- WebSocket messages are JSON: `{ type: 'input'|'output'|'resize'|'session'|'spawn_error', ... }`
- File tree reads are depth-limited (3 levels) and skip: `node_modules`, `.git`, `.next`, `dist`, `build`, `target`, `.idea`, `__pycache__`, `.DS_Store`

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
- ALWAYS start servers via `./server.sh` — never run `node server/index.js` directly (blocks the terminal)
- ALWAYS use the existing CSS custom properties for colors — no hardcoded hex values in components (except in the theme definition itself)
