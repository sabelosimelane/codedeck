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

Prerequisites: Node.js 22+, npm 10+

```bash
# Install all dependencies (workspace root installs both server and client)
npm install

# Start both servers (backend :43001, frontend :43000)
./start.sh

# Or use server.sh for background management
./server.sh start    # Start in background
./server.sh stop     # Stop gracefully
./server.sh restart  # Restart
./server.sh status   # Check status
./server.sh logs     # Show recent logs
```

Open `http://localhost:43000` in the browser.

## Build & Run Commands
- Install deps: `npm install` (from project root)
- Start both servers: `./server.sh start` (uses `./start.sh` internally)
- Start backend only: `cd server && node index.js`
- Start frontend only: `cd client && npx vite`
- Build client: `cd client && npx vite build`
- Run server tests: `cd server && npx vitest --maxWorkers=1` (OOM prevention)

## Infrastructure
- **SQLite**: embedded, file-based at `~/.codedeck.db`. WAL mode enabled, foreign keys on. No migration tool — schema created via `CREATE TABLE IF NOT EXISTS` in `server/db.js`.
- **Vite dev server**: runs on `:43000`, proxies `/api/*` and `/ws/*` to Express on `:43001`.
- **No Docker**: runs directly on the local machine. No containerization needed.
- **No CI/CD**: runs locally. Contributions welcome to add CI.

## Environment & Configuration
- No environment variables required for basic operation
- `PORT` env var optionally overrides backend port (default: 43001)
- Application config stored in SQLite `configs` table (key-value pairs)
- `~/.codedeck.db` is the sole persistent state file

## Source Control
- Git repository hosted on GitHub: `github.com/sabelosimelane/codedeck`
- Workspace monorepo: root `package.json` with `"workspaces": ["server", "client"]`
- Dependencies hoisted to root `node_modules/` — server and client share the tree
