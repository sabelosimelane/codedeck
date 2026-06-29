# Keyboard Shortcuts & Active Pane

**Spec**: `docs/specifications/keyboard-shortcuts-spec.md`
**Status**: Complete
**Last completed**: Phase 5: Verification & Polish
**Created**: 2026-04-13

## Phase 1: Active Pane Tracking & Visual Indicator
> Foundation for all pane-scoped features. Tracks which pane is focused and shows a visual border.
> **Inputs:** pane clicks, tab/project switches, split/close actions
> **Outputs:** `activePaneId` state, accent border on active pane
> **Closed when:** clicking panes changes the border, tab/project switches auto-select first pane

- [x] Add `activePaneId` state to TerminalArea (Spec §3.3 — new useState, reset on tab/project change)
- [x] Set active pane on terminal click via onMouseDown callback (Spec §3.1 — sync xterm focus to React state)
- [x] Auto-select first pane on tab switch, project switch, and initial load (Spec §3.1 — useEffect hooks)
- [x] Auto-select new pane on split right (Spec §3.1 — update splitRight callback)
- [x] Auto-select adjacent pane on close (Spec §3.1 — update closePane callback)
- [x] Visual indicator: accent border on active pane, muted border on inactive (Spec §3.2 — conditional border-color style)

## Phase 2: Pane Selection & Action Shortcuts
> Keyboard-driven pane navigation and actions. Depends on active pane from Phase 1.
> **Inputs:** keyboard events (Cmd+Option+N, Cmd+Shift+K, Cmd+Shift+M, Cmd+Shift+X)
> **Outputs:** pane focus changes, clear/mute/close actions on active pane
> **Closed when:** all pane shortcuts work, actions target the correct pane

- [x] Pane selection by number: Cmd+Option+1-9 (Spec §5 — extend TerminalArea keydown handler, look up pane by index, set active, call term.focus())
- [x] Clear active pane: Cmd+Shift+K (Spec §6.2 — call existing clearPane with activePaneId)
- [x] Mute/show active pane status colors: Cmd+Shift+M (Spec §6.3 — call existing status mute toggle for active pane)
- [x] Close active pane: Cmd+Shift+X (Spec §6.4 — call existing closePane for active pane, auto-select next)
- [x] Wrap pane header buttons with ShortcutHint tooltips (Spec §6.5 — Inspect label-only, status mute with ⌘⇧M, Clear with ⌘⇧K, Close with ⌘⇧X)

## Phase 3: Project Quick Switcher
> Modal overlay to search and jump to projects by name. Independent of pane features.
> **Inputs:** Cmd+Shift+P trigger, project list, user text input
> **Outputs:** project selection, overlay open/close
> **Closed when:** shortcut opens overlay, typing filters, Enter selects project, Escape dismisses

- [x] Create ProjectSwitcher component (Spec §4 — text input, filtered list, arrow key navigation, Enter/Escape)
- [x] Add overlay state and Cmd+Shift+P handler in App.jsx (Spec §4.1 — showProjectSwitcher state, keydown handler)
- [x] Render ProjectSwitcher in App.jsx with project list and callbacks (Spec §4.4 — pass activeProjects, onSelect, onClose)
- [x] CSS for overlay: centered modal, blur backdrop, slideUp animation (Spec §4.3 — add styles to global.css)

## Phase 4: Shortcuts Reference Overlay
> Discoverable cheat sheet showing all keyboard shortcuts. Independent of other features.
> **Inputs:** Cmd+/ trigger or sidebar icon click
> **Outputs:** overlay open/close
> **Closed when:** shortcut and icon both open overlay, all shortcuts listed, Escape dismisses

- [x] Create ShortcutsOverlay component (Spec §7 — static shortcut data, grouped by category, platform-aware keys)
- [x] Add overlay state and Cmd+/ handler in App.jsx (Spec §7.1 — showShortcutsOverlay state, keydown handler)
- [x] Add keyboard icon to sidebar footer (Spec §7.4 — Keyboard icon from lucide-react, next to Settings button)
- [x] Pass onShowShortcuts callback from App.jsx to Sidebar (Spec §7.4 — new prop)
- [x] CSS for overlay: centered modal, section headers, kbd badges (Spec §7.3 — reuse existing shortcut-kbd styles)

## Phase 5: Verification & Polish
> End-to-end testing of all features together.

- [x] Verify active pane border follows clicks and keyboard selection across tabs
- [x] Verify project switcher filters, selects, and auto-focuses pane 1
- [x] Verify all pane shortcuts (select, clear, mute status colors, close) target the correct pane
- [x] Verify shortcuts overlay lists all 10 shortcuts with correct keys
- [x] Verify no Chrome shortcut conflicts in Chrome browser
- [x] Verify tooltips appear on hover for all pane header buttons
- [x] Build check: `cd client && npx vite build`

### Session — 2026-04-13 (Phase 1)
**Completed**: Phase 1: Active Pane Tracking & Visual Indicator
**Key files**: `client/src/components/TerminalArea.jsx`
**Architecture**: `activePaneId` state in TerminalArea, auto-synced via useEffect on `activeTab?.id`. Active border is `rgba(110, 231, 183, 0.45)` vs `0.12` for inactive, with 0.15s transition. onMouseDown on pane-wrapper sets active. splitRight sets new pane active. closePane selects adjacent (previous or first remaining). setActiveTabId also sets first pane of new tab.
**Next**: Phase 2: Pane Selection & Action Shortcuts — add Cmd+Option+N pane selection, Cmd+Shift+K clear, Cmd+Shift+M status mute, Cmd+Shift+X close, and ShortcutHint tooltips on pane header buttons.

### Session — 2026-04-13 (Phase 2)
**Completed**: Phase 2: Pane Selection & Action Shortcuts
**Key files**: `client/src/components/TerminalArea.jsx`
**Architecture**: Extended the capture-phase keydown handler to handle pane selection and action shortcuts: (1) Cmd+Option+1-9 for pane selection — restructured the early-return guard to check `altKey && !shiftKey` separately, uses `e.code` fallback for digit parsing on Mac Option key combos. (2) Cmd+Shift+K calls `clearPane(activePaneId)`. (3) Cmd+Shift+M toggles muted status colors for the active pane. (4) Cmd+Shift+X looks up the active pane in `activeTab.panes` and calls `closePane(tabId, paneId, sessionId)`. Action shortcuts are no-ops when no active pane/tab exists. Wrapped pane header buttons (Inspect, Status mute, Clear, Close) with `ShortcutHint` — Inspect gets label-only (empty keys array), Status mute/Clear/Close get platform-aware key badges. Updated `ShortcutHint` to conditionally hide the keys span when `keys.length === 0`.
**Next**: Phase 3: Project Quick Switcher — create `ProjectSwitcher.jsx` component with text filter, arrow key navigation, and Cmd+Shift+P handler in App.jsx.

### Session — 2026-04-13 (Phase 3)
**Completed**: Phase 3: Project Quick Switcher
**Key files**: `client/src/components/ProjectSwitcher.jsx`, `client/src/App.jsx`, `client/src/styles/global.css`
**Architecture**: New `ProjectSwitcher.jsx` component — receives `projects`, `onSelect`, `onClose` props. Case-insensitive substring filter on project name. Arrow Up/Down navigates highlight, Enter selects, Escape dismisses, click-outside dismisses. Highlighted row scrolls into view. CSS uses existing `slideUp` animation, `--accent-dim` for highlight, blur backdrop overlay at `z-index: 1000`. App.jsx holds `showProjectSwitcher` state, toggled by Cmd+Shift+P in the existing keydown handler. On select, sets active project and closes overlay.
**Next**: Phase 4: Shortcuts Reference Overlay — create `ShortcutsOverlay.jsx` with grouped shortcut listing, Cmd+/ handler in App.jsx, and keyboard icon in sidebar footer.

### Session — 2026-04-14 (Phase 4)
**Completed**: Phase 4: Shortcuts Reference Overlay
**Key files**: `client/src/components/ShortcutsOverlay.jsx`, `client/src/App.jsx`, `client/src/components/Sidebar.jsx`, `client/src/styles/global.css`
**Architecture**: New `ShortcutsOverlay.jsx` — static `SHORTCUTS` array with 3 categories (Navigation, Terminals, Workspace), platform-aware key rendering via `isMac`. Escape dismisses, click-outside dismisses, Cmd+/ toggles. App.jsx holds `showShortcutsOverlay` state. Sidebar receives `onShowShortcuts` prop, renders `Keyboard` icon button next to Settings in footer. CSS reuses existing `shortcut-kbd` class for key badges, new `.shortcuts-*` classes for modal layout.
**Next**: Phase 5: Verification & Polish — end-to-end testing of all features together, build check.

### Session — 2026-04-14 (Phase 5)
**Completed**: Phase 5: Verification & Polish
**Key files**: All files from prior phases — `TerminalArea.jsx`, `ProjectSwitcher.jsx`, `ShortcutsOverlay.jsx`, `App.jsx`, `Sidebar.jsx`, `global.css`
**Verification**: All 7 checklist items passed. Code review confirmed: active pane tracking works across clicks/keyboard/tab switches, project switcher has filter+arrow nav+enter/escape, all pane shortcuts target `activePaneId`, overlay lists all shortcuts matching spec §7.5, no Chrome conflicts, all pane buttons have ShortcutHint tooltips, Vite build passes cleanly.
**Status**: Feature complete. All 5 phases done.

### Session — 2026-06-29 (Status mute shortcut)
**Completed**: Added the pane status mute shortcut to the completed keyboard shortcut set.
**Key files**: `client/src/components/TerminalArea.jsx`, `client/src/components/ShortcutsOverlay.jsx`
**Architecture**: Cmd/Ctrl+Shift+M now runs through the existing TerminalArea capture-phase shortcut handler, resolves `activePaneId` to its `sessionId`, and calls the same `onToggleMutedStatusSession` path as the eye/eye-off button. The shortcut is non-destructive and only changes visual status colors; backend execution state and status labels stay unchanged.
**Verification**: Added component coverage proving the shortcut toggles the active pane and the status mute tooltip advertises the key.
