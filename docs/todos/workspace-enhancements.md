# Workspace Enhancements

**Spec**: `docs/specifications/workspace-enhancements-spec.md`
**Status**: Not Started
**Created**: 2026-04-10

---

## Phase 1: Error Handling & Feedback Foundation
> Cross-cutting concern that underpins all other features. Build the toast system, fix all silent error swallowing, add the health endpoint. Everything after this phase has proper error handling from day one.
> **Inputs:** Existing codebase with silent `catch(() => {})` patterns
> **Outputs:** Toast notification system, all API calls handled, health endpoint
> **Closed when:** Every API call shows success/error feedback, no silent catches remain

- [ ] Create `ToastContext` and `useToast` hook — React context providing `showToast({ type, message })` (Spec §6.1)
- [ ] Create `ToastContainer` component — renders toast stack in bottom-right, auto-dismiss timers, slide-in/fade-out animation, max 4 visible (Spec §6.1)
- [ ] Wrap `App.jsx` with `ToastProvider` so all components can use `useToast` (Spec §6.1)
- [ ] Add `GET /api/health` endpoint to backend — returns `{ status: "ok", uptime }` (Spec §6.4)
- [ ] Fix `App.jsx` — `addProject`: add try/catch, check `res.ok`, show success/error toast (Spec §6.3)
- [ ] Fix `App.jsx` — `renameProject`: add success toast on rename, error toast on failure (Spec §6.3)
- [ ] Fix `App.jsx` — `removeProject`: add try/catch, show success/error toast (Spec §6.3)
- [ ] Fix `App.jsx` — `openFile`: add try/catch, show error toast on failure (Spec §6.3)
- [ ] Fix `Sidebar.jsx` — `handleAddClick`: replace `catch(() => {})` with error toast (Spec §6.3)
- [ ] Fix `SettingsPanel.jsx` — replace all silent catches with toast notifications (Spec §6.3)
- [ ] Add WebSocket disconnect/reconnect logic to `Terminal.jsx` — exponential backoff, reconnection banner (Spec §6.4)
- [ ] Verify: trigger each error path manually and confirm toast appears

## Phase 2: Flexible Terminal Panes
> Replace the current 2-terminal split toggle with a flexible N-pane model. Each tab holds a horizontal group of panes separated by draggable dividers.
> **Inputs:** Single terminal or 2-terminal split per project
> **Outputs:** N panes per tab, draggable dividers, proper tab management
> **Closed when:** Can open a project, split right multiple times, resize panes, close individual panes, manage multiple tabs

- [ ] Refactor `TerminalArea.jsx` state model — replace flat `terminals` array with `tabs[].panes[]` structure, each pane has `id`, `sessionId`, `widthFraction` (Spec §3.4)
- [ ] Implement "split right" action — adds a new pane to the active tab, redistributes `widthFraction` equally across all panes in the tab (Spec §3.1)
- [ ] Implement "new tab" action — creates a new tab with one pane, switches to it (Spec §3.1)
- [ ] Implement "close pane" — removes pane, redistributes width. If last pane in tab, close tab. If last tab, create a new default tab (Spec §3.1)
- [ ] Implement "close tab" — kills all PTY sessions in the tab, removes from tab list (Spec §3.6)
- [ ] Create `PaneDivider` component — 4px vertical bar, `col-resize` cursor, drag to resize adjacent panes (Spec §3.3)
- [ ] Implement divider drag logic — update `widthFraction` of adjacent panes on mousemove, enforce 200px minimum pane width (Spec §3.3)
- [ ] Implement divider double-click — reset adjacent panes to equal width (Spec §3.3)
- [ ] Update tab bar UI — replace split toggle with "split right" button (`Columns` icon), keep "+" for new tab (Spec §3.5)
- [ ] Render pane group — map `activeTab.panes` to `Terminal` components with dividers between them, widths from `widthFraction` (Spec §3.2)
- [ ] Verify: open project → split right 3 times → 4 panes → drag dividers → close middle pane → panes redistribute → add new tab → switch between tabs

## Phase 3: Live Sidebar Cockpit
> Add ambient status indicators to each project in the sidebar — terminal count, activity status, elapsed time. Backend tracks session metadata.
> **Inputs:** Backend PTY sessions Map (currently stores just the pty object)
> **Outputs:** Per-project status display in sidebar, backend session status endpoint
> **Closed when:** Sidebar shows live terminal count, colored status dot, and elapsed time per project; updates every 5 seconds

- [ ] Extend backend `sessions` Map entries — store `{ pty, cwd, startedAt, lastOutputAt, alive }` instead of just the pty object (Spec §7)
- [ ] Update `ptyProcess.onData()` handler — refresh `lastOutputAt` timestamp on each output event (Spec §4.3)
- [ ] Update `ptyProcess.onExit()` handler — set `alive: false` on the session entry (Spec §4.3)
- [ ] Add `GET /api/sessions` endpoint — returns all sessions with `sessionId`, `cwd`, `startedAt`, `lastOutputAt`, `alive` (Spec §4.3)
- [ ] Add frontend polling — `App.jsx` or `Sidebar.jsx` polls `GET /api/sessions` every 5 seconds, maps sessions to projects by `sessionId` prefix or `cwd` match (Spec §4.4)
- [ ] Update `Sidebar.jsx` project rows — show status dot (green/gray/red), terminal count, elapsed time below project name (Spec §4.1)
- [ ] Implement elapsed time formatting — "just now", "Nm", "Nh", "Nd" based on earliest `startedAt` (Spec §4.5)
- [ ] Implement status aggregation — project status is "most active" across its terminals: any active → green, all idle → gray, all dead → red (Spec §4.2)
- [ ] Verify: open project with 2 terminals → sidebar shows "2 terminals · active" → wait 15s idle → status changes to gray → kill a terminal → count updates

## Phase 4: Per-Project File Browsing
> Add a file browse button to each project row that opens a slide-in panel showing the project's file tree. Clicking a file opens it in the system editor. Decoupled from the active project.
> **Inputs:** Existing `FileTree` component and `GET /api/files` endpoint
> **Outputs:** File browse button per project, modal panel with scoped file tree
> **Closed when:** Can click file browse on any project (including non-active), browse files, click to open in editor, dismiss panel

- [ ] Create `FileBrowserPanel` component — modal overlay with backdrop blur, header (project name + path + close button), body wrapping `FileTree`, footer help text (Spec §5.3)
- [ ] Add file browse button to each project row in `Sidebar.jsx` — icon button (e.g., `FolderSearch` from lucide-react) next to pencil and trash (Spec §5.1)
- [ ] Wire button click — opens `FileBrowserPanel` with the clicked project's `path` as root (Spec §5.2)
- [ ] Panel dismiss — close on × button click, Escape key, or clicking outside the panel (Spec §5.2)
- [ ] File click handler — calls `POST /api/open` with file path, shows success toast or error toast on failure (Spec §5.2)
- [ ] Verify: open file browser on non-active project → browse tree → click a file → opens in editor → dismiss panel → terminal area unchanged

## Phase 5: Final Verification & Cleanup
> Full regression pass across all features, ensure everything works together.

- [ ] Run full test suite (all phases together)
- [ ] End-to-end manual test: open 3 projects, split panes in each, observe sidebar status updating, browse files from one project while terminals show another, trigger error conditions (stop backend) and verify toasts appear
- [ ] Verify no silent `catch(() => {})` patterns remain in codebase
- [ ] Update `README.md` — reflect new features (flexible panes, sidebar status, file browsing)

---

## Session Notes
_To be filled during implementation._
