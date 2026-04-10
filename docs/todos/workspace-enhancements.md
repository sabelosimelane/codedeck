# Workspace Enhancements

**Spec**: `docs/specifications/workspace-enhancements-spec.md`
**Status**: Complete
**Last completed**: Phase 5: Final Verification & Cleanup
**Created**: 2026-04-10

---

## Phase 1: Error Handling & Feedback Foundation
> Cross-cutting concern that underpins all other features. Build the toast system, fix all silent error swallowing, add the health endpoint. Everything after this phase has proper error handling from day one.
> **Inputs:** Existing codebase with silent `catch(() => {})` patterns
> **Outputs:** Toast notification system, all API calls handled, health endpoint
> **Closed when:** Every API call shows success/error feedback, no silent catches remain

- [x] Create `ToastContext` and `useToast` hook — React context providing `showToast({ type, message })` (Spec §6.1)
- [x] Create `ToastContainer` component — renders toast stack in bottom-right, auto-dismiss timers, slide-in/fade-out animation, max 4 visible (Spec §6.1)
- [x] Wrap `App.jsx` with `ToastProvider` so all components can use `useToast` (Spec §6.1)
- [x] Add `GET /api/health` endpoint to backend — returns `{ status: "ok", uptime }` (Spec §6.4)
- [x] Fix `App.jsx` — `addProject`: add try/catch, check `res.ok`, show success/error toast (Spec §6.3)
- [x] Fix `App.jsx` — `renameProject`: add success toast on rename, error toast on failure (Spec §6.3)
- [x] Fix `App.jsx` — `removeProject`: add try/catch, show success/error toast (Spec §6.3)
- [x] Fix `App.jsx` — `openFile`: add try/catch, show error toast on failure (Spec §6.3)
- [x] Fix `Sidebar.jsx` — `handleAddClick`: replace `catch(() => {})` with error toast (Spec §6.3)
- [x] Fix `SettingsPanel.jsx` — replace all silent catches with toast notifications (Spec §6.3)
- [x] Add WebSocket disconnect/reconnect logic to `Terminal.jsx` — exponential backoff, reconnection banner (Spec §6.4)
- [x] Verify: trigger each error path manually and confirm toast appears

## Phase 2: Flexible Terminal Panes
> Replace the current 2-terminal split toggle with a flexible N-pane model. Each tab holds a horizontal group of panes separated by draggable dividers.
> **Inputs:** Single terminal or 2-terminal split per project
> **Outputs:** N panes per tab, draggable dividers, proper tab management
> **Closed when:** Can open a project, split right multiple times, resize panes, close individual panes, manage multiple tabs

- [x] Refactor `TerminalArea.jsx` state model — replace flat `terminals` array with `tabs[].panes[]` structure, each pane has `id`, `sessionId`, `widthFraction` (Spec §3.4)
- [x] Implement "split right" action — adds a new pane to the active tab, redistributes `widthFraction` equally across all panes in the tab (Spec §3.1)
- [x] Implement "new tab" action — creates a new tab with one pane, switches to it (Spec §3.1)
- [x] Implement "close pane" — removes pane, redistributes width. If last pane in tab, close tab. If last tab, create a new default tab (Spec §3.1)
- [x] Implement "close tab" — kills all PTY sessions in the tab, removes from tab list (Spec §3.6)
- [x] Create `PaneDivider` component — 4px vertical bar, `col-resize` cursor, drag to resize adjacent panes (Spec §3.3)
- [x] Implement divider drag logic — update `widthFraction` of adjacent panes on mousemove, enforce 200px minimum pane width (Spec §3.3)
- [x] Implement divider double-click — reset adjacent panes to equal width (Spec §3.3)
- [x] Update tab bar UI — replace split toggle with "split right" button (`Columns` icon), keep "+" for new tab (Spec §3.5)
- [x] Render pane group — map `activeTab.panes` to `Terminal` components with dividers between them, widths from `widthFraction` (Spec §3.2)
- [x] Verify: open project → split right 3 times → 4 panes → drag dividers → close middle pane → panes redistribute → add new tab → switch between tabs

## Phase 3: Live Sidebar Cockpit
> Add ambient status indicators to each project in the sidebar — terminal count, activity status, elapsed time. Backend tracks session metadata.
> **Inputs:** Backend PTY sessions Map (currently stores just the pty object)
> **Outputs:** Per-project status display in sidebar, backend session status endpoint
> **Closed when:** Sidebar shows live terminal count, colored status dot, and elapsed time per project; updates every 5 seconds

- [x] Extend backend `sessions` Map entries — store `{ pty, cwd, startedAt, lastOutputAt, alive }` instead of just the pty object (Spec §7)
- [x] Update `ptyProcess.onData()` handler — refresh `lastOutputAt` timestamp on each output event (Spec §4.3)
- [x] Update `ptyProcess.onExit()` handler — set `alive: false` on the session entry (Spec §4.3)
- [x] Add `GET /api/sessions` endpoint — returns all sessions with `sessionId`, `cwd`, `startedAt`, `lastOutputAt`, `alive` (Spec §4.3)
- [x] Add frontend polling — `App.jsx` or `Sidebar.jsx` polls `GET /api/sessions` every 5 seconds, maps sessions to projects by `sessionId` prefix or `cwd` match (Spec §4.4)
- [x] Update `Sidebar.jsx` project rows — show status dot (green/gray/red), terminal count, elapsed time below project name (Spec §4.1)
- [x] Implement elapsed time formatting — "just now", "Nm", "Nh", "Nd" based on earliest `startedAt` (Spec §4.5)
- [x] Implement status aggregation — project status is "most active" across its terminals: any active → green, all idle → gray, all dead → red (Spec §4.2)
- [x] Verify: open project with 2 terminals → sidebar shows "2 terminals · active" → wait 15s idle → status changes to gray → kill a terminal → count updates

## Phase 4: Per-Project File Browsing
> Add a file browse button to each project row that opens a slide-in panel showing the project's file tree. Clicking a file opens it in the system editor. Decoupled from the active project.
> **Inputs:** Existing `FileTree` component and `GET /api/files` endpoint
> **Outputs:** File browse button per project, modal panel with scoped file tree
> **Closed when:** Can click file browse on any project (including non-active), browse files, click to open in editor, dismiss panel

- [x] Create `FileBrowserPanel` component — modal overlay with backdrop blur, header (project name + path + close button), body wrapping `FileTree`, footer help text (Spec §5.3)
- [x] Add file browse button to each project row in `Sidebar.jsx` — icon button (e.g., `FolderSearch` from lucide-react) next to pencil and trash (Spec §5.1)
- [x] Wire button click — opens `FileBrowserPanel` with the clicked project's `path` as root (Spec §5.2)
- [x] Panel dismiss — close on × button click, Escape key, or clicking outside the panel (Spec §5.2)
- [x] File click handler — calls `POST /api/open` with file path, shows success toast or error toast on failure (Spec §5.2)
- [x] Verify: open file browser on non-active project → browse tree → click a file → opens in editor → dismiss panel → terminal area unchanged

## Phase 5: Final Verification & Cleanup
> Full regression pass across all features, ensure everything works together.

- [x] Run full test suite (all phases together)
- [x] End-to-end manual test: open 3 projects, split panes in each, observe sidebar status updating, browse files from one project while terminals show another, trigger error conditions (stop backend) and verify toasts appear
- [x] Verify no silent `catch(() => {})` patterns remain in codebase
- [x] Update `README.md` — reflect new features (flexible panes, sidebar status, file browsing)

---

## Session Notes

### Session — 2026-04-10 (Phase 1)
**Completed**: Phase 1: Error Handling & Feedback Foundation
**Key files**:
- `client/src/components/ToastContext.jsx` — new: ToastProvider, useToast, ToastContainer
- `client/src/App.jsx` — wrapped with ToastProvider, all 4 API calls have try/catch + toast
- `client/src/components/Sidebar.jsx` — handleAddClick catch shows error toast
- `client/src/components/SettingsPanel.jsx` — load + save both show success/error toasts
- `client/src/components/Terminal.jsx` — WebSocket reconnect with exponential backoff + banner
- `server/index.js` — added GET /api/health endpoint
- `client/src/styles/global.css` — added toastIn animation
**Architecture**: Toast system uses React Context (ToastProvider wraps App). showToast({ type, message }) is the API. ToastContainer renders fixed bottom-right stack, max 4, auto-dismiss (3s/5s/6s by type). Terminal reconnection uses local `wasConnectedBefore` flag + `retryRef` counter, onData registered once outside connect loop.
**Bug fixes**: Fixed onData listener stacking on WebSocket reconnect — moved registration outside connect() so it's only attached once. Removed dead useEffect for reconnect toast.
**Next**: Phase 2: Flexible Terminal Panes — refactor TerminalArea.jsx from flat terminals array to tabs[].panes[] model with draggable dividers

### Session — 2026-04-10 (Phase 2)
**Completed**: Phase 2: Flexible Terminal Panes
**Key files**:
- `client/src/components/TerminalArea.jsx` — rewritten: tabs[].panes[] state model, split right, new tab, close pane/tab, divider drag/reset
- `client/src/components/PaneDivider.jsx` — new: 4px draggable divider with mouse event handling, accent color on hover
- `client/src/styles/global.css` — added `.pane-divider` hover styles and `.pane-wrapper:hover .pane-close-btn` visibility
**Architecture**: Combined `{tabs, activeTabId}` into single state object to keep tab switching and tab removal atomic. Module-level counters (`tabCounter`, `sessionCounter`) reset on project change — session IDs reuse existing PTY sessions on the server when switching back. `flex: widthFraction` on panes lets flexbox handle divider space naturally. PaneDivider sends incremental pixel deltas; parent converts to fraction using container width minus divider widths. Min pane width enforced as `200 / availableWidth` fraction.
**Next**: Phase 3: Live Sidebar Cockpit — extend backend sessions Map with metadata, add GET /api/sessions endpoint, frontend polling + sidebar status display

### Session — 2026-04-10 (Phase 3)
**Completed**: Phase 3: Live Sidebar Cockpit
**Key files**:
- `server/index.js` — sessions Map stores `{ pty, cwd, startedAt, lastOutputAt, alive }`, `onData` updates `lastOutputAt`, `onExit` sets `alive: false`, new `GET /api/sessions` endpoint, DELETE handler uses `entry.pty`
- `client/src/App.jsx` — new `sessionStatus` state, polls `/api/sessions` every 5s, passes to Sidebar
- `client/src/components/Sidebar.jsx` — new helpers: `formatElapsed(timestamp)`, `getProjectStatus(sessions)`, `getProjectSessions(project)`. Status dot (green/gray/red), terminal count, elapsed time below project name. Sessions mapped to projects by sessionId prefix (`projectName-N`) or cwd match.
**Architecture**: Polling-based (5s interval) rather than WebSocket push — simpler and sufficient for ambient status. Status aggregation: any alive session with output <10s = active (green), all alive but idle >10s = idle (gray), no alive sessions = dead (red), no sessions = no dot. Dead sessions return count: 0 so cockpit subtitle hidden.
**Next**: Phase 4: Per-Project File Browsing — add file browse button per project row, `FileBrowserPanel` modal wrapping `FileTree`

### Session — 2026-04-10 (Phase 4)
**Completed**: Phase 4: Per-Project File Browsing
**Key files**:
- `client/src/components/FileBrowserPanel.jsx` — new: modal overlay with own TreeNode rendering, fetches `/api/files`, file click calls `POST /api/open` with toast feedback, Escape/backdrop dismiss
- `client/src/components/Sidebar.jsx` — added `FolderSearch` icon button per project row, new `onBrowseFiles` prop
- `client/src/App.jsx` — new `fileBrowserProject` state, passes `onBrowseFiles={setFileBrowserProject}` to Sidebar, renders FileBrowserPanel when set
**Architecture**: FileBrowserPanel is self-contained — has its own TreeNode (same pattern as FileTree) and its own file-open handler with toast error handling. Decoupled from active project — any project's files can be browsed without switching the terminal area. Modal follows DirectoryBrowser pattern (overlay + backdrop blur + slideUp animation). Used `FolderSearch` icon from lucide-react positioned before pencil/trash buttons.
**Next**: Phase 5: Final Verification & Cleanup — full regression pass, end-to-end manual test, verify no silent catches, update README

### Session — 2026-04-10 (Phase 5)
**Completed**: Phase 5: Final Verification & Cleanup
**Key fixes**:
- `TerminalArea.jsx` — replaced 2 silent `.catch(() => {})` on DELETE fetch calls with `console.warn` logging
- `FileTree.jsx` — replaced silent `.catch(() => setLoading(false))` with proper tree-clearing error handler
- `Sidebar.jsx` — replaced hardcoded `#ef4444` in STATUS_COLORS.dead with `var(--danger)` CSS variable
- `README.md` — rewrote to reflect current features: flexible panes, sidebar cockpit, file browsing, toast system, SQLite config, server.sh management
**Remaining silent catches**: 2 in Terminal.jsx for `fitAddon.fit()` — intentional, xterm.js throws when terminal element isn't mounted during resize events. Not API calls, not user-facing.
**Build**: Vite build passes cleanly
