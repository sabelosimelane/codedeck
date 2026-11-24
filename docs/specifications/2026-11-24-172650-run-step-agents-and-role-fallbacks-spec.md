# Changing a running step’s agent and handing off on quota exhaustion — Feature Specification

**Version:** 1.0
**Date:** 2026-11-24
**Status:** Draft for implementation

## 1. Overview

A workflow owner can choose another saved agent for a single step of this run. The open pass finishes on its current agent. Separately, a team editor can choose one optional fallback agent for each role. A confirmed provider quota refusal interrupts the unsuccessful pass immediately and restarts it with that role’s fallback. Both operations preserve the task, checkout and work already on disk. They work independently.

This extends [Workflow Pipelines](2026-11-13-134947-workflow-pipelines-spec.md). On this branch the assignment PUT in `server/routes/pipelines.js` requires a resumable run. The run view already exposes `agentName` and optional `nextAgentName`. The reducer applies `nextAgent` on loop-back, but repeated passes can also start inside the terminal workflow. Implement the boundary in both places. See `applyLoopBack` and `progressForAgent` in `server/pipelines/run-machine.js`, and `applyWorkflowSnapshot`, answer, continue and sendBack in `server/pipelines/run-engine.js`.

## 2. Change one step in Task view

Offer **Change agent** on eligible workflow nodes, with the step name, current agent, pending choice if any, and a saved-agent picker. Explain when the selection takes effect. Disable Save with no change, while saving or without agents. An empty picker points to agent settings. Cancel discards the draft. Show request errors in the dialog. A stale dialog requires reviewing the refreshed assignments before another submission.

| State of the selected node | Result of saving |
|---|---|
| Pending run or future node | Use the replacement on its first dispatch. |
| Launching or running pass | Keep its terminal, reset command and signal owner. Show “Next pass” with the queued name. Apply before the next prompt for a new pass, including until-complete repetitions. Finishing a one-pass step never starts another pass just to use the choice. |
| Waiting for input | Leave the request and its answer attached to the open pass. If the engine starts a fresh pass after the answer, deliver the recorded answer with that pass. A terminal dialog remains with the terminal that opened it. |
| Waiting for approval | Approve advances normally. Send back starts the new attempt on the selected agent, retaining the review comment. |
| Workflow repeat limit paused | Keep the pause. Continue uses the replacement for the next dispatch. This limit is independent of provider quota. |
| Completed node reachable by a remaining loop | Show “Next round”. Preserve the completed round’s agent and note until re-entry. |
| Stopped, interrupted or error | Keep the existing Change team operation, including multi-step and team changes. Resume uses the latest selection, including an override queued before Stop. Existing worktree/resume eligibility still applies. |
| Setup, finished run, or completed node beyond reach of any remaining loop | No edit. Reject a direct mutation. |

Use the run's enabled node snapshot and loop bounds for eligibility. A second edit replaces the queued selection. Selecting the active assignment again while one is queued cancels the queue and retains the original provenance. On final completion discard unused pending choices. When switching, preserve old terminals in session history, acquire the appropriate agent terminal under the existing session rules, and show the actual agent for each finished attempt. Apply on this run only. A real override marks attribution mixed and displays the existing changed team label where there is a team.

Reuse `PUT /api/pipelines/runs/:id/team` with `{expectedUpdatedAt, stepOverrides: {<step name>: <saved agent UUID>}}` for a live edit. Outside the existing resumable contract accept exactly one override and no teamId. Return 200 with the run view, including effective and queued names. Use 400 for malformed bodies, unknown fields, invalid agent references or invalid node selections, 404 for missing run, and 409 for stale revisions, state conflicts or live bulk/team changes. Validate and commit against the same run revision as dispatch. If dispatch wins, present the updated state for review. Never let a stale poll overwrite a saved choice. Use shared RFC 9457 problem responses with timestamp, status, error, message, path, traceId and field errors for 400s. Preserve existing client-readable errors. No new collection endpoint.

## 3. Configure a role’s fallback

In Teams, each member has its existing primary selector and a **Fallback agent** selector with **None** and eligible saved agents. Show both names in the saved summary when configured. Store an optional UUID `fallbackAgentId` alongside role and agentId in the existing team members JSON. Accept null as an explicit clear. On creation and old rows, absence means none. On update, omission from an existing role preserves its setting for older clients (case-insensitive role identity). Removing a role removes its reference. Keep team revision checks, role uniqueness, size bounds and primary validation. Reject same primary/fallback or missing catalog entries with field-level errors. Agent deletion must check both references. Two roles can share agents.

At run creation and stopped team reassignment, snapshot each team-assigned node’s eligible fallback using the existing agent snapshot fields (id, name, launch/reset commands and revision), its role and team identity/revision. Mark the assignment source explicitly. A workflow agent, manual override, trial or setup assignment has no automatic fallback, even if its id also belongs to a team. Runs predating the field have no eligible fallback until explicitly reassigned from a team. Edits or deletion in the catalog never retarget a snapshot. Extend team validators, library store, run snapshot reader/writer, attribution, run view and client record parsers together. Check fields individually at request, storage hydration, snapshot construction and response parsing. Invalid present data fails with a field and record identity. Never print terminal contents or command strings in validation errors.

## 4. Recognise a provider quota refusal

Port the quota reader, settled-idle engine hook and associated tests from local commit `f4672783048b43c5dfe3a9860321b2e60a9e1395`. Its handoff-reminder edits are independent. Add `usageLimit(lines)` to each named profile. Match a current CLI-generated refusal block at its own idle input prompt after this pass was dispatched and after the existing consecutive settled readings. Return a short safe reason or null. Use normalized screen lines and profile-specific boundaries. A text substring anywhere in scrollback is insufficient.

| CLI | Evidence and wording for a positive fixture |
|---|---|
| Antigravity | The fixture in `git show f467278 -- server/__tests__/agent-profile-generalization.test.js` has “⚠ Individual quota reached” above the prompt. Handle wrapped reset advice and omit Error ID. |
| Claude Code | The installed Anthropic CLI 2.1.330 contains the display literal “You've hit your session limit”. Match this stopped-turn notice with its prompt and documented reset decoration. Fast-mode downgrade/retry messages alone do not qualify. Reproduce the wording check with `rg -aoF "You've hit your session limit" ~/.local/bin/claude`. |
| Codex | Match the refusal beginning “You’ve hit your usage limit” with its emitted ending, including named-limit/reset variants. Preserve vendor punctuation in fixtures. [OpenAI’s error formatter](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error.rs) |
| Cursor Agent | The captured CLI block begins “Error: You've hit your usage limit” with plan/reset details. Match the refusal heading in that block. A generic upgrade suggestion also occurs on other errors. [Firsthand terminal capture, release 1.18.0](https://github.com/saaranshM/unsnooze/blob/main/CHANGELOG.md#1180--2026-09-02) |
| Muse Code | The installed release 1.4.25-R9361.1 contains the template fragments “You've used your ” and “ quota (resets at ” adjacent to the separate forecast “ quota runs out in about ”. See `strings -a ~/.local/bin/muse-bin-1.4.25-R9361.1` around the first fragment. Build the fixture from the exhausted window plus the terminal’s stopped-turn/reset or upgrade advice. Exclude forecasts and the “Usage exhausted (last reported)” status display. The fragments establish wording, not a capture of a live refused turn. [Meta CLI documentation](https://dev.meta.ai/docs/muse-code) |

For every reader reject working/delegated output, quotes in replies, command output, typed prompts, historical refusals, threshold warnings, malformed or unfamiliar layouts, login errors, transient throttling and generic 429s. If the evidence is ambiguous, continue ordinary monitoring. No provider API calls, billing lookups or timed retries.

## 5. Restart on the fallback

1. Verify the driver still owns the running step, terminal, attempt and pass. A valid workflow completion already accepted or an owner Stop takes precedence over a late screen observation. Stop observing and invalidate the old driver before its terminal can submit another signal.
2. At a confirmed refusal look up the current assignment in the run snapshot. With an eligible fallback, record the interrupted attempt and safe reason, keep the worktree, inputs, attachments, notes, earlier completions, elapsed work, loop budgets and approval gates. Restart the incomplete logical pass, with a fresh driver/signal identity and the usual prompt and handoff context, in the replacement agent’s own terminal. Increment the attempt once. Replaying an unfinished pass can encounter partial work on disk. Never credit it as completed or repeat setup.
3. For the remaining team-supplied nodes on the depleted primary, resolve each node using **its own role’s** snapshotted fallback. Include future loop visits. Protect manual choices and finished history. If another role shares this primary but lacks a fallback, fail naming the known limit when that node is next due, before prompting the exhausted agent. A queued owner choice on the refused step wins at the restart boundary when an automatic takeover is eligible. Without an eligible fallback the run enters error, preserving the choice for Resume.
4. Keep the replacement for this run. A fallback that reaches quota fails with the agent, step and limit, even if another role could supply a third agent. Likewise fail when there is no eligible fallback or the snapshotted fallback identifies the exhausted agent. Give the existing manual Change team / Resume recovery guidance. Treat ordinary launch and terminal failures through existing error handling. No automatic switch back.
5. Persist the replacement, affected future choices, mixed attribution, reason and restart intent atomically. Repeated reads, concurrent edits and backend interruption must not cause duplicate notes, launches or lost overrides. Recover using existing interrupted-run/Resume ownership rules. Surface one durable activity entry identifying step, exhausted agent, reason and successor, plus the effective/pending names after refresh. Record audit history against the agent that performed the work.

## 6. Boundaries

Saved workflow definitions, other runs, team primary assignments, approval policy, repeat caps, task files and CLI account settings retain their current meaning. The scope is the desktop web task view, Teams editor and run engine. Phone UI, free-form model IDs, per-account quota tracking across runs, chains of fallbacks, credential rotation, terminal transcript migration and unrelated changes in the reference commit are outside this feature.

## 7. Acceptance checks

| ID | Observable result |
|---|---|
| A1 | Task view and single-step PUT implement the state/eligibility table, picker states, cancel, validation and stale-write outcomes. Existing stopped Change team requests still work. |
| A2 | A queued override takes effect just before the next eligible dispatch across repeats, loops, questions, approval/send-back, continue and stop/resume. A running terminal finishes its pass. Re-edit, cancel and final completion preserve accurate history. |
| A3 | Local run reload, concurrent edits and dispatch preserve the winning assignment, terminal ownership, mixed attribution and changed label. Another run and saved definitions retain their original assignments. |
| B1 | Team edit/create/read/clear, revision conflicts, deleted-role references, shared primaries and deletion guards work in UI, API and SQLite, including old records/clients and invalid fields. |
| B2 | Run start and stopped reassignment snapshot the proper role’s fallback and provenance, survive restart/catalog edits, and exclude legacy and non-team assignments as specified. |
| B3 | Antigravity refusal restarts exactly once, propagates per role and reports the reason. No fallback, self-fallback or exhausted fallback fails recoverably. Manual choices win as specified. Stops, duplicates and interruptions retain work and budgets. |
| C1 | Claude Code, Codex, Cursor and Muse each trigger the same takeover or named error on their source-backed refusal fixture. Each of all five readers rejects the negative cases in §4. |
| C2 | A local desktop run driven by simulated CLI screens shows the handoff, previous terminal, successor and persistent reason, then completes on the replacement. A second depleted agent ends in the documented recoverable error. |
