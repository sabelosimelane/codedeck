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

`GET /api/sessions` adds `worktreePath` to each existing session row. It is the
absolute directory where that session started, or `null` for the project's main
checkout. It does not follow later shell `cd` commands. Older sessions have no
recorded worktree and appear under the main checkout until closed.

The CodeDeck client no longer calls the endpoint below; it creates tasks instead (see
**Tasks**). The endpoint is kept for older clients.

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
and `client/src/components/__tests__/TerminalAreaWorktree.test.jsx` (now the New task flow).

## Tasks

All paths are under `/api/tasks`; the router owns a 4 KB JSON parser. Errors are RFC 9457
problem documents with `message`, field `errors` on 400, `traceId` and a matching
`X-Trace-Id`. A refused landing action (409) may add `reasons` (`[{code, message}]`) or
`conflicts` (file paths). Unknown body and query fields are 400.

A task is `{id, project, title, state, worktreePath, branch, baseBranch, baseCommit, prUrl,
revision, createdAt, updatedAt, finishedAt, folder, worktrees}`. `state` is `active`, `pr_open`,
`merged` or `closed`; `baseBranch` is null for a task started from a detached checkout.
`worktrees` has one entry per repository of the task, the one it started in first:
`{id, repository, own, first, worktreePath, branch, baseBranch, baseCommit, state, prUrl}`.
The task's own `worktreePath`, `branch`, `baseBranch`, `baseCommit` and `prUrl` are those of that
first entry and stay for clients that read only them. `folder` is the folder that holds the
task's worktrees, or null when each is named on its own.

| Method and path | Contract |
| --- | --- |
| GET `/` | Paginated tasks. Filters `project` (exact), `state`, `open=true\|false` (open is `active` or `pr_open`). Sort `createdAt`, `updatedAt` or `title` with `asc\|desc` (default `createdAt,desc`, id tiebreaker); `size` 1–100, default 20 |
| GET `/changes` | Paginated changes: one per task with at least one merged repository. Filter `project` (exact). Sort `mergedAt` with `asc\|desc` (default `mergedAt,desc`, id tiebreaker); `size` 1–100, default 20. Each is `{id, project, title, mergedAt, workflow, summary, detail, repositories}`: `id` is the task's, `mergedAt` its latest merge, `workflow` the name of the workflow of its most recent run (null without a run), `summary` and `detail` the first line and the whole of the note that run's last agent step last wrote (both null without one), and `repositories` lists the merged ones as `{repository, branch, baseBranch, commit, mergedAt}`, where `commit` is what the checkout stood at after the merge (null for a merge made before it was kept) |
| POST `/` | `{project, title, repositories?}` (title 1–80 characters on one line; `repositories` lists the project's repositories the task includes, the one it starts in first, and defaults to the project's own). Creates one worktree and branch per repository and returns 201 with the task; if a later worktree cannot be created the earlier ones are removed again and the answer is 409 naming the repository. Each request creates a task; 400 for a repository the project does not list, 404 unknown project, 409 remote project or not a Git repository root |
| GET `/:id` | The task; 404 when unknown |
| PUT `/:id` | `{title, revision}`; 409 on a stale revision |
| POST `/:id/terminals` | Optional `{worktreeId}`. Opens a terminal in that repository of the task, or in the one the task started in (the oldest still open once that is finished), and returns 201 `{sessionId, taskId, project, worktreeId}`; 400 for a worktree the task does not have, 409 when the task or that repository is finished or its files are gone, 503 when the terminal runtime is unavailable |
| GET `/:id/landing` | Read live from Git: `filesPresent`, `runActive`, `uncommitted` (at most 50 paths) and `uncommittedCount`, `commitsAhead`, `commitsBehind`, `alreadyInBase` (true when the worktree has commits made since the task's `baseCommit` and `commitsAhead` is 0: its work is already in the base branch; false otherwise; null, like the two counts, when the files are gone or the worktree is finished), `ignoredAtRisk` (at most 50 paths of files Git ignores that exist only in the worktree) and `ignoredAtRiskCount`, `main {branch, dirty}`, `remotes [{name, host, tool}]` (`tool` is `gh`, `glab` or null), `prUrl`, and `blockers {commit, merge, pullRequest, close}`, each a list of `{code, message}` that is empty when the action is allowed. With no commit the base lacks, merge and pullRequest carry `already_in_base` when `alreadyInBase` is true and `nothing_to_land` when the task has made no commit |
| POST `/:id/commit` | `{message}` (1–200 characters on one line). Commits every change on the recorded task branch and returns the landing status. A switched or detached worktree returns 409 with `branch_switched` in `reasons` |
| POST `/:id/merge` | No body. Merges the task's branch into its base branch in the project's checkout, removes the worktree and deletes the merged branch; returns `{task, mergedInto, filesRemoved, filesDetail, branchDeleted, terminalsClosed, terminalsNotClosed}` (the last two are session ids: the task's terminals that were closed, and those that could not be). 409 with `reasons`, or with `conflicts` after an aborted merge |
| POST `/:id/pull-request` | `{remote}`. Pushes the branch and opens a pull or merge request with `gh` or `glab`; returns `{task, prUrl, remote}` and the task becomes `pr_open`. 409 when the host is unsupported or its CLI is missing, 503 when the push or the request fails |
| POST `/:id/close` | No body, or `{deleteIgnored}` (true or false; 400 otherwise). Checks every open repository before removing any worktree. With `deleteIgnored: true` the blocker `ignored_files` no longer refuses and those files are deleted with each folder; every other blocker still refuses. Removes each clean worktree and keeps its branch; returns `{task, branchKept, unmergedCommits, repositories [{repository, branchKept, unmergedCommits}], taskFinished, folderRemoved?, terminalsClosed, terminalsNotClosed}`. 409 with `reasons` when preflight refuses. If a later repository removal fails after earlier ones closed, 409 names the repositories already closed and includes `partialClose {terminalsClosed, terminalsNotClosed}` |
| POST `/:id/worktrees` | Gives an open task one more repository; exactly one of `{repository}` (one of the project's, by name), `{path}` (the absolute folder a repository the project does not list is checked out in) or `{worktreePath}` (the absolute path of a worktree that already exists). The first two create a worktree on the task's branch from that checkout's current commit; `worktreePath` records the worktree as it is and only reads Git. `path` and `worktreePath` join this task only and never change the project's list. Returns 201 with the task. 400 with field errors for a missing, relative or over-long path (1–1024 characters), a folder that does not exist or is not the top level of a Git working tree, more than one of the three fields, or an unknown field; 409 when the repository is or was part of the task, its name is one the project already uses, a run is working in the task, the worktree belongs to a task or a run, has no branch, or its repository has no base branch checked out |
| GET `/:id/worktrees` | Paginated. How each repository of the task stands: the fields of `/:id/landing` plus `worktreeId`, `repository`, `own`, `first` and `worktreePath`. Sort `repository` with `asc\|desc` (default `repository,asc`, worktree id tiebreaker); `size` 1–100, default 20 |
| POST `/:id/worktrees/:worktreeId/commit` | `{message}`. Commits that repository's changes on its recorded task branch and returns how it stands. A switched or detached worktree returns 409 with `branch_switched` in `reasons` |
| POST `/:id/worktrees/:worktreeId/merge` | No body. Merges that repository's branch into its base branch in the checkout the repository is listed with; returns the merge fields plus `repository` and `taskFinished`. The task stays open while another repository is |
| POST `/:id/worktrees/:worktreeId/pull-request` | `{remote}`, one of that repository's remotes; returns `{task, repository, prUrl, remote}` |
| POST `/:id/worktrees/:worktreeId/close` | No body, or `{deleteIgnored}` as for `/:id/close`. Closes that repository of the task; returns `{task, repository, branchKept, unmergedCommits, taskFinished, terminalsClosed, terminalsNotClosed}` |

The task-level `/:id/landing`, `/commit`, `/merge` and `/pull-request` act on the worktree the task
started in. An unknown `worktreeId` is 404.

The pull-request action calls a remote host with explicit timeouts (90 seconds for the push
and for the request) and reports failure as 503. It has no circuit breaker: it is a single
owner-initiated action, not a path other requests depend on.

Coverage: `server/__tests__/task-store.test.js`, `task-service.test.js`, `task-landing.test.js`
(real throwaway repositories), `task-adoption.test.js`, `tasks-api.test.js`, and
`client/src/utils/__tests__/tasksApi.test.js`.

## Project repositories

A project's own repository is its `path`; the others are a list in CodeDeck's configuration,
returned on each project of `GET /api/projects` as `repositories: [{name, path}]`. Paths are
under `/api/projects/:name`; the router owns a 4 KB JSON parser. Errors are RFC 9457 problem
documents with `message`, field `errors` on 400, `traceId` and a matching `X-Trace-Id`; a
refused request is logged once with its route and field names. Unknown body and query fields
are 400. All four answer 404 for an unknown project and 409 for a project on another host.

| Method and path | Contract |
| --- | --- |
| GET `/repositories` | Paginated. The own repository (`own: true`) and the others, each `{name, path, own, branch, head, dirty, usable, reason}` read from Git now; `usable` is false with `reason {code, message}` (and null `branch`, `head`, `dirty`) when the folder is not the top level of a Git working tree. Sort `name` with `asc\|desc` (default `name,asc`, path tiebreaker); `size` 1–100, default 20 |
| GET `/repository-candidates` | Paginated `{name, path, branch}`: Git repositories that are direct children of the own repository's parent folder and not listed yet, each with the branch its folder is on (`null` when none is checked out); the folder `worktrees` and hidden folders are skipped. Same sort and sizes. 409 when the project's own folder is not a repository |
| POST `/repositories` | `{path}`: an absolute path, at most 1024 characters, of a folder that is the top level of a Git working tree (it may be a worktree that holds the repository's main branch). The entry is named after the repository's own folder. Returns 201 with the entry. 409 for a repository already listed, a name already used, or more than 8 others. The same request twice stores one entry and answers 409 to the second |
| DELETE `/repositories/:repository` | Removes the entry by name and returns 204; the folder is not touched. 404 when the project does not list it |
| POST `/terminals` | `{repository}`, the name of the project's own repository or of one it lists. Opens a terminal in that repository's own checkout and returns 201 `{sessionId, project, repository, path}`. Each request opens a terminal. 400 for a name the project does not have, 409 when that folder is no longer a Git working tree, 503 when the terminal runtime is unavailable |

Coverage: `server/__tests__/project-repositories.test.js` and `project-repositories-api.test.js`
(real throwaway repositories), `client/src/utils/__tests__/projectRepositoriesApi.test.js`,
`client/src/components/__tests__/ProjectRepositoriesDialog.test.jsx`.

## Assistant

`GET /api/projects/:name/situation` returns one bounded, read-only situation document for a
local project. It accepts no query parameters. The response has `project`, `generatedAt`,
`repositories`, open tasks (`active`/`pr_open`) with their worktrees and open runs,
`todos`, `specifications`,
`skipped`, ordered `flags`, `truncated`, and an agent-readable `markdown` rendering. Dirty
paths are limited to 50 per repository; todo and specification files are limited to the
last 50 by file name per location. Files over 512 KiB appear in `skipped` with their size.
Every repository has `usable`; one the repository service cannot read as a Git working tree is `{name, own, path, usable: false, reason: {code, message}}` and no Git command runs in it. A readable repository also has `strayFiles` (untracked names that are blank or only whitespace, backslashes and escape letters). Dirty and untracked paths are kept untrimmed, so a file named `" "` is a valid path. A run whose progress file is missing or unreadable has `progress` with null `phaseCount`, `tasksDone` and `tasksTotal`. Missing locations report `missing: true`. Todos are keyed by repository and path. A task copy
identical in content to its repository's Main copy appears in Main's `alsoIn`; a changed copy is
listed separately. Run status passes through as `complete`.

The endpoint returns 404 for an unknown project, 409 for a remote project, and 400 with
field `errors` for any query parameter or invalid project name. Every response has
`X-Trace-Id`; errors are RFC 9457 `application/problem+json` documents with `timestamp`,
`status`, `error`, `message`, `path`, and `traceId`.

Coverage: `server/__tests__/assistant-*.test.js`, `client/src/utils/assistantApi.test.js`,
`client/src/components/assistant/AssistantPanel.test.jsx`, and
`client/src/components/assistant/AssistantChat.test.jsx`.

Phase 2 adds `GET /api/assistant/conversations/current?project=` (creates the current
conversation if absent), `POST /api/assistant/conversations` with `{project}` (ends the
old current conversation and creates another, 201), and paginated
`GET /api/assistant/conversations/:id/messages`. Messages use zero-based `page`,
`size` 1–100 (default 20), and `sort=createdAt,asc|desc` (default ascending),
with message ID as the stable tiebreaker. The response uses `{data,page}`.
Unknown body/query fields, malformed JSON, and invalid paging return 400 with field
`errors`; the router owns a 4 KB parser and returns 413 for a larger body. Unknown projects/conversations return 404,
and remote projects return 409. All responses carry `X-Trace-Id`; errors are
RFC 9457 problems with the matching `traceId`. SQLite permits one current
conversation per project and never edits or deletes messages.

`/ws/assistant?project=` uses exactly the same private access rules as
`/ws/terminal`: an allowed local or owner Serve origin and loopback connection are
required for an upgrade. Other upgrade paths are refused. Missing or malformed,
unknown, and remote projects close with 4400, 4404, and 4409 respectively;
a bridge start failure sends `spawn_error` then closes with 1011. One socket and ACP child may run per project; a new socket ends the
older one. Owner messages are saved before `session/prompt`, agent text once at
turn end, and each tool call once when it finishes or the turn ends, using its
latest title, status, and execute command summary. The browser reloads the paginated transcript
before opening the socket. The new agent session sends a restart notice when
that transcript already contains messages. Phase 2 uses ACP v1 as negotiated
by the pinned `claude-agent-acp` 0.106.0 adapter; MCP and assistant briefing
are introduced in Phase 3.
After `session/new`, the bridge requires the v1 `default` mode and successfully
calls `session/set_mode` before sending `ready` or accepting prompts. It closes
with `spawn_error` if the mode is unavailable or cannot be set. A later mode
change away from `default` blocks prompts until the bridge restores it.
ACP notifications whose method begins with `_` are extension notifications and
are ignored. Other unknown methods produce an `error` frame.

Browser to server frames are JSON objects with only these fields:

| Type | Fields |
| --- | --- |
| `prompt` | `text`: 1–20,000 characters |
| `cancel` | No other fields; valid only during a running turn |
| `permission_response` | `requestId`: pending ACP string or integer ID; `outcome`: `{outcome:'cancelled'}` or `{outcome:'selected', optionId}` where `optionId` belongs to that request |

Server to browser frames are:

| Type | Fields |
| --- | --- |
| `ready` | `conversationId`: UUID; `restarted`: boolean |
| `notice` | `message`: text; `messageId`: stored positive integer ID (reserved for compatibility; current notices use `message`) |
| `message` | `message`: persisted `{id, conversationId, role, content, toolName, proposalId, createdAt}` |
| `update` | `update`: ACP session update with `sessionUpdate` and its type-specific fields; text chunks carry `content:{type:'text',text}`, tool calls carry `toolCallId` and `title` |
| `auth` | `state`: `authenticated` or `unauthenticated`; `label`: active account label or `null` |
| `permission_request` | `requestId`: ACP string or integer ID; `toolCall`: ACP tool call including `toolCallId` and `title`; `options`: ACP `{optionId,name,kind}` list |
| `turn_end` | `messageId`: saved agent message ID, or `null` for an empty or failed turn |
| `error` | `message`: recoverable error text; the socket stays open |
| `spawn_error` | `message`: ACP process start failure text; the socket closes |
| `agent_exit` | `code`: integer or `null` after a signal; `signal`: signal name or `null`; `stderrTail`: text; the socket closes |

The bridge stores an owner message before sending the prompt and emits its `message`
frame only after storage succeeds. Notices also use persisted `message` frames.

Phase 3 adds per-session in-memory tokens (32 random bytes, hex, scoped to one project and
conversation, ended when the agent exits or the socket closes) and five token-authorised read
endpoints used by `server/assistant/mcp-server.js` over stdio:

- `GET /api/assistant/sessions/:token/situation` — returns `{project, generatedAt, flags, markdown, truncated, skipped}` for the token's project; no query parameters allowed.
- `GET /api/assistant/sessions/:token/tasks/:taskId/landing` — returns `{taskId, project, worktrees}` for a task of the token's project (404 for another project's task).
- `GET /api/assistant/sessions/:token/todo?location=&path=` — reads a `.md` file directly under `docs/todos/` or `docs/specifications/` inside `main:<repository>` or `task:<taskId>/<worktreeId>`, enforcing `realpath` containment and a 512 KiB limit (413 when exceeded).
- `GET /api/assistant/sessions/:token/runs/:runId/notes?stepIndex=` — returns `{runId, stepIndex, note}` (the latest written note for `stepIndex` 0–32, or `null`) for a run of the token's project.
- `GET /api/assistant/sessions/:token/runs` — paginated (`{data, page}`, `size` 1–100 default 20, `sort=createdAt,asc|desc` default `desc`, optional exact `taskId` UUID filter) scoped to the token's project.

Unknown, malformed, or ended tokens return 401 RFC 9457 problems; validation and path containment
failures return 400 with `errors`; oversized files return 413. On `session/new`, the ACP bridge
passes the `codedeck` stdio MCP server in `mcpServers` and the assistant brief with the current
situation `markdown` in `systemPrompt: {mode: 'append', content: [{type: 'text', text}]}`,
storing and emitting the briefed notice.

Phase 4 adds proposals and approval (`assistant_proposals`, `server/assistant/proposal-store.js`,
`server/assistant/proposal-payloads.js`, `server/assistant/proposal-executor.js`):

- `POST /api/assistant/sessions/:token/proposals` — `{kind, payload, summary, reason}` (16 KB JSON limit). Validates all fields per kind (`commit`, `merge`, `pull_request`, `close`, `new_task`, `start_run`), rejecting tasks of other projects, unknown worktrees, `deleteIgnored`, and over-long fields with 400 and all field `errors`. Returns 201 with the pending proposal, 401 for an invalid/ended token, or 409 when the conversation already has 10 pending proposals.
- `GET /api/assistant/proposals` — Paginated (`{data, page}`, `size` 1–100 default 20, `sort=createdAt,asc|desc` default `desc`). Requires exact `project` filter (400/404/409); optional `conversationId` UUID and `state` filters.
- `GET /api/assistant/proposals/:id` — Returns one proposal (200), 400 for a malformed UUID, or 404 when unknown.
- `POST /api/assistant/proposals/:id/approve` — Empty body only (4 KB JSON limit). Atomically transitions `pending → approved`, executes the matching CodeDeck service directly (using the proposal id as `requestId` for `start_run` and never passing `deleteIgnored: true` on `close`), and sets `done` (200) or `failed` (409 with `reasons`/`conflicts` and `proposal`, or 500 on unexpected error). Concurrent approvals execute the service once; the loser gets 409.
- `POST /api/assistant/proposals/:id/decline` — Empty body only. Transitions `pending → declined` without calling any service (200; 409 if already decided; 404 if unknown).
- `POST /api/assistant/conversations` expires all pending proposals of the ended conversation and revokes its session tokens.
- MCP adds `propose_commit`, `propose_merge`, `propose_pull_request`, `propose_close`, `propose_new_task`, and `propose_start_run`. Decisions since the previous prompt are prefixed to the next `session/prompt` as `[CodeDeck] Proposal <id> (<kind>): <state> — <one-line result>`. The WebSocket pushes `{type: 'proposal', proposal}` and refreshed `{type: 'situation', flags}` frames to the panel.

## Workflow pipelines

All paths below are under `/api/pipelines`; the router owns a 512 KB JSON parser.
`POST /runs` also accepts `multipart/form-data` with one JSON `run` part (same 512 KB
bound) and 1–20 ordered `files` parts (20 MiB each, 100 MiB aggregate, 101 MiB total
with framing). Errors are RFC 9457 problem documents with `message`, field `errors`
when applicable (including indexed `files[n]`), `traceId`, and matching `X-Trace-Id`.
Lists use the pagination envelope above and a stable identity tiebreaker; unknown
filters and sorts are rejected.

| Method and path | Contract |
| --- | --- |
| GET/POST `/agents`, GET/PUT/DELETE `/agents/:id` | Named launch/reset definitions; PUT requires revision; referenced agents cannot be deleted |
| GET/POST `/teams`, GET/PUT/DELETE `/teams/:id` | A team has a name and 1–32 members with a unique case-insensitive role, a saved `agentId`, an optional distinct saved `fallbackAgentId`, an optional `effort` for the primary, and an optional `fallbackEffort` for a selected fallback. Each effort must be a 1–16 character single-line string supported by the assigned agent's launch preset. PUT requires revision. Omitting an optional assignment field on an existing role preserves it. Send null on PUT to clear an effort override. Clearing the fallback agent also removes its effort. Responses omit unset fields. List supports exact `name` and sorting by name or update time. Deleting an agent referenced as a primary or fallback returns 409. |
| GET/POST `/workflows`, GET/PUT/DELETE `/workflows/:id` | Optional `kind` (`build`, `bugfix`, `troubleshoot`, `review`, `other`; default `other`) and `description` (up to 280 characters on one line); each node may name a `role` (up to 32 characters). An explicit `agentId: null` with a role defers assignment until launch. Named ordered nodes, agent references, prompt and repeat rules (`once`, `until_complete` with `max`, or `loop_back` with `to` — the name of an earlier node — and `max` rounds; loops may not share a node) and `agentsDecide` (boolean, required); optional per-node booleans `readOnly`, `approval` and `askOwner` (the step's questions always go to the owner, also when agents decide) default to false; `approval: true` is invalid on a loop-closing node; optional `progressFile` is null or a 1–300 character relative POSIX Markdown path inside the run worktree; PUT requires revision |
| GET/POST `/templates`, GET/PUT/DELETE `/templates/:id` | Owner-saved workflow templates: a workflow body whose nodes name no `agentId` (naming one is 400). Same list, revision and name-conflict rules as workflows |
| GET/POST `/step-presets`, GET/PUT/DELETE `/step-presets/:id` | Owner-saved steps: `{name, role?, prompt, repeat, readOnly?, approval?}` with optional `askOwner` and `repeat` `once` or `until_complete`; `loop_back` is 400 |
| POST `/prompt-previews` | `{workflow, nodeIndex, input}` with `workflow` in template form (no agents). Returns 200 `{stepName, prompt, placeholders, skillRewrite}`: the prompt a run would send for that node, with placeholders for the task's folder, the run notes folder and the pass identifier. Saves nothing |
| POST `/run-plans` | `{workflowId, project, input}` (input 1–4096 characters; CRLF and CR become LF. When the workflow's Progress file uses `{input}` the input names a path and must be one line without control characters; otherwise it may hold line breaks but no other control characters). Returns 200 `{progressFile, input, foundIn, problem, repositories}` and saves nothing: `progressFile` is the path the input names (`null` when the workflow has no Progress file or the input completes no `.md` path), `input` what a run would be recorded with, `foundIn` the repository of the project whose current commit holds that file (`null` when none does). `repositories` is `null`, or what the file's `**Repositories**:` line asks for, one `{repository, role, todo, input, listed, present}` each: `role` is `this`, `minor` or `todo`; `todo` and `input` are another repository's own todo and the input a run takes for it (`input` is `null` when its path does not fit the workflow's Progress file); `listed` says whether the project lists that repository; `present` whether that todo is committed there (`null` when not applicable). A line that cannot be read, or that puts the todo in another repository than it was found in, is `problem` with `repositories` `null`. 404 unknown workflow or project; 409 with `reasons` when the project cannot take a run |
| GET/PUT `/settings` | `{setupAgentId, defaultBaseBranch, timeouts, revision}`. `timeouts` is required on PUT, with every field an integer in range: `agentReadySeconds` 10–3600, `resetSettleSeconds` 5–600, `finalSignalIdleSeconds` 5–600, `lostPromptSeconds` 5–600, `stallWarningMinutes` 1–240 (defaults 120, 15, 24, 30, 15). A missing, unknown or out-of-range field is 400 with a field error naming `timeouts.<field>`; a stale `revision` is 409. Runs read the values while they work, so a change applies to the next poll, reset or handoff |
| GET `/preflight?project=...` | Eligibility reasons and dirty-checkout warning for a local Git repository root |
| GET `/worktrees?project=...` | Paginated working trees of the project's repository (sort `path,asc\|desc`); each says whether a run may use it and why not |
| POST `/runs` | JSON body or multipart (`run` JSON part plus `files`). `requestId` (1–128 letters, digits, underscores or hyphens), workflow, project and input. `input` is 0–4096 characters with CRLF and CR normalized to LF: one line without control characters when the workflow's Progress file uses `{input}`, otherwise descriptive text that may hold line breaks but no other control characters, recorded and sent to the agents as written. Optional attachments are staged server-side; the run view exposes ordered `{ name, path, sizeBytes }` only (no digests or staging paths). Optional `teamId` assigns named roles from the selected team. Roleless steps keep their saved agent. Optional `stepOverrides` maps exact workflow step names to agent IDs for this run. Overrides take precedence. Every step must resolve before launch. The run snapshots the resolved agents and both options participate in request replay. Workflow and task IDs are UUIDs. Where the run works is at most one of: `taskId` (an open task of that project: 404 unknown, 400 another project's, 409 finished, files gone or in use; no Setup), `newTask` (a task is created for the run only after every other check passed; the run starts with Setup and needs a setup agent. `{title}` is a title the owner typed, 1–80 characters on one line, and is never replaced. `{}` has the task called after the first 80 characters of the input and named later from the run's first step note by the session-naming CLI; a `title` that is present but blank is 400), or `worktreePath` of an existing worktree (404 unknown, 409 missing, unreadable by git, detached or in use). With none of them the run gets a worktree of its own that it removes when it completes, as before. A run never removes a task's worktree; snapshots definitions with `notesDir`; 400 on `input` when a configured progress file is absent from the repository's current commit or the chosen worktree. An `input` that is the progress file's whole path is accepted when the file as composed is absent and that path is present (`docs/{input}` with `docs/todos/x.md`): the run is then recorded with the part that replaces `{input}` (`todos/x.md`), which is the `input` the response returns; the refusal names both paths when neither is present. The `requestId` stays recorded with the input as sent; 400 on `project` when step guidance exceeds 4,000 characters; requestId replay is idempotent and conflicting reuse is 409. `startIn` (with `taskId` or `newTask`) names the repository of the task the run starts in: its working directory, and where its notes and progress file are; `newTask.repositories` lists the project's repositories a new task includes (1–9 names; `startIn`, when given, must be one of them and comes first). A `worktreePath` may also be the own checkout of one of the project's listed repositories. A task takes one unfinished run: a second start is 409 with reason `task_in_use`. The progress file of a new task is looked for in the checkout of the repository the run starts in. `startIn` and `newTask.repositories` are part of what a `requestId` is recorded with: a replay that changes either is 409 |
| GET `/runs`, GET `/runs/:id` | `taskId` (null outside a task); `attachments` (ordered `{ name, path, sizeBytes }`, empty when none); `team` (`{ name, changed }`, or null for a run with no team: the team the run started with or was last given, `changed` once its lineup was changed after the start; a label only, separate from team scoring); persisted progress, steps (including `role`, `readOnly`, `approval`, and a looping step's `repeat.toStepIndex` and `roundsCompleted`, and `elapsedMs`, the milliseconds the step has worked over all its rounds and attempts), worktree state, allowed actions including `approve` and `sendBack`, `agentsDecide`, `decisionCount`, `notesDir`, and per-step `notePath` and latest `note`; `approvalRequest` is null except in `awaiting_approval`, when it contains `stepIndex`, `stepName`, and the latest note; `progress` is null or `{file, status, phaseCount, phase, tasksDone, tasksTotal}` (the last two count every phase, or are null) with status `in_progress`, `all_done`, `no_phases`, `missing`, or `unreadable`. A run started without a progress file follows the workflow's current setting; if its input does not compose a valid path, `progress` is null |

A matching start replay returns 200 with the same run, even after its task is renamed. The
comparison uses the original workflow, project, input, and place selector, with a typed title
trimmed. Changed parameters or reuse of an ID that predates start reservations returns 409.
A matching replay of an interrupted start can finish provisioning using its recorded open task.

A step the owner continued past its limit has status `limit_accepted`. With a queued agent on that step, Continue dispatches it on the selected agent as a new attempt. With no configured Progress file, a run's optional notes `plan.md` is read; a missing plan or one with no phase sections returns `progress: null`, while an unreadable plan retains its status. Configured files retain all existing statuses.
`stopReason` also accepts `no_progress` when a looping run stops after two rounds without a newly ticked task. The run remains `stopped` and offers `resume` and `cleanup`.
| GET `/runs/:id/decisions` | Paginated requests the run's agents settled themselves: step, pass, the questions listed, whether that list was cut, and the answer typed. Sort `createdAt,asc\|desc` (default `asc`); optional exact `stepIndex` filter; 404 for an unknown run |
| GET `/runs/:id/answers` | Paginated answers the owner gave when an agent asked: step, pass, the questions listed (null when the agent listed none) and the answer. Sort `createdAt,asc\|desc` (default `asc`); optional exact `stepIndex` filter; 404 for an unknown run |
| GET `/runs/:id/reviews` | Paginated owner reviews: step, attempt, `verdict` (`approved` or `sent_back`) and the send-back comment. Sort `createdAt,asc\|desc` (default `asc`); optional exact `stepIndex` filter; 404 for an unknown run |
| GET `/runs/:id/notes` | Paginated append-only notes: step, attempt, pass, status, summary and written content. Sort `createdAt,asc\|desc` (default `asc`, id tiebreaker); optional exact `stepIndex` filter; 404 for an unknown run |
| POST `/runs/:id/stop` | Stop automation; repeated Stop is idempotent |
| PUT `/runs/:id/team` | Send `expectedUpdatedAt` and one saved agent in `stepOverrides` to change an eligible node of an active run. Pending nodes use it on dispatch. An open pass keeps its agent and a completed node eligible for another round queues the choice until it is revisited. The run view reports the effective `agentId`/`agentName` and any queued `nextAgentId`/`nextAgentName`. Malformed or invalid fields return 400, a missing run returns 404, and stale requests or active bulk/team edits return 409. Resumable runs still accept `teamId`, multiple overrides, or both. Assignments apply to the run and mark its existing team label changed. |
| POST `/runs/:id/resume` | Fresh attempt; refuses a missing worktree |
| POST `/runs/:id/continue` | Advance from a pass-limit pause |
| POST `/runs/:id/answer` | Body `{ answer }` (1–4000 characters; new lines allowed, other control characters refused). Types the answer into the terminal of an agent that signalled NEEDS_INPUT and returns the run; 409 when the run is not waiting on such a request, the agent has stopped waiting, or another answer is being sent |
| POST `/runs/:id/approve` | Empty body or `{}`; append an approval review and advance the waiting run. Unknown fields are 400, unknown run is 404, and a run outside `awaiting_approval` is 409 |
| POST `/runs/:id/send-back` | Body `{ comment }` (1–4000 characters; new lines allowed, other control characters refused); append a send-back review and rerun the same step with a feedback file. Unknown fields are 400, unknown run is 404, and a run outside `awaiting_approval` is 409 |
| POST `/runs/:id/cleanup` | Close run. Remove a clean worktree without force; retain branch. For a run in an existing worktree it releases the worktree and removes nothing. Then closes the terminals the run's steps used, unless the run is still open because its worktree could not be removed. Returns the run with `terminalsClosed` and `terminalsNotClosed` (session ids); a terminal that could not be closed does not fail the request. A second call is 409 |

Agents/workflows filter by exact `name`, and runs by `status`, `project`,
`workflowId`, `taskId`, or `open=true|false`. A run is open until it is closed: a complete run
stays open while it sits finished in a task or in Main (worktree `external`), until the owner
closes it, another run starts in that worktree, or its task is finished. A complete run never
makes its worktree `in_use`. The task view filters by project; sidebar counts
page through all open runs. Definition conflicts and disallowed run actions return
409. Missing records return 404. Setup's clean-worktree guard and blocked cleanup
are represented in the returned run; clients must inspect run status even on HTTP 200.

Coverage: `server/__tests__/pipelines-api.test.js`, `pipeline-run-progress.test.js`, `pipeline-run-notes.test.js`, `pipeline-note-store.test.js`, `pipeline-review-store.test.js`, `pipeline-run-engine.test.js`,
`pipeline-run-store.test.js`, and client pipeline settings, run-hook and sidebar tests.

## Team improvements

CodeDeck serves these resources under `/api/pipelines/improvements/teams`. List responses use the shared pagination envelope, zero-based pages, size 1–100 (default 20), and the record ID as the stable sort tiebreaker. Invalid filters and sorts return a traced 400 problem detail.

| Resource | Contract |
| --- | --- |
| GET /scorecards | Scores grouped by team configuration and policy version. Filter by teamId and sort by name. Metric values can be null. |
| GET /runs | Attributed run summaries including mixed assignments. Filter by teamId or cardId and sort by at. |
| GET /runs/:id | Request, criteria, evidence excerpts, correction revision, delivery signature, and executed assignments. An unattributed or missing run returns 404. |
| GET /runs/:id/history | Page through the saved reviewer assessments and owner corrections, sorted by at. |
| POST /runs/:id/corrections | Supply the reviewed signature and revision, criterion text, verdict, and reason. A concurrent correction or changed delivery returns 409. |
| GET /trials | Recommendations, assignment progress, observed results and approval-time results. Filter by teamId and sort by at. |
| POST /trials/:id/decision | Supply revision and one of start, dismiss, stop, or adopt. Stale decisions return 409. Start enrolls up to five matching future runs. Adoption changes one saved team role. |
