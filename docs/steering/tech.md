# Technology Stack

## Core Stack

| Component | Technology | Version |
|-----------|------------|---------|
| Runtime | Node.js (ES Modules) | 22.12.0 |
| Backend | Express | 4.21.x |
| WebSocket | ws | 8.18.x |
| Terminal | node-pty | 1.0.x |
| Database | SQLite via better-sqlite3 | 12.8.x |
| Frontend | React | 18.3.x |
| Build | Vite | 5.4.x |
| Terminal UI | xterm.js | 5.5.x |
| Icons | lucide-react | 0.383.x |

## Key Dependencies
- **better-sqlite3**: synchronous SQLite driver with WAL mode. Database stored at `~/.codedeck.db`.
- **node-pty**: native PTY spawning. Each terminal pane gets a real shell process.
- **xterm.js**: terminal emulator in the browser. Addons: `@xterm/addon-fit` (auto-resize), `@xterm/addon-web-links` (clickable URLs).
- **ws**: WebSocket server mounted at `/ws/terminal` for PTY I/O.

## Dev Dependencies
- **vitest** (4.1.x): test runner for server-side unit tests. Config at `server/vitest.config.js`.
- **supertest** (7.2.x): HTTP assertion library for API integration tests.

## Development Setup

Prerequisites: Node.js 22+, npm 10+, and `tmux` for terminal sessions.

```bash
# Install all dependencies (workspace root installs both server and client)
npm install

# Preferred: start both servers in the background via the service manager
./server.sh start
./server.sh status
./server.sh logs
./server.sh stop

# Foreground developer launcher (Ctrl-C stops both child processes)
./start.sh
```

Open `http://localhost:43000` in the browser.

### Run Script Behavior
- `./server.sh` is the primary entrypoint for local development and day-to-day use.
- `./server.sh start` checks that backend port `43001` and frontend port `43000` are free before launching.
- `./server.sh` starts `./start.sh` detached, writes logs to `logs/server.log`, and stores the launcher PID in `logs/.server.pid`.
- `./server.sh status` reports the launcher PID plus the live frontend/backend listener PIDs when available.
- `./server.sh restart` is stop-then-start; `./server.sh logs` tails the combined launcher output.
- `./start.sh` is the foreground orchestrator: it starts `cd server && npm run dev` and `cd client && npm run dev`, then traps `EXIT/INT/TERM` to kill both cleanly.
- `server/package.json` uses `node --watch-path=./index.js --watch-path=./db.js --watch-path=./ws-handler.js --watch-path=./terminal-runtime.js index.js` for backend hot reload.
- `client/package.json` uses plain `vite` for the frontend dev server.

## Build & Run Commands
- Install deps: `npm install`
- Start app in background: `./server.sh start`
- Stop app: `./server.sh stop`
- Restart app: `./server.sh restart`
- Check status: `./server.sh status`
- Tail logs: `./server.sh logs`
- Run app in foreground: `./start.sh`
- Run backend dev server only: `cd server && npm run dev`
- Run frontend dev server only: `cd client && npm run dev`
- Build client: `cd client && npm run build`
- Preview built client: `cd client && npm run preview`
- Test all server tests: `cd server && npx vitest --maxWorkers=1`
- Test single server file: `cd server && npx vitest __tests__/ws-handler.test.js --maxWorkers=1`
- Lint/format: no dedicated lint or format script is defined in `package.json`
- Database migration: no migration tool; schema is created on startup in `server/db.js`

## Infrastructure
- **SQLite**: embedded, file-based at `~/.codedeck.db`. WAL mode enabled, foreign keys on. No migration tool — schema created via `CREATE TABLE IF NOT EXISTS` in `server/db.js`.
- **Vite dev server**: runs on `:43000`, proxies `/api/*` and `/ws/*` to Express on `:43001`.
- **No Docker**: runs directly on the local machine. No containerization needed.
- **No CI/CD**: runs locally. Contributions welcome to add CI.

## Environment & Configuration
- No environment variables are required for the default local setup.
- `PORT` overrides the backend Express/WebSocket port (default: `43001`).
- `FRONTEND_PORT` overrides the frontend listener port checked and reported by `server.sh` (default: `43000`).
- `CODEDECK_TERMINAL_RUNTIME=tmux` is the supported runtime contract; legacy non-`tmux` values are ignored and the backend still enforces tmux-required terminals.
- `CODEDECK_CAFFEINATE=1` re-execs `./start.sh` under macOS `caffeinate -i` to prevent idle sleep while CodeDeck is running.
- Application config is stored in SQLite `configs` table key-value rows; documented keys include `defaultPath` and `editorCommand`.
- `~/.codedeck.db` is the main persistent state file; terminal durability and truthful scrollback depend on tmux-backed sessions plus snapshot-first reconnects.

## Source Control
- Git repository hosted on GitHub: `github.com/sabelosimelane/codedeck`
- Workspace monorepo: root `package.json` with `"workspaces": ["server", "client"]`
- Dependencies hoisted to root `node_modules/` — server and client share the tree
