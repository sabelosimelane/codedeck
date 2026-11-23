---
name: feature-dev
description: Guided feature development with codebase understanding and architecture focus. Use when implementing features from an existing todo file, or when the user says "feature-dev", "continue implementing", "pick up where I left off", or "next phase". This skill orchestrates deep codebase exploration, architecture design, and disciplined strict test-driven (red-green-refactor) implementation with built-in safeguards against test-fix spirals and context loss between sessions.
argument-hint: Optional feature description or todo file path
---

# Feature Development

Implement the **next incomplete phase** of a feature. Follow a systematic approach: resume prior context, understand the codebase, resolve ambiguities, design architecture, then implement with discipline.

## Core Principles

- **Resume, don't restart**: Always check for prior session context before exploring from scratch. The biggest token waste is re-learning what was already known.
- **One phase per invocation**: Find the next incomplete phase in the todo file, implement it, write handoff notes, and stop. The orchestrator (shell script, dev-loop, or user) will invoke you again for the next phase.
- **Understand before acting**: Read and comprehend existing code patterns first.
- **Read files identified by agents**: After agents complete, read the key files they identify.
- **Agents must finish inside your turn**: Whenever you launch explore, review, or delegated implementation agents, run them in the foreground and wait for their results before continuing — parallel is fine, but awaited is mandatory. Never end your turn in a "waiting for the agents" / "will collect results when notified" state. You are often invoked single-shot by an orchestrator with no follow-up turn, so backgrounded agents are killed when the turn ends and their work is lost — leaving the phase half-done with nothing to resume from.
- **Strict TDD — test first, always**: Never write production code except to make a failing test pass. Every increment goes red → green → refactor. Writing the test first isn't ceremony — it forces you to state the behavior precisely *before* an implementation biases you, and it guarantees every line of production code exists because a test demanded it. The moment you're tempted to "just write the code and add a test after" is exactly when the discipline is paying for itself: an after-test rationalizes whatever you wrote; a before-test specifies what you meant. Phase 4 is where this happens.
- **Diagnose before fixing**: When tests fail, understand the root cause before changing code.
- **Log deviations as they happen**: The todo file and spec are a plan the user reviewed. Whenever reality forces you off that plan — an unknown the spec doesn't answer, an assumption you had to make, a design change, a task you skipped or reordered, a workaround for something broken — record it in the Deviation Log (see below) *at the moment it happens*, not retroactively at handoff. The user isn't watching the session; the log is how they audit where and why the implementation departed from what they approved.
- **Test scope: fast and targeted**: The tests you run in the red→green loop are fast ones — unit tests and lightweight slice tests (single file, class, method, or one HTTP/persistence slice) that return in seconds. Run them constantly; that tight loop is the whole point of TDD. The full verify/regression sweep and heavy end-to-end integration runs belong to `feature-test`, which runs right after this skill exits — duplicating them here turns a seconds-long loop into a 5-10 minute one without adding signal feature-test wouldn't surface a minute later.
- **Use TodoWrite**: Track progress throughout.

## State Files — Two Files, Two Jobs

Long features span many sessions. To prevent re-discovery, feature-dev maintains two state files per feature:

| File | Holds | Changes |
|---|---|---|
| `docs/todos/<slug>.md` | **Progress**: phase list with `[ ]`/`[x]`, `**Status**`, `**Last completed**`, compact session notes | Every invocation |
| `.workflow/<slug>.md` | **Understanding**: feature intent, architecture chosen, key files (annotated), project conventions that matter here, gotchas discovered | Only when durable context changes |

The `<slug>` is the todo filename without extension (e.g., `user-auth.md` → slug `user-auth`).

**Why two files**: progress churns every phase; understanding is stable. Mixing them means either the progress file balloons (wasting tokens on every read) or durable context gets overwritten on each handoff. Separating lets the workflow file stay small *and* complete.

**What belongs in `.workflow/<slug>.md`** (keep it ~50-100 lines, not a dissertation):

```markdown
# <Feature Name>

## Intent
2-3 lines: what this feature is, why it exists, what "done" looks like.

## Architecture
Chosen approach, key abstractions, patterns to follow. Written once during
Phase 2; updated only if the approach changes.

## Key files
- `path/to/file.ext` — one line on why this file matters
- ...5-15 files total...

## Conventions that matter here
Distilled from CLAUDE.md and project lore — *only* the rules relevant to this
feature (testing framework quirks, naming conventions, commands). A reader of
this file should not need to re-read CLAUDE.md end-to-end.

## Gotchas
Non-obvious discoveries: caller cascades, framework quirks, things that broke
last time. Grows over the life of the feature.
```

**The promise**: if `.workflow/<slug>.md` is present and current, the next session can skip re-reading CLAUDE.md end-to-end and skip Phase 2 exploration. This is the main lever against token waste.

## Deviation Log — Recording Unknowns and Plan Departures

The todo file and spec together form a contract the user signed off on. When you depart from that contract, the departure itself is often fine — specs have gaps, code has surprises — but a *silent* departure is not. The user reviews the result later and needs to reconstruct where the implementation stopped matching the plan and why. That reconstruction is impossible from a diff alone; it needs your in-the-moment reasoning.

**Where it lives**: a `### Deviations` section inside the current session's notes block at the bottom of the todo file (created on first deviation; omit entirely if the session had none).

**When to write an entry** — at the moment the decision is made, not batched at handoff (by handoff you'll have rationalized or forgotten the context that made it a judgment call):

- **Unknown**: the spec/todo doesn't answer a question you need answered to proceed, and you resolved it with your own judgment instead of stopping.
- **Plan change**: you implemented something differently than the todo/spec/architecture describes (different design, different file, different behavior at an edge case).
- **Skipped/reordered work**: a checklist item turned out to be unnecessary, already done, blocked, or had to move to a later phase.
- **Workaround**: existing code, a framework quirk, or an environment problem forced an approach you wouldn't otherwise choose.
- **Spec conflict**: the spec contradicts itself or the existing code, and you picked a side.

Ordinary TDD churn (a test failed, you fixed it) is not a deviation. The test is: *would the user reading the todo and spec be surprised by what the code actually does or by what you did to get there?* If yes, log it.

**Entry format** — keep each entry 3-6 lines:

```markdown
### Deviations
- **[Phase N / task name] — <one-line label>**
  - **Planned**: what the spec/todo/architecture said (or "spec silent on this")
  - **Found**: what you actually encountered, with file:line or command evidence
  - **Did**: what you did instead, and why this option over the alternatives
  - **Follow-up**: what the user should review or decide, or "none"
```

An entry whose **Follow-up** is a real decision the user must make also belongs in the Exit Report's **Blockers**/**Key decisions** — the Deviations section is the durable record; the Exit Report is where it gets seen.

---

## Phase 0: Resume Context

**Goal**: Pick up where a previous session left off instead of wasting tokens re-exploring

This phase is what separates a 2-session feature from a 10-session feature. Every minute spent here saves 10 minutes of re-exploration.

### Step 1: Find the feature (todo file)

Check `$ARGUMENTS` for a path or feature name. If none, scan `docs/todos/` for an incomplete todo file using this priority:
- **Flat files first**: Scan `docs/todos/*.md` — sort alphabetically, pick the first one that still has unchecked `[ ]` items and whose `**Status**` is not `Complete`.
- **Composed directories**: If no flat file has remaining work, check for subdirectories under `docs/todos/` (e.g., `docs/todos/implementation-gap/`). If a subdirectory exists, look for a `README.md` index inside it — that index defines the dependency order and overall status. Read it to find the next sub-todo whose dependencies are satisfied and whose status is not Complete. Then open that specific sub-todo file (e.g., `01-foundation.md`).
- **Dependency awareness**: Composed directories have inter-file dependencies (e.g., `02-filtering-core.md` depends on `01-foundation.md`). The index `README.md` lists these. Never start a sub-todo whose dependencies are not yet marked Complete in the index.
- Do not use modification time for selection; a recently-touched file may be complete while a later file has work remaining.

### Step 2: Read state files — `.workflow/<slug>.md` FIRST, then todo

Derive `<slug>` from the todo filename (e.g., `docs/todos/user-auth.md` → `.workflow/user-auth.md`). For composed sub-todos (e.g., `docs/todos/implementation-gap/01-foundation.md`), use the directory name as slug (`.workflow/implementation-gap.md`) — the workflow file covers the whole feature, not each sub-todo.

1. **Read `.workflow/<slug>.md` if it exists.** This is your durable context: feature intent, architecture, key files, conventions that matter, gotchas. It replaces re-reading CLAUDE.md and re-running Phase 2 exploration.
2. **Read the todo file.** Extract:
   - `**Last completed**` line — which phase was finished last
   - `**Session notes**` sections at the bottom — handoff from the most recent prior session
   - Checked (`[x]`) vs unchecked (`[ ]`) items — progress within phases
   - `**Spec**` path — the specification file to reference
3. Check for `docs/todos/.dev-loop-state.json` — if present, you're being orchestrated by the dev-loop skill or shell script. Read it for additional context (files changed, fix count, stage).
4. **Read CLAUDE.md or AGENTS.md only if `.workflow/<slug>.md` is absent or incomplete.** Many projects use `AGENTS.md` instead of `CLAUDE.md` — treat them as equivalent. If the workflow file is present and lists the conventions that matter, trust it — don't duplicate its job by re-reading project steering files end-to-end. If the workflow file exists but feels thin (no "Conventions" section, or the current phase touches an area the file doesn't cover), *then* read CLAUDE.md/AGENTS.md and plan to extend the workflow file at Phase 6.

### Step 3: Decide — resume or explore?

**Orchestrator preamble does not override resume.** Workflow/dev-loop dispatches often prefix the message with `[search-mode]` or `[analyze-mode]` ("MAXIMIZE SEARCH EFFORT", "launch explore agents in parallel"). Those are generic orchestrator defaults. **Feature-dev's Phase 0 decision wins.** When Step 3 below says resume, do not launch explore/librarian agents or run broad codebase sweeps — regardless of preamble text.

**If `.workflow/<slug>.md` exists AND session notes exist** (the common case on any session past the first):
- You have everything you need. Announce what you're resuming and skip to Phase 3 (Decide Scope) → Phase 4 (Implementation). **Do not re-explore.**
- **Quick-check for already-implemented work**: skim the key files listed in the workflow file and run `git diff --name-only` to see if code already exists for the target phase. A prior session may have implemented code but failed to update the todo checkboxes. If the code exists, just mark items `[x]` and move to the next phase.
- **Do NOT re-ask questions** that prior sessions answered.
- **Do NOT re-design architecture** if the workflow file records the approach.
- Tell the user: "Resuming [feature name]. Last session completed [Phase N]. Starting Phase [M]: [name]."

**If `.workflow/<slug>.md` is missing** (first session on this feature, or legacy feature created before this skill version):
- Proceed to Phase 1 → Phase 2. You'll *create* the workflow file at the end of Phase 2 so future sessions benefit.

**If `.workflow/<slug>.md` exists but the current phase touches an area it doesn't cover** (e.g., workflow file describes the backend, but this phase is the frontend):
- Read what's there for background, then do a *targeted* Phase 2 (one agent on the new area, not three). Extend the workflow file at Phase 6 — don't rewrite it.

---

## Phase 1: Discovery

**Goal**: Understand what needs to be built

Initial request: $ARGUMENTS

**Actions**:
1. Create todo list with all phases (if no todo file exists yet)
2. If a spec file exists (referenced in todo header, or check `docs/specifications/`, `docs/specs/`), read the relevant sections. The spec is the source of truth.
3. If the feature is unclear, ask the user:
   - What problem are they solving?
   - What should the feature do?
   - Any constraints or requirements?
4. Summarize understanding and confirm with user
5. Identify the **next incomplete phase** — this is what you'll implement in this invocation

---

## Phase 2: Codebase Exploration

**Goal**: Understand relevant existing code and patterns

**Skip if**: `.workflow/<slug>.md` exists with architecture and key files, OR session notes from a prior run already describe the relevant patterns. Only re-explore if you're on the first session (no workflow file) or the current phase touches NEW areas not covered by the workflow file.

**When explore agents fail** (ProviderModelNotFoundError, timeout, unavailable subagent): do not retry with more agents or compensate with exhaustive grep/glob sweeps. Read the **Key files** from `.workflow/<slug>.md` directly, then at most 1–2 targeted greps for the specific gap. Agent failure means use cached context, not explore harder.

**Actions**:
1. Launch 2-3 code-explorer agents in parallel. Each agent should:
   - Trace through the code comprehensively with focus on abstractions, architecture, and control flow
   - Target a different aspect (similar features, architecture, UI patterns, etc.)
   - Include a list of 5-10 key files to read

   **Example agent prompts**:
   - "Find features similar to [feature] and trace their implementation comprehensively"
   - "Map the architecture and abstractions for [feature area], tracing through the code"
   - "Identify UI patterns, testing approaches, or extension points relevant to [feature]"

2. Read all files identified by agents to build deep understanding
3. **Caller survey for shared types**: If this phase changes a DAO, interface, table, or value object used in more than one place (e.g., migrating writes from `campaign_step` → `campaign_version_step`), `grep` for every caller/reader of the old type **before editing**. Enumerate them in your plan. Missing a caller turns into a 30-minute cascade of `mvnw verify` → red → patch → verify → red when the broken callers surface one at a time.
4. Present comprehensive summary of findings and patterns discovered
5. **Write `.workflow/<slug>.md`**: distill what you just learned into the durable context file (see structure in "State Files" section above). Aim for ~50-100 lines. This is the investment that pays off on every future session — the next invocation will read this instead of re-running Phase 2. Create the `.workflow/` directory if it doesn't exist. Skip this step only if the file already exists and is still current (e.g., you did a targeted re-explore on a narrow area; update at Phase 6 instead).

---

## Phase 3: Decide Scope

Look at the unchecked phases and decide how much to take on in this session. Consider:

- **Phase size**: Small phases can be combined. A phase with 2-3 small tasks can be paired with the next phase.
- **Complexity**: A phase involving new architectural patterns or cross-cutting concerns is probably enough on its own.
- **Dependencies**: If Phase N's output is needed to validate Phase N+1's approach, do them separately.

Briefly tell the user what you plan to implement and why, then proceed directly to implementation — no need to wait for confirmation. The user has already reviewed the todo and spec by invoking this skill.

---

## Phase 4: Implementation

**Goal**: Build the current phase under **strict TDD** — no production code in any layer without a failing test that demands it. Every increment is red → green → refactor, uniformly. There is no "implement-first" layer.

### Step 1: Pre-flight

1. Read all relevant files identified in previous phases.
2. Before writing code, check if each todo item's target file already exists — a prior session may have implemented it without marking the checkbox. If code exists and matches the spec requirement, just mark `[x]` and move on.

### Step 2: Rule Extraction

Before writing any code, read the spec and enumerate **every discrete business rule, constraint, and edge case** relevant to this phase. Write them as a numbered list. This list becomes your test plan — each rule maps to one or more test cases.

Example:
```
Rules for Threshold Mode:
1. Alert triggers when occurrence count >= configured threshold within the time window
2. Time window is sliding, not fixed
3. Threshold of 1 means "trigger on first occurrence"
4. Occurrences outside the window are not counted
5. Window resets after alert triggers
```

This step is what separates disciplined implementation from "write code and hope." The spec already contains these rules — your job is to make them explicit before encoding them as tests. Include boundary conditions, error cases, and combinations the spec implies but doesn't spell out.

### Step 3: Build each behavior test-first (red → green → refactor)

Strict TDD is **one loop, applied to every layer** — there is no layer you "just implement." What changes between layers is only *which kind of test is the cheapest one that can fail for the right reason*. Reach for the fastest such test; leave the heavy end-to-end check for `feature-test`. The reason this works is that fast tests keep the red→green loop in the seconds range, so being strict everywhere costs you almost nothing per cycle while buying a precise spec for every line you write.

**The loop — repeat for each rule from your Step 2 extraction:**

1. **RED** — Write one focused, failing test that encodes the rule. Name it after the behavior, not the method: `rejectsEventWhenSourceIsSuspended()`, `returns404WhenCampaignMissing()`. One rule, one test — small steps surface mistakes faster than big ones.
2. **Run it, and read the failure.** Confirm it fails for the *reason you intended* — the assertion you care about, or a symbol you're about to create — not an unrelated NPE, a typo'd import, or a misconfigured fixture. A test that fails for the wrong reason proves nothing and will lie to you later when it goes green.
3. **GREEN** — Write the **minimum** production code to pass it. If you catch yourself writing a branch, field, or method that no current test exercises, stop — that's the signal to go back to RED and write the test first. (Caveat that keeps this sane, not dogmatic: one failing test legitimately pulls a small cluster of types into existence — the value object, DTO, or interface it references. That's still test-first: the test named the behavior, and those types are the minimum to satisfy it. What you never do is add a getter, field, or code path *no* failing test asked for.)
4. **Run it. Confirm green.**
5. **REFACTOR** — Remove duplication, sharpen names, extract helpers — while every test stays green. New behavior is never added during refactor; new behavior means a new RED test.
6. Next rule.

**Which test drives each layer** — pick the fastest one that fails honestly:

| Layer | Test-first driver | Why this one |
|---|---|---|
| Domain / value objects | Pure unit test | Invariants come straight from the spec ("SourceId must not be blank"). No infra, milliseconds. |
| Business logic (handlers, domain services, pure functions) | Pure unit test | Where TDD pays off most: pure in→out, rules map 1:1 to tests. Spend the most cycles here. |
| Persistence (DAO / repository) | A **fast slice test**, written first — `@DataJpaTest`, an in-memory/fake store, or the repo against a fast local engine | Drives the query/mapping behavior without standing up the full stack. Don't reach for full Testcontainers here — the end-to-end proof is `feature-test`'s job. |
| API / transport (controllers, route handlers, DTO validation) | A **fast slice test**, written first — `@WebMvcTest`, or supertest/`request()` against the handler with the service mocked | Pins the contract — status codes, response shape, validation errors — while staying fast and focused on transport. |
| End-to-end wiring | An integration test (`@SpringBootTest` + Testcontainers, full HTTP→DB cycle) | Still write it before the wiring it proves, so the wiring is test-driven too. But you may **defer running** the heavy version to `feature-test` — the slice tests above already drove each piece; this only confirms they compose. |

The slice-test rule is the hinge that lets strict TDD stay both strict and fast: every layer is genuinely test-first, yet the loop you run on each change is seconds, not minutes. Heavy end-to-end runs simply don't belong in the inner loop.

**After all rules are green**, step back twice:
- **Gap hunt** — boundary values, error paths, and rule combinations the spec implies but your Step 2 list missed. Each is another RED test.
- **Coverage honesty check** — skim `git diff` for any production branch, field, or method with no test behind it. If you find one, you drifted from test-first; add the test and confirm it would have failed without the code. Finding none is the proof the discipline held.

### Step 4: Progress tracking

- Update todos as you progress — mark items `[x]` as you complete them.
- **Log deviations as they occur.** Implementation is where most deviations surface — a spec gap, a surprise in existing code, a design that doesn't survive contact with reality. The moment you resolve one with your own judgment, append an entry to the `### Deviations` section (see "Deviation Log" above) before moving on. Writing it now costs 30 seconds; reconstructing it at handoff costs accuracy.
- After completing a phase, update the todo file header. Add or update a `**Last completed**` line immediately after the `**Status**` line:
  ```
  **Last completed**: Phase 1: Backend — New System Endpoints
  ```
  This line is how `feature-test` knows what to test. Update this every time you finish a phase — if you complete multiple phases in one session, set it to the last one you finished.

### Test Execution

**Feature-dev runs fast, targeted tests only** — unit tests and lightweight slice tests (single file, class, method, or one HTTP/persistence slice), narrow enough to return in seconds. These *are* your red→green loop, so run them constantly. Do **not** run the project's full verify/regression suite or a heavy end-to-end integration suite (full Testcontainers `@SpringBootTest`) from this skill, not even as a "final check" at the end of the phase. The broad sweep is `feature-test`'s job and runs right after feature-dev exits; running it twice slows the dev-loop without adding any signal that feature-test wouldn't catch a minute later.

If you genuinely think you need a broader run, you almost certainly want to either (a) write another targeted test that pins down what you're worried about, or (b) hand off to feature-test now.

**Detect the project's test framework from `package.json`, `pom.xml`, or CLAUDE.md and pick a targeted, resource-safe command:**
- **vitest/vite**: `npx vitest run path/to/file.test.ts --maxWorkers=1` (vitest defaults can OOM; always cap workers)
- **jest**: `npx jest path/to/file.test.js --maxWorkers=2`
- **mvnw**: `./mvnw test -Dtest=SpecificTest` (single class) or `-Dtest=SpecificTest#methodName` (single method). Never `./mvnw verify` from this skill.
- **gradle**: `./gradlew test --tests "com.example.SpecificTest"` (single class)
- **other**: check CLAUDE.md for the project's targeted-test command

**Long-running targeted tests** (a single `@SpringBootTest` class with Testcontainers can still take 1-2 minutes): `bash-server` caps at ~30s and will abort. Don't retry with a bigger `timeout`. Use the `run` script: `run ./mvnw test -Dtest=PipelineInvokeIntegrationTest` launches it detached and returns a PID immediately. Then `run --logs <pid>` to read output, `run --watch <pid>` to tail live, `run --list` to see active runs, `run --stop <pid>` when done. See `run --help` for full usage.

### Circuit Breaker — Preventing Test-Fix Spirals

**After 3 consecutive test failures on the same file or area, STOP fixing and START diagnosing.**

This is non-negotiable. The sessions that resolve fastest pause to diagnose after 2-3 failures.

When you hit 3 failures:
1. **Stop making code changes**
2. **Read the failing test** — understand what it actually asserts
3. **Read the code under test** — trace the execution path end-to-end
4. **Write a root-cause diagnosis**: "The failures share a common root cause: [X]. Incremental fixes aren't working because [Y]."
5. Make ONE targeted fix based on the diagnosis and re-run
6. If still failing after a targeted root-cause fix, **tell the user and stop**. Do not attempt a 5th or 6th fix.

---

## Phase 5: Quality Review and Auto-Fix

**Goal**: Ensure code is simple, DRY, and correct

**Actions**:
1. Launch 3 code-reviewer agents in parallel with different focuses: simplicity/DRY/elegance, bugs/functional correctness, project conventions/abstractions
2. Consolidate findings and identify all issues by severity (only report issues with confidence >= 80)
3. **Add each issue as a sub-task** using TodoWrite — do not skip any
4. **Fix every issue automatically** — work through each sub-task until all are resolved. Do not ask the user whether to fix them; the answer is always yes. Mark each sub-task complete as you fix it.
5. After all fixes are applied, re-run **only the targeted tests** for the files you touched during fixes (single class or single method). Do not run the full verify/regression suite here — feature-test runs it immediately after this skill exits, and running it twice slows the dev-loop without adding signal. If your fixes touched a different file than the original implementation, run that file's targeted tests too.
6. If fixes introduce new issues, add those as sub-tasks too and keep going until clean

---

## Phase 6: Session Handoff

**Goal**: Persist context so the next invocation resumes seamlessly

**Actions**:
1. Mark all completed items as `[x]` in the todo file
2. Update the `**Last completed**` line at the top of the todo file:
   ```
   **Last completed**: Phase [N]: [Name]
   ```
3. **Update `.workflow/<slug>.md` if durable context changed.** Most phases don't need this — if you only implemented to the existing architecture using the existing conventions, skip. Touch the workflow file only when:
   - You added a new architectural pattern worth recording (e.g., introduced a new abstraction layer).
   - You hit a non-obvious gotcha the next session should know about (caller cascade, framework quirk, flaky test pattern). Add it to the **Gotchas** section.
   - New key files were created that future phases will touch. Add them to **Key files** with a one-line annotation.
   - A new project convention came up (e.g., spec added a naming rule). Add to **Conventions that matter here**.

   Prefer small additive edits over rewrites. The file's value is that it stays stable and trustworthy — if you rewrite it every phase, it becomes as noisy as the todo file's session notes.

4. Append session notes at the bottom of the todo file. Use a parenthetical to scope which phases the notes cover:
   ```markdown
   ### Session — [YYYY-MM-DD] ([Phase N] or [Phase N-M])
   **Completed**: Phase [N]: [Name]
   **Key files**: [5-10 most important files for context]
   **Next**: Phase [M]: [Name] — [what needs to happen]
   ```

   Include whichever of these optional fields are relevant (skip any that add no value for this phase):
   - **Architecture**: [approach chosen, key patterns] — include for early phases; skip for later phases where it's already established
   - **Decisions**: [user choices, tradeoffs] — include when the user made explicit choices
   - **Bug fixes**: [issues found and how they were resolved] — include when bugs were fixed during implementation, so the next session doesn't reintroduce them
   - **Quirks**: [framework surprises, workarounds] — include when something non-obvious was discovered

   If the session logged any deviations, verify the `### Deviations` section under this session's notes is complete — every unknown resolved by your own judgment, plan change, skipped item, workaround, or spec conflict should have an entry (see "Deviation Log" above). Don't rewrite entries at handoff; they were written in the moment for a reason. Do add any you realize you missed, marked `(logged at handoff)` so the user knows the context is reconstructed.
5. If `docs/todos/.dev-loop-state.json` exists, update its `files_changed` and `stage` fields.
6. Update `**Status**` to `In Progress` (or `Complete` if all phases are done)
7. **If working in a composed todo directory** (e.g., `docs/todos/implementation-gap/`): when a sub-todo file has all phases done, update its `**Status**` to `Complete`, then update the index `README.md`'s status table to mark this file Complete. This keeps the index in sync so the next invocation of feature-dev knows which files are done.
8. **Print the Exit Report** as the final message to the user. This block is the contract that tells the user (and any orchestrator reading the transcript) whether the feature is done or how much remains. It must always be the last thing you output, even if the session ended early due to a blocker.

   Compute the counts directly from the todo file before printing:
   - **Phase counts**: total phases = count of phase headers (e.g., lines matching `## Phase` or `### Phase`); complete phases = phases whose every `[ ]`/`[x]` checkbox under them is `[x]`. A phase with zero checkboxes counts as complete only if its header itself is marked done (e.g., `~~Phase 3~~` or an explicit `**Status**: Complete` line under it).
   - **Task counts**: total tasks = `[ ]` + `[x]` markers across the whole file; completed tasks = `[x]` markers. Use `grep -c` or read the file directly — don't estimate.
   - **Composed todos** (sub-todo in a directory like `docs/todos/implementation-gap/`): also report the index-level progress from `README.md` (e.g., "Sub-todos: 2 of 5 complete") so the user sees both the local file and the overall feature.

   Use this exact template — the structure is what makes it parseable at a glance:

   ```markdown
   ## Exit Report

   **Feature**: <feature name from todo header>
   **Todo file**: `docs/todos/<slug>.md`
   **Phases**: <X> of <Y> complete
   **Tasks**: <A> of <B> complete (<percent>%)
   <if composed:> **Sub-todos**: <P> of <Q> complete

   ### This session
   - **Completed**: Phase <N>: <name>
   - **Built**: <1-2 lines on what changed>
   - **Key decisions**: <bullets, or "none">
   - **Deviations**: <count + one-line label per entry, or "none"> — details live in the todo file's `### Deviations` section

   ### Next
   - **Phase**: Phase <M>: <name>
   - **What it involves**: <1-2 lines>
   - **Blockers**: <list, or "none">

   ### Status
   <one of:>
   - ✅ Feature complete — all phases done.
   - 🔄 In progress — run `/feature-dev` to continue with the next phase.
   - ⚠️ Blocked — see Blockers above; resolve before re-running.
   ```

   Two rules for the report:
   - **Numbers must match the file on disk.** If you marked checkboxes during this session, re-read the file before computing counts so the report reflects the saved state, not your memory.
   - **Don't pad it.** If "Key decisions" or "Blockers" is empty, write "none" — don't omit the field. The fixed shape is what lets the user (and future you) skim it.

**Keep session notes compact** — aim for 10-15 lines. They carry *what changed this session*. The durable "what this feature is" context lives in `.workflow/<slug>.md` instead — don't duplicate it here.

---
