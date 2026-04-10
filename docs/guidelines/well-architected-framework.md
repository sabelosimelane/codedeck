# Well-Architected Framework — CodeDeck

## Table of Contents
1. [Introduction](#introduction)
2. [Technology Stack](#technology-stack)
3. [Architectural Principles](#architectural-principles)
4. [Application Structure](#application-structure)
5. [Best Practices](#best-practices)
6. [Frontend Patterns](#frontend-patterns)

## Introduction

CodeDeck is a lightweight multi-project terminal workspace. This framework governs how it's built — ensuring clean separation between backend and frontend, reliable error handling, and a responsive user experience.

Every user action that modifies state must round-trip through the backend. The frontend is a rendering layer — it does not hold authoritative state.

## Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Backend Runtime | Node.js (ES Modules) | Lightweight, native PTY support via node-pty |
| Backend Framework | Express | Minimal HTTP framework, WebSocket support via ws |
| Database | SQLite (better-sqlite3) | Embedded, zero-config, WAL mode for concurrent reads |
| Terminal | node-pty + xterm.js | Real PTY sessions over WebSocket |
| Frontend | React (Vite) | Fast dev server, HMR, proxy to backend |
| Icons | lucide-react | Consistent icon set |

## Architectural Principles

1. **Backend is the source of truth** — all state lives in SQLite. The frontend reads and writes via API calls. If the backend is unreachable, the frontend must show an error — never silently proceed.
2. **Separation of concerns** — Express handles REST + WebSocket. React handles rendering. No business logic in the frontend.
3. **Fail visibly** — every API call must handle failure. The user must see feedback for both success and failure (toasts, status indicators).
4. **Thin controllers** — Express route handlers validate input, call a service function, and return a response. No business logic inline in route definitions.
5. **No silent failures** — `catch(() => {})` is forbidden. Errors must be logged, surfaced to the user, or both.

## Application Structure

```
server/
  index.js          — Express app, routes, WebSocket server
  db.js             — SQLite connection and schema migrations
  services/         — Business logic (project management, config, etc.)

client/
  src/
    App.jsx         — Root component, data fetching, top-level state
    components/     — UI components (Sidebar, TerminalArea, Terminal, etc.)
    hooks/          — Shared React hooks (useApi, useToast, etc.)
    styles/         — Global CSS
```

### Backend Layer

#### Route Handlers (API Layer)
- Validate input (required fields, path existence, types)
- Call service functions for any state mutation
- Return consistent response shapes:
  - **Success**: `{ data: ... }` or the resource directly
  - **Error**: `{ error: string, detail?: string }` with appropriate HTTP status

```javascript
// Good — validates, delegates, returns consistently
app.post('/api/projects', (req, res) => {
  const { name, path: projectPath } = req.body;
  if (!name || !projectPath) return res.status(400).json({ error: 'name and path required' });
  if (!existsSync(projectPath)) return res.status(400).json({ error: 'path does not exist' });

  const result = projectService.addProject(name, projectPath);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.data);
});
```

#### Service Layer (Business Logic)
- Pure functions or stateless modules
- Accept validated inputs, return results or error objects
- Never touch `req`/`res` — those belong to the route handler
- Database access goes through db helpers, not raw SQL in service functions

#### Data Layer
- SQLite via better-sqlite3 (synchronous API)
- Schema migrations in `db.js` using `CREATE TABLE IF NOT EXISTS`
- WAL mode enabled for concurrent reads
- Foreign keys enforced

### Frontend Layer

#### State Management
- Top-level state in `App.jsx`, passed down via props
- All data fetched from the backend API — no localStorage as primary storage
- Optimistic UI updates are allowed **only** if followed by a backend confirmation and rollback on failure

#### API Interaction Pattern
Every API call must:
1. Show a loading state if the operation takes time
2. On success: update local state **from the backend response** (not from the request payload)
3. On failure: show user-visible feedback (toast notification) and revert any optimistic state
4. Never silently swallow errors

```javascript
// Good — confirms with backend, shows feedback, handles failure
const renameProject = async (oldName, newName) => {
  const project = projects.find(p => p.name === oldName);
  if (!project) return;
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(oldName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, path: project.path }),
    });
    if (!res.ok) {
      const err = await res.json();
      showToast({ type: 'error', message: err.error || 'Failed to rename project' });
      return;
    }
    const updated = await res.json();
    showToast({ type: 'success', message: `Renamed to ${updated.name}` });
    await fetchProjects(); // re-sync from backend
  } catch {
    showToast({ type: 'error', message: 'Server unreachable' });
  }
};
```

#### Toast / Notification Pattern
- Success: brief confirmation ("Project renamed")
- Error: actionable message ("Failed to rename — server unreachable")
- Auto-dismiss after 3-4 seconds for success, longer for errors
- Toasts stack if multiple fire quickly

#### Connection Awareness
The frontend must detect when the backend is unreachable:
- WebSocket disconnect → show a reconnection banner
- REST API failures → show toast with "server unreachable" when fetch throws (not just non-2xx)
- Periodic health check (optional) for ambient awareness

## Best Practices

### Validation
- **Backend**: validate at every route handler. Required fields, type checks, path existence.
- **Frontend**: validate for UX only (disable submit button, inline hints). Never trust frontend validation as the sole gate.

### Error Handling
- Backend: use try/catch around filesystem and database operations. Return structured error responses.
- Frontend: every `fetch()` must have error handling. No bare `await fetch(...)` without checking the response.
- WebSocket: handle `onerror` and `onclose` events. Show reconnection state to the user.

### Error Response Format
All backend error responses follow this shape:

```json
{
  "error": "Human-readable error message",
  "detail": "Optional technical detail for debugging"
}
```

HTTP status codes:
- `400` — bad input (missing fields, invalid path)
- `404` — resource not found
- `409` — conflict (duplicate project)
- `500` — unexpected server error

### Security
- Never pass unsanitized user input to shell commands. Validate that file paths exist and are files before opening them.
- Sanitize file paths to prevent directory traversal.
- Prefer `execFile` over shell-based execution to avoid command injection.
- Do not expose sensitive environment variables through the API.

### Performance
- SQLite with WAL mode handles CodeDeck's concurrency needs.
- File tree reads are depth-limited (default 3 levels) and skip ignored directories.
- PTY sessions are pooled and persist across WebSocket reconnections.

## Frontend Patterns

### Component Guidelines
- Components receive data and callbacks via props — no direct API calls in leaf components (except Terminal which manages its own WebSocket)
- Inline styles using CSS custom properties for theming
- Icons from lucide-react, sized consistently (12-16px depending on context)

### Layout
- Sidebar: fixed width, scrollable project list
- Terminal area: flexible panes, tab bar for terminal management
- File tree: collapsible panel between sidebar and terminal area
- Modals: overlay with backdrop blur, dismiss on outside click or Escape

### Pre-Commit Checklist

- [ ] Every API call in the frontend has error handling (no bare fetch)
- [ ] Success and failure both produce user-visible feedback
- [ ] State mutations go through the backend — frontend doesn't write to localStorage as source of truth
- [ ] No `catch(() => {})` anywhere — errors are handled or logged
- [ ] New routes validate input before processing
- [ ] File paths passed to shell commands are validated
- [ ] WebSocket handlers handle disconnect/reconnect gracefully
