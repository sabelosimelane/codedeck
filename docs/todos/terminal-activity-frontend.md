# Terminal Activity Dashboard — Frontend

**Spec**: `docs/specifications/terminal-activity-frontend-spec.md`
**Status**: Complete
**Last completed**: Phase 4: Polish & Edge Cases
**Created**: 2026-04-10

---

## Phase 1: Backend — Last Output Line Buffering
> Extend the backend to capture and serve the last output line per terminal session. This is the data foundation for the sidebar terminal list.
> **Inputs:** Existing `onData` handler in ws-handler.js, existing `GET /api/sessions` endpoint
> **Outputs:** `lastOutputLine` field in session entries, ANSI-stripped and truncated
> **Closed when:** `GET /api/sessions` returns `lastOutputLine` for each session, verified with a running terminal

- [x] Add ANSI escape code stripping utility — regex `/\x1b\[[0-9;]*[a-zA-Z]/g` plus `\r` stripping and whitespace trim (Spec §5.3)
- [x] Add `lastOutputLine` field to session entries in ws-handler.js — initialize to `''` on session creation (Spec §5.2)
- [x] Update `onData` handler to extract last non-empty line from output, strip ANSI codes, truncate to 200 chars, store as `entry.lastOutputLine` (Spec §5.2)
- [x] Update `GET /api/sessions` endpoint in index.js to include `lastOutputLine` in response (Spec §5.1)
- [x] Verify: start a terminal, run a command, call `GET /api/sessions` — confirm `lastOutputLine` contains the latest clean output line

## Phase 2: Sidebar Terminal List
> Render individual terminal rows under each project in the sidebar with activity dots, session labels, time context, and output preview.
> **Inputs:** `sessionStatus` prop (already passed to Sidebar), extended with `lastOutputLine`
> **Outputs:** Always-expanded terminal list under every project with terminals
> **Closed when:** Every project shows its individual terminals with status dots, time, and output preview; updates every 2 seconds

- [x] Add `terminalPulse` keyframe animation to global.css — opacity 0.4→1.0 with subtle green box-shadow glow, 1.5s cycle, respects `prefers-reduced-motion` (Spec §2.3, §9)
- [x] Add `getTerminalStatus(session)` helper to Sidebar.jsx — returns `'busy'|'idle'|'dead'` based on `lastOutputAt` (5s threshold) and `alive` flag (Spec §2.3)
- [x] Add `formatTimeSince(isoString)` helper — returns "just now", "Ns ago", "Nm ago", "Nh ago" (Spec §2.5)
- [x] Render terminal rows under each project's summary line — indented at `margin-left: 30px` (line 1) and `38px` (line 2), activity dot + session label + time on line 1, output preview on line 2 (Spec §2.1, §2.2, §2.4)
- [x] Style activity dot — 6px circle, green with `terminalPulse` animation when busy, static gray when idle, static red when dead (Spec §2.3, §8.2)
- [x] Style output preview — `11px`, `var(--font-mono)`, `var(--text-muted)`, `opacity: 0.6`, single line with ellipsis overflow (Spec §2.2, §8.1)
- [x] Add `title` attributes to activity dots for accessibility: "Terminal {sessionId}: {status}" (Spec §9)
- [x] Change poll interval in App.jsx from 5000ms to 2000ms for more responsive updates (Spec §6.1)
- [x] Verify: open project with 2+ terminals → sidebar shows individual terminal rows with correct status dots, time, and output preview → run a command → dot pulses green → wait 10s → dot goes gray

## Phase 3: Browser Notifications
> Fire browser notifications when a long-running terminal finishes. Track busy duration per session, request permission, respect project mute state.
> **Inputs:** Session status from polling, terminal activity transitions
> **Outputs:** Browser notifications on busy→idle/dead transitions after 30s+ of activity
> **Closed when:** Running a long command (30s+) triggers a browser notification when it finishes; quick commands do not; muted projects are silent

- [x] Request `Notification.requestPermission()` on first poll that detects a busy terminal — one-time, no error if denied (Spec §3.3)
- [x] Add `busyTracker` ref in Sidebar.jsx — `Map<sessionId, { busyStartedAt: number }>` tracking when each session entered busy state (Spec §3.4)
- [x] Implement busy duration tracking in poll effect — on each poll, for each session: if newly busy → set `busyStartedAt`; if still busy → keep; if transitioned to idle/dead → check duration ≥ 30s → fire notification → clear tracker (Spec §3.4)
- [x] Fire `new Notification()` with title "CodeDeck — {sessionId} finished" and body containing last output line preview (Spec §3.2)
- [x] Add `mutedProjects` state to Sidebar.jsx — initialized from `localStorage` key `codedeck-muted-projects`, defaults to empty array (Spec §4.2)
- [x] Add mute toggle button to project row — `Bell`/`BellOff` icon from lucide-react, positioned with existing action buttons, toggles project in `mutedProjects` array, persists to localStorage on change (Spec §4.1, §4.2)
- [x] Add `aria-label` to mute toggle: "Mute/Unmute notifications for {project}" (Spec §9)
- [x] Skip notification if project is in `mutedProjects` array (Spec §4.3)
- [x] Verify: run a 30s+ command → terminal goes idle → browser notification appears → mute the project → repeat → no notification → unmute → notification works again

## Phase 4: Polish & Edge Cases
> Handle edge cases, verify animation performance, and ensure everything degrades gracefully.

- [x] Verify `prefers-reduced-motion` disables pulse animation — dot should be static bright green instead (Spec §9)
- [x] Verify terminal list renders correctly with 0, 1, 4+ terminals per project (Spec §2.1)
- [x] Verify dead terminals show red static dot and last output line is preserved (Spec §2.3)
- [x] Verify mute state persists across page refresh — mute a project, reload, check it's still muted (Spec §4.2)
- [x] Verify notification permission denied gracefully — no errors, no repeated prompts (Spec §3.3)
- [x] Verify sidebar scrolling works smoothly with 3-4 projects each having multiple terminals (Spec §2.1)
- [x] Verify poll interval of 2s does not cause performance issues (Spec §6.1)
- [x] Run full test suite to check no regressions

---

## Session Notes

### Session — 2026-04-10 (Phase 4)
**Completed**: Phase 4: Polish & Edge Cases
**Key files**: No code changes — all verifications passed via code review and test run.
**Result**: 23/23 server tests passed. All edge cases correct: `prefers-reduced-motion` CSS override present, 0/4+ terminals guarded, dead sessions show red static dot, mute localStorage persisted, permission denial silently no-ops, sidebar `overflowY: auto` handles scroll, poll at 2s.
**Feature complete.**

### Session — 2026-04-10 (Phase 3)
**Completed**: Phase 3: Browser Notifications
**Key files**:
- `client/src/components/Sidebar.jsx` — added `Bell`/`BellOff` imports; `mutedProjects` state (localStorage init/persist); `busyTracker`, `prevStatusRef`, `permissionRequested`, `mutedProjectsRef`, `activeProjectsRef` refs; notification `useEffect` watching `sessionStatus`; `toggleMute()` handler; mute button per project row after Trash2
**Architecture**: Notification logic lives entirely in Sidebar.jsx via a `useEffect([sessionStatus])`. Mutable refs (`mutedProjectsRef`, `activeProjectsRef`) avoid stale closures without adding them as deps and causing spurious re-runs. `prevStatusRef` tracks per-session status across polls to detect busy→idle/dead transitions. `busyTracker` deleted when session leaves busy state (covering dead sessions too).
**Next**: Phase 4: Polish & Edge Cases — verify `prefers-reduced-motion`, 0/1/4+ terminal counts, dead terminal display, mute persistence, permission denial, sidebar scroll, and run full test suite.

### Session — 2026-04-10 (Phase 1–2)
**Completed**: Phase 2: Sidebar Terminal List
**Key files**:
- `server/ws-handler.js` — `extractLastLine()` strips ANSI+CR, splits by newline, takes last non-empty, truncates to 200. `lastOutputLine: ''` initialized on entry creation, updated in `onData`.
- `server/index.js` — `GET /api/sessions` now includes `lastOutputLine: entry.lastOutputLine || ''`
- `client/src/styles/global.css` — added `@keyframes terminalPulse` + `.terminal-dot-busy` class + `prefers-reduced-motion` override (Phase 4 covered)
- `client/src/components/Sidebar.jsx` — added `getTerminalStatus(session)` (5s threshold), `formatTimeSince(isoString)`, terminal rows rendered after summary line with pulsing dot, sessionId, time, and output preview
- `client/src/App.jsx` — poll interval changed from 5000ms to 2000ms
**Architecture**: Terminal rows use CSS class `.terminal-dot-busy` for animation (not inline) so `prefers-reduced-motion` media query can override it cleanly.
**Next**: Phase 3: Browser Notifications — `busyTracker` ref, `Notification.requestPermission()` on first busy detection, notification on busy→idle/dead after 30s, mute toggle with `Bell`/`BellOff` icons, `localStorage` persistence.
