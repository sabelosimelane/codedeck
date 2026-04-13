# Keyboard Shortcuts & Active Pane — Feature Specification

**Version:** 1.0
**Date:** 2026-04-13
**Status:** Draft

## 1. Overview

CodeDeck currently requires mouse interaction for pane selection, project switching, and pane actions. As the workspace grows (multiple projects, multiple tabs, multiple panes), keyboard-driven navigation becomes essential. This specification adds:

1. **Active pane tracking** — React-level state tracking which pane is focused, with a visual indicator
2. **Project quick switcher** — modal overlay to search and jump to any project
3. **Pane selection by number** — jump to the Nth pane in the active tab
4. **Pane action shortcuts** — keyboard shortcuts for clear and close pane
5. **Shortcuts reference overlay** — discoverable cheat sheet of all keyboard shortcuts

All shortcuts are chosen to avoid clashing with Chrome browser shortcuts, since CodeDeck runs inside a Chrome tab.

## 2. Current State

### 2.1 Existing Shortcuts

| Shortcut | Action | Location |
|----------|--------|----------|
| Cmd+B | Toggle sidebar compact/expanded | App.jsx |
| Cmd+Shift+B | Toggle file tree | App.jsx |
| Cmd+Shift+D | Split right (add pane) | TerminalArea.jsx |
| Cmd+Shift+J | New terminal tab | TerminalArea.jsx |

### 2.2 What's Missing

- No concept of "active pane" — all panes in a tab render equally, no visual focus indicator
- No keyboard project switching — sidebar requires mouse click
- No keyboard pane navigation — can't move between panes without clicking
- No shortcuts for pane actions (clear, close, inspect)
- No discoverable shortcut reference

## 3. Feature 1: Active Pane Tracking

### 3.1 Behavior

Track which pane is "active" (focused) as React state in TerminalArea. The active pane is the target for all pane-scoped actions (clear, close, inspect).

**Setting the active pane:**
- Clicking a terminal pane sets it as active (sync xterm focus to React state)
- Keyboard pane selection (Cmd+Option+N) sets it as active
- When switching projects, the first pane of the active tab is auto-selected
- When switching tabs, the first pane of the new tab is auto-selected
- When splitting right, the new pane becomes active
- When closing the active pane, the previous pane (or first remaining) becomes active

### 3.2 Visual Indicator

The active pane receives a subtle accent border to distinguish it from inactive panes:

- **Active pane:** border changes from `rgba(110, 231, 183, 0.12)` to `rgba(110, 231, 183, 0.45)` — a brighter version of the existing border
- **Inactive panes:** retain current border styling `rgba(110, 231, 183, 0.12)`
- Transition: `border-color 0.15s ease` for smooth visual feedback
- Single-pane tabs: the lone pane is always active but still shows the indicator for consistency

### 3.3 State Model

```javascript
// New state in TerminalArea
const [activePaneId, setActivePaneId] = useState(null);
```

The `activePaneId` references a `pane.id` within the current active tab. It resets when:
- The active tab changes (set to first pane of new tab)
- The project changes (set to first pane of first tab)
- The active pane is closed (set to adjacent pane)

## 4. Feature 2: Project Quick Switcher

### 4.1 Trigger

- **Shortcut:** Cmd+Shift+P (Mac) / Ctrl+Shift+P (Windows/Linux)
- Chrome-safe: Chrome uses Cmd+P for print, but not Cmd+Shift+P

### 4.2 Behavior

1. Shortcut opens a centered modal overlay with a text input
2. All active (non-shelved) projects are listed below the input
3. Typing filters the list by case-insensitive substring match on project name
4. Arrow keys (Up/Down) navigate the filtered list; first item is highlighted by default
5. Enter selects the highlighted project and closes the overlay
6. Escape closes the overlay without changing the active project
7. Clicking outside the overlay dismisses it
8. On selection: project is set as active, first pane of the active tab is auto-focused

### 4.3 UI

```
┌─────────────────────────────────┐
│  ┌───────────────────────────┐  │
│  │ 🔍 Search projects...    │  │
│  └───────────────────────────┘  │
│  ┌───────────────────────────┐  │
│  │ ▸ codedeck          ~/... │  │  ← highlighted
│  │   api-server        ~/... │  │
│  │   mobile-app        ~/... │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

- Overlay: centered, max-width 420px, dark background with blur backdrop
- Input: full-width, auto-focused on open
- Project rows: project name (left), truncated path (right, muted)
- Highlighted row: accent background `var(--accent-dim)`
- Animation: `slideUp` on open (reuse existing animation)

### 4.4 Props

The ProjectSwitcher component receives:
- `projects` — array of active project objects `{ name, path }`
- `onSelect(project)` — callback when a project is selected
- `onClose()` — callback to dismiss the overlay

## 5. Feature 3: Pane Selection by Number

### 5.1 Trigger

- **Shortcut:** Cmd+Option+1 through Cmd+Option+9 (Mac) / Ctrl+Alt+1 through Ctrl+Alt+9 (Windows/Linux)
- Chrome-safe: Chrome uses Cmd+1-9 for tab switching, but not Cmd+Option+1-9

### 5.2 Behavior

- Cmd+Option+N selects the Nth pane (1-indexed, left-to-right) in the active tab
- Updates `activePaneId` and calls `term.focus()` on the target terminal via its ref
- No-op if pane N doesn't exist in the active tab
- No-op if no active tab exists

### 5.3 Implementation Notes

- Handled in TerminalArea's existing keydown listener (capture phase)
- Check: `isCmdOrCtrl && e.altKey && !e.shiftKey && digit >= 1 && digit <= 9`
- Look up `activeTab.panes[digit - 1]`, set as active pane, focus its terminal ref

## 6. Feature 4: Pane Action Shortcuts

### 6.1 Shortcuts

| Action | Shortcut (Mac) | Shortcut (Win/Linux) | Notes |
|--------|----------------|---------------------|-------|
| Clear active pane | Cmd+Shift+K | Ctrl+Shift+K | Clears terminal output |
| Close active pane | Cmd+Shift+W | Ctrl+Shift+W | Kills session, removes pane |
| Inspect terminal | No shortcut | No shortcut | Mouse-only (niche debug feature) |

- All pane action shortcuts act on the currently active pane (`activePaneId`)
- No-op if no pane is active
- Chrome-safe: Chrome uses Cmd+W (close tab) but not Cmd+Shift+W

### 6.2 Clear Pane (Cmd+Shift+K)

- Calls `clearPane(activePaneId)` which invokes `terminal.clear()` on the xterm instance
- Non-destructive — only clears visible output, doesn't kill the session
- The existing `clearPane` function in TerminalArea already accepts a paneId

### 6.3 Close Pane (Cmd+Shift+W)

- Calls `closePane(tabId, paneId, sessionId)` for the active pane
- This triggers the existing flow: DELETE session API call, remove pane from state, redistribute widths
- If it's the last pane in the tab, the tab closes (existing behavior)
- After closing, the adjacent pane (previous, or first remaining) becomes active

### 6.4 Pane Button Tooltips

All 3 pane header buttons get wrapped with the existing `ShortcutHint` component:

| Button | Tooltip Label | Keys (Mac) | Keys (Win/Linux) |
|--------|---------------|------------|-------------------|
| Bug icon | Inspect terminal | (no keys — label only) | (no keys — label only) |
| Eraser icon | Clear terminal | ⌘ ⇧ K | Ctrl ⇧ K |
| X icon | Close pane | ⌘ ⇧ W | Ctrl ⇧ W |

For Inspect, the `ShortcutHint` wrapper shows the label but no key badges (pass empty `keys` array or omit).

## 7. Feature 5: Shortcuts Reference Overlay

### 7.1 Trigger

- **Shortcut:** Cmd+/ (Mac) / Ctrl+/ (Windows/Linux)
- **Icon:** Keyboard icon button in sidebar footer (next to Settings icon)
- Chrome-safe: Cmd+/ is not a Chrome shortcut

### 7.2 Behavior

- Opens a modal overlay listing all keyboard shortcuts
- Grouped by category with section headers
- Dismiss with Escape, click outside, or pressing Cmd+/ again
- Platform-aware: shows Cmd on Mac, Ctrl on Windows/Linux

### 7.3 UI

```
┌─────────────────────────────────────────┐
│                                         │
│          Keyboard Shortcuts             │
│                                         │
│  NAVIGATION                             │
│  Switch project          ⌘ ⇧ P         │
│  Select pane 1-9         ⌘ ⌥ 1-9       │
│                                         │
│  TERMINALS                              │
│  New terminal            ⌘ ⇧ J         │
│  Split right             ⌘ ⇧ D         │
│  Clear terminal          ⌘ ⇧ K         │
│  Close pane              ⌘ ⇧ W         │
│                                         │
│  WORKSPACE                              │
│  Toggle sidebar          ⌘ B           │
│  Toggle file tree        ⌘ ⇧ B         │
│  Keyboard shortcuts      ⌘ /           │
│                                         │
└─────────────────────────────────────────┘
```

- Modal: centered, max-width 480px, dark background with blur backdrop
- Title: "Keyboard Shortcuts" centered at top
- Sections: uppercase category headers in muted text
- Rows: action name (left) + key badges (right) using `<kbd>` elements styled like existing `shortcut-kbd` class
- Animation: `slideUp` on open

### 7.4 Sidebar Icon

- Added next to the existing Settings button in the sidebar footer
- Icon: `Keyboard` from lucide-react (size 14)
- Same styling as the Settings button
- Title: "Keyboard shortcuts"
- In compact mode: displayed alongside Settings icon (same layout rules)

### 7.5 Shortcut Data

The shortcut list is a static array defined in the overlay component, structured as:

```javascript
const SHORTCUTS = [
  { category: 'Navigation', items: [
    { label: 'Switch project', mac: ['⌘', '⇧', 'P'], other: ['Ctrl', '⇧', 'P'] },
    { label: 'Select pane 1-9', mac: ['⌘', '⌥', '1-9'], other: ['Ctrl', 'Alt', '1-9'] },
  ]},
  { category: 'Terminals', items: [
    { label: 'New terminal', mac: ['⌘', '⇧', 'J'], other: ['Ctrl', '⇧', 'J'] },
    { label: 'Split right', mac: ['⌘', '⇧', 'D'], other: ['Ctrl', '⇧', 'D'] },
    { label: 'Clear terminal', mac: ['⌘', '⇧', 'K'], other: ['Ctrl', '⇧', 'K'] },
    { label: 'Close pane', mac: ['⌘', '⇧', 'W'], other: ['Ctrl', '⇧', 'W'] },
  ]},
  { category: 'Workspace', items: [
    { label: 'Toggle sidebar', mac: ['⌘', 'B'], other: ['Ctrl', 'B'] },
    { label: 'Toggle file tree', mac: ['⌘', '⇧', 'B'], other: ['Ctrl', '⇧', 'B'] },
    { label: 'Keyboard shortcuts', mac: ['⌘', '/'], other: ['Ctrl', '/'] },
  ]},
];
```

## 8. Complete Shortcut Map

All keyboard shortcuts after this feature is implemented:

| Shortcut (Mac) | Shortcut (Win) | Action | Scope | New? |
|----------------|----------------|--------|-------|------|
| ⌘ B | Ctrl+B | Toggle sidebar | Global | No |
| ⌘ ⇧ B | Ctrl+⇧+B | Toggle file tree | Global | No |
| ⌘ ⇧ P | Ctrl+⇧+P | Project quick switcher | Global | Yes |
| ⌘ / | Ctrl+/ | Shortcuts reference | Global | Yes |
| ⌘ ⇧ D | Ctrl+⇧+D | Split right | Active tab | No |
| ⌘ ⇧ J | Ctrl+⇧+J | New terminal tab | Active tab | Yes |
| ⌘ ⌥ 1-9 | Ctrl+Alt+1-9 | Select pane by number | Active tab | Yes |
| ⌘ ⇧ K | Ctrl+⇧+K | Clear active pane | Active pane | Yes |
| ⌘ ⇧ W | Ctrl+⇧+W | Close active pane | Active pane | Yes |

## 9. Keyboard Event Architecture

### 9.1 Current Pattern

- **App.jsx**: registers `keydown` on `window` (bubble phase) for global shortcuts (Cmd+B, Cmd+Shift+B)
- **TerminalArea.jsx**: registers `keydown` on `window` with **capture phase** (`true`) to intercept before xterm.js steals key events (Cmd+Shift+D, Cmd+Shift+J)

### 9.2 New Shortcut Registration

New shortcuts follow the same pattern:
- **Global shortcuts** (project switcher Cmd+Shift+P, shortcuts overlay Cmd+/) — registered in App.jsx's keydown handler
- **Pane-scoped shortcuts** (pane selection Cmd+Option+N, clear Cmd+Shift+K, close Cmd+Shift+W) — registered in TerminalArea.jsx's capture-phase keydown handler

All new handlers call `e.preventDefault()` and `e.stopPropagation()` to prevent Chrome and xterm.js from processing the keys.

## 10. Files Affected

### New Files
- `client/src/components/ProjectSwitcher.jsx` — project filter overlay
- `client/src/components/ShortcutsOverlay.jsx` — shortcuts reference modal

### Modified Files
- `client/src/components/TerminalArea.jsx` — active pane state, pane shortcuts, pane button tooltips
- `client/src/App.jsx` — global shortcut handlers, overlay state, render overlays
- `client/src/components/Sidebar.jsx` — keyboard icon in footer
- `client/src/styles/global.css` — active pane border, overlay styles
