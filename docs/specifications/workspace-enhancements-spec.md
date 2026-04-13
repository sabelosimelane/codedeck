# Workspace Enhancements — Feature Specification

**Version:** 1.0
**Date:** 2026-04-10
**Status:** Implemented

## 1. Overview

CodeDeck is a lightweight multi-project terminal workspace for developers who work across 3-5 projects simultaneously. This specification covers four enhancements that transform it from a basic terminal multiplexer into an informed operations dashboard:

1. **Flexible terminal panes** — arbitrary side-by-side splits with draggable dividers
2. **Live sidebar cockpit** — ambient status indicators per project (terminal count, activity, elapsed time)
3. **Per-project file browsing** — scoped file tree panel, decoupled from the active project
4. **Error handling & feedback foundation** — toast notifications, connection awareness, no silent failures

These features are cross-cutting — the error handling foundation underpins all other features.

## 2. Current Architecture

```
┌──────────┬──────────────────────────────────┐
│ Sidebar  │  Terminal Area                    │
│ (220px)  │  ┌─────────────────────────────┐  │
│          │  │ Tab bar (Terminal 1, 2...)   │  │
│ Project  │  ├─────────────────────────────┤  │
│ list     │  │                             │  │
│          │  │  Terminal pane(s)            │  │
│          │  │  (currently: 1 or 2 max)    │  │
│          │  │                             │  │
│          │  └─────────────────────────────┘  │
└──────────┴──────────────────────────────────┘
```

**What exists today:**
- Sidebar: project list with rename/delete buttons, global file tree toggle, settings
- Terminal area: tab bar, split toggle (2 max), terminal components via xterm.js + WebSocket
- Backend: Express REST API, WebSocket PTY sessions, SQLite config storage
- File tree: `FileTree` component (scoped to active project), `DirectoryBrowser` modal (for onboarding)

## 3. Feature 1: Flexible Terminal Panes

### 3.1 Behavior

When the user opens a project, they see a single terminal pane. From there:

- **Split right** — adds a new terminal pane to the right of the current panes in the active tab. All panes in a tab share the horizontal space.
- **New tab (+)** — adds a new tab in the tab bar with its own single terminal pane. Tabs are independent terminal groups.
- **Close pane** — removes a pane. If it's the last pane in a tab, the tab closes. If it's the last tab, a new default tab is created.

### 3.2 Layout Model

Each tab contains a **pane group** — a horizontal row of terminal panes separated by draggable dividers.

```
Tab 1: [ Pane A | divider | Pane B | divider | Pane C ]
Tab 2: [ Pane D ]
Tab 3: [ Pane E | divider | Pane F ]
```

- Panes within a tab are always side-by-side (horizontal split only)
- No vertical splits or nested grids
- No maximum pane count (practical limit ~4-5 based on screen width)

### 3.3 Draggable Dividers

- Each divider between panes is a vertical bar (~4px wide) that can be dragged left/right
- Dragging resizes the adjacent panes proportionally
- Minimum pane width: 200px (prevents panes from collapsing to nothing)
- Double-click a divider to reset adjacent panes to equal width
- Cursor changes to `col-resize` on hover

### 3.4 State Model (Frontend)

```javascript
// Per-project terminal state
{
  tabs: [
    {
      id: 'tab-1',
      label: 'Terminal 1',
      panes: [
        { id: 'pane-1a', sessionId: 'project-1', widthFraction: 0.5 },
        { id: 'pane-1b', sessionId: 'project-2', widthFraction: 0.5 },
      ]
    },
    {
      id: 'tab-2',
      label: 'Terminal 2',
      panes: [
        { id: 'pane-2a', sessionId: 'project-3', widthFraction: 1.0 },
      ]
    }
  ],
  activeTabId: 'tab-1'
}
```

- `widthFraction` values within a tab always sum to 1.0
- When a pane is added, all existing panes in the tab are resized equally
- When a pane is removed, remaining panes are resized equally

### 3.5 Tab Bar Changes

Current tab bar shows: project name, flat terminal list, split toggle, + button.

New tab bar:
- Project name (left)
- Tab buttons (middle) — each tab shows its label and a close × (if more than one tab)
- **Split right** button (icon: `Columns` or similar) — adds a pane to the active tab
- **New tab (+)** button — adds a new tab

The current split toggle button (`SplitSquareHorizontal`) is replaced by the "split right" action button.

### 3.6 Terminal Session Lifecycle

- Each pane gets its own PTY session (existing WebSocket + node-pty mechanism)
- Splitting creates a new session with the same `cwd` as the project
- Closing a pane kills its PTY session via `DELETE /api/terminal/:sessionId`
- Switching tabs does not kill hidden terminals — they stay alive in the background

## 4. Feature 2: Live Sidebar Cockpit

### 4.1 Per-Project Status Display

Each project row in the sidebar shows ambient state below or beside the project name:

```
┌─────────────────────────┐
│ ● project-name     ✎ 🗑 │
│   2 terminals · 14m     │
└─────────────────────────┘
```

- **Status dot** (●): colored indicator — green (active), dim/gray (idle), red (dead/disconnected)
- **Terminal count**: "N terminals" (only shown when project has active sessions)
- **Elapsed time**: time since the project's first terminal was opened in this session (e.g., "14m", "2h", "1d")

### 4.2 Status Definitions

| Status | Color | Condition |
|--------|-------|-----------|
| Active | Green (`var(--accent)`) | PTY output received within the last 10 seconds |
| Idle | Gray (`var(--text-muted)`) | PTY alive but no output for >10 seconds |
| Dead | Red | PTY process exited or WebSocket disconnected |
| None | No dot | No terminals open for this project |

When a project has multiple terminals, the status reflects the "most active" — if any terminal is active, the project shows active.

### 4.3 Backend: Session Status Endpoint

New REST endpoint to provide terminal session metadata:

**`GET /api/sessions`**

Returns all active PTY sessions with status metadata.

Response:
```json
[
  {
    "sessionId": "anvil-1",
    "cwd": "/home/user/projects/anvil",
    "startedAt": "2026-04-10T09:30:00.000Z",
    "lastOutputAt": "2026-04-10T09:44:12.000Z",
    "alive": true
  },
  {
    "sessionId": "anvil-2",
    "cwd": "/home/user/projects/anvil",
    "startedAt": "2026-04-10T09:35:00.000Z",
    "lastOutputAt": "2026-04-10T09:35:45.000Z",
    "alive": true
  }
]
```

**Backend tracking:** The server already has a `sessions` Map of PTY processes. Extend each entry to track:
- `startedAt` — timestamp when the PTY was spawned
- `lastOutputAt` — updated every time `ptyProcess.onData()` fires
- `alive` — true until `ptyProcess.onExit()` fires

### 4.4 Frontend Polling

The sidebar polls `GET /api/sessions` every 5 seconds to refresh status indicators. This is simpler than pushing status over WebSocket and acceptable given the low frequency.

The frontend maps sessions to projects by matching `sessionId` prefix (sessions are named `${project.name}-N`) or by matching `cwd` to project path.

### 4.5 Elapsed Time Display

Elapsed time is calculated from the earliest `startedAt` among a project's active sessions. Displayed as:
- `<1m` → "just now"
- `1m` – `59m` → "Nm"
- `1h` – `23h` → "Nh"
- `≥24h` → "Nd"

Updated on each poll cycle (every 5 seconds).

## 5. Feature 3: Per-Project File Browsing

### 5.1 Trigger

A new icon button on each project row in the sidebar (e.g., `FolderOpen` or `FileSearch` from lucide-react), positioned near the existing pencil (rename) and trash (delete) buttons.

### 5.2 Panel Behavior

Clicking the file browse button opens a **slide-in panel** — a modal overlay similar to the existing `DirectoryBrowser` component. The panel:

- Shows the file tree rooted at that project's `path`
- Uses the existing `GET /api/files?root=<path>` endpoint for tree data
- Displays directories (expandable) and files in a hierarchical list
- Clicking a file calls `POST /api/open` with the file path → opens in system editor
- Clicking outside the panel or pressing Escape dismisses it
- Works independently of which project is active in the terminal area

### 5.3 Panel Layout

```
┌─────────────────────────────────┐
│  📁 anvil                    ✕  │
│  /home/user/projects/anvil  │
│─────────────────────────────────│
│  ▸ src/                         │
│  ▸ tests/                       │
│    package.json                 │
│    README.md                    │
│    tsconfig.json                │
│─────────────────────────────────│
│  Click a file to open in editor │
└─────────────────────────────────┘
```

- Header: project name + full path + close button
- Body: scrollable file tree (reuses existing `FileTree` component or its data-fetching logic)
- Footer: help text
- Width: ~400px, vertically centered, overlay with backdrop blur (consistent with existing modals)

### 5.4 Reuse Strategy

The existing `FileTree` component already renders a tree from `GET /api/files` and handles click-to-open. The new panel wraps `FileTree` in a modal overlay and passes the clicked project's `path` as the `root` prop. Minimal new code required.

## 6. Feature 4: Error Handling & Feedback Foundation

### 6.1 Toast Notification System

A global toast container that displays brief messages for user feedback.

#### Toast Types

| Type | Color | Auto-dismiss | Use case |
|------|-------|-------------|----------|
| Success | Green accent | 3 seconds | "Project renamed", "Settings saved" |
| Error | Red | 6 seconds | "Failed to rename — server unreachable" |
| Warning | Yellow | 5 seconds | "Connection lost — reconnecting..." |

#### Toast Behavior
- Toasts appear in the bottom-right corner of the viewport
- Stack vertically if multiple are active (newest on top)
- Each toast has a dismiss × button
- Maximum 4 visible toasts — oldest dismissed when exceeded
- Slide-in animation on appear, fade-out on dismiss

#### Toast API (Frontend)

A React context + hook pattern:

```javascript
// In any component:
const { showToast } = useToast();

showToast({ type: 'success', message: 'Project renamed' });
showToast({ type: 'error', message: 'Failed to save — server unreachable' });
```

### 6.2 API Call Error Handling Pattern

Every `fetch()` call in the frontend must follow this pattern:

```javascript
try {
  const res = await fetch('/api/...', { ... });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    showToast({ type: 'error', message: err.error || 'Operation failed' });
    return;
  }
  const data = await res.json();
  showToast({ type: 'success', message: 'Done' });
  // update state from data
} catch {
  showToast({ type: 'error', message: 'Server unreachable' });
}
```

### 6.3 Existing Code Remediation

The following patterns in the current codebase must be fixed:

| File | Current | Fix |
|------|---------|-----|
| `App.jsx` — `addProject` | No error handling on fetch | Add try/catch, check `res.ok`, show toast |
| `App.jsx` — `renameProject` | Checks `res.ok` but no user feedback | Add success/error toast |
| `App.jsx` — `removeProject` | No error handling | Add try/catch, show toast |
| `App.jsx` — `openFile` | No error handling | Add try/catch, show toast |
| `Sidebar.jsx` — `handleAddClick` | `catch(() => {})` | Handle error, show toast |
| `SettingsPanel.jsx` — `useEffect` fetch | `.catch(() => {})` | Handle error, show toast |
| `SettingsPanel.jsx` — `handleSave` | `catch {}` swallows errors | Show success/error toast |
| `Terminal.jsx` — `ws.onmessage` | `catch {}` in JSON parse | Log or handle gracefully |

### 6.4 Connection Awareness

#### WebSocket Disconnect Banner

When the terminal WebSocket disconnects unexpectedly:
- Show a persistent banner at the top of the terminal area: "Connection lost — reconnecting..."
- Attempt reconnection with exponential backoff (1s, 2s, 4s, 8s, max 30s)
- On reconnect: dismiss banner, show success toast "Reconnected"
- After max retries (e.g., 10 attempts): banner changes to "Unable to connect to server. Check that the backend is running."

#### Backend Health Check

The frontend can optionally poll a health endpoint to detect backend availability even when no WebSocket is active:

**`GET /api/health`**

Response:
```json
{ "status": "ok", "uptime": 3600 }
```

This is lower priority — the WebSocket disconnect detection covers the most common case.

## 7. Backend API Changes Summary

### New Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/sessions` | List all active PTY sessions with status metadata |
| `GET` | `/api/health` | Health check endpoint |

### Modified Backend State

The `sessions` Map in `server/index.js` currently stores `pty` process objects. Extend each entry to be an object:

```javascript
sessions.set(sessionId, {
  pty: ptyProcess,
  cwd: cwd,
  startedAt: new Date().toISOString(),
  lastOutputAt: new Date().toISOString(),
  alive: true,
});
```

Update `lastOutputAt` in the `ptyProcess.onData()` handler. Set `alive: false` in `ptyProcess.onExit()`.

## 8. Frontend Component Changes Summary

### New Components

| Component | Purpose |
|-----------|---------|
| `ToastContainer` | Global toast notification renderer |
| `ToastContext` / `useToast` | React context + hook for showing toasts |
| `PaneDivider` | Draggable vertical divider between terminal panes |
| `FileBrowserPanel` | Modal overlay wrapping `FileTree` for per-project browsing |

### Modified Components

| Component | Changes |
|-----------|---------|
| `App.jsx` | Wrap with `ToastProvider`, add error handling to all API calls |
| `TerminalArea.jsx` | Replace split toggle with flexible pane model, add dividers |
| `Sidebar.jsx` | Add status indicators, terminal count, elapsed time, file browse button per project |
| `Terminal.jsx` | Add WebSocket reconnection logic, disconnect banner |
| `SettingsPanel.jsx` | Replace silent catches with toast notifications |

## 9. Non-Goals (Explicitly Out of Scope)

- Terminal content parsing (command detection, exit code tracking)
- LLM-powered session summaries
- Layout persistence across browser refreshes
- Vertical splits or grid layouts
- Code editing within CodeDeck
- Workflow orchestration panel (Phase 2 future work)
