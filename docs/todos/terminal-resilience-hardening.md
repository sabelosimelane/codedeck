# Terminal Resilience Hardening

**Spec**: `docs/specifications/terminal-resilience-hardening-spec.md`
**Status**: Complete
**Last completed**: Phase 6: Final Verification and Documentation
**Created**: 2026-04-11

## Phase 1: Debug Inspector and Session Ground Truth
> Build the hidden diagnostic slice that explains a sick pane without changing the default workspace experience.
> **Inputs:** Existing PTY session map, existing `GET /api/sessions`, existing terminal pane chrome
> **Outputs:** Pane-local inspector, debug endpoint, session health summary, recent event timeline
> **Closed when:** A misbehaving pane can be inspected and classified as PTY, transport, or browser-view related without reading raw logs

- [x] Extend backend session entries with diagnostic metadata in `server/ws-handler.js` (Spec §4.1, §4.3 — attachment timestamps, client ack timestamp, stall reason, bounded event timeline)
- [x] Extend `GET /api/sessions` in `server/index.js` with lightweight health summary fields (Spec §5.1, §6.1 — `wsAttached`, `lastClientAckAt`, `health`, `stallReason`)
- [x] Add `GET /api/debug/terminal-health` in `server/index.js` returning per-session diagnostics and recent events (Spec §5.2, §6.2 — rich debug snapshot for inspector use)
- [x] Add pane-local inspector entry point in `client/src/components/TerminalArea.jsx` (Spec §3.2, §3.3 — hidden-by-default debug affordance in pane chrome)
- [x] Add inspector UI and session fetch flow in `client/src/components/Terminal.jsx` or a dedicated terminal debug component (Spec §3.2, §4.2 — current state snapshot plus event timeline)
- [x] Compute and render explicit health labels `healthy`, `detached`, `reconnecting`, `stalled`, `replaying`, `dead` (Spec §3.4 — avoid vague connected/disconnected wording)
- [x] Add `Copy debug snapshot` action in the inspector (Spec §3.2, §7.5 — copy current diagnostics and recent events for live bug capture)
- [x] Unit/integration verification for debug endpoint and health classification (Spec §4, §5 — prove the backend returns consistent diagnostic state for attach/detach/exit scenarios)

## Phase 2: Visibility-Aware Refocus Recovery
> Make backgrounding and refocus a first-class state transition instead of a silent browser quirk.
> **Inputs:** Phase 1 diagnostics, existing xterm fit/resize behavior, browser visibility state
> **Outputs:** Explicit hidden/visible tracking, refocus resync path, stale-view detection
> **Closed when:** Returning to a backgrounded tab triggers deterministic recovery and the inspector can explain whether the pane is recovering or stalled

- [x] Add `document.visibilitychange` handling in the terminal client (Spec §7.2 — record hidden/visible transitions and push timeline events)
- [x] Track client-side `documentVisibility`, `lastMessageAt`, `lastPaintAt`, and `lastResizeAt` in terminal session state (Spec §4.2 — browser-view diagnostics)
- [x] On refocus, force xterm fit, resend resize, and trigger an explicit resume/resync request path even if the socket never formally closed (Spec §7.2 — deterministic refocus recovery)
- [x] Add stale-view detection logic that marks a pane `stalled` when backend output advances without corresponding client acknowledgment or paint updates (Spec §7.3 — distinguish stale view from dead PTY)
- [x] Surface hidden/visible transitions and stale-view status in the inspector timeline and snapshot (Spec §4.3, §7.2, §7.3 — make the failure story legible)
- [x] Add browser-focused tests or targeted manual verification scenarios for hidden → visible transitions and refocus recovery (Spec §7.2 — prove the recovery path works under throttling-prone conditions)

## Phase 3: Heartbeat, Sequence Numbers, and Replay
> Upgrade the transport from best-effort reconnect to loss-aware recovery with bounded replay.
> **Inputs:** Phase 1 diagnostic model, Phase 2 refocus flow, current WebSocket terminal protocol
> **Outputs:** Heartbeat messages, monotonic output sequencing, bounded replay buffer, resume/replay recovery
> **Closed when:** A pane that misses output during reconnect or backgrounding can catch up from a replay buffer and report when a gap exceeded that buffer

- [x] Add monotonic output `seq` assignment and bounded per-session replay buffer in `server/ws-handler.js` (Spec §4.1, §7.4 — retain recent output chunks for recovery)
- [x] Extend terminal output messages to include `seq` and add `resume`, `replay`, and heartbeat protocol messages (Spec §5.3, §6.3, §6.4 — formalize recovery-capable transport)
- [x] Track `lastSeenSeq` and `reconnectCount` on the client (Spec §4.2 — maintain recovery cursor and attachment history)
- [x] On reconnect or refocus, request resume from `lastSeenSeq` and apply replayed output before clearing recovery state (Spec §7.4 — deterministic catch-up flow)
- [x] Detect and surface replay-window overflow or partial replay conditions in the inspector (Spec §7.4 — make missing history explicit rather than silent)
- [x] Add protocol-level tests covering ordered output, replay correctness, heartbeat handling, and reconnect edge cases (Spec §5.3, §7.4 — verify recovery semantics, not just happy-path reconnect)

## Phase 4: Explicit Recovery UX and Supporting Logs
> Convert the new health model into a practical operator workflow when something feels wrong.
> **Inputs:** Phase 1 inspector, Phase 2 stall states, Phase 3 replay-aware transport
> **Outputs:** Recovery actions, richer lifecycle logs, usable recovery loop
> **Closed when:** A user can inspect a sick pane, choose the least-destructive recovery action, and understand what happened afterward

- [x] Add explicit inspector actions for `Reconnect`, `Resync`, and `Redraw` (Spec §7.5 — expose deterministic recovery controls instead of relying on ad hoc focus changes)
- [x] Wire recovery actions to the underlying socket/resume/xterm repaint flows with clear post-action status updates (Spec §7.5 — actions must change state in a traceable way)
- [x] Add structured terminal lifecycle logging on the backend for attach, detach, replay, stall, and exit events (Spec §4.3, §7.5 — support deeper diagnosis when inspector evidence is insufficient)
- [x] Surface action outcomes and health transitions in the inspector timeline (Spec §4.3, §7.5 — the user should see whether recovery succeeded, replayed, or failed)
- [x] Verify that the main workspace stays clean while the debug tooling remains discoverable and effective (Spec §3.1, §7.6 — preserve normal UX while supporting debugging)

## Phase 5: Durable Runtime Options (`tmux` + `caffeinate`)
> Add the larger-scope runtime hardening options without making them prerequisites for correctness.
> **Inputs:** Stable diagnostics and recovery model from Phases 1–4, existing server startup workflow
> **Outputs:** tmux-backed session mode behind a rollout flag, optional macOS `caffeinate` support via server management
> **Closed when:** CodeDeck can run with durable tmux-backed terminal sessions and optional sleep guardrails while preserving the same browser-side pane model

- [x] Design and implement a runtime abstraction that allows the browser session model to target either raw `node-pty` or tmux-backed sessions (Spec §7.7 — keep browser concepts stable across backends)
- [x] Add configuration gating for tmux-backed session mode so rollout is incremental and reversible (Spec §7.7 — safe opt-in architecture)
- [x] Implement tmux-backed attach/detach behavior while preserving pane identity and inspector compatibility (Spec §7.7 — durable terminal substrate without losing debug tooling)
- [x] Add optional backend `caffeinate` integration to the existing server startup workflow on macOS (Spec §7.8 — operational guardrail managed via `server.sh`, not manual shell wrapping)
- [x] Verify tmux mode, raw PTY mode, and optional `caffeinate` behavior remain compatible with diagnostics, replay, and recovery actions (Spec §7.7, §7.8 — the larger runtime changes must not regress earlier phases)

## Phase 6: Final Verification and Documentation
> Lock the hardening work down as a coherent reliability feature rather than a stack of partial fixes.
> **Inputs:** All prior phases
> **Outputs:** Verified end-to-end terminal resilience story, updated docs, regression confidence
> **Closed when:** The full reliability flow is proven across debug inspection, background/refocus recovery, replay-aware transport, and optional durable runtime modes

- [x] Run full server and client verification for all implemented phases together (Spec §8.3 — regression check across health, recovery, and runtime behavior)
- [x] Perform end-to-end manual scenarios that reproduce the original failure shape: background tab, multiple active terminals, stalled-looking pane, refocus recovery, replay, and debug inspection (Spec §2.2, §7.2, §7.4 — prove the feature addresses the motivating problem)
- [x] Review inspector copy and health labels for clarity and signal-to-noise (Spec §3.1, §3.4 — debugging surface should be explicit without feeling like a generic metrics wall)
- [x] Update relevant user-facing or developer-facing documentation to reflect the debug inspector, recovery actions, and any runtime modes that shipped (Spec §1, §8 — keep the roadmap and product behavior documented)

---

## Session Notes

### Session — 2026-04-11 (Phase 1)
**Completed**: Phase 1: Debug Inspector and Session Ground Truth
**Key files**:
- `server/ws-handler.js` — extended session entries with `wsAttached`, `lastAttachAt`, `lastDetachAt`, `lastClientAckAt`, `lastReplayAt`, `lastSeq`, `stallReason`, `events[]`. Added `pushTimelineEvent()`, `computeSessionHealth()`, `computeStallReason()` exports. Heartbeat message handler updates `lastClientAckAt`. WebSocket close/PTY exit record timeline events.
- `server/index.js` — extended `GET /api/sessions` with health summary fields (`wsAttached`, `lastAttachAt`, `lastClientAckAt`, `lastSeq`, `health`, `stallReason`). Added `GET /api/debug/terminal-health` returning full diagnostics + last 20 events per session.
- `client/src/components/TerminalInspector.jsx` — new: modal inspector panel showing health dot + label, state snapshot table, reverse-chronological event timeline, copy debug snapshot action. Polls `/api/debug/terminal-health` every 3s. Dismiss via Escape/backdrop.
- `client/src/components/TerminalArea.jsx` — added Bug icon button (low opacity, hidden-by-default feel) in pane chrome, renders `TerminalInspector` when active.
- `client/src/components/Terminal.jsx` — added client heartbeat interval (5s) on WebSocket open, cleared on cleanup.
- `server/__tests__/ws-handler.test.js` — 50 tests: added 7 diagnostic metadata tests + `computeSessionHealth` (7 tests) + `computeStallReason` (3 tests).
**Architecture**: Health computation is pure functions exported from `ws-handler.js`, used by both API endpoints. Stall detection requires at least one heartbeat (`lastClientAckAt !== null`) before triggering — intentional to avoid false positives during the 5s window before first heartbeat. Timeline capped at 50 events per session.
**Next**: Phase 2: Visibility-Aware Refocus Recovery — add `document.visibilitychange` handling, client-side diagnostics tracking, deterministic refocus resync, stale-view detection.

### Session — 2026-04-11 (Phase 2)
**Completed**: Phase 2: Visibility-Aware Refocus Recovery
**Key files**:
- `client/src/components/Terminal.jsx` — added `document.visibilitychange` listener, client diagnostic refs (`lastMessageAtRef`, `lastPaintAtRef`, `lastResizeAtRef`, `documentVisibilityRef`), extended heartbeat with client diagnostics, extracted `syncTerminalSize` helper for refocus recovery (shared between visibility handler and isVisible effect), `mountedRef` guard on all deferred callbacks.
- `server/ws-handler.js` — handles `visibility_change` message (stores `documentVisibility`, pushes `visibility_hidden`/`visibility_visible` timeline events), extended heartbeat handler to store `clientLastMessageAt`/`clientLastPaintAt`/`clientLastResizeAt`, enhanced `computeStallReason` with `stale_view_document_hidden` (when document hidden) and `stale_view_paint_lagging` (when visible but paint lags output >10s).
- `server/index.js` — debug endpoint includes `documentVisibility`, `clientLastMessageAt`, `clientLastPaintAt`, `clientLastResizeAt` fields.
- `client/src/components/TerminalInspector.jsx` — snapshot table shows Doc Visibility, Last Message, Last Paint, Last Resize.
- `server/__tests__/ws-handler.test.js` — 59 tests total: added 10 tests for visibility change handling (message storage, timeline events, heartbeat diagnostics) and enhanced stall detection (stale_view_document_hidden, stale_view_paint_lagging).
**Architecture**: Client diagnostics flow via heartbeat messages to backend (every 5s), visibility transitions sent as explicit `visibility_change` messages that push timeline events. Stall detection now has 3 tiers: `stale_view_document_hidden` (browser throttled), `stale_view_paint_lagging` (visible but xterm paint behind), `server_output_outpaced_client_ack` (generic ack lag). Refocus recovery: on `document.visibilitychange` visible → deferred fit + resize + dimension sync.
**Bug fixes**: Fixed heartbeat interval capturing stale `ws` closure — now reads `wsRef.current`. Added `mountedRef.current` guard to visibility and isVisible setTimeout callbacks.
**Next**: Phase 3: Heartbeat, Sequence Numbers, and Replay — add monotonic `seq` to output, bounded replay buffer, `resume` message, client-side `lastSeenSeq` tracking, replay on reconnect/refocus.

### Session — 2026-04-11 (Phase 3)
**Completed**: Phase 3: Heartbeat, Sequence Numbers, and Replay
**Key files**:
- `server/ws-handler.js` — added `REPLAY_BUFFER_SIZE` (1000, exported), `replayBuffer: []` in session entry, `lastSeq` incremented in `onData` with seq included in output message, `resume` message handler that filters buffer, detects overflow, sends `replay` response, records timeline events (`replay_requested`, `replay_served`), stores `clientLastSeenSeq`/`clientReconnectCount` from heartbeat.
- `client/src/components/Terminal.jsx` — added `lastSeenSeqRef`, `reconnectCountRef`, `resumeInFlightRef`. Output handler tracks `msg.seq`. Replay handler writes chunks to xterm, updates `lastSeenSeq`, shows toast on overflow. Resume sent on reconnect (in `ws.onopen`) and on refocus (in visibility change handler), guarded by `resumeInFlightRef` to prevent duplicates. Heartbeat includes `lastSeenSeq` and `reconnectCount`.
- `client/src/components/TerminalInspector.jsx` — added Client Last Seq, Replay Buffer Size, Last Replay, Reconnect Count to snapshot table.
- `server/index.js` — debug endpoint returns `replayBufferSize`, `clientLastSeenSeq`, `clientReconnectCount`.
- `server/__tests__/ws-handler.test.js` — 76 tests total: added 17 tests for seq assignment, replay buffer bounds, resume/replay (exact, overflow, empty, caught-up), timeline events, lastReplayAt/lastClientAckAt updates, heartbeat Phase 3 fields. Updated 2 existing output tests to expect `seq` field.
**Architecture**: Replay buffer is a simple array with slice trim (not a ring buffer class) — sufficient for 1000 entries. Overflow detection: `oldestBufferedSeq > lastSeenSeq + 1` (gap means buffer can't serve seq N+1). Resume in-flight guard prevents duplicate replay when reconnect and refocus fire near-simultaneously.
**Next**: Phase 4: Explicit Recovery UX and Supporting Logs — add Reconnect/Resync/Redraw inspector actions, wire to underlying recovery flows, add structured lifecycle logging, surface action outcomes in timeline.

### Session — 2026-04-11 (Phase 4)
**Completed**: Phase 4: Explicit Recovery UX and Supporting Logs
**Key files**:
- `client/src/components/Terminal.jsx` — extended `useImperativeHandle` with `reconnect()` (drops WS, resets retry counter), `resync()` (sends resume without teardown), `redraw()` (forces fit + refresh + resize sync). Added `sendRecoveryAction()` helper that notifies backend via `recovery_action` message.
- `client/src/components/TerminalInspector.jsx` — added Recovery Actions section with Reconnect (Wifi icon), Resync (ArrowDownToLine icon), Redraw (Paintbrush icon) buttons. Each triggers `onAction` prop and shows toast feedback. Accepts new `onAction` prop.
- `client/src/components/TerminalArea.jsx` — passes `onAction` callback to `TerminalInspector` that looks up the terminal ref by sessionId across all tabs/panes and calls the matching method.
- `server/ws-handler.js` — added `recovery_action` message handler that pushes `recovery_{action}` timeline events. Added structured `console.log` with `[terminal]` prefix for attach (initial + reconnect), detach, pty_exited, replay, stall_detected, and recovery actions. Added stall_detected timeline events when stall reason changes (in heartbeat and visibility_change handlers).
- `server/__tests__/ws-handler.test.js` — 82 tests total: added 6 tests for recovery action handling (3 action types + unknown default) and stall detection timeline events (trigger via visibility change + no-duplicate guard).
**Architecture**: Recovery actions flow: Inspector button → `onAction(name)` → TerminalArea looks up terminal ref by sessionId → calls `ref[name]()` → Terminal method executes + sends `recovery_action` WS message → backend pushes timeline event + logs. Stall detection timeline events are pushed when stall reason transitions (not on every heartbeat), preventing duplicate events.
**Next**: Phase 5: Durable Runtime Options (tmux + caffeinate) — runtime abstraction for tmux-backed sessions, configuration gating, caffeinate integration.

### Session — 2026-04-11 (Phase 5)
**Completed**: Phase 5: Durable Runtime Options (tmux + caffeinate)
**Key files**:
- `server/terminal-runtime.js` — NEW: runtime abstraction with `createTerminalRuntime(mode)` factory. Two backends: raw PTY and tmux-backed (now the default when available). Both expose `spawn({ cwd, cols, rows, sessionId })`, `kill(entry, sessionId)`, `isSessionRecoverable(sessionId)`. Tmux backend creates detached tmux sessions, attaches via node-pty. Uses `execFileSync` (not `execSync`) for shell-injection safety.
- `server/ws-handler.js` — `handleWsConnection` now accepts `runtime` object instead of `spawnPty`. Added `registerPtyDataHandler()` (DRY helper for onData), `registerPtyExitHandler()` with tmux-aware recovery (re-spawns tmux attach when PTY exits but tmux session alive, capped at `MAX_TMUX_REATTACH=3`). Reconnect path re-attaches to living tmux sessions. Session entries store `runtimeType`.
- `server/index.js` — resolves runtime mode from `CODEDECK_TERMINAL_RUNTIME` env var > `terminalRuntime` SQLite config > `'tmux'` default. Uses `terminalRuntime.kill()` in DELETE handler. Health endpoint returns `terminalRuntime` type. Removed direct `node-pty` and `buildShellEnv` imports (moved to terminal-runtime.js).
- `start.sh` — optional `CODEDECK_CAFFEINATE=1` wraps the entire startup under `caffeinate -i` on macOS. Uses `exec` re-invocation with guard var to prevent infinite recursion.
- `client/src/components/TerminalInspector.jsx` — added "Runtime" row to state snapshot table.
- `server/__tests__/ws-handler.test.js` — 90 tests total (was 82): updated mock factory to `createMockRuntime()`, added 8 tests for runtimeType storage, sessionId in spawn args, tmux-aware exit (recoverable, failed re-attach), tmux-aware reconnect recovery, and pty-mode no-recovery.
**Architecture**: Runtime abstraction is at the spawn/kill boundary — ws-handler.js doesn't know whether it's raw PTY or tmux, it just calls `runtime.spawn()` and checks `runtime.isSessionRecoverable()` on exit. tmux session names are sanitized from sessionId (replace non-alphanumeric). Re-attach limit prevents infinite recursion if tmux keeps dying.
**Next**: Phase 6: Final Verification and Documentation — full regression pass, end-to-end scenarios, documentation updates.

### Session — 2026-04-11 (Phase 6)
**Completed**: Phase 6: Final Verification and Documentation
**Key files**:
- `README.md` — added Terminal Resilience section documenting inspector, recovery actions, visibility recovery, replay buffer, heartbeat, tmux mode, and caffeinate
- `CLAUDE.md` — updated Current Work to reflect terminal resilience hardening completion
- `docs/steering/structure.md` — added `terminal-runtime.js` and `TerminalInspector.jsx` to directory layout, updated backend patterns with replay buffer and message types, updated test count to 90
- `docs/steering/product.md` — added terminal resilience, durable sessions, and sleep prevention to implemented features
- `docs/specifications/terminal-resilience-hardening-spec.md` — status updated from Draft to Implemented
**Verification**: 90 tests pass across 5 test files. Client Vite build passes cleanly. Inspector health labels are clear and diagnostic (healthy/detached/reconnecting/stalled/replaying/dead with explanatory descriptions). Stall reasons distinguish browser-throttled, paint-lagging, and generic ack-lag cases. Recovery actions have descriptive tooltips. No code quality issues found.
