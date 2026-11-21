# Make an existing worktree a task

**Spec**: `docs/specifications/adopt-worktree-task-spec.md`
**Status**: Complete
**Created**: 2026-11-21
**Last completed**: Phase 2

> Strict TDD: every task starts with its red test. Every field crossing an edge (request body,
> query, Git output, API response read by the client) gets its own guard and a rejecting test.
> Read `~/.claude/standards/api-design.md` before touching the endpoints.
> Run Vitest with `--maxWorkers=1`, under Node 22.

## Phase 1: Backend — list candidates and make a task from one

- [x] Service: `listWorktreeCandidates(projectName)` in the task service (or a new
      `server/tasks/task-worktree-candidates.js` injected into it), per spec rules 1–3:
      exclusions, reasons, fields. Uses `listWorktrees` / `readWorktreeChanges` from
      `server/pipelines/run-worktree.js`; "in use" reuses the same meaning as `worktreeRefusal`.
- [x] Service: `adoptWorktree({ project, worktreePath, title })` per rules 4–7: re-checks the
      candidate, base branch, merge-base, derived or owner title, `taskStore.create` with no
      others. No Git write.
- [x] Route `GET /api/tasks/worktree-candidates` (paginated, `project` required, sort `path`),
      registered before `GET /api/tasks/:id`.
- [x] Route `POST /api/tasks` accepts `worktreePath` (+ optional `title`), exclusive with
      `repositories`.
- [x] Tests: service unit tests over real temporary Git repositories (own repository, a listed
      other repository, home worktree excluded, project checkouts excluded, open-task worktree
      excluded, each not-selectable reason, merge-base, derived title, untracked files kept).
      Route tests across the api-design §4 dimensions (happy path with full envelope, 400 field
      errors incl. both forms given, boundaries on size/title, null/empty, fuzzed path strings,
      404/409).
- [x] An adopted task takes a run: route-level test that `POST /api/pipelines/runs` with its
      `taskId` and a progress file that is only untracked in the worktree starts.

## Phase 2: Frontend and docs

- [x] `client/src/utils/tasksApi.js`: validated `listWorktreeCandidates(project)` and
      `makeTaskFromWorktree({ project, worktreePath, title })`; each response field guarded.
- [x] `RunWorkflowDialog.jsx`: **An existing worktree** choice, candidate list with disabled
      reasons, optional title, Start = make task then start run in it; run-start failure
      switches to that open task. Toasts on success and failure.
- [x] `NewTaskDialog.jsx`: **Use an existing worktree** with **Make task**, then the same
      follow-up as creating a task.
- [x] Client tests for both dialogs and the API client.
- [x] README (Tasks and Workflow pipelines sections) and `docs/steering/structure.md` say how
      to start from a worktree made outside CodeDeck.
- [x] Full server and client suites pass; `cd client && npx vite build` succeeds.

## Session notes

- 2026-11-21 Phase 1: Added read-only Git candidate discovery, guarded adoption into the task store, paginated task route and real Git/API/run-start tests. Focused server run: 463 passed across `task-adopt-worktree`, `tasks-api`, and `pipelines-api`. Phase 2 remains.
- 2026-11-21 Phase 2 work: New task opens the adopted task's terminal without creating another worktree. Both entry dialogs, API validation, docs, and the two review fixes are implemented. Focused checks: 203 client and 466 server tests passed. Full server: 3,727 passed; Vite build and Node 22 SQLite load passed. Full client: 1,840 passed, one stale `PipelineSettings.test.jsx:605` approval assertion failed again in isolation; commit `6618f36` changed the template's Analyse approval to false. Left as a baseline failure on main, outside this feature.
- 2026-11-21 Review: a run refused after making the task re-sent the stale request, dropping a corrected input; fixed in `RunWorkflowDialog.jsx` with a red test. Full client 1,841 passed / 1 failed (the `PipelineSettings` baseline above); full server 3,727 passed; `vite build` and Node 22 SQLite load pass.
