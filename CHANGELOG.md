# Changelog

## [2026-04-11] - Durable Tmux Defaults and Terminal View Recovery

### Executive Summary
* Hardened CodeDeck’s terminal behavior for long-running work by making durable `tmux` sessions the default runtime and fixing two recovery regressions that could leave a pane looking blank or stale after reconnecting or switching tabs. This reduces the chance that active builds or noisy log streams appear to vanish when the terminal process is still alive.

### Technical Details
* **🐛 Bug Fix:**
  * Problem: reattaching to an existing session could inject a literal `^L` into the live process and fail to request replay after a pane remounted.
  * Solution:
    * `server/ws-handler.js` — stopped sending `Ctrl+L` into the PTY on reconnect and kept the session handshake focused on replay-aware recovery.
    * `client/src/components/Terminal.jsx` — now requests replay when the server reports an `existing` session, centralizes resume requests, and refreshes the xterm viewport when a tab becomes visible again.
    * `client/src/utils/terminalResume.js` — extracted replay-handshake decision logic for a focused regression point.
    * `client/src/utils/terminalVisibility.js` — extracted visibility and size guards so hidden tabs do not send invalid resize/fitting updates.
* **🛠️ Codebase:**
  * `server/index.js` — changed terminal runtime resolution to default to `tmux` instead of raw PTY when no override is configured.
  * `server/terminal-runtime.js` — updated the runtime factory default and inline documentation to reflect `tmux` as the preferred durable backend.
  * `docs/steering/product.md` — updated the product-level description to treat durable sessions as the normal runtime behavior.
  * `docs/todos/terminal-resilience-hardening.md` — corrected implementation notes so the recorded default runtime matches the current behavior.
  * `README.md` — documented `tmux` as the default runtime, explicit override commands, and the relationship between durable sessions and the bounded replay buffer.
* **🧪 Tests:**
  * `server/__tests__/ws-handler.test.js` — added coverage proving reconnect no longer writes `Ctrl+L` into the PTY.
  * `client/src/components/__tests__/terminalResume.test.js` — added regression coverage for replay requests on existing-session handshakes.
  * `client/src/components/__tests__/terminalVisibility.test.js` — added regression coverage for suppressing resize/reflow work while a terminal tab is hidden.

## [2026-04-11] - Terminal Resilience Hardening

### Executive Summary
* Implemented a full terminal resilience layer for CodeDeck across six phases. Terminals now have a pane-local debug inspector with health classification, explicit recovery actions (Reconnect, Resync, Redraw), visibility-aware refocus recovery, a heartbeat/sequence-tracked transport with bounded replay, and optional durable sessions via tmux. The backend grew from 23 to 90 unit tests. These changes address the core pain of misbehaving panes that silently stall when a browser tab is backgrounded or a WebSocket reconnects.

### Technical Details
* **✨ New Feature:**
  * `server/terminal-runtime.js` — New runtime abstraction factory; supports raw node-pty (default) and tmux-backed sessions. Both expose `spawn`, `kill`, and `isSessionRecoverable`. Uses `execFileSync` for shell-injection safety in tmux commands.
  * `client/src/components/TerminalInspector.jsx` — New modal debug inspector panel; polls `/api/debug/terminal-health` every 3s, renders health dot + label, state snapshot table, reverse-chronological event timeline, Copy Snapshot action, and Recovery Actions (Reconnect / Resync / Redraw).
* **🛠️ Codebase:**
  * `server/ws-handler.js` — Session entries extended with `wsAttached`, `lastAttachAt`, `lastDetachAt`, `lastClientAckAt`, `lastReplayAt`, `lastSeq`, `stallReason`, `events[]`, `replayBuffer`, `runtimeType`. Added `pushTimelineEvent`, `computeSessionHealth`, `computeStallReason` exports. Handles `heartbeat`, `resume`, `replay`, `visibility_change`, and `recovery_action` WebSocket messages. Monotonic `seq` assigned to each output chunk and stored in a bounded 1000-entry replay buffer. Tmux-aware PTY exit handler with capped re-attach logic.
  * `server/index.js` — `GET /api/sessions` extended with health summary fields. `GET /api/debug/terminal-health` added with per-session diagnostics and last 20 timeline events. Runtime resolved from `CODEDECK_TERMINAL_RUNTIME` env var → SQLite config → `'pty'` default. Health endpoint returns active `terminalRuntime` type.
  * `client/src/components/Terminal.jsx` — Added `lastSeenSeqRef`, `reconnectCountRef`, `resumeInFlightRef`, `heartbeatRef`, and browser-view diagnostic refs. `document.visibilitychange` listener triggers refit + resize sync + replay request on refocus. Heartbeat sends client diagnostics every 5s. `useImperativeHandle` extended with `reconnect()`, `resync()`, `redraw()` recovery methods.
  * `client/src/components/TerminalArea.jsx` — Added Bug icon button per pane to trigger the inspector; renders `TerminalInspector` with session lookup and `onAction` dispatch across tabs/panes.
  * `start.sh` — Optional `CODEDECK_CAFFEINATE=1` wraps startup under macOS `caffeinate -i` to prevent idle sleep.
* **🧪 Tests:**
  * `server/__tests__/ws-handler.test.js` — Expanded from 23 to 90 tests. Added coverage for diagnostic metadata, health classification, stall detection (3 tiers), visibility change handling, seq assignment, replay buffer bounds, resume/replay correctness (exact, overflow, empty, caught-up), recovery action handling, tmux-aware exit and reconnect, and runtimeType storage.
* **📝 Docs:**
  * `README.md` — Added Terminal Resilience section documenting inspector, recovery actions, replay buffer, tmux mode, and caffeinate.
  * `CLAUDE.md`, `docs/steering/product.md`, `docs/steering/structure.md` — Updated to reflect new components, backend patterns, message types, and test count.
  * `docs/specifications/terminal-resilience-hardening-spec.md` — Status updated from Draft to Implemented.
  * `docs/todos/terminal-resilience-hardening.md` — All 34 tasks marked complete across 6 phases with full session notes.
  * `client/dist/index.html` — Rebuilt client bundle.
