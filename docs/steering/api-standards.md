# API standards mapping: session naming and terminal waiting

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
