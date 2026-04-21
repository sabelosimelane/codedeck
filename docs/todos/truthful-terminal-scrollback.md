# Truthful Terminal Scrollback

**Spec**: `docs/specifications/truthful-terminal-scrollback-spec.md`
**Plan**: `docs/plans/2026-04-21-truthful-terminal-scrollback-design.md`
**Status**: Complete
**Last completed**: Phase 5: Final Verification & Cleanup
**Created**: 2026-04-21

## Phase 1: tmux-Required Runtime Gate
> Make tmux a hard prerequisite instead of a best-effort runtime choice. This phase closes when CodeDeck never silently falls back to raw PTY mode and clearly asks the user to install tmux when unavailable.
> **Inputs:** server startup, terminal runtime discovery, terminal creation attempts on unsupported machines
> **Outputs:** explicit tmux-required runtime contract, install-tmux UX, blocked terminal creation without durability bluffing
> **Closed when:** tmux-missing environments fail visibly and supported environments report tmux as the only terminal runtime

- [x] Runtime contract — remove raw PTY fallback from terminal runtime selection and enforce tmux-only startup/attachment behavior (Spec §4.1–§4.3 — tmux mandatory, no silent downgrade)
- [x] Health/session reporting — expose tmux availability and terminal-runtime contract through existing health/session surfaces (Spec §4.3, §7.1 — UI can render correct install/blocked states)
- [x] Frontend install prompt — replace broken terminal fallback states with a clear “install tmux” prompt and disabled terminal actions (Spec §4.2 — explicit ask to install tmux)
- [x] Unit tests — runtime selection and health reporting prove that missing tmux never yields `pty` fallback (Spec §4.1–§4.3)
- [x] Integration tests — startup and terminal-open flows verify visible failure when tmux is unavailable (Spec §4.2, §9.1.8)

## Phase 2: Authoritative Snapshot Attach & Reconnect
> Rebuild every browser attachment from one fresh tmux snapshot instead of stitching together stale browser state, tmux history hydration, and replay fragments. This is the main truthfulness anchor.
> **Inputs:** browser attach/reattach, existing durable tmux session, backend restart recovery
> **Outputs:** xterm cleared and rehydrated from a fresh authoritative 10,000-line snapshot, then resumed at live output
> **Closed when:** refresh, browser-close reopen, and backend-restart reconnect all produce truthful recent history from tmux

- [x] Snapshot capture contract — implement a tmux-backed recent-history capture path capped at 10,000 lines for every attach/reconnect (Spec §5.1–§5.3, §7.2–§7.4 — authoritative recent window)
- [x] WebSocket attach flow — send `session` + `snapshot` before steady-state live output on reattach paths (Spec §5.2–§5.3, §7.2 — snapshot-first hydration)
- [x] Client terminal rebuild — clear stale xterm view before hydrating the new snapshot and land at the live bottom by default (Spec §3.3, §5.2, §8.1–§8.3 — no stale local history survives reconnect)
- [x] Durable recovery tests — verify refresh, browser-close reopen, and backend-restart recovery all reseed from tmux snapshot instead of mixed history (Spec §8.1–§8.3, §9.1.1–§9.1.3)
- [x] Unit tests — snapshot-window capping, session metadata, and attach sequencing across reconnect cases (Spec §5.1–§5.3, §7.3–§7.4)

## Phase 3: VS Code-Style Live Scrollback Semantics
> Preserve the normal terminal-emulator UX while removing tmux-history leakage and hybrid scroll authority. This phase is about trustworthy scrolling during active use.
> **Inputs:** user wheel/trackpad scrolling, live output while pinned or detached, Latest-button actions
> **Outputs:** auto-follow at bottom, stable detached viewport above bottom, 10,000-line local scrollback UX seeded from tmux snapshot
> **Closed when:** attached scrolling feels like VS Code and the visible viewport remains truthful while output continues below

- [x] Scroll authority cleanup — remove ordinary wheel-routing into tmux history/copy-mode and stop mixed local/tmux scroll handoff (Spec §5.4–§5.5, §7.2 — no tmux UX leakage)
- [x] Auto-follow contract — keep bottom-pinned auto-scroll, disable it as soon as the user scrolls up, and restore it only through reaching bottom/Latest (Spec §5.4, §8.5 — keep current product behavior, make it reliable)
- [x] Scrollback-window enforcement — keep the user-facing xterm scrollback window fixed at 10,000 lines with silent stop at the top (Spec §5.1, §8.4 — bounded recent window, no deeper fetch)
- [x] Client component tests — verify detached viewport stability, Latest-button behavior, and live-output accumulation below the user’s reading position (Spec §5.4, §8.5, §9.1.4–§9.1.5)
- [x] Manual UX verification — confirm wheel/trackpad behavior matches VS Code expectations during normal attached use (Spec §2.1, §5.4, §9.2)

## Phase 4: Visible Truthfulness Failures
> If preserved history cannot be guaranteed, surface that fact explicitly instead of pretending the recovered scrollback is complete. This phase closes the most dangerous trust gap.
> **Inputs:** snapshot capture failures, incomplete or unverifiable recent-history recovery, degraded reconnect conditions
> **Outputs:** explicit warning surfaces, guaranteed-vs-unavailable history metadata, no silent bluffing
> **Closed when:** any non-guaranteed reconnect shows a visible warning and still attaches live output when possible

- [x] Snapshot guarantee state — compute whether preserved recent history is trustworthy for the current reattach and propagate that through server diagnostics (Spec §6.1–§6.3, §7.1 — history-guarantee metadata)
- [x] Warning protocol — add explicit `history_warning` (or equivalent) messaging for reconnects where recent history cannot be guaranteed (Spec §6.2, §7.2, §7.5 — fail visibly)
- [x] Frontend warning UX — show a clear toast/banner/pane-local warning when preserved history is unavailable or incomplete, without blocking live reattach (Spec §6.2, §8.1–§8.3 — truthful degraded mode)
- [x] Regression tests — verify that incomplete snapshot scenarios never silently reuse stale browser history as if it were guaranteed (Spec §6.1–§6.3, §9.1.7)
- [x] Diagnostic verification — ensure inspector/session surfaces reflect guarantee state accurately for support and debugging (Spec §4.3, §7.1)

## Phase 5: Final Verification & Cleanup
- [x] Remove or quarantine obsolete replay/history code paths that still act as user-visible history authority (Spec §3.3, §7.2 — replay may not be required for correctness)
- [x] Run full automated test suite and targeted reconnect/scrollback regressions (Spec §9.1 — all invariants proven together)
- [x] Manual end-to-end verification across: browser refresh, browser close/reopen, backend restart, long-output scrollback, snapshot failure warning (Spec §8, §9.2)
- [x] Review docs and user-facing copy so terminal behavior is described as VS Code-style scrolling over tmux durability (Spec §1, §2, §10)

### Session — 2026-04-21 (Phase 1)
**Completed**: Phase 1: tmux-Required Runtime Gate
**Key files**: `server/terminal-runtime.js`, `server/index.js`, `server/ws-handler.js`, `server/terminal-session-status-service.js`, `client/src/components/TerminalArea.jsx`, `client/src/components/Terminal.jsx`, `client/src/components/__tests__/TerminalRuntimeBlocked.test.jsx`
**Architecture**: `createTerminalRuntime()` now always enforces the tmux contract, reports runtime availability via `getTerminalRuntimeStatus()`, blocks `/api/terminal` + WS attach when tmux is missing, and exposes the blocked state through `/api/health`, `/api/sessions`, and `/api/debug/terminal-health`. `TerminalArea` fetches `/api/health` alongside `/api/sessions`, disables new-terminal actions, and shows an install-tmux card instead of misleading pane fallbacks. `Terminal.jsx` now renders server-provided terminal failure messages instead of a generic backend-down overlay.
**Bug fixes**: Removed the silent tmux→pty downgrade and replaced it with explicit tmux-required messaging on both REST and WebSocket open paths.
**Quirks**: `GET /api/sessions` still returns a bare array, so global runtime metadata lives in `/api/health`; per-session runtime contract fields were added compatibly to the array entries.
**Next**: Phase 2: Authoritative Snapshot Attach & Reconnect — replace the current `history` + `resume/replay` hybrid attach flow with a snapshot-first tmux recent-history reseed and client-side xterm reset.

### Session — 2026-04-21 (Phase 2)
**Completed**: Phase 2: Authoritative Snapshot Attach & Reconnect
**Key files**: `server/terminal-runtime.js`, `server/ws-handler.js`, `server/terminal-session-status-service.js`, `server/index.js`, `client/src/components/Terminal.jsx`, `client/src/utils/terminalResume.js`, `server/__tests__/ws-handler.test.js`, `client/src/components/__tests__/TerminalHistoryRestore.test.jsx`
**Architecture**: Added `captureSessionSnapshot()` to the tmux runtime for full-window 10,000-line reseeds. WebSocket attach now sends `session` + `snapshot` metadata on durable reattach paths, buffers live PTY output during in-memory reconnects, and suppresses the bootstrap redraw from fresh tmux attaches so the snapshot remains the only visible history seed.
**Bug fixes**: Reconnect no longer asks the server for replay when the handshake advertises snapshot hydration. `Terminal.jsx` now clears stale xterm state before hydrating snapshots, updates `lastSeenSeq` from the snapshot boundary, and flushes hidden-tab snapshots before later buffered output.
**Quirks**: For live tmux reconnects, the attach buffer must be enabled before snapshot capture or output can leak ahead of the snapshot. For recovered tmux attaches, the first bootstrap repaint from `attach-session` is discarded so it does not duplicate the authoritative snapshot.
**Next**: Phase 3: VS Code-Style Live Scrollback Semantics — remove tmux-history wheel routing, keep scrolling purely local in xterm, and harden auto-follow / Latest behavior around the 10,000-line snapshot window.

### Session — 2026-04-21 (Phase 3 partial)
**Completed**: Phase 3 implementation items 1-4 (manual UX verification pending)
**Key files**: `client/src/components/Terminal.jsx`, `client/src/utils/terminalAutoScroll.js`, `client/src/components/__tests__/TerminalAutoScroll.test.jsx`, `client/src/utils/__tests__/terminalAutoScroll.test.js`
**Architecture**: Ordinary wheel/trackpad scrolling now stays inside xterm; the only custom wheel interception left blocks xterm’s no-scrollback ArrowUp fallback. Auto-follow only detaches on upward scroll from the live bottom or an actual viewport detach, and `Latest` re-enables bottom-pinning without touching tmux history.
**Bug fixes**: Removed the tmux `scroll_history` handoff from normal wheel usage and fixed the false detach where a downward wheel gesture at the live bottom could show `Latest`.
**Next**: Phase 3 manual UX verification — confirm wheel/trackpad feel against a live terminal session; if that passes, continue with Phase 4 truthfulness warnings.

### Session — 2026-04-21 (Phase 4)
**Completed**: Phase 4: Visible Truthfulness Failures
**Key files**: `server/terminal-runtime.js`, `server/ws-handler.js`, `server/terminal-session-status-service.js`, `server/index.js`, `client/src/components/Terminal.jsx`, `client/src/components/TerminalInspector.jsx`, `server/__tests__/ws-handler.test.js`, `client/src/components/__tests__/TerminalHistoryRestore.test.jsx`
**Architecture**: Snapshot capture now returns guarantee metadata (`historyGuaranteed`, warning reason/message). `ws-handler` sends `session` + `snapshot` + `history_warning` on degraded tmux reconnects while still clearing the browser terminal and resuming live output. `/api/sessions` and `/api/debug/terminal-health` expose the same guarantee fields, and the inspector renders them directly.
**Bug fixes**: Degraded reconnects no longer look like authoritative restores — the client shows a pane-local warning banner + toast instead of silently trusting empty/best-effort history.
**Quirks**: Keep `snapshotWindowLines` on degraded snapshot handshakes so the client still suppresses replay as a visible history authority; otherwise replay could quietly bluff preserved scrollback again.
**Next**: Phase 3 manual UX verification still needs a human pass in a real browser/trackpad environment, then Phase 5 can remove obsolete replay/history authority paths and run final end-to-end verification.

### Session — 2026-04-21 (Phase 3 manual verification)
**Completed**: Phase 3: VS Code-Style Live Scrollback Semantics
**Key files**: `client/src/components/Terminal.jsx`, `client/src/utils/terminalAutoScroll.js`, `client/src/components/__tests__/TerminalAutoScroll.test.jsx`, `client/src/utils/__tests__/terminalAutoScroll.test.js`
**Verification**: Real Chrome (remote debugging, non-headless) against `http://localhost:43000` on `dev-scripts-2`: upward wheel input detached the viewport, `Latest` returned the terminal to the live bottom, and follow mode resumed for later `UX-AUTOFOLLOW` output. While detached, the visible `UX-LINE-71`…`UX-LINE-76` viewport stayed fixed while later `UX-STABLE-*` lines accumulated below.
**Quirks**: Headless Chrome was not representative here — tmux attach left xterm in the alternate buffer there, so real scrollback behavior needed verification in a normal Chrome window.
**Tests**: `cd client && npx vitest run src/components/__tests__/TerminalAutoScroll.test.jsx src/utils/__tests__/terminalAutoScroll.test.js --maxWorkers=1`
**Next**: Phase 5: Final Verification & Cleanup — remove obsolete replay/history authority paths, run broader reconnect/scrollback regressions, and finish manual end-to-end verification.

### Session — 2026-04-21 (Phase 5)
**Completed**: Phase 5: Final Verification & Cleanup
**Key files**: `server/terminal-runtime.js`, `server/ws-handler.js`, `client/src/components/Terminal.jsx`, `server/__tests__/terminal-runtime.test.js`, `server/__tests__/ws-handler.test.js`, `README.md`, `docs/steering/product.md`, `docs/steering/tech.md`, `docs/steering/structure.md`
**Bug fixes**: Removed legacy `history`/`scroll_history` handlers so replay stays transport-only. Fixed tmux history-limit setup — the 10,000-line window must be applied before `new-session`, otherwise the initial pane silently keeps the default ~2000-line backlog.
**Verification**: `cd server && npx vitest --maxWorkers=1`; `cd client && npx vitest run --maxWorkers=1`; `cd client && npx vite build`; live WebSocket verification covered browser close/reopen, refresh, backend restart, and 10,000-line long-output snapshot retention. Snapshot-failure warning coverage remained locked by the Phase 4 regression suite.
**Quirks**: `tmux show-options` can misleadingly report `history-limit 10000` even when the first pane was born with the older default. The option has to exist before session creation to affect that initial pane.
**Next**: None — feature complete.

### Feature Test — 2026-04-21
**Phase tested**: Phase 5: Final Verification & Cleanup
**Automated**: `cd server && npx vitest --maxWorkers=1` (141 passed), `cd client && npx vitest run --maxWorkers=1` (107 passed), `cd client && npx vite build` passed.
**Targeted**: `terminal-runtime`, `terminal-session-status-service`, `ws-handler`, `TerminalHistoryRestore`, `TerminalAutoScroll`, `TerminalRuntimeBlocked`, `terminalResume`, and `TerminalArea` reconnect-layout tests all passed.
**Live API / WS**: Verified `/api/health`, `/api/sessions`, and `/api/debug/terminal-health` on the running server. Disposable `codedeck-*` sessions proved tmux-only handshakes, snapshot-first reconnect (`session` → `snapshot`), continued live output after reconnect, and the 10,000-line snapshot window retaining `FT_LONG_10020` while dropping early lines like `FT_LONG_00001`.
**Browser UI (Chrome MCP)**: Verified real-browser reconnect behavior on `dev-scripts-2`. After writing durable markers into the terminal, a hard refresh restored `MCP_REFRESH_MARKER_20260421_A`, closing the tab and reopening the app restored both refresh/reopen markers, and `./server.sh restart` still allowed reattaching to the same tmux-backed session with `MCP_RESTART_MARKER_20260421_C` present. Console stayed clean except for transient `ERR_CONNECTION_REFUSED` / WebSocket connection errors while the server was intentionally down during restart, after which the UI recovered and reattached successfully. Live scroll/Latest semantics remain covered by the earlier manual UX verification plus the passing component tests.
