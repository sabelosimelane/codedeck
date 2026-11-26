# Project Assistant

**Spec**: `docs/specifications/2026-11-25-222214-project-assistant-spec.md`
**Status**: Complete
**Last completed**: Phase 5: Final Verification + Cleanup
**Created**: 2026-11-25

> Working rules for every phase: strict TDD (red test first), Vitest with `--maxWorkers=1`, per-field
> guards on everything crossing an edge, including rows read back from SQLite and every value read
> from Git or the file system. No fallback logic, no silent error swallowing, and toasts for every
> mutating client call.
> Read `docs/steering/api-standards.md` and `~/.claude/standards/api-design.md` before touching an
> endpoint, and add an "Assistant" section to `api-standards.md` as endpoints land.
> Server tests: `cd server && npx vitest run __tests__/<file> --maxWorkers=1`.
> Client tests: `cd client && npx vitest run <path> --maxWorkers=1`.
> Reuse, do not rewrite: `createProjectRepositories().list`, `listDirtyPaths`, `landing.worktrees`,
> the run view builder in `server/routes/pipelines.js`, `parseTodoRepositories`, and
> `collection-query.js`.

## Phase 1: Situation brief and the panel's "Where things stand"
> The riskiest and most useful slice: CodeDeck says, unprompted, what misled the owner.
> **Inputs:** a local project, with its repositories, open tasks, runs and docs.
> **Outputs:** `GET /api/projects/:name/situation`, and a right-hand panel listing the flags.
> **Closed when:** the GRS-shaped fixture produces every flag of Spec §9.2, the endpoint passes the
> six API dimensions, and the panel shows the flags in the browser.

- [x] `server/pipelines/run-progress.js`: `parsePhaseBreakdown(markdown)` returning
  `[{number,title,done,total}]`, and rebuild `parsePhaseProgress` on it (Spec §8.1.5). Existing
  run-progress tests stay green unchanged.
- [x] `server/assistant/todo-docs.js`: list and read `docs/todos/*.md` and
  `docs/specifications/*.md` in one location. Read the title, `**Spec**`/`**Status**`/`**Repositories**`
  lines, `dependsOn` from `>` header notes, phases, and `committed`, with the bounds and
  `skipped`/`truncated` handling (Spec §8.1.4, §8.1.6). Unit tests with fixture markdown, including
  files over 512 KiB and more than 50 files.
- [x] `server/assistant/situation-flags.js`: pure `situationFlags(facts)`, one rule per code, in
  Spec §5.4 order, with messages per §8.2. Exhaustive unit tests, one for each code raised and one
  for it not raised, plus the task-copy-wins rule for a todo found in both Main and a task.
- [x] Export the run view builder from `server/routes/pipelines.js` into a module callable without
  a request; the route keeps its behaviour (Spec §8.1.3). Existing pipelines route tests stay green.
- [x] `server/assistant/situation.js`: the composer over repositories, tasks/landing, runs and docs.
  Include `missing` locations, guards on every field with the id named, read-only (Spec §8.1), and
  `markdown` rendering. Integration test with temporary Git repositories and worktrees shaped like
  Spec §1, asserting every flag in Spec §9.2; a clean project gives no flags (§9.3).
- [x] `server/routes/assistant.js`: GET `/api/projects/:name/situation` with RFC 9457 errors (404,
  409 remote, 400 unknown query). API tests across the six dimensions. Mount it in `server/index.js`.
- [x] Client: `utils/assistantApi.js` `fetchSituation` (validated parse, problem `message` on
  failure); `components/assistant/AssistantPanel.jsx` shell with the header (Spec §8.7.2); top-bar
  toggle and ⌘/Ctrl+⇧L listed in `ShortcutsOverlay.jsx`; open state in `localStorage` with
  try/catch. Component tests: flags rendered, "Nothing needs your attention", failure shown,
  shortcut toggles.
- [x] Check by an agent in the browser against the live GRS project: the header lists the flags of
  Spec §9.2.

## Phase 2: Conversation storage and the chat over ACP (advise only)
> The owner can talk to Claude Code in the panel, and the transcript survives a reload.
> **Inputs:** Phase 1's panel; `server/acp-bridge.js` from `feature/agent-chat-pane` (`13796d5`).
> **Outputs:** `assistant_conversations` and `assistant_messages`, the conversation routes, and
>   `/ws/assistant`.
> **Closed when:** a fake ACP agent round-trips prompts, permissions and turns through the socket;
> messages persist; the panel renders them after a reload.

- [x] `server/assistant/conversation-store.js`: both tables, with the partial unique index on the
  current conversation, writes and hydration guarded per column (Spec §4.1, §4.2). Store tests for
  each bad value failing with the row id and column.
- [x] Routes: GET `/api/assistant/conversations/current`, POST `/api/assistant/conversations`, GET
  `/api/assistant/conversations/:id/messages`, paginated (Spec §6.2). API tests across the six
  dimensions; two concurrent POSTs leave one current conversation.
- [x] Adapt `server/acp-bridge.js` and its test from `13796d5`; use the already pinned
  `@agentclientprotocol/claude-agent-acp@0.106.0` per Spec §8.5.3. Adapt the bridge to persist messages
  (§8.6.2) and to report `ready.restarted` (§8.6.3).
- [x] `server/index.js`: route `/ws/assistant` inside the existing upgrade handler after
  `privateAccess.authorizeUpgrade`, with 4404/4409 closes and one agent per project socket
  (Spec §6.4, §8.5.6). Tests: an unauthorised upgrade is refused like `/ws/terminal`, an unknown
  project gets 4404, and a second socket ends the first with a notice.
- [x] Fake ACP agent test double (JSON-RPC over stdio). Bridge tests for prompt/turn_end storage,
  permission forwarding with the owner's outcome unchanged, spawn_error, and agent_exit
  (Spec §9.13 without MCP).
- [x] Client: use the already pinned `marked` and `dompurify`. Adapt the message, tool-card and permission-card
  rendering from `AgentChatPane.jsx` (`13796d5`) into the panel; load the transcript, open the
  socket, **New conversation** without confirmation in Phase 2, and switch on project change (Spec §8.6, §8.7.3,
  §8.7.6). Component tests with a mocked socket.
  **Fixed (was open, found in the Phase 4 feature test):** an agent turn rendered as an empty bubble
  until a reload. `turn_end` passed `streamRef.current` inside a functional `setMessages` updater,
  which React runs after the handler had already cleared the ref (`AssistantChat.jsx:131`), so the
  stored content was `''`. The content is now captured before `setState`, with a red-then-green
  component test (`AssistantChat.test.jsx` "keeps the agent turn after turn_end instead of an empty
  bubble") and a browser check ("agent turn rendered live after turn_end").
- [x] Check by an agent in the browser: ask a question on a local project, reload, and see the
  transcript and the restart notice.

## Phase 3: CodeDeck read tools and the assistant brief
> The agent answers from the situation instead of guessing.
> **Inputs:** Phase 1's composer, Phase 2's bridge.
> **Outputs:** `server/assistant/mcp-server.js` read tools, session tokens, and the assistant brief
>   as the first prompt.
> **Closed when:** with the fake agent, `session/new` carries the `codedeck` MCP server and the first
> prompt is the brief; each read tool returns real data through its token; a wrong token is refused.

- [x] `server/assistant/session-tokens.js`: make, check and end per-session tokens scoped to one
  conversation's project, held in memory (Spec §8.3.2). Unit tests: a token works only for its own
  project, and an ended token is refused.
- [x] Token-authorised read routes behind the tools: situation, task landing, todo or spec read by
  location and path (with path containment checked against the §8.1.4 locations), run notes, runs
  (Spec §8.3.3). API tests: wrong token 401, a path outside the locations 400, over 512 KiB refused.
- [x] `server/assistant/mcp-server.js` on `@modelcontextprotocol/sdk` with `get_situation`,
  `get_task_landing`, `read_todo`, `read_run_notes` and `list_runs`. Tool errors carry the problem
  `message` (Spec §8.3.6). Tests start it over stdio against a test server.
- [x] Bridge: pass `mcpServers` in `session/new` and send the assistant brief with the situation
  `markdown` as the first prompt, shown as a `notice` (Spec §8.5.2, §8.5.4). Fake-agent tests assert
  both.
- [x] Check by an agent in the browser on GRS: "where am I and what should I do next?" is answered
  with the Phase 2 count, the unfinished todo, the Main blocker and the stray files.

## Phase 4: Proposals and approval (act after asking)
> The agent proposes; nothing happens until the owner approves, and blockers still apply.
> **Inputs:** Phase 3's tools and token.
> **Outputs:** `assistant_proposals`, the propose tools, the proposal routes, and the panel's
>   proposal cards.
> **Closed when:** Spec §9.6–§9.11 pass and a proposal is approved end to end in the browser.

- [x] `server/assistant/proposal-store.js`: the table, a guarded hydration per column including the
  per-kind payload check, and the conditional `pending → approved` update (Spec §4.3, §5.3, §8.4.4).
  Store tests for corrupt rows and the race.
- [x] `server/assistant/proposal-payloads.js`: pure validation per kind (Spec §7.4). It rejects a
  task of another project, an unknown worktree, `deleteIgnored`, and over-long fields, reporting
  every field at once. Exhaustive unit tests.
- [x] `server/assistant/proposal-executor.js`: maps a kind to the service call (Spec §5.2, §8.4),
  with the proposal id as `requestId` for `start_run`, `failed` results carrying `reasons` or
  `conflicts`, and logging without payloads. Integration tests with temporary repositories:
  - commit lands on the task branch only
  - merge with Main dirty fails with `main_dirty`
  - close never deletes ignored files
  - `start_run` replayed starts one run
- [x] Routes: the proposals list, get, approve and decline, plus the token route that creates a
  proposal, with the 10-pending limit (Spec §6.3). Expire pending proposals when a conversation
  ends (§9.11). API tests across the six dimensions, including concurrent approve → one 200 and
  one 409.
- [x] MCP propose tools, and the decision lines prefixed to the next prompt (Spec §8.3.4, §8.3.5).
  Fake-agent test: a proposal is created, decided, and reported on the next prompt.
- [x] Bridge: push `{type:'proposal'}` and refreshed `{type:'situation'}` to the panel
  (Spec §7.5).
- [x] Client: proposal cards with Approve/Decline, an in-flight state, outcome rendering, toasts on
  success and failure with the problem message, and a header refresh after a decision
  (Spec §8.7.4–5). Component tests for each outcome, including network failure.
- [x] Check by an agent in the browser: ask the assistant to commit a task in a scratch project,
  approve, and confirm with `git log main..HEAD` in that task; decline another and see nothing
  change.

## Phase 5: Final Verification + Cleanup
> Local verification only.

- [x] Run the full server suite (`cd server && npx vitest run --maxWorkers=1`) and the full client
  suite; report failures that also fail on `main` separately, unchanged.
- [x] `cd client && npx vite build` succeeds.
- [x] Cross-phase check in the browser: open the panel, read the flags, ask, propose, approve,
  reload, and the transcript and outcome are still there.
- [x] Code review pass over the branch (`/code-review`).
- [x] Update `README.md` (Project Assistant section), `docs/steering/product.md` (feature and
  domain terms), `docs/steering/structure.md` (`server/assistant/`, `components/assistant/`) and
  `docs/steering/api-standards.md` (Assistant).

### Feature test — 2026-11-26 (Phase 5, and the Phase 2 empty-bubble fix)
**Verdict**: COMPLETE. Every task of Phases 1–5 is ticked and the full suites hold except the failures already on `main`.
- **Fixed the reopened Phase 2 defect** (red test first): `AssistantChat.jsx` `turn_end` now captures
  `streamRef.current` before `setMessages` instead of reading the ref inside the updater after it was
  cleared. Test `AssistantChat.test.jsx` "keeps the agent turn after turn_end instead of an empty
  bubble": failed before the change (`findByText(/Phase 2/)` found nothing), passes now.
- **Client assistant tests**: `cd client && npx vitest run src/utils/assistantApi.test.js src/components/assistant/AssistantChat.test.jsx src/components/assistant/AssistantPanel.test.jsx --maxWorkers=1`
  → 3 files / 51 tests passed.
- **Browser cross-phase check** (`.codedeck/runs/8750d349/tmp/phase4/harness.mjs`, extended this pass
  with "agent turn rendered live after turn_end"): isolated HOME, scratch Git project, server on 43231,
  headless Chrome over CDP, real server routes, real MCP token and `mcp-server.js`, fake ACP agent for
  Claude's prose only. **19/19 checks passed**: panel opens and shows the flags without a prompt; the
  agent's turn renders live after `turn_end`; a commit proposal card appears; **Approve** → Done +
  toast, `git log main..HEAD` = `Add notes.txt`, `main` untouched; the decision line is prefixed to the
  next prompt and the dirty-worktree flag disappears; **Decline** → Declined + toast and nothing
  changes; after a reload the transcript and both outcomes come back; backend log clean.
- **Vite build**: `cd client && npx vite build` → succeeded (4.33 s), chunk-size warnings only.
- **Full server suite**: `cd server && npx vitest run --maxWorkers=1` → **4,408 passed, 3 failed, 3 skipped**.
  The 3 failures are on `main`'s baseline, in files and modules this branch does not touch:
  `project-config` "defaults missing shelf and waiting fields…" and "preserves existing waiting metadata"
  (`server/project-config.js` unmodified), and `project-repositories-api` "opens a terminal in the own
  checkout…" (`host: 'local'` was already in `HEAD`'s `server/routes/project-repositories.js:80`, unchanged here).
- **Full client suite**: `cd client && npx vitest run --maxWorkers=1` → **2,076 passed, 14 failed**.
  All 14 are `main`'s baseline in files untouched by this branch: the Sidebar mocks
  (`SidebarPipelineRuns`, `SidebarWaitingCount`: the `lucide-react` mock lacks `Server`) and mobile
  `runsApi` (2). None is in an assistant file.
- **Docs**: `README.md` gained a Project Assistant section and a feature bullet; `docs/steering/product.md`
  gained the feature, Situation/Flag/Conversation/Message/Proposal domain terms and the approval rules;
  `docs/steering/structure.md` gained `server/assistant/`, `routes/assistant.js`, `components/assistant/`,
  `assistantApi.js` and a Project Assistant section; `api-standards.md` coverage now names `AssistantChat.test.jsx`.
- **Review pass**: one defect fixed — `server/assistant/mcp-server.js` returned `null` for a 200 whose
  body was not JSON (`requestJson` now fails loudly; test "reports a non-JSON answer from the server
  instead of using nothing"). Checked and fine: the proposal routes' problem documents and trace ids,
  atomic approve with `notifyAfterDecision` degrading to a logged warning (the decision already
  succeeded), the client parser's per-field guards, and no silent catches beyond deliberate logged ones.
- **Limit (unchanged, stated)**: no signed-in Claude answer clicked in Chrome — under an isolated HOME
  `claude auth status` reports `loggedIn:false`, and the real HOME would write the owner's live
  database. The real adapter answer path is recorded in the Phase 3/4 Develop probes; this pass's
  browser run uses a fake agent that calls the real MCP tools and token.

### Session — 2026-11-25 (Phase 1)
**Completed**: Phase 1: Situation brief and the panel's "Where things stand"
**Key files**: `server/assistant/situation.js`, `server/assistant/situation-flags.js`, `server/assistant/todo-docs.js`, `server/routes/assistant.js`, `server/pipelines/run-view.js` (run view builder moved out of `routes/pipelines.js`), `server/pipelines/run-worktree.js` (detailed `-z` status with `--no-optional-locks`), `client/src/components/assistant/AssistantPanel.jsx`, `client/src/utils/assistantApi.js`
**Built by**: Codex gpt-6-sol@high (implementation, then a fix pass over 3 parallel reviews: correctness, conventions, simplicity). Targeted verify: server 11 files / 626 tests, client 3 files / 21 tests, Vite build OK.
**Bug fixes**: path-only todo matching judged a run by another task's copy; closed (`released`) runs were still listed; `git status` could take `index.lock` while agents commit; stray regex flagged files named `0`/`t`/`n`; the panel showed the previous project's flags after a switch.
**Quirks**: Codex rewrote the main checkout's `.remember/remember.md` handoff (restored by the coordinator). The live-GRS browser check was done by Codex before the fix pass; `feature-test` should repeat it.
**Next**: Phase 2: Conversation storage and the chat over ACP. Plan the new dependencies first (adapter, marked, dompurify): `node_modules` is the main checkout's.

### Deviations
- **[Phase 1 / situation flags] — Run status is `complete`, not `completed`**
  - **Planned**: Spec §5.4 and §7.1 said a run is `completed`.
  - **Found**: the run machine's status is `complete` (`server/pipelines/run-machine.js:141`); the first implementation renamed it on the way out.
  - **Did**: amended the spec to `complete`; the composer passes the domain value through unchanged.
  - **Follow-up**: none
- **[Phase 1 / situation composer] — Todo copies keyed by repository and path, compared by content**
  - **Planned**: Spec §8.2 said a todo in Main and a task is judged by the task copy.
  - **Found**: every task worktree contains every todo committed in Main, so path-only matching let task B's untouched copy decide task A's progress (correctness review).
  - **Did**: amended §8.2. Todos are keyed by repository+path; a task copy identical to Main's is listed under Main's `alsoIn`; a differing copy is its own todo; a run is judged only by its own `progress`.
  - **Follow-up**: none
- **[Phase 1 / situation composer] — Closed runs left out with `isOpenRun`**
  - **Planned**: §8.1.3 "runs that are not closed", with no rule named.
  - **Found**: Close run sets `worktreeState` to `released`, not `removed`, so the first implementation kept closed runs.
  - **Did**: amended §8.1.3 to name `isOpenRun` (`server/pipelines/run-worktree-hold.js`).
  - **Follow-up**: none
- **[Phase 1 / tests] — Fixed an unrelated stale assertion in `tasks-api.test.js`**
  - **Planned**: out of scope.
  - **Found**: the create-task assertion lacked the `host: 'local'` field the API already returns; it was one of the failures recorded on `main` in the 2026-11-25 handoff.
  - **Did**: Codex added the field so the targeted suite runs green.
  - **Follow-up**: none
- **[Phase 1 / feature-test] — Five bugs found only against real data (logged during feature-test)**
  - **Planned**: tests with one-project fixtures; Spec §8.1 silent on non-Git folders, untrimmed names and null progress counts.
  - **Found**: on a copy of the live database, each of these returned 500 or wrong wording:
    - GRS Local: a run of another project (mlondolozi) failed the per-run project guard before runs were filtered by task.
    - codedeck: a Main checkout holding a file named `" "` failed the trimmed-text guard on dirty paths.
    - Equinox Local: a run whose progress file is missing has null counts, which the server and client guards refused.
    - nav-billing and job-broker (5 projects in all): their folder is not a Git repository, and `git status` failed.
    - Wording: a Main todo was labelled "for task “<todo title>”" through a `task?.title ?? todo.title` fallback, and stray names were double-escaped by `JSON.stringify`.
  - **Did**: one red test per bug, then:
    - runs are filtered by task before their guards run
    - Git paths are checked as non-empty and never trimmed
    - progress counts are nullable, on the server and in the client
    - the composer honours the repository service's `usable`/`reason`, and the panel lists unusable repositories
    - Main todos are named "in Main (<repository>)", with no fallback
    - stray names are quoted raw
    - stray files are now also reported for repository checkouts (Spec §5.4 covers any untracked path)
    - Spec §5.4, §8.1.7–8 and `api-standards.md` amended to match
  - **Follow-up**: none

### Feature test — 2026-11-25 (Phase 1)
**Verdict**: FULLY TESTED
- **Coverage gaps filled**: 30-second refresh while open (fake timers); the shortcut overlay row (new `ShortcutsOverlay.test.jsx`); the 50-path dirty bound and `truncated.dirty` at 50 and 51.
- **Targeted suites**:
  - server `assistant-*`: 6 files / 36 tests
  - client `assistantApi`, `AssistantPanel`, `App`, `ShortcutsOverlay`: 4 files / 29 tests
  - Vite build OK
- **Full suites**: server 4,312 passed, 4 failed; client 2,040 passed, 14 failed. All failures are in files listed as failing on `main` (`project-config`, `project-repositories-api`, Sidebar mocks, mobile `runsApi`), except one `assistant-flags` failure: a red test caught mid-edit, which passes now.
- **One unexplained flake**: `assistant-api` "409 for remote" returned 400 once in 7 runs, while the full suites ran beside it. It did not reproduce in 6 reruns.
- **Boot**: the worktree backend booted clean on port 43111 with an isolated HOME and a backup copy of the live database. Session naming was cleared and unfinished runs were marked interrupted, both in the copy only, so the test backend could not reattach live runs or launch review CLIs. The first boot had reattached a live mlondolozi run; it was stopped within about 70 s, with no prompt sent, and the copy was then fixed.
- **Live API**:
  - all 66 local projects return 200 (slowest 0.76 s)
  - 404 for an unknown project, 409 for a remote one
  - 400 with field `errors` for a query parameter, a bad encoding, a 101-character name, a traversal name and a script-tag name
  - trace ids on every response; parallel requests return equal flags
  - no backend errors after the fixes
- **Browser** (Claude in Chrome, served from `client/dist` on 43111):
  - the GRS panel shows the 9 expected flags
  - ⌘⇧L closes and reopens the panel
  - Refresh sends a second GET, which returns 200
  - switching to Equinox shows its own 3 flags with nothing stale
  - the open state survives a reload
  - no console errors
  - not checked in the browser: the unusable-repository line (unit-tested, and the API returns it for the 5 non-Git projects)

### Session — 2026-11-25 (Phase 2)
**Completed**: Phase 2: Conversation storage and the chat over ACP (advise only)
**Key files**:
- `server/assistant/conversation-store.js`
- `server/assistant/acp-bridge.js` (forces mode `default`, v1 updates, auth frames, tool title from updates)
- `server/assistant/ws-upgrade.js` (`routeUpgrade`, one agent per project)
- `server/assistant/project.js` (`isLocalProject`)
- `server/mobile-access.js` (`/ws/assistant` allowed like `/ws/terminal`)
- `client/src/components/assistant/AssistantChat.jsx`
- `client/src/utils/assistantApi.js` (`parseAssistantFrame`)
- `server/__tests__/fixtures/assistant-fake-acp-agent.js` (replays real adapter frames)

**Built by**: Codex gpt-6-sol@high over three runs: the build; 3 parallel reviews and their fix pass; then a fix pass for what the live probe of the real adapter found. Targeted verify: server 13 files / 307 tests, client 4 files / 50 tests, Vite build OK.
**Live verification**:
- Browser (Claude in Chrome, test backend on 43111 with a throwaway database and repository):
  - the panel connects, shows the sign-in state, and the chat says Ready
  - an owner message is saved and shown, with emoji intact
  - after a reload the transcript comes back and the restart notice appears
  - not signed in, the panel shows the clear message and returns to Ready
- Real adapter with the owner's login, through `handleAssistantConnection` and an in-memory database:
  - the session is forced to `default` before `ready`
  - a read-only `git status` runs without asking (Claude Code allows read-only commands)
  - a Write asks for permission; the owner's reject is honoured, and the file was not created
  - one tool message is stored, under its real title, and one agent message
**Bug fixes**:
- the real access check refused `/ws/assistant`
- crash paths: a null browser frame; stdin EPIPE with no error listener
- UTF-8 split across output chunks
- writes after close
- the panel locked after a non-fatal error
- a 500 for a malformed conversation id
- the owner's message was shown before it was saved
- the agent ran in the owner's `auto` mode without asking
- auth and extension notifications were reported as errors
**Quirks**:
- The test backend cannot sign in to Claude: the Claude CLI's login lookup depends on the real HOME (`claude auth status` gives `loggedIn:false` under another HOME, even with `~/.claude` linked), and `server/db.js` takes the database from HOME. A signed-in chat in the browser therefore needs the real instance; the signed-in path was proven at the bridge level.
- One answer costs about $0.26 (about 49k cached tokens of the owner's Claude Code context).
- Probe sessions were written to the owner's real `~/.claude/projects` (a throwaway repository under the scratchpad).
**Next**: Phase 3: CodeDeck read tools and the assistant brief. Use the adapter's `systemPrompt: {mode:'append', content:[{type:'text', text}]}` in `session/new` for the brief, rather than a first prompt (Spec §8.5.4 to be amended), and `mcpServers` for the codedeck MCP server.

### Deviations
- **[Phase 2 / dependencies] — ACP adapter package renamed; worktree given its own node_modules**
  - **Planned**: Spec §8.5.3 named `@zed-industries/claude-code-acp` (the prototype used 0.16.2).
  - **Found**: `npm view` says that package "has been renamed to @agentclientprotocol/claude-agent-acp". The newest release at least two weeks old (cut-off 2026-11-11) is 0.106.0 (2026-11-10). It uses ACP SDK 2.6.0, not 0.14, and exports only `.`; its entry point is the `bin` path `dist/index.js`.
  - **Did**:
    - pinned `@agentclientprotocol/claude-agent-acp@0.106.0`, `marked@18.2.0` and `dompurify@3.4.17` exactly
    - replaced the worktree's `node_modules` link with its own `npm ci` under Node 22, so the main checkout's tree (used by the live backend) is untouched
    - amended Spec §8.5.3
  - **Follow-up**: Merging this branch changes the main checkout's lockfile; run `npm install` in the main checkout after merging.
- **[Phase 2 / review] — /ws/assistant uses the same private-access rule as /ws/terminal**
  - **Planned**: Spec §6.4: mount after `privateAccess.authorizeUpgrade` so it is guarded like /ws/terminal.
  - **Found**: `authorizeUpgrade` (`server/mobile-access.js:55`) refuses every path other than `/ws/terminal`, so the real server would refuse every assistant connection with 403. The ws-upgrade tests injected a fake check, which hid this.
  - **Did**: `authorizeUpgrade` authorises `/ws/assistant` with exactly the `/ws/terminal` rules: loopback with the local origins, or the owner over Tailscale. A test now uses the real `createPrivateAccess`. Anyone who can open a terminal can already run any command, so this does not widen access.
  - **Follow-up**: none
- **[Phase 2 / live check] — The real adapter started sessions in "auto" mode, so tools ran without asking**
  - **Planned**: Spec §8.5.5: every tool use is shown in the panel for approval; nothing is allowed by default.
  - **Found**: a probe of `claude-agent-acp@0.106.0` with the owner's login: `session/new` returned `currentModeId: "auto"` (the owner's Claude Code default), and a Bash tool (`git status --short`) ran with no `session/request_permission`. The same probe showed:
    - an `auth/status_update` notification and an `_auth/status_update` extension notification, which the bridge reported as "Unknown ACP method"
    - "Authentication required" when not signed in (the test backend's fake HOME)
    - tool titles that arrive only in later `tool_call_update`s
    - a cost of $0.26 for a one-sentence answer, about 49k cached tokens of the owner's Claude Code context
  - **Did**: a focused fix run. The bridge forces mode `default` ("Always ask before making changes") before `ready`, refuses to run otherwise, and reverts any later mode change. It accepts all v1 update kinds, takes tool titles from updates, shows the sign-in state, ignores `_` extension notifications, and words the not-signed-in error.
  - **Follow-up**: the owner may want the assistant on a cheaper model; that is not specified (Spec §11) and has not been done.

### Feature test — 2026-11-26 (Phase 2)
**Verdict**: FULLY TESTED (one limit, stated below)
- **Coverage gaps filled**:
  - Closing the socket ends the adapter process (SIGTERM), and an adapter that ignores SIGTERM is killed with SIGKILL after 3 s. These are real-process tests; removing the SIGKILL line makes the second one fail.
  - Enter sends and Shift+Enter does not.
  - `spawn_error` and `agent_exit` states show their message and keep the input disabled.
- **Full suites**: server 4,372 passed, 3 failed; client 2,068 passed, 14 failed. Every failure is in `main`'s known baseline: `project-config` (2), `project-repositories-api` (1), the Sidebar mocks (12) and mobile `runsApi` (2).
- **Boot**: the worktree backend booted clean on 43111 (isolated HOME, empty database, two throwaway projects). 0 errors in the log through every check.
- **Live API** (Spec §6.2):
  - `current` creates once and returns the same id on a repeat call
  - messages: empty, size 100 / 101, past the end, a malformed id → 400 `id`, an unknown id → 404
  - an unknown project → 404; a missing or unknown field → 400 with `errors`; malformed JSON → 400; a 5 KB body → 413; a foreign Origin → 403
  - two parallel POSTs leave one current conversation; every response has a trace id
- **Live socket** (Spec §6.4):
  - a missing project closes with 4400 and an unknown one with 4404; a foreign origin and no origin get HTTP 403
  - a valid socket gets `auth` then `ready`
  - a second socket takes over: the first gets the stored notice "The assistant was opened elsewhere." and closes, and its adapter ends
  - another project runs alongside
  - 0 adapters remain afterwards
- **Browser** (Claude in Chrome):
  - the transcript is loaded from the backend, and the chat reaches Ready
  - a sent message is stored and shown; when not signed in, the clear message appears and the chat returns to Ready
  - New conversation → POST 201, the toast "New conversation started.", an empty transcript
  - a project switch shows the other project's situation and chat
  - no console errors
- **Limit**: no signed-in answer or permission card in the browser, because the test backend cannot sign in to Claude (the login lookup depends on the real HOME). Both were verified against the real adapter at the bridge level in feature-dev; the cards are also covered by component tests.
- **Observation**: every reconnect stores another restart notice, so frequent reloads fill the transcript with notices. This follows Spec §8.6.3 and is noted for the owner.
- **Spec**: §7.5 corrected to the actual frames (`message` for stored owner messages and notices, `auth`, the `signal` on `agent_exit`).


### Session — 2026-11-26 (Phase 3)
**Completed**: Phase 3: CodeDeck read tools and the assistant brief
**Key files**:
- `server/assistant/session-tokens.js` (`createSessionTokens`, 32-byte hex in-memory tokens scoped to project + conversation, `timingSafeEqual`, `end`, `endConversation`)
- `server/assistant/session-reads.js` (`parseDocLocation`, `validateDocPath`, `resolveLocationRoot`, `readScopedDoc` with `realpath` containment and 512 KiB limit)
- `server/assistant/mcp-server.js` (stdio MCP server on `@modelcontextprotocol/sdk` exposing `get_situation`, `get_task_landing`, `read_todo`, `read_run_notes`, `list_runs`; returns MCP `isError: true` carrying RFC 9457 `message`)
- `server/assistant/brief.js` (`buildAssistantBrief(situationMarkdown)`)
- `server/routes/assistant.js` (five token-authorised read routes under `/api/assistant/sessions/:token/...`, 401/413 problem handling)
- `server/assistant/acp-bridge.js`, `server/assistant/ws-upgrade.js`, `server/index.js` (issue/revoke session token, pass `codedeck` stdio MCP server and `systemPrompt` brief in `session/new`, store/emit briefed notice)
- Tests: `server/__tests__/assistant-session-tokens.test.js`, `server/__tests__/assistant-session-reads-api.test.js`, `server/__tests__/assistant-mcp-server.test.js`, updated `server/__tests__/assistant-acp-bridge.test.js` & `server/__tests__/fixtures/assistant-fake-acp-agent.js`
**Verification**:
- Targeted server suite: 13 files / 104 tests passed (`cd server && npx vitest run __tests__/assistant-*.test.js --maxWorkers=1`).
- Real ACP adapter GRS probe (`@agentclientprotocol/claude-agent-acp@0.106.0` with owner's login, in-memory DB, live Express HTTP server, real `mcp-server.js`): `session/new` accepted `systemPrompt` and `codedeck` MCP server, emitted `Assistant briefed on the current situation.`, and answered "Where am I and what should I do next?" with Phase 2 at 4 of 6, the unfinished & dependent todos, backend Main's 30 dirty paths / merge blocker, frontend's 4 dirty paths, and stray files `" "` and `"\n"`. Token count dropped from 1 to 0 on close.
- Live worktree server boot on port 43115 (isolated HOME + throwaway Git repo): `/ws/assistant?project=GRS%20Demo` reached `ready`, persisted and emitted `Assistant briefed on the current situation.`, and `GET /api/assistant/conversations/:id/messages` returned the stored notice. Note: `chrome-devtools` MCP tool failed in this environment due to a missing module in the global npx cache (`McpResponse.js`), so browser UI rendering was not re-clicked in Chrome during Develop; Test can verify in a working browser if available.
**Next**: Phase 4: Proposals and approval (`assistant_proposals`, `proposal-store.js`, `proposal-payloads.js`, `proposal-executor.js`, proposal routes + `POST /api/assistant/sessions/:token/proposals`, MCP `propose_*` tools, decision lines prefixed to next prompt, bridge push frames, and panel proposal cards).

### Deviations (Phase 3)
- **[Phase 3 / briefing mechanism] — Assistant brief passed via `session/new` `systemPrompt` instead of a first `session/prompt`**
  - **Planned**: Spec §8.5.4 originally sent the brief as the first `session/prompt`.
  - **Found**: Phase 2's live probe established that `claude-agent-acp@0.106.0` supports `systemPrompt: { mode: 'append', content: [{ type: 'text', text }] }` in `session/new`, whereas sending a first `session/prompt` burns ~$0.26 per reconnect and fails when unauthenticated.
  - **Did**: Implemented `systemPrompt: { mode: 'append', content: [{ type: 'text', text: buildAssistantBrief(situation.markdown) }] }` in `session/new` (per Phase 2 session notes), still storing/emitting `"Assistant briefed on the current situation."`, and amended Spec §8.5.4 and §9.13.
  - **Follow-up**: none

### Review — 2026-11-26 (Phase 3)
- **Fixed**: `server/assistant/mcp-server.js` imported `@modelcontextprotocol/sdk` and `zod` that only arrived transitively; both are now exact dependencies of `server/package.json` (1.32.2, 4.6.7, the installed versions) and the lock's `server` entry.
- **Fixed**: every start-up failure of the bridge said "could not switch Claude Code to ask before acting", including a failing situation compose. The `spawn_error` now names the stage that failed (`could not start Claude Code`, `could not read the project situation`, `could not switch … ask before acting`). Test: `assistant-acp-bridge.test.js` "reports a situation failure as such…".
- **Fixed**: MCP tool errors for a 400 carried only "One or more fields failed validation.", so the agent could not tell what to change. The message now appends each `field: message` from the problem's `errors`. Test: `assistant-mcp-server.test.js`.
- **Noted, not changed**: `endConversation` is not called yet; New conversation ends the old token only by closing the old socket. Phase 4 needs it when ending a conversation expires its proposals. `readScopedDoc` checks the size by `stat` before reading, so a file growing between the two calls could be returned over 512 KiB (local, owner-only files; left as is).

### Feature test — 2026-11-26 (Phase 3)
**Verdict**: FULLY TESTED (one limit, stated below); no Phase 3 task unticked.
- **Targeted suites**: `cd server && npx vitest run __tests__/assistant-session-tokens.test.js __tests__/assistant-session-reads-api.test.js __tests__/assistant-mcp-server.test.js __tests__/assistant-acp-bridge.test.js --maxWorkers=1` → 4 files / 43 tests passed.
- **Independent probe** (`.codedeck/runs/8750d349/probe-phase3.mjs`, run from the worktree; not committed): a real §1 GRS-shaped fixture (two Git repos, a task worktree with 22 uncommitted files, stray `" "` and `"\n"`, a `complete` run whose Test step is `limit_accepted`, todo 1 on Phase 2 at 4 of 6, todo 2 depending on it) driven through the real `composeSituation`, `createProjectRepositories`, `createTaskLanding`, `createRunViewBuilder` and `createNoteStore`. 23 of 23 checks passed:
  - `/situation` 200 with `X-Trace-Id`; all seven §9.2 codes; markdown carries "4 of 6" and the Main blocker.
  - the real stdio MCP server, launched by the SDK client with a minted token: five read tools; `get_situation` returns the composed flags; `get_task_landing` returns the real worktree (22 uncommitted); `read_todo` reads the real worktree todo by `task:<taskId>/<worktreeId>` and a Main todo by `main:backend`; `read_run_notes` returns the written note; `list_runs` returns the composed run.
  - a wrong token is refused over MCP and 401 as a problem document over HTTP; a path outside the doc locations is 400 with `errors[0].field = path`; a 512 KiB + 1 byte todo is 413; the ended token is 401.
  - the real ACP adapter (`claude-agent-acp@0.106.0`, the owner's login), over `/ws/assistant` on the same socket the panel uses: reached `ready`, stored and sent "Assistant briefed on the current situation.", called `mcp__codedeck__get_task_landing` and `mcp__codedeck__read_todo` through the token, and answered "where am I and what should I do next?" with Phase 2 at 4 of 6, the unfinished todo, `second.md` blocked on Phase 2, Main's uncommitted files as the merge blocker, and the stray `" "`/`"\n"` files.
- **Live server boot** (isolated HOME, port 43197): `node server/index.js` clean, `POST /api/projects` 201, `GET /api/projects/Codedeck%20Probe/situation` 200 with 5 flags over this worktree and `X-Trace-Id`, unknown project 404, unknown query 400 with `errors`; 0 errors in the log. Server stopped, temp HOME removed.
- **Limit**: no Chrome click-through of a signed-in answer. The test backend cannot sign in to Claude under an isolated HOME (login is bound to the real HOME), and the real instance would use the owner's live database; the same limit was recorded in Phase 2. The answer itself was produced by the real adapter over the panel's own socket, and the panel's rendering of messages was browser-verified in Phase 2.
- **Observation**: in `default` mode Claude Code asks permission before each CodeDeck MCP tool call; that follows §8.5.5 (nothing allowed by default) and the probe approved each card.

### Session — 2026-11-26 (Phase 4)
**Completed**: Phase 4: Proposals and approval (act after asking)
**Key files**:
- `server/assistant/proposal-payloads.js` (pure structural + contextual per-kind validation for all 6 kinds, reporting every field at once, rejecting cross-project tasks, unknown worktrees, `deleteIgnored`, over-long/multiline fields)
- `server/assistant/proposal-store.js` (`assistant_proposals` table, per-column guarded hydration including per-kind payload check without leaking payload/result, 10-pending limit, atomic conditional `claimApprove`, `finish`, `decline`, `expireForConversation`, `list`, `listDecided`)
- `server/assistant/proposal-executor.js` (maps each kind to `landing.*`, `taskService.create`, or `pipelinesRouter.startRun` with proposal id as `requestId`, `close` always passing `deleteIgnored: false`, refusal 409 with `reasons`/`conflicts`, logging without payloads)
- `server/routes/pipelines.js` (exposed `router.startRun` so the executor invokes the run-start service directly without HTTP)
- `server/routes/assistant.js`, `server/assistant/conversation-store.js`, `server/index.js` (`POST /api/assistant/sessions/:token/proposals`, `GET /api/assistant/proposals`, `GET /api/assistant/proposals/:id`, `POST /api/assistant/proposals/:id/approve`, `POST /api/assistant/proposals/:id/decline`; `POST /api/assistant/conversations` now expires pending proposals and revokes session tokens via `endConversation`)
- `server/assistant/mcp-server.js` (added `propose_commit`, `propose_merge`, `propose_pull_request`, `propose_close`, `propose_new_task`, `propose_start_run`)
- `server/assistant/acp-bridge.js`, `server/assistant/ws-upgrade.js` (prefixes newly decided proposals to the next `session/prompt` once without altering stored owner messages; pushes `{type:'proposal'}` and `{type:'situation'}` frames)
- `client/src/utils/assistantApi.js`, `client/src/components/assistant/AssistantChat.jsx`, `client/src/components/assistant/AssistantPanel.jsx`, `client/src/components/assistant/AssistantPanel.css` (proposal cards, Approve/Decline in-flight disable + spinner, done/failed/declined/expired rendering, toasts with problem message, header refresh, confirmation on New conversation with pending proposals)
- Tests: `server/__tests__/assistant-proposal-payloads.test.js`, `server/__tests__/assistant-proposal-store.test.js`, `server/__tests__/assistant-proposal-executor.test.js`, `server/__tests__/assistant-proposals-api.test.js`, updated `assistant-mcp-server.test.js`, `assistant-acp-bridge.test.js`, `client/src/utils/assistantApi.test.js`, `client/src/components/assistant/AssistantChat.test.jsx`, `client/src/components/assistant/AssistantPanel.test.jsx`
**Verification**:
- Targeted server tests: `cd server && npx vitest run __tests__/assistant-*.test.js --maxWorkers=1` → 17 files / 124 tests passed.
- Targeted client tests: `cd client && npx vitest run src/utils/assistantApi.test.js src/components/assistant/AssistantChat.test.jsx src/components/assistant/AssistantPanel.test.jsx --maxWorkers=1` → 3 files / 49 tests passed.
- Client Vite build: `cd client && npx vite build` → succeeded cleanly.
- Live E2E scratch-project probe with real `@agentclientprotocol/claude-agent-acp@0.106.0` + real `mcp-server.js` + temporary Git repository + in-memory DB: agent called `propose_commit`, server pushed `{type:'proposal'}`, `POST /api/assistant/proposals/:id/approve` returned 200 `done`, `git log main..HEAD` in the task worktree showed `d69f043 Add notes.txt` with `main` unchanged, server pushed `{type:'situation'}`, and declining a second `merge` proposal returned 200 `declined` with `main` unchanged.
**Next**: Phase 5: Final verification + cleanup (full server & client suites, Vite build, cross-phase browser check, code review pass, README and steering docs).

### Review — 2026-11-26 (Phase 4)
- **Fixed**: `client/src/utils/assistantApi.js` dropped a malformed `proposal` in a failure problem with `catch { /* ignore */ }`, against the no-silent-catch rule. The error's message now says the proposal in the response could not be read and why; the server's message is kept. Test: `assistantApi.test.js` "surfaces a malformed proposal in a failure problem…".
- **Fixed**: `server/assistant/proposal-executor.js` kept only the message of a service refusal, so a 400 at approval (e.g. `startRun` field errors) failed with "One or more fields failed validation." and nothing else on the card or in the decision line. The failed result's `message` now appends each `field: message`. Test: `assistant-proposal-executor.test.js` "keeps the field detail…".
- **Checked and fine**: payload validation per kind incl. another project's task, closed task, unknown worktree, `deleteIgnored`; hydration guards per column with no payload/result text in errors; conditional `pending → approved` and `approved → done|failed`; 10-pending limit inside one transaction; executor calls `landing.*`, `taskService.create` and `pipelinesRouter.startRun` directly (no HTTP), `close` always `deleteIgnored: false`, proposal id as `requestId`; logs carry id/kind/outcome only; expiry and token end on New conversation; decision lines prefixed once to the next prompt; `proposal`/`situation` frames pushed; result fields the card and the decision line read (`commitsAhead`, `uncommittedCount`, `mergedInto`, `prUrl`, `taskFinished`, `id`, `title`) match what the services return.
- **Noted, not changed**: a proposal left `approved` by a backend crash mid-service stays `approved` for good (cannot be approved, declined or expired); the spec does not say what happens then. The agent has no read tool listing workflows or teams, so `propose_start_run` needs ids it can only learn from `list_runs` or the owner (spec §8.3.3 lists none). The Phase 4 "check in the browser" was an API-level probe with the real adapter, not clicked in Chrome; Phase 5's cross-phase browser check covers it.

### Feature test — 2026-11-26 (Phase 4, with one Phase 2 regression reopened)
**Verdict**: Phase 4's eight tasks hold; Phase 2's client rendering task is reopened (agent turns render empty live).
- **Targeted suites (this exact tree)**:
  - server `npx vitest run __tests__/assistant-*.test.js --maxWorkers=1` → 17 files / 125 tests passed (Review's new test included).
  - client `npx vitest run src/utils/assistantApi.test.js src/components/assistant/AssistantChat.test.jsx src/components/assistant/AssistantPanel.test.jsx --maxWorkers=1` → 3 files / 50 tests passed.
  - `cd client && npx vite build` → succeeded (4.5 s).
- **Browser end-to-end (Chrome, headless via CDP; isolated HOME; scratch Git project; real server, real `mcp-server.js` and session token; a fake ACP agent only stands in for Claude Code's prose)**:
  - the panel shows the flags without a prompt (uncommitted-work and merge-blocker flags for the scratch task);
  - the agent proposes a commit through the real `propose_commit` MCP tool → a card with Approve/Decline;
  - **Approve**: spinner/disabled state, `Done — Committed (1 ahead, 0 uncommitted).`, the success toast, `git log main..HEAD` in the task worktree shows `Add notes.txt`, and `main`'s HEAD and worktree are unchanged;
  - a second prompt carries `[CodeDeck] Proposal … (commit): done — committed (1 ahead, 0 uncommitted)` and the situation flag for the dirty worktree disappears from the header after the decision;
  - **Decline**: `Declined`, the toast, and neither `main` nor the task branch changes;
  - after a reload the transcript and both outcomes come back from the backend.
  - 18/18 checks passed **after** the one-line fix described below; 17/18 on the source tree, failing only on the live agent message.
- **Phase 2 defect reopened**: an agent turn is stored with its full text (the reload shows it) but is rendered as an **empty bubble** live. `AssistantChat.jsx:131` passes `streamRef.current` inside a functional `setMessages` updater; React runs the updater after the handler cleared the ref two lines later, so the content is `''`. Reproduced in the browser with a real WS `update` + `turn_end`; capturing the content before `setState` in the built bundle made the message appear and the decision line pass. No client test asserts the agent message after `turn_end`; the red test belongs here.
- **Limits**:
  - no signed-in Claude answer in the browser: under an isolated HOME the CLI reports `loggedIn:false` (even with `~/.claude` and `~/.claude.json` linked and `CLAUDE_CONFIG_DIR` set), and the real HOME would write the owner's live database. The real-adapter ask remains covered by Develop's recorded probe; this pass's browser run used a fake ACP agent that calls the real MCP server and token.
  - the harness files are run notes only (`.codedeck/runs/8750d349/tmp/phase4/`), not committed.
- **Environment**: no listeners left on 43231/43232; the Chrome profile is under the run folder and the temp HOME is inside the worktree; `client/dist` was rebuilt from source after the confirmation patch.

