# CodeDeck

Browser-based multi-project terminal workspace. Split panes, project switching, file browsing, and a live sidebar cockpit — all in one window. Built with React + xterm.js on the frontend, Express + node-pty on the backend, SQLite for config.

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
- Start both servers: `./server.sh start`
- Stop: `./server.sh stop`
- Restart: `./server.sh restart`
- Status: `./server.sh status`
- Logs: `./server.sh logs`
- Build client: `cd client && npx vite build`
- Install deps: `npm install` (workspace root — installs both server and client)
- Run server tests: `cd server && npx vitest --maxWorkers=1`

## Rules — IMPORTANT
- NEVER let the frontend hold authoritative state — backend (SQLite) is the source of truth
- NEVER swallow errors silently — no `catch(() => {})` or `catch {}` without handling
- NEVER pass unsanitized user input to shell commands — validate paths exist before `open`/`exec`
- ALWAYS show user feedback (toast) for both success and failure on mutating API calls
- ALWAYS handle fetch errors — every `fetch()` needs try/catch and `res.ok` check
- ALWAYS start the backend via `./server.sh start` — never run `node server/index.js` directly (blocks terminal)
- ALWAYS run Vitest with `--maxWorkers=1` to avoid OOM
- Server routes live in `server/index.js`, WebSocket handler extracted to `server/ws-handler.js`. If route handlers grow past ~400 lines, extract into `server/routes/`.

## References
See @README.md for setup and usage instructions
See @docs/specifications/ for feature specs
