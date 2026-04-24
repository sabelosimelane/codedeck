# Terminal Bake-Off Decision Gate

**Spec**: `docs/specifications/terminal-bakeoff-spec.md`
**Status**: In Progress
**Created**: 2026-04-24

## Phase 1: Bake-Off Harness And Criteria
> Define the repeatable evaluation surface before testing candidates.
> **Inputs:** terminal objective, existing terminal specs, candidate list, torture-test dimensions
> **Outputs:** runnable/checkable scorecard format and test script notes
> **Closed when:** every candidate can be tested against the same criteria and outcomes are recorded consistently

- [ ] Create a scorecard template for `pass`, `minor`, `major`, and `fail` outcomes (Spec §5 — simple scoring model)
- [ ] Define the exact manual commands for long output, paste, alternate-screen apps, resize, refresh, reconnect, key routing, and copy behavior (Spec §6.2 — required test cases)
- [ ] Define what evidence to capture for each candidate, including launch notes, versions, caveats, screenshots, or recordings where useful (Spec §6.1 — required evidence)
- [ ] Confirm `code-server` or `openvscode-server` remains reference-only and is not treated as an adoption candidate (Spec §3.2 — reference benchmark)

## Phase 2: Current CodeDeck Baseline
> Measure the product as it exists today so future options are judged against real current behavior.
> **Inputs:** running CodeDeck app, existing tmux-backed terminal, current terminal parity concerns
> **Outputs:** baseline scorecard with concrete quirks and strengths
> **Closed when:** the current implementation has scored evidence for every required test

- [ ] Run the full torture suite against the current CodeDeck terminal (Spec §4 — evaluation dimensions)
- [ ] Record observed behavior for mouse/trackpad scrolling, paste, resize, refresh, reconnect, alternate-screen apps, and Ctrl/key routing (Spec §4 — highest-risk dimensions)
- [ ] Capture current strengths that must not regress, including project context, split panes, tmux durability, and diagnostics (Spec §7.1 — default bias)
- [ ] Record no-go or pain-point evidence clearly enough to compare against contenders (Spec §6.1 — required evidence)

## Phase 3: Minimal `xterm.js + node-pty` Control
> Separate base emulator/PTY behavior from CodeDeck-specific lifecycle and recovery logic.
> **Inputs:** minimal browser terminal using xterm and node-pty, same local shell environment where practical
> **Outputs:** control scorecard identifying whether CodeDeck glue is the likely source of instability
> **Closed when:** the clean control has been scored and compared against the CodeDeck baseline

- [ ] Run the full torture suite against the minimal `xterm.js + node-pty` control (Spec §3.1 — runnable candidates)
- [ ] Compare scroll, paste, resize, and alternate-screen behavior against current CodeDeck (Spec §7.3 — current-core refactor gate)
- [ ] Identify whether failures appear intrinsic to xterm/PTY or concentrated in CodeDeck lifecycle, replay, snapshot, viewport, or key-routing logic (Spec §7.3 — current-core refactor gate)
- [ ] Record adoption risk for the control path as either targeted hardening or current-core refactor (Spec §5 — adoption-risk note)

## Phase 4: Mature Web-Terminal Contenders
> Test focused external projects without assuming a fork is automatically safer.
> **Inputs:** `ttyd`, `Wetty`, same torture suite, CodeDeck product-fit requirements
> **Outputs:** contender scorecards and product-fit risk notes
> **Closed when:** each mature contender has scored behavior and explicit adoption/no-go notes

- [ ] Run the full torture suite against `ttyd` (Spec §3.1 — mature contender)
- [ ] Run the full torture suite against `Wetty` (Spec §3.1 — mature contender)
- [ ] Evaluate whether each contender can coexist with tmux-backed durability or offers an acceptable equivalent (Spec §7.2 — external integration gate)
- [ ] Record integration risks around product shape, split panes, project context, session persistence, and unknown inherited behavior (Spec §7.2 — external integration gate)
- [ ] Reject any contender that performs well in isolation but would force CodeDeck into a full IDE or unrelated product model (Spec §7.2 — external integration gate)

## Phase 5: VS Code-Like Reference Calibration
> Use the real VS Code-like experience as a feel benchmark without turning it into the adoption target.
> **Inputs:** `code-server` or `openvscode-server` reference terminal
> **Outputs:** calibration notes for expected terminal feel
> **Closed when:** reference behavior has informed the scorecard without becoming a runnable adoption candidate

- [ ] Observe mouse scroll, paste, resize, alternate-screen apps, and Ctrl/key routing in the VS Code-like reference (Spec §3.2 — reference benchmark)
- [ ] Record only the behaviors needed to calibrate "VS Code-like" feel (Spec §4 — evaluation dimensions)
- [ ] Confirm the reference remains out of adoption scope because it brings a full browser IDE surface (Spec §3.2 — reference benchmark)

## Phase 6: Decision Report
> Convert the evidence into a direction decision.
> **Inputs:** all scorecards, adoption-risk notes, reference calibration, existing terminal roadmap
> **Outputs:** one recommended direction and explicit rejected alternatives
> **Closed when:** the next terminal investment path is clear and documented

- [ ] Produce the final scorecard across all candidates (Spec §5 — scoring model)
- [ ] Choose one decision: `current-hardening`, `current-core-refactor`, `external-integration`, or `defer` (Spec §7 — decision rules)
- [ ] Write the no-go reasons for rejected paths so the same options are not re-litigated without new evidence (Spec §7 — decision rules)
- [ ] Map the recommendation to the next planning artifact: existing `docs/todos/vscode-terminal-parity.md`, a new terminal-core refactor todo, or a new external-integration todo (Spec §8 — relationship to existing terminal specs)
- [ ] Confirm the bake-off itself did not change the production terminal implementation (Spec §9 — non-goals)

