# Remote Host Connectors

**Spec**: `docs/specifications/2026-07-06-195021-remote-host-connectors-spec.md`
**Status**: In Progress
**Created**: 2026-07-06
**Last completed**: Phase 3A: SSH Connection Pressure + Attachment Lifecycle Hardening

## Phase 0: Command Runner Foundation
> The primitive everything else rides on: per-host command runner with local and SSH implementations. Highest-risk piece (quoting, timeouts, ControlMaster) — front-loaded.
> **Inputs:** host descriptor ({ name, sshTarget } or local)
> **Outputs:** runner object with `run`, `spawnPty`, `copyTo`
> **Closed when:** unit tests pass for both runners including quoting round-trips, timeout kills, and argv composition; existing test suite unaffected

- [x] Create `server/command-runner.js` — runner factory: local runner (execFile / node-pty / fs.copyFile) and SSH runner (Spec §5 — method table + invocation rules)
- [x] SSH argv composition: BatchMode, ControlMaster/ControlPath/ControlPersist, ConnectTimeout on every call; CodeDeck-owned socket dir created 0700 on demand (Spec §5)
- [x] Remote argument shell-quoting helper — single-quote wrap with escape, pure function (Spec §5 — argument safety)
- [x] Per-call timeout enforcement with child kill; async-only SSH surface (Spec §5)
- [x] Unit tests — quoting round-trips (spaces, quotes, newlines, unicode), argv assertions via stubbed ssh/scp shim on PATH, timeout rejection + process-killed assertion, local runner parity
- [x] Integration test — stub-ssh shim script exercised end-to-end through `run`/`spawnPty`/`copyTo`

## Phase 1: Host Entity + CRUD API + Settings UI
> Hosts become first-class config with full lifecycle and honest connection testing.
> **Inputs:** none (foundational data slice)
> **Outputs:** `/api/hosts` CRUD + test endpoint; hosts section in SettingsPanel
> **Closed when:** all CRUD/validation acceptance criteria pass via supertest; settings UI manages hosts with toasts

- [x] Host service — validation (name rules, reserved `local`, sshTarget regex `^[A-Za-z0-9._@-]+$`, case-insensitive uniqueness), stored under `hosts` config key (Spec §3)
- [x] Routes: GET/POST/PUT/DELETE `/api/hosts`, POST `/api/hosts/:name/test` (ssh + remote tmux check, latency) (Spec §6.1, §7)
- [x] Deletion guard: 409 while referenced by projects; rename rewrites referencing projects atomically (Spec §6.1)
- [x] Unit tests — host service validation permutations (reserved name, regex rejects incl. leading `-` and whitespace, duplicates)
- [x] Integration tests — supertest CRUD happy paths + all error rows in Spec §6.1 table; test-connection payload shape with stubbed ssh (Spec §7, §9)
- [x] SettingsPanel hosts section — list, add, rename, delete, test-connection button with honest result display; success/failure toasts (Spec §8.2 UI conventions)

## Phase 2: Host-Aware Terminal Runtime
> The core capability: remote tmux terminals with the full resilience stack routed through the runner. Largest slice; touches terminal-runtime, ws-handler, session bookkeeping.
> **Inputs:** Phase 0 runner, Phase 1 hosts; project `host` field
> **Outputs:** durable remote terminals — spawn, attach, snapshot reconnect, status, kill, GC across hosts
> **Closed when:** all "Terminal runtime routing" acceptance criteria pass; existing 90-test ws-handler suite still green for local sessions

- [x] Project entity change: optional `host` field, per-host path uniqueness, host-existence + remote path validation on POST `/api/projects` (Spec §4, §6.2)
- [x] Parameterize `server/terminal-runtime.js` by runner: new-session/attach (`spawnPty` → `ssh -tt ... tmux attach-session`)/kill/has-session/capture-pane/display-message/resize/list-sessions all via runner; migrate affected sync call sites to async (Spec §8.4, §5)
- [x] Remote tmux availability check per host with local-style blocked-creation UX, message names the host (Spec §8.3)
- [x] Session entry gains `host`; ws-handler resolves runner from session's host on attach/reconnect; SSH-drop PTY exit treated as recoverable detach, not death (Spec §6.3, §8.4)
- [x] Session enumeration + `server/session-gc.js` iterate all hosts, skip unreachable ones (Spec §6.3)
- [x] Unit tests — runtime routes every tmux op through the injected runner (fake runner records calls); detach-vs-dead classification on remote PTY exit
- [x] Integration tests — ws-handler harness with fake SSH runner: spawn, snapshot-first attach, reconnect reseed, kill; regression: full existing suite passes with local runner (`cd server && npx vitest --maxWorkers=1`)

## Phase 3: Host Reachability State Machine + Truthful UI States
> The truthfulness core: host-unreachable as a first-class state, distinct from backend-down and session-dead. This is the acceptance-test slice ("pull the network mid-session").
> **Inputs:** Phase 2 host-aware sessions and polling
> **Outputs:** reachability tracking, fail-fast 503s, backoff probing, auto-recovery reseed, greyed UI
> **Closed when:** all "Reachability state machine" acceptance criteria pass; UI renders three distinct failure states

- [x] `server/host-reachability.js` — pure state machine: unknown/reachable/failing/unreachable, 3-consecutive-failure threshold, probe backoff 5→10→20→40→60s (Spec §8.1)
- [x] Unit tests — exhaustive transitions incl. blip tolerance (1–2 failures stay non-unreachable), backoff schedule with fake timers (Spec §9)
- [x] Wire into runner/status layer: command outcomes feed the machine; unreachable hosts fail host-dependent API calls fast with 503 `{ error: "host unreachable", host }` without issuing SSH; cockpit polling suspends per host (Spec §8.1, §7)
- [x] Recovery: successful probe resumes polling and triggers snapshot-reseed reconnect for waiting attachments (Spec §8.1)
- [x] GET `/api/hosts` + session/status payloads expose reachability, `unreachableSince`, `lastError` (Spec §7, §6.2)
- [x] Integration tests — 503 fast-fail without stub invocation; recovery reseed through ws-handler harness (Spec §9)
- [x] Frontend: sidebar grey-out + warning host badge + "unreachable" label (never dead), terminal host-unreachable overlay with retry, distinct from reconnect banner and dead state (Spec §8.2, §8.8)

## Phase 3A: SSH Connection Pressure + Attachment Lifecycle Hardening
> Keep remote-host status polling below OpenSSH channel limits and ensure closing a browser terminal releases its live SSH/tmux attachment while preserving the durable tmux session.
> **Inputs:** Phase 2 host-aware runtime and Phase 3 reachability state machine
> **Outputs:** bounded one-shot SSH concurrency, isolated interactive transports, aggregate status probes, capacity-aware reachability, and orphan-free detach behavior
> **Closed when:** focused runner/reachability/status/WebSocket lifecycle regressions pass and a restarted local server shows remote attachment count tracking open browser terminals

- [x] Bound one-shot SSH/scp work per host below the shared ControlMaster channel ceiling
- [x] Run interactive PTYs on dedicated non-multiplexed SSH transports
- [x] Collapse cwd + execution metadata + snapshot-tail refresh into one remote command
- [x] Classify multiplexed-session refusal as capacity pressure without marking the host unreachable
- [x] Kill the local PTY/SSH attachment on browser detach while preserving the durable tmux session and reconnect behavior
- [x] Unit tests — limiter, PTY argv isolation, aggregate status query, reachability neutrality, and local/remote detach cleanup
- [x] Live verification — restart CodeDeck, close/reopen a remote terminal, and compare browser sockets to SSH/tmux attachments

## Phase 4: Remote File Browsing (Directory Browser, Tree, Preview)
> The navigator goes host-aware: add-project browses the selected host; tree and preview follow the project's host.
> **Inputs:** Phases 0–1 (runner + hosts); Phase 3 for unreachable fail-fast behavior
> **Outputs:** host selector in add-project flow; remote file tree + preview
> **Closed when:** "Files, browse" acceptance criteria pass; response shapes unchanged from local

- [ ] `/api/browse` accepts `host` param; remote listing via runner (POSIX one-liner) producing existing entry shape; unknown host → 404 (Spec §8.7, §6.2)
- [ ] File tree (`server/file-tree.js` path) and file preview resolve project host and read via runner; keep depth limit + skip list semantics (Spec §6.2)
- [ ] Project create validates path existence on selected host; unreachable host → 503, never created unvalidated (Spec §8.7)
- [ ] Unit tests — remote listing/tree output parsing to existing shapes; error mapping
- [ ] Integration tests — supertest browse/tree/preview with fake runner; shape parity assertions vs local responses (Spec §9)
- [ ] Frontend: DirectoryBrowser host selector (default local, reachability indicators); FileBrowserPanel/FileTree work unchanged against host-aware endpoints (Spec §8.7)

## Phase 5: Remote Upload Paste + Open-in-Editor + Host Badges
> Last-mile capabilities: screenshot paste lands on the remote host, click-to-open uses VS Code Remote-SSH, sidebar shows where each project lives.
> **Inputs:** Phases 0–2
> **Outputs:** remote-path injection for paste; `code --remote` launching; host badges
> **Closed when:** "upload, editor" acceptance criteria pass; badges render from payloads

- [ ] `/api/upload` host resolution: local save → `copyTo` host `/tmp/codedeck-drops/` (mkdir -p on demand) → return remote path + host; scp failure → 502 + toast, no injection (Spec §8.5, §7)
- [ ] Terminal paste/drop flow passes the pane's project host; injected quoted path is the returned (possibly remote) path (Spec §8.5)
- [ ] `/api/open-file`: remote projects launch local `code --remote ssh-remote+<sshTarget> <path>`; local keeps `editorCommand`; launch failure → error toast with detail (Spec §8.6)
- [ ] Sidebar host badge on remote project rows (none for local) (Spec §8.8)
- [ ] Integration tests — upload copyTo argv assertion + remote path response + 502 path; open-file spawn argv assertion for both local and remote (Spec §9)

## Phase 6: Final Verification + Cleanup
> Local verification only — everything checkable inside this repo with its own tests and tooling.

- [ ] Run full server test suite (`cd server && npx vitest --maxWorkers=1`) — regression across all phases
- [ ] Cross-phase integration test: fake-SSH host end-to-end — create host → add remote project → spawn terminal → simulate host failure (grey state, fast 503s) → recover (snapshot reseed) → paste upload → open-file argv
- [ ] Verify local-only workflow is behaviorally unchanged (no host configured: all existing endpoints, payload shapes, and ws flows identical)
- [ ] Code review pass — no silent catches, all new fetches have res.ok + toasts, no sync SSH calls, `index.js` route-size check (~400-line rule → extract `server/routes/hosts.js` if exceeded)
- [ ] Update documentation — README (hosts setup, SSH key predicate, Remote-SSH note), `docs/steering/product.md`/`tech.md`/`structure.md` (host entity, runner, new files)

---

## Session Notes

### Session — 2026-07-06 (Phase 0)
**Completed**: Phase 0: Command Runner Foundation
**Built**: `server/command-runner.js` — `shellQuote` (POSIX single-quote wrap), `createLocalRunner`, `createSshRunner`, `createCommandRunner` dispatch. SSH runner puts BatchMode + ControlMaster/ControlPath(`%C`)/ControlPersist=600 + ConnectTimeout=5 on every `run`/`spawnPty`/`copyTo`; `--` before target/source; remote args + scp remote path shell-quoted; per-call `timeout` kills child. Socket dir created 0700 on demand (injectable via `deps.socketDir`).
**Tests**: `server/__tests__/command-runner.test.js` — 38 tests, all green. Uses real `ssh`/`scp` **shim scripts on PATH** (generated to a temp bin dir in `beforeAll`, PATH restored in `afterAll`) that echo argv (`SSH_ARGV:`/`SCP_ARGV:` on stderr) and simulate the remote shell via `execFileSync('/bin/sh',['-c',...])` for genuine quoting round-trips. Both ssh and scp argv are asserted for the mandatory flags.
**Key files**: `server/command-runner.js`, `server/__tests__/command-runner.test.js`, spec §5/§9.
**Decisions**:
- Added defense-in-depth: `createSshRunner` throws on an `sshTarget` failing `SSH_TARGET_REGEX` (exported = `^[A-Za-z0-9._@-]+$`, the §3 pattern). Reason: `--` blocks flag-injection but not whitespace/metacharacter target-structure abuse.
- Test strategy is PATH shims (per spec §9), not `vi.mock`, so real execFile/node-pty/scp quoting is exercised.
**Quirks**:
- **Leading-dash `sshTarget`**: the §3 regex `^[A-Za-z0-9._@-]+$` *allows* `-` anywhere (needed for `dev-box`), so it does NOT reject a leading `-`. §3/§9 require leading-`-` rejected — that is a **separate rule the Phase 1 host service must add on top of the regex**. The runner is safe regardless because of the `--` guard.
- `execFile`'s built-in `timeout` option is what kills the child → rejects with `err.killed === true`.
- A repo security hook blocks the shell-string exec APIs — use `execFileSync('/bin/sh', ['-c', ...])` in tests/shims instead.
**Next**: Phase 1: Host Entity + CRUD API + Settings UI — host service validation (reuse exported `SSH_TARGET_REGEX`; add reserved-`local`, case-insensitive uniqueness, **leading-`-` rejection**), `/api/hosts` CRUD + `/test`, deletion guard + rename-rewrites-projects, SettingsPanel hosts section.

### Session — 2026-07-06 (Phase 1)
**Completed**: Phase 1: Host Entity + CRUD API + Settings UI
**Built**:
- `server/host-service.js` — pure CRUD/validation (`validateHostInput`, `addHost`, `updateHost`, `deleteHost`, `rewriteProjectHost`, `listHostsWithLocal`, `isReservedHostName`, `findHostByName`). Returns `{error,status}`/`{data}`. Reuses `SSH_TARGET_REGEX` + explicit leading-`-` reject.
- `server/routes/hosts.js` — `createHostsRouter(deps)` (DI): GET/POST/PUT/DELETE `/api/hosts` + POST `/api/hosts/:name/test`. `index.js` was already 517 lines (past ~400 rule) so hosts live in `routes/`.
- `server/index.js` — added `loadHosts`/`saveHosts` (`hosts` config key, like `projects`) + `saveHostsAndProjects` (db.transaction) + mounted the router.
- `client/src/components/HostsSection.jsx` — hosts UI (list/add/rename/delete/test), mounted in `SettingsPanel.jsx`. Every fetch: try/catch + res.ok + success/failure toasts, error read from API `error` field.
**Tests**: `host-service.test.js` (45) + `hosts-routes.test.js` (27, supertest) — all green. Client build passes (`cd client && npx vite build`); no client test harness yet, so UI is feature-test's browser gate.
**Decisions**:
- Reserved `local` on PUT/DELETE/test → **400** (built-in, not "unknown"), which is more truthful than 404 and consistent with the §6.1 400 "reserved name" row. POST `local` → 400.
- GET reachability: `local`→`reachable`, stored→`unknown` (default). Live reachability + `lastError`/`unreachableSince` come in **Phase 3** via a `getReachability` resolver already wired as an optional dep in `listHostsWithLocal` / the router.
- test endpoint: ssh-fail does NOT probe tmux; always 200; tmux-missing message names the host.
**Bug fixes** (from Phase 5 review): PUT rename was two separate SQLite writes (non-atomic) → wrapped hosts+projects in one `db.transaction` via injected `saveHostsAndProjects`; router uses it only on the rename path. Tests pin "rename → one combined persist call".
**Next**: Phase 2: Host-Aware Terminal Runtime — add optional `host` to projects (per-host path uniqueness, host-existence + remote path validation on POST `/api/projects`), parameterize `server/terminal-runtime.js` by the Phase 0 runner (migrate tmux ops to async via runner), session entry gains `host`, ws-handler resolves runner per session, session GC iterates all hosts. Reuse `createCommandRunner` + `findHostByName`.

### Session — 2026-07-06 (Phase 2)
**Completed**: Phase 2: Host-Aware Terminal Runtime
**Built**:
- `server/routes/projects.js` — project routes extracted from index.js, host-aware: optional `host`, per-host path uniqueness, **global name uniqueness** (session ids derive from names — dup names would misroute terminals), path check via runner (`test -d`), 503 `{error:'host unreachable',host}` on transport failure.
- `server/terminal-runtime.js` — `createHostTerminalRuntime(runner, hostName)`: async-only tmux ops all via runner (spawn/kill/has-session/capture/resize/cwd/execution/list + `checkTmuxAsync`); `listSessionIdsAsync({strict})` rethrows transport for allocation fail-fast. Extracted `parseTmuxPaneStateOutput`/`TMUX_PANE_STATE_FORMAT` shared with the sync path.
- `server/command-runner.js` — `isTransportFailure(err)`: killed/code 255/string-code = transport (host state UNKNOWN); exit 1/127 = definitive. The detach-vs-dead hinge.
- `server/ws-handler.js` — options param `{resolveHostRuntime}`; remote branch BEFORE the local tmux gate; async `handleRemoteWsConnection` (tmux-check naming host, snapshot-first attach, reconnect reseed); `registerRemotePtyExitHandler`: recoverable→re-attach, definitive→dead, **transport→`remoteDetached` suspended (ws stays open, never dead)**; per-session attach queue (race fix); deleted-during-attach guard; mid-attach disconnect detach marking; `entry.host`/`entry.hostRuntime` refreshed on reconnect. Extracted `registerSessionSocketHandlers` facade + `createSessionEntry` + `completeAttach` (local path stayed byte-identical — 107-test suite passes unmodified).
- `server/host-runtime-resolver.js` — `createHostRuntimeResolver({loadProjects,loadHosts})`: session→project→host→runtime with per-descriptor cache (key `name::sshTarget` so target edits rebuild), `listAllSessionIds` cross-host merge.
- `server/session-gc.js` — sync prune skips remote entries; `pruneRemoteTerminalSessions` (unreachable host → skip whole host this pass; dead+TTL → killAsync).
- `server/terminal-session-status-cache.js`/`-service.js` — refresh routes via `entry.hostRuntime`; detached ids attributed to their host via `resolveHostRuntime`; rows carry `host`; `!alive && remoteDetached` → `host_connection_lost`/unknown/low, never `pane_dead`. `computeSessionHealth` → 'detached' for remoteDetached.
- `server/index.js` — consumes the resolver; allocation 503 on unreachable host; DELETE resolves host runtime even without an in-memory entry (was killing local tmux by name!); debug endpoint guards remote entries; prune timer runs both prunes; cache uses cross-host enumerator.
**Tests**: 391 passing / 24 files (~90 new this phase: projects-routes 21, host-terminal-runtime 21, ws-handler-remote 17, host-session-gc-cache 15, host-runtime-resolver 6, +additions). Local suites pass **unmodified**.
**Bug fixes** (Phase 5 review, 13 findings all fixed): literal NUL byte in index.js cache key (file read as binary); SSH-drop reported dead on status surfaces; DELETE-without-entry killed local tmux; detached remote ids polled local tmux; double-attach race spawning 2 PTYs; mid-attach disconnect leaving wsAttached forever; stale hostRuntime after sshTarget edit; allocation id-collision on unreachable host; duplicate project names misrouting; unhandled-rejection sinks; per-host GC short-circuit; DRY extractions.
**Quirks**:
- Local attach flow MUST stay fully synchronous (tests pin send ordering) — remote is a separate async flow sharing extracted sync helpers; never add an `await` (even on a non-promise) to the local path.
- The Edit tool once emitted a literal NUL byte for a template-literal separator — if `file server/index.js` says "data", hunt for `\\0`.
**Next**: Phase 3: Host Reachability State Machine + Truthful UI States — `server/host-reachability.js` pure state machine (unknown/reachable/failing/unreachable, 3-failure threshold, 5→10→20→40→60s backoff), wire command outcomes into it, fast-fail 503s without SSH, recovery snapshot-reseed for waiting attachments, GET /api/hosts live reachability (hook already stubbed: `getReachability` dep in hosts router + `listHostsWithLocal`), frontend grey-out/badge/overlay. The `remoteDetached` entries + `host_connection_lost` reason from this phase are what Phase 3's recovery reseed consumes.

### Session — 2026-07-08 (Phase 3)
**Completed**: Phase 3: Host Reachability State Machine + Truthful UI States
**Built**:
- `server/host-reachability.js` — pure state machine (`unknown/reachable/failing/unreachable`), 3-consecutive-failure threshold, backoff `[5,10,20,40,60]s`; `HostUnreachableError` (status 503, `toJSON`→`{error,detail?,host}`); `wrapRunner`; `createHostReachabilityManager` (local host always reachable). Manager methods: `getReachability/isUnreachable/assertReachable/recordSuccess/recordTransportFailure/wrapRunner`.
- `server/index.js` — manager wired via `createReachabilityAwareRunner`; `onRecovered` reseeds remote detached sessions + refreshes status cache; `getReachability` threaded into resolver/status/cache/gc/ws; POST `/api/terminal` fast-503 for unreachable remote host.
- `server/ws-handler.js` — fast-fail remote attach `spawn_error reason:"host_unreachable"`; exports `reseedRemoteDetachedSessions`.
- `server/routes/projects.js` — GET `/api/projects` spreads live reachability per project (local→`reachable`, remote→`getReachability` or `{}`); POST/PUT fast-503. `server/routes/hosts.js` — GET includes reachability; `/test` fast-503.
- `client/src/utils/terminalActivity.js` — `isHostUnreachableSession` → `getTerminalStatus` returns `unknown` (never `dead`).
- `client/src/components/Sidebar.jsx` — `getProjectHost/getProjectReachability/getProjectLastError/getTruthfulProjectStatus/renderHostReachabilityBadges`; grey-out + badge + `unreachable` label on active/waiting/shelved rows.
- `client/src/components/Terminal.jsx` — `host_unreachable` connection status + overlay + Retry, distinct from the `disconnected` reconnect banner and the `failed` red state.
**Tests**: server touched set 220 pass (9 files); client full component/utils 149 pass (24 files); client build passes (only pre-existing chunk-size warning). This session re-verified targeted: server Phase 3 files 81 pass (`host-reachability, hosts-routes, projects-routes, ws-handler-remote`), client 30 pass (`TerminalHostUnreachable, Sidebar, terminalActivity`).
**Bug fixes** (Phase 5 review): host-unreachable Retry (`retryConnectionRef.current`) did not clear a pending backoff reconnect `setTimeout(connect)` (`retryTimerRef.current`); a stale timer could fire after the immediate retry → duplicate socket. Added `clearTimeout(retryTimerRef.current); retryTimerRef.current = null;` at the top of the retry callback (Terminal.jsx:778). Regression assertion added to `TerminalHostUnreachable.test.jsx`: after retry creates a 2nd socket, advance timers 30s and assert still exactly 2 sockets.
**Next**: Phase 4: Remote File Browsing — `/api/browse` host param + remote listing via runner (unknown host→404); file-tree + preview resolve project host; project create validates path on selected host (unreachable→503); DirectoryBrowser host selector with reachability indicators.

### Deviations
- **[Phase 5 / quality review] — code-reviewer subagents unavailable, review done locally**
  - **Planned**: launch 3 code-reviewer agents in parallel (simplicity/DRY, bugs, conventions).
  - **Found**: all 3 subagent spawns failed with `Model "gpt-5.4" not found` (Sakana endpoint 404) — subagent spawning was broken this session.
  - **Did**: performed the review locally instead; applied one ≥80-confidence fix (retry-timer race in Terminal.jsx) with a regression test. Other candidates (async `spawnPty` transport feedback; Sidebar per-row reachability DRY) were considered and rejected as <80 confidence / risky churn.
  - **Follow-up**: none — behavior is locked by tests; revisit the Sidebar DRY smell only if that file is touched again.

### Session — 2026-07-13 (Phase 3A)
**Completed**: Phase 3A: SSH Connection Pressure + Attachment Lifecycle Hardening
**Built**:
- `server/command-runner.js` — shared per-host/per-ControlPath limiter (8 one-shot calls), one direct-connection retry for ControlMaster capacity refusal, and dedicated non-multiplexed PTY transports.
- `server/terminal-runtime.js` / `server/terminal-session-status-cache.js` — one remote status command returns cwd, pane state, and tail snapshot instead of opening multiple SSH channels per refresh.
- `server/host-reachability.js` — ControlMaster capacity refusal is neutral host evidence rather than an unreachable transition.
- `server/ws-handler.js` / `server/terminal-session-status-service.js` — browser close kills only the attachment PTY, records `clientDetached`, preserves tmux, reports a resumable detached/unknown state, and safely reattaches across close-during-hydration races.
**Tests**: focused Phase 3A suite 216 pass (7 files); full server suite 425 pass (24 files); full client suite 168 pass (29 files); client production build passes with the existing chunk-size warning.
**Live verification**: restarted via `./server.sh restart` (backend 43001, frontend 43000; clean readiness log). Opening `Mace-118` created one dedicated `ControlMaster=no` SSH attachment; closing reduced its process count to 0 and `/api/sessions` reported `detached` / `unknown` / `client_detached`. Reopening produced `reconnect_recovery`, then closing again returned the process count to 0.
**Review fixes**: made the limiter shared across independently-created runners, added direct fallback for full masters, separated browser detach from genuine PTY death, and rechecked liveness after async snapshot hydration.
**Next**: Phase 4: Remote File Browsing.

### Feature test — 2026-07-13 (Phase 3A)
**Verdict**: FULLY TESTED
- Spec coverage: all Phase 3A transport pressure, capacity classification, aggregation, detach, and reconnect-race requirements covered.
- Integration: no data layer; real process/WebSocket lifecycle verified against the restarted app.
- Backend boot: clean readiness marker, listeners on 43000/43001, no error/exception signals.
- Browser: not required for this server-only phase; browser control was unavailable, so the same live WebSocket endpoint was exercised directly.

### Deviations
- **[Phase 3A / interactive transport isolation] — long-lived PTYs no longer use the shared ControlMaster**
  - **Planned**: original Spec §5 required ControlMaster options on every SSH call.
  - **Found**: live evidence showed persistent tmux attachments consuming the master's logical-session allowance and status bursts failing with `Session open refused by peer`.
  - **Did**: retained bounded multiplexing for one-shot SSH/scp work but moved interactive PTYs to dedicated non-multiplexed transports; updated Spec §5 to match.
  - **Follow-up**: none.

### Code review — 2026-07-13 (Phase 3A, before commit)
**Did**: high-effort multi-agent review of the Phase 3A diff (19 verified findings, deduped to 10); fixed 8, kept 2 as by-design. Supersedes two statements in the session notes above: the ControlMaster capacity direct-connection fallback was REMOVED (unrequested fallback logic; capacity errors now reach host-reachability's neutral classification as designed), and detached sessions no longer report `unknown`/`client_detached`.
- Client-detached durable sessions report `alive: true` plus live tmux-by-name execution status (service + cache) — the cockpit keeps showing real running/idle for backgrounded projects; session GC still prunes if the tmux session actually dies.
- Remote PTY exit handler re-checks detach state after the async recoverability probe AND after `spawnAsync` — a browser close mid-recovery can no longer respawn an orphaned SSH attachment.
- Post-hydration liveness re-check gained the unrecoverable branch: the attach fails with `spawn_error` instead of binding the new socket to a dead PTY with a normal handshake.
- Client input (live typing, Ctrl-key passthrough, reconnect buffer) is gated on the `session` handshake like `resume` — no silent keystroke loss during the remote SSH attach window.
- Shared SSH limiter keyed by `controlPath\0sshTarget` only (no longer fragmented by max), resolved per call, self-evicts when idle; `detachTmuxClient` logs `pty.kill()` failures; deleted the host runtime's dead `getSessionExecutionStateAsync` (the cache always uses `getSessionStatusAsync` for host entries).
**Not changed (judged by-design)**: the 8-command one-shot bound stays (Spec §5; the status cache's own 4-refresh cap prevents poll saturation of the limiter); interactive PTYs stay off the ControlMaster (Spec §5 deviation above — MaxStartups pressure when restoring >10 panes at once is the accepted trade-off).
**Tests**: server 429 pass (24 files), client 168 pass (29 files); new regression tests for the detach races, handshake-gated input flush, detached-status polling, and no-fallback capacity propagation.
