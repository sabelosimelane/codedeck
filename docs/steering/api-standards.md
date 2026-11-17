# API standards mapping: session naming and terminal waiting

## Android companion

`/api/mobile/v1` implements capabilities, projects, sessions, device registration,
test notifications and private event resolution. Collections use the pagination
envelope below. Projects filter by `name` and sort by `name`/`id`; sessions filter
by `id`/`projectId`/`status` and sort by `title`/`id`/`status`. Every sort appends
`id`; unknown query fields fail with 400. The router owns its 12 KB JSON parser.
Errors use `server/mobile-access.js` Problem Details with field errors and trace IDs.
Device PUT is idempotent by installation UUID; DELETE returns 204, including repeated
deletion. Test notification POST returns 202 for a new identifiable test event,
409 for disabled permission/token, 503 when FCM is unconfigured, 404 for unknown installation.
Events carry epoch-millisecond `createdAt`; test events have null session identities.
Session `cwd` may be null when unavailable. No token appears in device API responses.
HTTP and WebSocket upgrades share loopback/owner/origin authorization.
FCM sends use opossum with explicit timeout and persistent retry/expiry; failure
does not block terminal traffic. See `docs/android-companion.md` for setup and gates.

The global API rules are mapped here for the `/api/session-naming` and
`/api/terminal-waiting` routes. Existing unrelated endpoints are outside these
features' migration scope.

| Method and path | Contract |
| --- | --- |
| GET `/settings` | Saved URL/provider/model/effort and `hasCredential`; never the credential |
| PUT `/settings` | Validate all settings and exact catalog selection before saving; optional credential replaces the saved credential, null removes it |
| POST `/connection-test` | Test supplied URL/credential; return a five-minute `connectionId` for catalog preview without saving credentials |
| GET `/catalog` | Paginated catalog from saved settings or preview `connectionId`; exact `id`, `enabled`, `available` filters; sort `id` |
| GET `/titles` | Paginated metadata; exact `sessionId`, `state` filters; sort `sessionId`, `title`, or `state` |
| PUT `/titles/:sessionId` | Manual title, 1–60 characters on one line; revision increments and defeats delayed generation |
| POST `/titles/:sessionId/retry` | `202 Accepted`; enqueue fresh capture for failed naming; repeated queued/generating retry does not duplicate work |
| GET `/health` | Conduit catalog/generation circuit state and success/failure counters |

Collections use zero-based `page` (default 0), `size` (default 20, maximum 100), and
`sort=field,asc` or `sort=field,desc`. Identity is the stable tiebreaker. Responses contain
`data` and `page: {currentPage, size, totalElements, totalPages, hasNextPage}`.
Unconfigured connections return 409. Missing sessions/previews return 404.

`server/routes/session-naming.js` owns a shared Problem Details handler for these routes,
including malformed JSON and the 16 KB request limit. All errors carry RFC 9457 fields
plus `timestamp`, `error`, `message`, `path`, and `traceId`. Validation errors include
field-level `errors`; `X-Trace-Id` matches safe request logs. Dependency failures return
503 and `Retry-After: 30`. Credentials, request bodies, and terminal excerpts are not logged.

External calls use opossum, explicit timeouts (catalog 15 seconds, generation 65 seconds),
a 30-second circuit reset, and a 1 MB response bound. Generation runs in a separate queue
with two concurrent workers and at most 100 waiting jobs. No terminal path awaits Conduit.
The client verifies returned provider/model against the explicit selection. CodeDeck never
chooses another provider or model. Conduit must permit that selection; its own routing is
outside CodeDeck's control.

SQLite stores only settings and validated title metadata. A separate mode-600 credential
file holds the API key. Restart changes interrupted jobs to retryable failures; retries
capture fresh context. Failures retry every 10 seconds for up to 60 seconds after the first failure, with fresh
context and no overlapping attempts per session. Retry timers are memory-only and are
cancelled on rename, deletion, or shutdown. A later nonempty task submission can rearm
a failed session. Revision checks reject late manual-rename/deletion results.

Coverage: `server/__tests__/session-naming-api.test.js`,
`server/__tests__/session-naming.test.js`, and the terminal status/WebSocket tests.
Run with Node 22: `cd server && npx vitest run --maxWorkers=1`.


## Terminal waiting

| Method and path | Contract |
| --- | --- |
| GET `/api/terminal-waiting` | Paginated waiting marks; exact `sessionId` filter; sort `sessionId` or `waitingAt` |
| PUT `/api/terminal-waiting/:sessionId` | `{waiting: boolean}`; marking is idempotent and keeps the original `waitingAt`; clearing an unmarked session is a no-op 200 |

Paging follows the same contract as above: zero-based `page` (default 0), `size`
(default 20, maximum 100), `sort=field,asc|desc`, with `sessionId` as the stable
tiebreaker. A `PUT` for a session that does not exist returns 404. Errors use the
same RFC 9457 envelope with `timestamp`, `error`, `message`, `path`, and `traceId`,
matched by the `X-Trace-Id` response header; validation failures carry field-level
`errors`. The route owns its JSON parser (4 KB limit) so malformed bodies use the
same handler.

SQLite `terminal_waiting` stores only `session_id` and an ISO-8601 `waiting_at`.
Rows are validated per field on read as well as write. Deleting a terminal session
clears its mark, because session ids are reused and a stale mark would silence a
brand-new terminal.

Coverage: `server/__tests__/terminal-waiting-store.test.js`,
`server/__tests__/terminal-waiting-api.test.js`,
`client/src/utils/__tests__/terminalWaiting.test.js`,
`client/src/hooks/__tests__/useWaitingSessions.test.jsx`,
`client/src/components/__tests__/TerminalAreaWaiting.test.jsx`, and
`client/src/components/__tests__/SidebarWaitingCount.test.jsx`.

## Terminal worktrees

`POST /api/terminal-worktrees` accepts exactly `{project: string, branch: string}` and
returns 201 with `{sessionId, project, branch, worktreePath, baseCommit}`. The project
must be local and its path a Git working tree root. The branch must be new, 1–100
characters, valid as `refs/heads/<branch>`, without a leading dash, whitespace,
control characters, `<`, or `>`. The worktree lives beside the home checkout in
`worktrees/<home-name>-<branch-slug>` and starts from the project's current HEAD.
The endpoint never removes a created worktree, including when terminal start fails.
Concurrent requests are serialized; a repeated branch returns 409.

The router owns a 4 KB JSON parser. Its errors use RFC 9457 Problem Details with
`timestamp`, `status`, `error`, `message`, `path`, `traceId` and a matching
`X-Trace-Id` header. Every 400 includes all failed fields in `errors`; malformed
JSON returns 400, oversized input 413, unknown projects and paths 404, and
conflicts 409. A terminal failure after creation returns 500 or 503 and names the
retained worktree path.

Coverage: `server/__tests__/terminal-worktree-service.test.js`,
`server/__tests__/terminal-worktrees-api.test.js`,
`client/src/utils/__tests__/terminalWorktreesApi.test.js`,
`client/src/components/__tests__/NewWorktreeTerminalDialog.test.jsx`, and
`client/src/components/__tests__/TerminalAreaWorktree.test.jsx`.

## Workflow pipelines

All paths below are under `/api/pipelines`; the router owns a 512 KB JSON parser.
Errors are RFC 9457 problem documents with `message`, field `errors` when applicable,
`traceId`, and matching `X-Trace-Id`. Lists use the pagination envelope above and a
stable identity tiebreaker; unknown filters and sorts are rejected.

| Method and path | Contract |
| --- | --- |
| GET/POST `/agents`, GET/PUT/DELETE `/agents/:id` | Named launch/reset definitions; PUT requires revision; referenced agents cannot be deleted |
| GET/POST `/workflows`, GET/PUT/DELETE `/workflows/:id` | Named ordered nodes, agent references, prompt and repeat rules (`once`, `until_complete` with `max`, or `loop_back` with `to` — the name of an earlier node — and `max` rounds; loops may not share a node) and `agentsDecide` (boolean, required); optional `progressFile` is null or a 1–300 character relative POSIX Markdown path inside the run worktree; PUT requires revision |
| GET/PUT `/settings` | Setup agent selection with revision |
| GET `/preflight?project=...` | Eligibility reasons and dirty-checkout warning for a local Git repository root |
| GET `/worktrees?project=...` | Paginated working trees of the project's repository (sort `path,asc\|desc`); each says whether a run may use it and why not |
| POST `/runs` | Request UUID, workflow, project and input; optional `worktreePath` of an existing worktree (404 unknown, 409 missing, unreadable by git, detached or in use) instead of a new one; snapshots definitions; requestId replay is idempotent and conflicting reuse is 409 |
| GET `/runs`, GET `/runs/:id` | Persisted progress, steps (a looping step's `repeat.toStepIndex` and `roundsCompleted`), worktree state, allowed actions, `agentsDecide` and `decisionCount`; `progress` is null or `{file, status, phaseCount, phase}` with status `in_progress`, `all_done`, `no_phases`, `missing`, or `unreadable` |
| GET `/runs/:id/decisions` | Paginated requests the run's agents settled themselves: step, pass, the questions listed, whether that list was cut, and the answer typed. Sort `createdAt,asc\|desc` (default `asc`); 404 for an unknown run |
| POST `/runs/:id/stop` | Stop automation; repeated Stop is idempotent |
| POST `/runs/:id/resume` | Fresh attempt; refuses a missing worktree |
| POST `/runs/:id/continue` | Advance from a pass-limit pause |
| POST `/runs/:id/answer` | Body `{ answer }` (1–4000 characters; new lines allowed, other control characters refused). Types the answer into the terminal of an agent that signalled NEEDS_INPUT and returns the run; 409 when the run is not waiting on such a request, the agent has stopped waiting, or another answer is being sent |
| POST `/runs/:id/cleanup` | Remove a clean worktree without force; retain branch. For a run in an existing worktree it only releases the worktree |

Agents/workflows filter by exact `name`, and runs by `status`, `project`,
`workflowId`, or `open=true|false`. The runs bar filters by project; sidebar counts
page through all open runs. Definition conflicts and disallowed run actions return
409. Missing records return 404. Setup's clean-worktree guard and blocked cleanup
are represented in the returned run; clients must inspect run status even on HTTP 200.

Coverage: `server/__tests__/pipelines-api.test.js`, `pipeline-run-progress.test.js`, `pipeline-run-engine.test.js`,
`pipeline-run-store.test.js`, and client pipeline settings, run-hook and sidebar tests.
