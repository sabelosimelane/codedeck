# Terminal Activity Dashboard — Frontend

**Spec**: `docs/specifications/terminal-activity-frontend-spec.md`
**Status**: Not Started
**Created**: 2026-04-10

---

## Phase 1: Backend — Last Output Line Buffering
> Extend the backend to capture and serve the last output line per terminal session. This is the data foundation for the sidebar terminal list.
> **Inputs:** Existing `onData` handler in ws-handler.js, existing `GET /api/sessions` endpoint
> **Outputs:** `lastOutputLine` field in session entries, ANSI-stripped and truncated
> **Closed when:** `GET /api/sessions` returns `lastOutputLine` for each session, verified with a running terminal

- [ ] Add ANSI escape code stripping utility — regex `/\x1b\[[0-9;]*[a-zA-Z]/g` plus `\r` stripping and whitespace trim (Spec §5.3)
- [ ] Add `lastOutputLine` field to session entries in ws-handler.js — initialize to `''` on session creation (Spec §5.2)
- [ ] Update `onData` handler to extract last non-empty line from output, strip ANSI codes, truncate to 200 chars, store as `entry.lastOutputLine` (Spec §5.2)
- [ ] Update `GET /api/sessions` endpoint in index.js to include `lastOutputLine` in response (Spec §5.1)
- [ ] Verify: start a terminal, run a command, call `GET /api/sessions` — confirm `lastOutputLine` contains the latest clean output line

## Phase 2: Sidebar Terminal List
> Render individual terminal rows under each project in the sidebar with activity dots, session labels, time context, and output preview.
> **Inputs:** `sessionStatus` prop (already passed to Sidebar), extended with `lastOutputLine`
> **Outputs:** Always-expanded terminal list under every project with terminals
> **Closed when:** Every project shows its individual terminals with status dots, time, and output preview; updates every 2 seconds

- [ ] Add `terminalPulse` keyframe animation to global.css — opacity 0.4→1.0 with subtle green box-shadow glow, 1.5s cycle, respects `prefers-reduced-motion` (Spec §2.3, §9)
- [ ] Add `getTerminalStatus(session)` helper to Sidebar.jsx — returns `'busy'|'idle'|'dead'` based on `lastOutputAt` (5s threshold) and `alive` flag (Spec §2.3)
- [ ] Add `formatTimeSince(isoString)` helper — returns "just now", "Ns ago", "Nm ago", "Nh ago" (Spec §2.5)
- [ ] Render terminal rows under each project's summary line — indented at `margin-left: 30px` (line 1) and `38px` (line 2), activity dot + session label + time on line 1, output preview on line 2 (Spec §2.1, §2.2, §2.4)
- [ ] Style activity dot — 6px circle, green with `terminalPulse` animation when busy, static gray when idle, static red when dead (Spec §2.3, §8.2)
- [ ] Style output preview — `11px`, `var(--font-mono)`, `var(--text-muted)`, `opacity: 0.6`, single line with ellipsis overflow (Spec §2.2, §8.1)
- [ ] Add `title` attributes to activity dots for accessibility: "Terminal {sessionId}: {status}" (Spec §9)
- [ ] Change poll interval in App.jsx from 5000ms to 2000ms for more responsive updates (Spec §6.1)
- [ ] Verify: open project with 2+ terminals → sidebar shows individual terminal rows with correct status dots, time, and output preview → run a command → dot pulses green → wait 10s → dot goes gray

## Phase 3: Browser Notifications
> Fire browser notifications when a long-running terminal finishes. Track busy duration per session, request permission, respect project mute state.
> **Inputs:** Session status from polling, terminal activity transitions
> **Outputs:** Browser notifications on busy→idle/dead transitions after 30s+ of activity
> **Closed when:** Running a long command (30s+) triggers a browser notification when it finishes; quick commands do not; muted projects are silent

- [ ] Request `Notification.requestPermission()` on first poll that detects a busy terminal — one-time, no error if denied (Spec §3.3)
- [ ] Add `busyTracker` ref in Sidebar.jsx — `Map<sessionId, { busyStartedAt: number }>` tracking when each session entered busy state (Spec §3.4)
- [ ] Implement busy duration tracking in poll effect — on each poll, for each session: if newly busy → set `busyStartedAt`; if still busy → keep; if transitioned to idle/dead → check duration ≥ 30s → fire notification → clear tracker (Spec §3.4)
- [ ] Fire `new Notification()` with title "CodeDeck — {sessionId} finished" and body containing last output line preview (Spec §3.2)
- [ ] Add `mutedProjects` state to Sidebar.jsx — initialized from `localStorage` key `codedeck-muted-projects`, defaults to empty array (Spec §4.2)
- [ ] Add mute toggle button to project row — `Bell`/`BellOff` icon from lucide-react, positioned with existing action buttons, toggles project in `mutedProjects` array, persists to localStorage on change (Spec §4.1, §4.2)
- [ ] Add `aria-label` to mute toggle: "Mute/Unmute notifications for {project}" (Spec §9)
- [ ] Skip notification if project is in `mutedProjects` array (Spec §4.3)
- [ ] Verify: run a 30s+ command → terminal goes idle → browser notification appears → mute the project → repeat → no notification → unmute → notification works again

## Phase 4: Polish & Edge Cases
> Handle edge cases, verify animation performance, and ensure everything degrades gracefully.

- [ ] Verify `prefers-reduced-motion` disables pulse animation — dot should be static bright green instead (Spec §9)
- [ ] Verify terminal list renders correctly with 0, 1, 4+ terminals per project (Spec §2.1)
- [ ] Verify dead terminals show red static dot and last output line is preserved (Spec §2.3)
- [ ] Verify mute state persists across page refresh — mute a project, reload, check it's still muted (Spec §4.2)
- [ ] Verify notification permission denied gracefully — no errors, no repeated prompts (Spec §3.3)
- [ ] Verify sidebar scrolling works smoothly with 3-4 projects each having multiple terminals (Spec §2.1)
- [ ] Verify poll interval of 2s does not cause performance issues (Spec §6.1)
- [ ] Run full test suite to check no regressions
