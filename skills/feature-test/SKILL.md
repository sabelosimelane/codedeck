---
name: feature-test
description: >
  Verify that a completed feature-dev phase is fully tested against the spec — unit tests,
  integration tests (with full permutation assertions), backend boot verification (start the
  app and confirm clean logs), live API endpoint testing, and browser-based UI testing
  (with explicit login) using chrome-devtools MCP tools. Reads the todo file and referenced
  spec to ensure tests cover the ENTIRE scope of the implemented phase, not just what the diff
  shows. Frontend changes ALWAYS require browser testing — skipping it is a failure, not a pass.
  Use when the user says "test this phase", "feature test", "verify the implementation",
  "test my changes", "test this", "QA this phase", or any variation of wanting to validate the
  most recently completed feature-dev phase. Also use after completing a /feature-dev session,
  or when the user just says "test it" or "make sure this works".
user-invocable: true
---

# Feature Test

Verify the most recently completed feature-dev phase across six layers: unit tests, integration
tests, backend boot verification, live API endpoints, login, and browser UI. The key difference
from generic testing: this skill reads the spec and todo file to ensure tests cover the **entire
scope of the specification for that phase**, not just what the diff happens to show. A missing
test for a spec requirement is a bug — even if the code was never written.

Two non-negotiables this skill exists to enforce:

1. **The application must actually boot cleanly** before any "tested" claim. Passing unit tests
   on code that can't start the server is a false signal. Phase 4 is the gate.
2. **Frontend changes require browser testing.** If the diff touches frontend files and the
   browser flow didn't complete successfully, the verdict is **FAILED** — not "skipped". The
   browser is the only place we observe what the user actually sees.

## Auto-Fix Principle — With Circuit Breaker

When you discover issues — test failures, implementation bugs, missing coverage — **fix them immediately**. Do not ask the user whether to fix them; the answer is always yes. Add each issue as a sub-task using TodoWrite.

**However: after 3 consecutive fix attempts on the same test or area, STOP and DIAGNOSE.**

The instinct to "just try one more fix" is what turns a 30-minute test session into a 3-hour spiral. When 3 fixes haven't resolved an issue:

1. Stop changing code
2. Read the failing test AND the code under test end-to-end
3. Write a root-cause diagnosis: what's actually wrong, why incremental fixes aren't converging
4. Present the diagnosis to the user with a proposed approach
5. Only proceed after you understand the root cause

Track your fix count per area mentally. If you've touched the same file 3 times for the same category of failure, that's your signal.

---

## Chain of Thought — MANDATORY Format

Every phase requires a visible reasoning block using EXACTLY this format:

```
> **Reasoning:** [your analysis here]
```

Each reasoning block must answer:
- What did I observe?
- What does the spec require?
- What permutations exist?
- Which am I testing and why?

---

## Phase 0: Understand What Was Built

Before testing anything, understand what the spec REQUIRES — not just what the diff shows.

### 0.1 Find the todo file

Scan `docs/todos/` for the most recently modified incomplete todo file — same file that
`feature-dev` was working from. Read it.

### 0.2 Read session notes for context

Check for `**Session notes**` and `### Feature test —` sections at the bottom of the todo file.
Session notes are written by feature-dev and contain:
- What was implemented and which files were changed
- Architecture decisions and patterns used
- Framework quirks discovered during implementation

This context helps you understand the implementation without re-exploring the entire codebase. Also check for `docs/todos/.dev-loop-state.json` for additional structured context.

**Check for prior feature-test runs.** If a `### Feature test —` section exists for the same
phase as `**Last completed**`, the phase has already been tested. Summarize the prior verdict
(tests run, coverage, what was verified) and ask the user:

> "Phase [N] was already tested on [date] — verdict: [summary]. Re-run the full suite, or skip?"

Default to skip unless the user asks for a re-run, the prior verdict was NEEDS FIXES/FAILED,
or the diff has changed since the prior test (use `git diff` against the commit the prior test
ran on, if recorded). Re-running a clean test for the sake of running it burns 20+ minutes for
no new signal.

### 0.3 Identify the completed phase(s)

Look for a `**Last completed**` line in the todo file header — `feature-dev` writes this after
finishing each phase (e.g., `**Last completed**: Phase 1: Backend — New System Endpoints`).
This is the authoritative signal for what needs testing.

If no `**Last completed**` line exists, fall back to scanning checkboxes: find the last phase
where all items are checked (`- [x]`) that precedes a phase with unchecked items. If that also
yields nothing, check git diff to correlate changes with todo items.

If none of these methods identify a completed phase, tell the user: "No completed phases found.
Run `/feature-dev` to implement a phase first."

### 0.4 Read the spec sections

Each todo item references a spec section (e.g., `Spec §4.1`). Read EVERY referenced spec
section for the completed phase(s). Build a complete picture of what the spec requires.

> **Reasoning:** The completed phase is [Phase N: name]. It references spec sections [list].
> The spec requires: [summarize each requirement]. I need to verify that BOTH the implementation
> AND the tests cover all of these requirements.

### 0.5 Discover the project's prescribed commands

Read CLAUDE.md files **in this order** to discover the project's commands. **You will use
these — not invented equivalents — throughout the rest of the skill.**

1. **Project root** — `./CLAUDE.md`
2. **Nested project files** — `**/CLAUDE.md` in relevant subtrees (monorepo workspaces, etc.)
3. **User-level global** — `~/.claude/CLAUDE.md` — this is where cross-project conventions
   often live (e.g., "all projects use `./server.sh`", maven/vitest resource flags). Don't skip
   it just because the project has no local CLAUDE.md.

Record what you find:

- **Build command** (e.g., `./mvnw compile -q`, `npx tsc --noEmit`, `go build ./...`)
- **Test runner** (jest/vitest/maven/etc. with resource-safe flags)
- **Infra startup** (docker compose / custom script)
- **Backend server commands** (typically `./server.sh start|stop|status|logs`)
- **Frontend server commands** (if applicable)
- **Test credentials location** (CLAUDE.md section, project env file, seed data, etc.)
- **Health/readiness URL or log marker**

**Verify by file presence too**, not just docs:

- `./server.sh` exists → use it, even if not explicitly mentioned in CLAUDE.md
- `compose.yaml` / `docker-compose.yml` exists → that's your infra
- `pom.xml` → Spring Boot / Maven; `package.json` → Node; `go.mod` → Go; etc.

Only stop and ask the user if you can find **neither** a documented convention **nor** a
prescribed script on disk. Inventing `npm start` / `./mvnw spring-boot:run` when the project
has its own wrapper will fight the process manager, port assignment, and log routing the
wrapper handles.

### 0.6 Build gate

Run the prescribed build/compile command. If it fails, report errors immediately and stop.

---

## Phase 1: Spec Coverage Audit

Before running any tests, verify that tests EXIST for every requirement in the spec.

### 1.1 Build the spec requirements checklist

For each spec section referenced in the completed phase, list every testable requirement:

> **Spec Coverage Checklist:**
>
> From Spec §4.1 (Entity: Notification):
> 1. [ ] Fields: id, projectId, message, type, createdAt — all persisted correctly
> 2. [ ] Unique constraint on (projectId, name) enforced
> 3. [ ] Cascade delete from parent project
>
> From Spec §6 (API Endpoints):
> 1. [ ] POST /notifications — creates with valid input
> 2. [ ] POST /notifications — rejects missing required fields
> 3. [ ] GET /notifications — returns project-scoped list only
> ...

### 1.2 Map existing tests to requirements

Search for tests covering the implemented code. For each test found, mark which spec
requirement it covers. Check off items in the checklist.

### 1.3 Identify coverage gaps

> **Reasoning:** Spec requires [N] testable behaviors. Existing tests cover [M].
> Missing coverage:
> - [Requirement] — no unit test exists
> - [Requirement] — unit test exists but no integration test for DB-level behavior
> - [Requirement] — only happy path tested, no permutations
> These gaps must be filled.

**Add each coverage gap as a sub-task** using TodoWrite.

---

## Phase 2: Unit Tests

### 2.1 Reason about unit test needs against the spec

> **Reasoning:** For each spec requirement, what logic runs in service/handler code?
> What branches exist? What exceptions can be thrown? Map each to a test case.
> Focus on what the SPEC requires, not just what the diff shows.

### 2.2 Write missing unit tests

If tests don't cover all spec requirements for this phase, **create them**. If they
exist but miss permutations, **expand them**.

**Assertion quality matters**: Every test must verify **behavior**, not just existence. Bad assertions create a false "done" signal that leads to bugs discovered in later sessions.

Bad (verifies nothing meaningful):
```
expect(response).toBeDefined()
expect(result).toBeTruthy()
```

Good (verifies actual behavior):
```
expect(response.statusCode).toBe(201)
expect(mockService.create).toHaveBeenCalledWith({ name: 'test', projectId: '123' })
expect(emitSpy).toHaveBeenCalledWith('session:updated', expect.objectContaining({ status: 'active' }))
```

**Verify downstream side effects**, not just return values:
- Mock calls: `expect(mock).toHaveBeenCalledWith(expectedArgs)`
- Database writes: verify the query function was called with correct parameters
- Event emissions: verify WebSocket/event emitter was called
- External service calls: verify HTTP client was called with correct payload

### 2.3 Run targeted tests

Use the project's test runner with **resource-safe defaults**:

- **Jest**: `npx jest path/to/file.test.js --maxWorkers=2`
- **Vitest**: `npx vitest run path/to/file.test.ts --maxWorkers=1` (vitest defaults can OOM)
- **Maven**: `./mvnw test -Dtest=SpecificTest`
- **Other**: Check CLAUDE.md for test commands

**Always run targeted tests first**, not the full suite.

### 2.4 Run full test suite for regressions

After targeted tests pass, run the full suite once as a regression check.

### 2.5 Reason about results and auto-fix (with circuit breaker)

> **Reasoning:** [X] tests passed, [Y] failed. Spec requirements covered: [update checklist].

**If tests fail**: Fix immediately — but track your fix count per test/area. After 3 consecutive failures on the same test, stop and diagnose the root cause before continuing. See the circuit breaker rules at the top of this skill.

---

## Phase 3: Integration Tests

Integration tests verify real database behavior, transaction boundaries, and constraint enforcement.

Skip only if the phase has zero data-layer impact. If skipping, explain with a reasoning block.

### 3.1 Reason about integration test needs against the spec

> **Reasoning:** The spec requires these data-layer behaviors for this phase:
> - [Repository queries needing real SQL/DB]
> - [Unique constraints needing DB enforcement]
> - [Cascade behavior needing real foreign keys]
> - [Cross-tenant isolation needing scoping filters]

### 3.2 Check existing integration tests

Find existing integration tests. Map them to spec requirements. Identify gaps.

### 3.3 Assert the full permutation set

For every spec requirement with data-layer impact, test ALL permutations:

**Input permutations:**

| Category | Permutations to assert |
|----------|----------------------|
| **Valid inputs** | Minimum valid, typical valid, maximum valid |
| **Required fields** | Each required field missing individually, all missing |
| **Optional fields** | All present, all absent, mixed |
| **Boundary values** | Min length, max length, at limit, over limit |
| **Data types** | Empty string vs null, zero vs null, blank vs whitespace |

**State permutations:**

| Category | Permutations to assert |
|----------|----------------------|
| **Valid transitions** | Every allowed state change from the spec |
| **Invalid transitions** | Every disallowed transition |
| **Cascade effects** | Parent state changes affecting children |

**Relationship permutations:**

| Category | Permutations to assert |
|----------|----------------------|
| **With parent** | Valid parent, missing parent, wrong tenant (cross-tenant) |
| **With children** | Zero, one, many children |
| **Uniqueness** | Duplicate within scope, duplicate across scopes |
| **Referential integrity** | Delete with children, orphan handling |

**Query/list permutations:**

| Category | Permutations to assert |
|----------|----------------------|
| **Empty results** | No matching records |
| **Pagination** | First, middle, last, beyond-last page |
| **Filters** | Each filter alone, combined |
| **Cross-tenant isolation** | Tenant A cannot see tenant B's data |

### 3.4 Write or expand integration tests

Use the project's established integration test patterns. Check CLAUDE.md and existing tests for:
- Base test class or setup helpers
- Test data builders or factories
- Database setup/teardown patterns
- Whether to verify DB state directly (queries) or through API responses

### 3.5 Run integration tests (targeted, then full)

### 3.6 Reason about results and auto-fix (with circuit breaker)

> **Reasoning:** Total spec-required permutations: [N]. Tests written: [M]. Passing: [P].

If any spec-required permutation is missing, **write the test before moving on**.

Apply the same circuit breaker: 3 failures on the same area → stop and diagnose.

---

## Phase 4: Backend Boot Verification + Live API

Code can pass every unit and integration test and still fail to boot. A "tested" claim against
an app that won't start in dev is a lie. This phase verifies the app runs cleanly with its real
dependencies, then exercises the endpoints from the spec.

Skip ONLY if the completed phase has no backend impact at all (rare — even pure frontend phases
usually need to verify the backend they call is still healthy).

### 4.1 Start infrastructure

Most apps need a database (and sometimes Redis, message broker, etc.) before the app can boot.
The convention is a `docker-compose.yml` or `compose.yaml` defining these services.

1. Identify the infra command from Phase 0.5 — typically `docker compose up -d` or a prescribed script
2. Start the non-app services
3. Verify health: `docker compose ps` — every service should be `running` and (where configured) `healthy`
4. If a service is stuck `unhealthy`, fetch its logs (`docker compose logs <service>`) and surface the error before going further

> **Reasoning:** Started [services]. Healthchecks: [status of each]. Ready to start the app.

### 4.2 Start the application

Use the **prescribed** server command from Phase 0.5 — typically:

```bash
./server.sh status || ./server.sh start
```

Never invent `npm start`, `./mvnw spring-boot:run`, `python manage.py runserver`, etc. The
project's `server.sh` (or equivalent) handles port assignment, env loading, PID tracking, and
log routing — bypassing it leaves orphan processes and silent failures.

If no prescribed command exists, stop and tell the user. (You should have caught this in 0.5.)

### 4.3 Verify clean boot from logs

This is the gate. A running process can still be broken — migrations may have failed, beans may
not have wired, env vars may be missing, a port may already be bound. Tail the logs and verify
both a positive readiness signal AND the absence of error signals.

Read the last ~200 lines (or since boot timestamp) using the prescribed logs command (e.g.
`./server.sh logs`).

**Positive signal — MUST appear since boot.** Use whatever's prescribed in CLAUDE.md if
specified; otherwise use the framework's standard marker:

| Framework | Typical readiness marker |
|-----------|--------------------------|
| Spring Boot | `Started <App> in X.Xs` / `Tomcat started on port` |
| Express / Node | `listening on port X` / `Server running at` |
| Vite | `Local:   http://...` / `ready in Xms` |
| Next.js | `Ready in Xms` / `started server on` |
| Django | `Starting development server at` / `Quit the server with` |
| Flask | `Running on http://` |
| Go (net/http) | usually a custom log line — check existing examples |
| Rails | `Listening on` / `Booting Puma` + `Use Ctrl-C to stop` |

If you can't find a clear marker, fall back to a healthcheck HTTP probe (`curl -fsS
http://localhost:<port>/` or whatever the prescribed health URL is) after a short wait.

**Negative signals — MUST NOT appear since boot:**
- `ERROR` or `FATAL` log levels
- `Exception`, `Stacktrace`, `Caused by:` lines
- `failed to start`, `connection refused`, migration failures
- Port-in-use errors, missing-env-var errors

If the readiness marker hasn't appeared yet, wait a few seconds and re-tail — apps boot
asynchronously. Don't conclude "not started" without giving it time.

> **Reasoning:** Tailed [N] lines since boot at [timestamp]. Readiness marker: [found / not found].
> Negative signals: [none / list with snippets]. Verdict: [clean boot / boot failed].

**If boot failed, fix it before going further.** The API and UI tests are meaningless against a
broken app. Apply the circuit breaker after 3 fix attempts on the same boot error.

### 4.4 Live API endpoint testing

Now that the app is up and clean, exercise the endpoints from the spec.

**Cross-reference spec endpoints** — read the spec's endpoint table and identify which
endpoints are part of this phase.

For each endpoint:

> **Reasoning for [METHOD /path]:**
> Spec §[N] requires: [what the spec says]
> Permutations:
> 1. Happy path — valid input, expected response shape and status
> 2. Validation — each required field missing, each constraint violated
> 3. Not found — non-existent ID, expected 404
> 4. Auth — missing credentials, wrong tenant credentials
> 5. Edge cases — specific to this endpoint per the spec

Execute each with curl. Verify response status codes and body shapes match the spec.

After each batch, re-check logs for any new ERROR/Exception entries triggered by your requests
— a 200 response with a stacktrace in the logs is still a bug.

### 4.5 Reason about results and auto-fix (with circuit breaker)

---

## Phase 5: Frontend Browser Testing

This phase is **mandatory** when the diff touches frontend files. Skipping it when it's required
turns the final verdict into **FAILED**, not a "skipped" pass. The browser is the only place we
observe what the user actually sees — assumed-working UI based on unit tests has burned us before.

### 5.1 Decide if browser testing is required

Run `git diff` (against the phase's baseline — `HEAD~N`, main, or the commit feature-dev started
from) and check for frontend changes:

- **File extensions:** `.tsx`, `.jsx`, `.ts`/`.js` in frontend dirs, `.vue`, `.svelte`,
  `.html`, `.css`, `.scss`
- **Directories:** `web/`, `frontend/`, `client/`, `ui/`, `app/`, or whatever CLAUDE.md
  identifies as the frontend root
- **Indirect:** backend changes that alter response shapes, add fields, or change error
  payloads — these change what the UI sees, so existing flows need re-verification

> **Reasoning:** Frontend file changes: [list / none]. UI-affecting backend changes: [list / none].
> Decision: browser testing is [REQUIRED / not applicable because ...].

**If REQUIRED and you cannot complete it** — chrome-devtools MCP unavailable, login impossible,
page crashes prevent flow — the phase verdict is **FAILED**. Surface the blocker clearly in
Phase 6, do not paper over it.

### 5.2 Start the frontend

Read CLAUDE.md (Phase 0.5 notes) for the frontend startup command. It may be a separate
`./frontend.sh start`, a workspace target, or the same `./server.sh` if the project bundles both.

Verify it's serving: navigate to the dev URL and confirm the page loads (no white screen, no
404). Check the browser console for errors.

### 5.3 Discover login credentials

Look in this order — first hit wins:

1. **`CLAUDE.md` → `## Test Credentials` section** — the preferred location, documents login
   URL, user, password, tenant (if multi-tenant), and a success indicator. Check project-level
   then user-level `~/.claude/CLAUDE.md`.
2. **Project env files** — whichever the project actually uses: `.env.local`, `.env.test`,
   `.env.development`, `.env`, or a custom name referenced from `application.yml` /
   `package.json` / etc. Look for `TEST_USER`, `TEST_PASSWORD`, `LOGIN_*`, `DEV_USER`,
   `ADMIN_*` patterns.
3. **Seed scripts** — `db/seed*`, `prisma/seed.*`, `migrations/seed*`, `dev-scripts/seed*`,
   Flyway `R__seed*.sql` — often define a default admin user
4. **Existing e2e/integration tests** — login helpers usually hardcode a test user
5. **Ask the user** — if all four failed, ask once for credentials. Then offer:
   *"Want me to add a `## Test Credentials` section to CLAUDE.md so future runs find these
   automatically? I'll reference the env file you already use rather than creating a new one."*

> **Reasoning:** Searched [locations]. Found credentials at [location]: user=[user].
> Login URL: [url]. Success indicator: [URL changes to / element appears].

### 5.4 Plan and execute login

Plan the steps before clicking — login flow is one of the most error-prone parts because
selectors vary and SPAs may have client-side routing that needs a wait.

Plan:
1. Navigate to login URL
2. Identify input selectors (email/username field, password field, submit button) via
   `take_snapshot` first — don't guess
3. Fill credentials with `fill` or `fill_form`
4. Click submit
5. Wait for the success indicator — URL change, authenticated-only element appearing, or login
   form disappearing
6. Screenshot the post-login state

If login fails — wrong creds, server error, captcha, MFA — **stop and surface clearly**. Do not
attempt feature tests as an unauthenticated user (you'll just be testing redirects to login).
Common fix: re-check credential discovery, re-check that the backend is up and migrations ran
(see Phase 4 logs), re-check that seed data was applied.

### 5.5 Execute feature flows — all permutations

> **Reasoning:** The spec describes these user-facing behaviors for this phase:
> [list from spec]. Testing plan with permutations:
> 1. [flow] — [all permutations]
> 2. [flow] — [all permutations]

For each user flow:

**Before:**
> **Reasoning [Test N]:** Testing [action]. Spec requires [behavior]. Expected: [result].

**Execute (chrome-devtools MCP tools):**
1. `take_snapshot` or `take_screenshot` — initial state
2. `click` / `fill` / `fill_form` — interact
3. `take_screenshot` — result state
4. `list_console_messages` — check for errors (any new ERROR-level message is a fail signal)
5. `list_network_requests` — verify the expected API calls fired with the right payloads and
   got the right status codes

**After:**
> **Reasoning [Test N result]:** Screenshot shows [observation]. Console: [clean / errors].
> Network: [expected calls succeeded / list anomalies]. Verdict: [PASS / FAIL].

### 5.6 Re-check backend logs

Each UI interaction hits the backend. After your flows complete, tail the backend logs again —
a green UI plus a backend stacktrace is still a bug.

---

## Phase 6: Summary Report

> **Final Reasoning:** Phase [N] covers spec sections [list]. Across all test layers,
> I verified [total permutations] against [total spec requirements].
> Fully covered: [N]. Gaps: [list or none]. Backend boot: [clean / failed].
> Browser testing: [required + completed / required + FAILED / not applicable].

```
## Test Results — Phase [N]: [Name]

### Spec Coverage
- Spec sections tested: [list]
- Requirements identified: N
- Requirements with full test coverage: M
- Coverage gaps: [none / list]

### Unit Tests
- Tests run: X passed, Y failed
- Spec requirements covered: [list]

### Integration Tests
- Permutations tested: M of N identified
- Pass: X, Fail: Y

### Backend Boot
- Infra services healthy: [yes / list problems]
- App started: [yes / no]
- Readiness marker observed: [marker / not seen]
- Error/Exception signals since boot: [none / list]

### API Endpoint Tests
- Endpoints: N tested, M permutations
- Backend log re-check after API tests: [clean / errors]

### Frontend / Browser Tests
- Required: [yes / no — reason]
- Frontend started: [yes / no]
- Login: [succeeded via <source> / FAILED — reason]
- Flows tested: N, permutations: M
- Passed: X, Failed: Y
- Backend log re-check after UI tests: [clean / errors]

### Circuit Breaker Activations
- [none / list of areas where 3+ failures triggered diagnosis]

### Verdict
[PHASE FULLY TESTED / NEEDS FIXES / FAILED — browser testing required but not completed]
[What needs attention if fixes needed]
```

**Verdict rules — read carefully:**

- **FULLY TESTED** requires: all spec requirements covered, all tests pass, backend booted
  clean, AND (if frontend changes exist) browser flows completed and passed.
- **FAILED** is the verdict when browser testing was required but didn't complete — regardless
  of how well the backend tests went. Do not soften this to "partially tested" or "skipped".
- **NEEDS FIXES** is for test failures or coverage gaps you've documented but not resolved.
- **The verdict token is mandatory and survives any output format.** Even when an orchestrator imposes its own report shape — and you write "testing node complete" / "feature-test node done" instead of the `### Verdict` block above — you must still emit one of `FULLY TESTED` / `NEEDS FIXES` / `FAILED` verbatim. "Node complete" only says the turn ended; it does not say whether the phase passed. Without the explicit token the orchestrator and the user must infer pass/fail from prose, which is exactly the ambiguity the verdict exists to remove.

Update the todo file with a note that Phase N has been tested (and the verdict).

Tell the user: "Phase [N] verdict: [verdict]. [Next step suggestion.]"

---

## Handling Blockers

Most issues should be fixed, not skipped. Only treat something as a true blocker if it requires external action (infrastructure down, missing credentials the user must provide, MFA on a login, etc.).

If genuinely blocked:
1. Add the blocker as a sub-task
2. Write a `> **Reasoning:**` block explaining what you tried
3. Document what the user needs to do manually
4. Move on to the next phase where possible
5. Note the gap in the summary — and if the blocker was on a *required* browser test, the
   verdict is FAILED

---

## Important Guidelines

- **Spec is the source of truth** — test what the spec requires, not just what the diff shows
- **Use prescribed commands** — read CLAUDE.md, never invent server/infra/test commands
- **Boot is a gate** — passing tests against an app that won't start cleanly is a lie
- **Frontend changes → browser tests, full stop** — skipping = FAILED, not "skipped"
- **Login is a planned step** — discover creds, plan the flow, confirm authenticated state
- **Reason before acting** — every phase starts with a `> **Reasoning:**` block
- **Circuit breaker is non-negotiable** — 3 failures → diagnose, not 4th fix attempt
- **Assertions must verify behavior** — not just existence or truthiness
- **Verify side effects** — downstream calls, DB writes, event emissions, not just return values
- **Resource-safe test runs** — use maxWorkers limits, run targeted before full suite
- **Read session notes** — understand what was built before testing from scratch
- **Re-check logs after API and UI flows** — green responses with backend stacktraces are bugs
