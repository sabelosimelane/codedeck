# Terminal Activity Dashboard — Frontend Specification

**Version:** 1.0
**Date:** 2026-04-10
**Status:** Draft
**Backend Spec:** N/A — backend changes are minor (extend existing `GET /api/sessions`)

## 1. Overview

Add per-terminal activity visibility to the sidebar. Every project with active terminals shows an always-expanded list of individual terminal sessions — each with a live execution indicator, time context, and a subtle preview of the terminal's last output line. When a long-running foreground command finishes (busy → idle after the configured cooldown), a browser notification fires so the user sees it even if CodeDeck is in the background. Projects can be muted to suppress notifications.

**Key UX goal:** See at a glance which terminals are busy across all projects without switching tabs or clicking anything. The terminal list is purely informational — no click-to-navigate.

## 2. Sidebar Terminal List

### 2.1 Layout

The terminal list is nested under each project row in the sidebar, below the existing summary line ("2 terminals · 14m"). Always expanded — no toggle, no collapse.

```
● Alpha                        📁 ✏ 🗑 🔔
  2 terminals · 14m
    ● alpha-1 · 3s ago
      [INFO] Building module...
    ○ alpha-2 · 2m ago
      Tests passed: 42/42

● sentinel                       📁 ✏ 🗑 🔔
  1 terminal · 26m
    ● sentinel-1 · 1s ago
      Compiling src/main.rs...
```

### 2.2 Terminal Row Structure

Each terminal row consists of two lines, indented further than the summary:

**Line 1:** Activity dot + session label + time since last output
- Activity dot: 6px circle, colored by status (see §2.3)
- Session label: the sessionId (e.g., `alpha-1`)
- Time: relative timestamp from `lastOutputAt` — "3s ago", "2m ago", "1h ago"

**Line 2:** Last output line preview
- Last non-empty line of PTY output, ANSI escape codes stripped
- Styled very subdued: `11px`, `var(--font-mono)`, `var(--text-muted)`, `opacity: 0.6`
- Single line, `text-overflow: ellipsis`, no wrapping
- Truncated to sidebar width minus indentation

### 2.3 Activity Status & Indicators

| Status | Dot Color | Animation | Condition |
|--------|-----------|-----------|-----------|
| Busy | `var(--accent)` (green) | Pulsing glow — CSS keyframe animation that scales opacity 0.4→1.0 and adds a subtle `box-shadow` glow, 1.5s cycle | `executionStatus: "running"` |
| Idle | `var(--text-muted)` (gray) | None — static dot | `executionStatus: "idle"` |
| Unknown | `var(--text-muted)` (gray) | None — static dot | tmux foreground state cannot be determined |
| Dead | `var(--danger)` (red) | None — static dot | `alive: false` (process exited) |

**Busy pulse animation:**
```css
@keyframes terminalPulse {
  0%, 100% { opacity: 0.4; box-shadow: 0 0 0 0 var(--accent); }
  50% { opacity: 1; box-shadow: 0 0 6px 2px var(--accent); }
}
```

### 2.4 Indentation

- Project name row: `padding-left: 16px` (existing)
- Summary line ("2 terminals · 14m"): `margin-left: 22px` (existing)
- Terminal row line 1 (dot + label + time): `margin-left: 30px`
- Terminal row line 2 (output preview): `margin-left: 38px`

### 2.5 Time Formatting

Time since last output, calculated from `lastOutputAt`:
- `<5s` → "just now"
- `5s–59s` → "Ns ago"
- `1m–59m` → "Nm ago"
- `1h+` → "Nh ago"

Updated on each poll cycle.

## 3. Browser Notifications

### 3.1 Trigger Logic

A notification fires when ALL of these are true:
1. The terminal was in "busy" state (`executionStatus: "running"`) for at least the configured cooldown
2. The terminal transitions to "idle" (foreground shell prompt returned) or "dead" (process exited)
3. The project is not muted
4. The browser tab is not focused (optional — notify even when focused if user prefers, but standard practice is background-only)
5. Notification permission has been granted

### 3.2 Notification Content

```
Title: "CodeDeck — alpha-1 finished"
Body: <last output line preview, same as sidebar>
Icon: (optional — CodeDeck favicon or a green checkmark)
```

### 3.3 Permission Request

On first terminal activity detection (when the polling first sees a busy terminal), request `Notification.requestPermission()`. This is a one-time browser prompt. If denied, notifications silently don't fire — no error toast or nag.

### 3.4 Busy Duration Tracking

The frontend tracks per-session busy duration:
- When a session first appears as "busy" (`executionStatus: "running"`), record `busyStartedAt = Date.now()`
- On each poll, if still busy, keep the timestamp
- When it transitions to idle/dead: if `Date.now() - busyStartedAt >= 30000`, fire notification
- Reset `busyStartedAt` when the session becomes busy again after being idle

This state is ephemeral — held in a React ref or module-level Map, not persisted.

## 4. Per-Project Mute Toggle

### 4.1 UI

A small bell icon button on the project row, next to the existing action buttons (📁 ✏ 🗑):
- **Unmuted (default):** `Bell` icon from lucide-react, same style as other action buttons (`var(--text-muted)`, `opacity: 0.5`)
- **Muted:** `BellOff` icon, same styling — visually indicates notifications are suppressed

Clicking toggles the mute state. No toast — the icon change is sufficient feedback.

### 4.2 Persistence

Mute state is persisted to `localStorage` under key `codedeck-muted-projects`:
```json
["sentinel", "anvil"]
```

An array of muted project names. Default is empty (all unmuted).

### 4.3 Scope

Muting only suppresses browser notifications. All visual indicators (activity dots, pulsing, output previews, time) continue to display normally. The sidebar remains fully informational regardless of mute state.

## 5. Backend Changes

### 5.1 Extend `GET /api/sessions` Response

Add execution-state fields plus `lastOutputLine` to each session entry:

```json
[
  {
    "sessionId": "alpha-1",
    "cwd": "/home/user/projects/alpha",
    "startedAt": "2026-04-10T09:30:00.000Z",
    "lastOutputAt": "2026-04-10T09:44:12.000Z",
    "alive": true,
    "executionStatus": "running",
    "foregroundCommand": "npm",
    "executionReason": "foreground_command",
    "executionConfidence": "medium",
    "lastOutputLine": "[INFO] Building module auth-service..."
  }
]
```

`executionStatus` is authoritative for busy/done UX. `executionReason` and `executionConfidence` explain the ordered evidence used by the classifier, such as `shell_prompt`, `foreground_command`, `agent_prompt_idle`, `agent_working`, or `agent_background_terminal`. Output timestamps remain preview/activity telemetry only. For persistent agent CLIs that keep a foreground process open after a turn completes, the backend uses the visible tmux snapshot to recognize known active and idle markers instead of treating the long-lived process itself as proof of activity.

### 5.2 Backend Buffering

In the `onData` handler (ws-handler.js), after updating `lastOutputAt`:
- Strip ANSI escape codes from the output chunk
- Split by newlines, take the last non-empty line
- Store as `entry.lastOutputLine` (overwrite on each output event)

ANSI stripping regex: `/\x1b\[[0-9;]*[a-zA-Z]/g` (covers standard SGR sequences, cursor movement, etc.)

The buffer is a single string, not an array — only the most recent line matters.

### 5.3 Output Line Sanitization

- Strip ANSI escape codes
- Strip carriage returns (`\r`)
- Trim whitespace
- Truncate to 200 characters (server-side safety limit)
- If empty after stripping, keep the previous `lastOutputLine`

## 6. Frontend Polling

### 6.1 Poll Frequency

Increase the existing session poll from 5 seconds to 2 seconds. The terminal list needs to feel responsive — a 5-second lag between a terminal finishing and the dot going static feels sluggish.

### 6.2 Data Flow

```
App.jsx polls GET /api/sessions every 2s
  → sessionStatus state (array of session objects)
  → passed to Sidebar as prop (existing pattern)
  → Sidebar maps sessions to projects (existing getProjectSessions)
  → Sidebar renders terminal rows per session
  → Sidebar tracks busy duration in a ref for notification logic
```

## 7. Component Changes

### 7.1 Sidebar.jsx

**New rendering:** After the existing summary line (`{count} terminals · {elapsed}`), render a list of individual terminal rows for each project.

**New state/refs:**
- `mutedProjects` state — loaded from localStorage on mount, saved on change
- `busyTracker` ref — `Map<sessionId, { busyStartedAt: number }>` for notification timing

**New helpers:**
- `getTerminalStatus(session)` — returns `'busy' | 'idle' | 'dead' | 'unknown'` based on `executionStatus` and `alive`
- `formatTimeSince(isoString)` — returns "just now", "Ns ago", "Nm ago", "Nh ago"
- `checkAndNotify(projectName, session, prevStatus, newStatus)` — fires browser notification if conditions met

### 7.2 global.css

Add `terminalPulse` keyframe animation (§2.3).

### 7.3 App.jsx

Change poll interval from 5000 to 2000.

## 8. Design Language

### 8.1 Terminal Row Visual Style

The terminal rows should feel like ambient telemetry — visible but not demanding attention. They sit in the background of your peripheral vision until something changes.

- **Typography:** `11px` `var(--font-mono)` for session label and time, `11px` for output preview
- **Colors:** Session label in `var(--text-secondary)`, time in `var(--text-muted)`, output preview in `var(--text-muted)` at `opacity: 0.6`
- **Spacing:** 4px vertical gap between terminal rows, 2px gap between line 1 and line 2
- **No borders, no backgrounds** — the indentation and dot are enough visual separation

### 8.2 Pulse Animation

The busy pulse should catch peripheral vision without being distracting:
- Gentle opacity oscillation (0.4 → 1.0), not a hard blink
- Subtle green glow via `box-shadow` that expands and fades
- 1.5-second cycle — slow enough to feel like breathing, not flickering
- Only the dot animates — the text stays static

### 8.3 Mute Button

Same visual weight as the existing action buttons (pencil, trash, folder). Doesn't stand out — you only notice it when you look for it.

## 9. Accessibility

- Activity dots use `title` attribute for screen readers: "Terminal alpha-1: busy", "Terminal alpha-2: idle"
- Pulse animation respects `prefers-reduced-motion` — degrades to a static bright green dot
- Mute toggle has `aria-label`: "Mute notifications for {project}" / "Unmute notifications for {project}"

## 10. Non-Goals

- Terminal row click-to-navigate (explicitly rejected — sidebar is informational only)
- Per-terminal mute (project-level only)
- Terminal renaming or custom labels
- Output preview longer than one line
- Full terminal output history in sidebar
- Sound notifications (browser notification only)
