# tmux Reconnect Review Fixes

**Source**: 2026-04-21 review on snapshot-first tmux attach recovery
**Status**: Complete
**Created**: 2026-04-21

## Phase 1: Stop losing live output during bootstrap attach
> Fix the reconnect path that currently drops real PTY data while a fresh `attach-session` client is booting.
> **Inputs:** backend restart recovery, reconnect after tmux wrapper death, PTY data emitted during `drop_bootstrap_output`
> **Outputs:** dropped bootstrap repaint stays hidden, but real terminal output still advances `lastSeq`, enters `replayBuffer`, and remains recoverable
> **Closed when:** reconnect recovery never loses build/log output emitted during bootstrap

- [x] Update `registerPtyDataHandler()` in `server/ws-handler.js` so `drop_bootstrap_output` suppresses browser delivery without skipping `lastSeq` / `replayBuffer` bookkeeping
- [x] Distinguish bootstrap redraw noise from real output during recovery so only the tmux attach repaint is hidden
- [x] Add a regression test in `server/__tests__/ws-handler.test.js` proving output emitted during bootstrap recovery remains replayable after attach completes

## Phase 2: Align snapshot sequence boundaries with the captured snapshot
> Fix the reconnect path that can duplicate trailing lines because it snapshots one seq boundary and captures pane content at a later state.
> **Inputs:** tmux reconnect to an alive session, output emitted during `captureSessionSnapshot()`, buffered live output flush
> **Outputs:** snapshot metadata reflects the seq boundary of the captured pane state itself
> **Closed when:** output already present inside a reconnect snapshot is not flushed again as post-snapshot live output

- [x] Change snapshot hydration in `server/ws-handler.js` so the `lastSeq` included in the `snapshot` message comes from the captured snapshot result, not the pre-capture `entry.lastSeq`
- [x] Extend snapshot hydration reconciliation so captured snapshot text can absorb overlapping buffered live output and report the correct cutoff seq for the pane state it returned
- [x] Add regression coverage in `server/__tests__/ws-handler.test.js` for reconnect and `rehydrate` flows where output arrives during capture, proving no duplicated trailing output

## Phase 3: Preserve modeful terminal state across snapshot restores
> Close the larger fidelity gap where reconnect restores visible text but loses terminal modes still active inside tmux.
> **Inputs:** reconnect into alternate-screen or modeful programs such as `vim`, `less`, `top`, or shells with bracketed paste enabled
> **Outputs:** restored browser terminal preserves the state required for input behavior to match the still-running tmux pane
> **Closed when:** reconnect into modeful sessions behaves correctly before the app redraws itself

- [x] Design a snapshot payload that carries terminal state, not just rendered text, for tmux-backed reconnects
- [x] Update `server/terminal-runtime.js` capture logic away from plain `capture-pane -pJ` as the sole authority for reconnect restoration
- [x] Add targeted tests for alternate-screen / modeful-session recovery in `server/__tests__/terminal-runtime.test.js` and `server/__tests__/ws-handler.test.js`
- [x] Verify client restore logic in `client/src/components/Terminal.jsx` consumes the richer payload without resetting xterm into the wrong mode state

**Residual risk:** tmux's documented pane-format surface exposes alternate-screen, cursor, keypad, insert/origin/wrap, and mouse flags, but not a bracketed-paste flag. Phase 3 restores the tmux-reported terminal state; any unreported terminal modes still depend on future tmux/runtime support rather than being guessed client-side.

**Investigation note (2026-04-22):** tmux 3.6a does track bracketed paste internally as `MODE_BRACKETPASTE` and uses it for `paste-buffer -p`, but the exposed format layer does not include a corresponding pane flag. A live `display-message -p -a` diff before/after `printf '\033[?2004h'` showed no exposed pane-variable changes, and tmux's `format.c` lists mouse/keypad/alternate/insert/origin/wrap flags without a bracketed-paste equivalent. If full fidelity is required, the clean follow-up is an upstream/local tmux patch that exports this bit (for example as a new format variable) so the snapshot payload can carry it honestly. CodeDeck now probes a future `#{bracketed_paste_flag}` safely and will restore bracketed paste automatically when a patched or upstream tmux exposes it.

## Recommended Order
- [x] Phase 1 first: it is a clear correctness bug with a local server-side fix and narrow regression surface
- [x] Phase 2 second: it is another local sequencing bug and likely shares code changes with Phase 1 snapshot bookkeeping
- [x] Phase 3 last: it needs a design decision on how to encode and replay terminal state faithfully, so it should not block the two narrower data-loss/duplication fixes
