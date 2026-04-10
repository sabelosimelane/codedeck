# CodeDeck

Lightweight multi-project terminal workspace for developers who juggle 3-5 projects simultaneously. No IDE overhead — just project switching, terminal multiplexing, and file browsing. Built for one user (Sabelo) as a personal productivity tool.

## Context
@docs/steering/product.md
@docs/steering/tech.md
@docs/steering/structure.md

## Coding Guidelines
@docs/guidelines/instructions.txt
@docs/guidelines/approach.txt

For detailed patterns and code examples, read these when relevant:
- `docs/guidelines/well-architected-framework.md` — full architectural patterns, error handling, frontend patterns
- `docs/guidelines/testing.md` — test generation strategy for Vitest + supertest

## Commands
- Start both servers: `./server.sh start` (runs `./start.sh` internally)
- Stop: `./server.sh stop`
- Restart: `./server.sh restart`
- Status: `./server.sh status`
- Logs: `./server.sh logs`
- Build client: `cd client && npx vite build`
- Install deps: `npm install` (workspace root — installs both server and client)

## Current Work
- Active todo: `docs/todos/workspace-enhancements.md` — Phase 1 complete (toast system, error handling)
- Spec: `docs/specifications/workspace-enhancements-spec.md`
- Remaining phases: flexible panes, sidebar cockpit, per-project file browsing

## Rules — IMPORTANT
- NEVER let the frontend hold authoritative state — backend (SQLite) is the source of truth
- NEVER swallow errors silently — no `catch(() => {})` or `catch {}` without handling
- NEVER pass unsanitized user input to shell commands — validate paths exist before `open`/`exec`
- ALWAYS show user feedback (toast) for both success and failure on mutating API calls
- ALWAYS handle fetch errors — every `fetch()` needs try/catch and `res.ok` check
- ALWAYS start the backend via `./server.sh start` — never run `node server/index.js` directly (blocks terminal)
- ALWAYS run Vitest with `--maxWorkers=1` to avoid OOM on this machine
- Server is a single-file Express app (`server/index.js`) — no router modules yet. If it grows past ~400 lines, extract route groups into `server/routes/`.

## References
See @README.md for setup and usage instructions
See @docs/specifications/workspace-enhancements-spec.md for current feature spec
See @docs/todos/workspace-enhancements.md for implementation progress
