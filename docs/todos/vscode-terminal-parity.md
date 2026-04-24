# VS Code Terminal Parity

**Source**: 2026-04-24 terminal experience assessment
**Status**: In Progress
**Created**: 2026-04-24

## Phase 1: Terminal Shell Fidelity Baseline
> Close the shell/runtime gaps that can make CodeDeck behave differently from a normal integrated terminal before larger UX work begins.
> **Inputs:** tmux-backed session startup, zsh/bash env setup, terminal capability variables, current key bindings
> **Outputs:** documented and tested shell startup contract matching the real tmux path
> **Closed when:** the real tmux-backed runtime applies the intended shell environment and key behavior consistently

- [ ] Verify whether `buildShellEnv()` and the zsh wrapper files affect the enforced tmux runtime or only the legacy raw PTY helper
- [ ] Move any required shell startup fixes onto the real tmux session creation path
- [ ] Add tests proving the real runtime receives intended `TERM`, shell init, and zsh keymap behavior
- [ ] Confirm `Ctrl+R` and other readline/zsh editing keys behave like a normal VS Code terminal in a live pane

## Phase 2: Keyboard Shortcut Contract
> Replace scattered terminal shortcut exceptions with a deliberate terminal-vs-app shortcut policy.
> **Inputs:** browser-reserved keys, CodeDeck app shortcuts, xterm input handling, shell shortcuts
> **Outputs:** predictable key routing with documented skip-shell behavior
> **Closed when:** app shortcuts, browser-safe shortcuts, and shell input no longer fight each other

- [ ] Inventory all CodeDeck global and terminal-scoped keyboard shortcuts
- [ ] Define which shortcuts must skip the shell and which must always pass through to the terminal
- [ ] Refactor the current manual `Ctrl+R/W/T/N` handling behind a small key-routing helper
- [ ] Add regression tests for shell-pass-through, app shortcuts, reconnect input buffering, and replay input behavior
- [ ] Live-verify common terminal keys against VS Code expectations on macOS Chrome

## Phase 3: Reconnect And Snapshot Fidelity Hardening
> Reduce cases where the visible xterm viewport can drift from the real tmux session after reconnect, resize, or hidden-tab recovery.
> **Inputs:** browser refresh, project switch, hidden tab restore, backend restart, alternate-screen TUIs
> **Outputs:** tighter snapshot/rehydrate behavior and explicit residual-risk coverage
> **Closed when:** reconnect into shell output and common TUIs remains visually and input-correct without manual redraw

- [ ] Re-test reconnect into `vim`, `less`, `top`, long command output, and prompt-only shells
- [ ] Add or update regression coverage for any modeful terminal state still not preserved by tmux metadata
- [ ] Review `resumeInFlight` behavior so user keystrokes during replay are queued or visibly blocked, not silently dropped
- [ ] Verify delayed font/resize rehydrate does not repaint or jump during ordinary pane resizing
- [ ] Keep any unrepresentable tmux state surfaced as an explicit documented residual risk

## Phase 4: VS Code Feature Parity UX
> Add or intentionally defer the highest-value VS Code terminal affordances missing from CodeDeck.
> **Inputs:** current xterm addon setup, file browser/editor opening behavior, terminal diagnostics
> **Outputs:** prioritized terminal UX improvements or explicit non-goals
> **Closed when:** the most visible VS Code parity gaps are either implemented or documented as out of scope

- [ ] Add terminal find/search or document why browser find is the supported path
- [ ] Improve terminal link handling beyond URLs, especially file paths relative to the live pane cwd
- [ ] Evaluate shell-integration-style command markers, command navigation, and cwd-aware actions
- [ ] Review copy/paste, selection, context menu, and file drop behavior against VS Code expectations
- [ ] Decide whether configurable scrollback/history limits are needed beyond the fixed 10,000-line contract

## Phase 5: Terminal Component Simplification
> Reduce the blast radius of future terminal bugs by separating transport, viewport, input, and file-drop concerns.
> **Inputs:** `Terminal.jsx`, terminal utilities, websocket protocol handlers, focused tests
> **Outputs:** smaller units with behavior locked by tests
> **Closed when:** terminal lifecycle changes can be made without editing one monolithic component

- [ ] Extract websocket lifecycle/reconnect state into a hook or utility with tests
- [ ] Extract xterm viewport/snapshot hydration behavior into a focused helper
- [ ] Extract file drop/paste upload behavior away from core terminal input routing
- [ ] Keep public behavior unchanged while simplifying internal ownership boundaries
- [ ] Run focused client/server terminal tests plus live browser smoke after each extraction

## Phase 6: Final Verification
- [ ] Run client terminal test suite
- [ ] Run server terminal/runtime/ws tests
- [ ] Run frontend build
- [ ] Live browser smoke: open pane, type, paste, scroll, split, reconnect, hard refresh, backend restart
- [ ] Compare final behavior against the original quirks report and update this todo with completed phases
