# Terminal Resilience Hardening

**Spec**: `docs/specifications/terminal-resilience-hardening-spec.md`
**Status**: In Progress
**Created**: 2026-04-11

## Phase 1: Debug Inspector and Session Ground Truth
> Build the hidden diagnostic slice that explains a sick pane without changing the default workspace experience.
> **Inputs:** Existing PTY session map, existing `GET /api/sessions`, existing terminal pane chrome
> **Outputs:** Pane-local inspector, debug endpoint, session health summary, recent event timeline
> **Closed when:** A misbehaving pane can be inspected and classified as PTY, transport, or browser-view related without reading raw logs

- [ ] Extend backend session entries with diagnostic metadata in `server/ws-handler.js` (Spec §4.1, §4.3 — attachment timestamps, client ack timestamp, stall reason, bounded event timeline)
- [ ] Extend `GET /api/sessions` in `server/index.js` with lightweight health summary fields (Spec §5.1, §6.1 — `wsAttached`, `lastClientAckAt`, `health`, `stallReason`)
- [ ] Add `GET /api/debug/terminal-health` in `server/index.js` returning per-session diagnostics and recent events (Spec §5.2, §6.2 — rich debug snapshot for inspector use)
- [ ] Add pane-local inspector entry point in `client/src/components/TerminalArea.jsx` (Spec §3.2, §3.3 — hidden-by-default debug affordance in pane chrome)
- [ ] Add inspector UI and session fetch flow in `client/src/components/Terminal.jsx` or a dedicated terminal debug component (Spec §3.2, §4.2 — current state snapshot plus event timeline)
- [ ] Compute and render explicit health labels `healthy`, `detached`, `reconnecting`, `stalled`, `replaying`, `dead` (Spec §3.4 — avoid vague connected/disconnected wording)
- [ ] Add `Copy debug snapshot` action in the inspector (Spec §3.2, §7.5 — copy current diagnostics and recent events for live bug capture)
- [ ] Unit/integration verification for debug endpoint and health classification (Spec §4, §5 — prove the backend returns consistent diagnostic state for attach/detach/exit scenarios)

## Phase 2: Visibility-Aware Refocus Recovery
> Make backgrounding and refocus a first-class state transition instead of a silent browser quirk.
> **Inputs:** Phase 1 diagnostics, existing xterm fit/resize behavior, browser visibility state
> **Outputs:** Explicit hidden/visible tracking, refocus resync path, stale-view detection
> **Closed when:** Returning to a backgrounded tab triggers deterministic recovery and the inspector can explain whether the pane is recovering or stalled

- [ ] Add `document.visibilitychange` handling in the terminal client (Spec §7.2 — record hidden/visible transitions and push timeline events)
- [ ] Track client-side `documentVisibility`, `lastMessageAt`, `lastPaintAt`, and `lastResizeAt` in terminal session state (Spec §4.2 — browser-view diagnostics)
- [ ] On refocus, force xterm fit, resend resize, and trigger an explicit resume/resync request path even if the socket never formally closed (Spec §7.2 — deterministic refocus recovery)
- [ ] Add stale-view detection logic that marks a pane `stalled` when backend output advances without corresponding client acknowledgment or paint updates (Spec §7.3 — distinguish stale view from dead PTY)
- [ ] Surface hidden/visible transitions and stale-view status in the inspector timeline and snapshot (Spec §4.3, §7.2, §7.3 — make the failure story legible)
- [ ] Add browser-focused tests or targeted manual verification scenarios for hidden → visible transitions and refocus recovery (Spec §7.2 — prove the recovery path works under throttling-prone conditions)

## Phase 3: Heartbeat, Sequence Numbers, and Replay
> Upgrade the transport from best-effort reconnect to loss-aware recovery with bounded replay.
> **Inputs:** Phase 1 diagnostic model, Phase 2 refocus flow, current WebSocket terminal protocol
> **Outputs:** Heartbeat messages, monotonic output sequencing, bounded replay buffer, resume/replay recovery
> **Closed when:** A pane that misses output during reconnect or backgrounding can catch up from a replay buffer and report when a gap exceeded that buffer

- [ ] Add monotonic output `seq` assignment and bounded per-session replay buffer in `server/ws-handler.js` (Spec §4.1, §7.4 — retain recent output chunks for recovery)
- [ ] Extend terminal output messages to include `seq` and add `resume`, `replay`, and heartbeat protocol messages (Spec §5.3, §6.3, §6.4 — formalize recovery-capable transport)
- [ ] Track `lastSeenSeq` and `reconnectCount` on the client (Spec §4.2 — maintain recovery cursor and attachment history)
- [ ] On reconnect or refocus, request resume from `lastSeenSeq` and apply replayed output before clearing recovery state (Spec §7.4 — deterministic catch-up flow)
- [ ] Detect and surface replay-window overflow or partial replay conditions in the inspector (Spec §7.4 — make missing history explicit rather than silent)
- [ ] Add protocol-level tests covering ordered output, replay correctness, heartbeat handling, and reconnect edge cases (Spec §5.3, §7.4 — verify recovery semantics, not just happy-path reconnect)

## Phase 4: Explicit Recovery UX and Supporting Logs
> Convert the new health model into a practical operator workflow when something feels wrong.
> **Inputs:** Phase 1 inspector, Phase 2 stall states, Phase 3 replay-aware transport
> **Outputs:** Recovery actions, richer lifecycle logs, usable recovery loop
> **Closed when:** A user can inspect a sick pane, choose the least-destructive recovery action, and understand what happened afterward

- [ ] Add explicit inspector actions for `Reconnect`, `Resync`, and `Redraw` (Spec §7.5 — expose deterministic recovery controls instead of relying on ad hoc focus changes)
- [ ] Wire recovery actions to the underlying socket/resume/xterm repaint flows with clear post-action status updates (Spec §7.5 — actions must change state in a traceable way)
- [ ] Add structured terminal lifecycle logging on the backend for attach, detach, replay, stall, and exit events (Spec §4.3, §7.5 — support deeper diagnosis when inspector evidence is insufficient)
- [ ] Surface action outcomes and health transitions in the inspector timeline (Spec §4.3, §7.5 — the user should see whether recovery succeeded, replayed, or failed)
- [ ] Verify that the main workspace stays clean while the debug tooling remains discoverable and effective (Spec §3.1, §7.6 — preserve normal UX while supporting debugging)

## Phase 5: Durable Runtime Options (`tmux` + `caffeinate`)
> Add the larger-scope runtime hardening options without making them prerequisites for correctness.
> **Inputs:** Stable diagnostics and recovery model from Phases 1–4, existing server startup workflow
> **Outputs:** tmux-backed session mode behind a rollout flag, optional macOS `caffeinate` support via server management
> **Closed when:** CodeDeck can run with durable tmux-backed terminal sessions and optional sleep guardrails while preserving the same browser-side pane model

- [ ] Design and implement a runtime abstraction that allows the browser session model to target either raw `node-pty` or tmux-backed sessions (Spec §7.7 — keep browser concepts stable across backends)
- [ ] Add configuration gating for tmux-backed session mode so rollout is incremental and reversible (Spec §7.7 — safe opt-in architecture)
- [ ] Implement tmux-backed attach/detach behavior while preserving pane identity and inspector compatibility (Spec §7.7 — durable terminal substrate without losing debug tooling)
- [ ] Add optional backend `caffeinate` integration to the existing server startup workflow on macOS (Spec §7.8 — operational guardrail managed via `server.sh`, not manual shell wrapping)
- [ ] Verify tmux mode, raw PTY mode, and optional `caffeinate` behavior remain compatible with diagnostics, replay, and recovery actions (Spec §7.7, §7.8 — the larger runtime changes must not regress earlier phases)

## Phase 6: Final Verification and Documentation
> Lock the hardening work down as a coherent reliability feature rather than a stack of partial fixes.
> **Inputs:** All prior phases
> **Outputs:** Verified end-to-end terminal resilience story, updated docs, regression confidence
> **Closed when:** The full reliability flow is proven across debug inspection, background/refocus recovery, replay-aware transport, and optional durable runtime modes

- [ ] Run full server and client verification for all implemented phases together (Spec §8.3 — regression check across health, recovery, and runtime behavior)
- [ ] Perform end-to-end manual scenarios that reproduce the original failure shape: background tab, multiple active terminals, stalled-looking pane, refocus recovery, replay, and debug inspection (Spec §2.2, §7.2, §7.4 — prove the feature addresses the motivating problem)
- [ ] Review inspector copy and health labels for clarity and signal-to-noise (Spec §3.1, §3.4 — debugging surface should be explicit without feeling like a generic metrics wall)
- [ ] Update relevant user-facing or developer-facing documentation to reflect the debug inspector, recovery actions, and any runtime modes that shipped (Spec §1, §8 — keep the roadmap and product behavior documented)
