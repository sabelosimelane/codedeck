# Contributing to CodeDeck

## Prerequisites

- Node.js 22+
- npm 10+
- tmux (optional, for durable terminal sessions)

## Development Setup

```bash
# Clone and install
git clone https://github.com/sabelosimelane/codedeck.git
cd codedeck
npm install

# Start both servers (backend on :43001, frontend on :43000)
./server.sh start

# Open in browser
open http://localhost:43000
```

The Vite dev server on `:43000` proxies `/api/*` and `/ws/*` to Express on `:43001`.

## Running Tests

```bash
cd server && npx vitest --maxWorkers=1
```

The `--maxWorkers=1` flag prevents OOM on development machines.

## Code Style

This project follows the guidelines in [`docs/guidelines/`](docs/guidelines/):

- **Backend as source of truth** — no authoritative state in the frontend
- **Fail visibly** — no silent error swallowing, toast feedback on every action
- **Structured errors** — `{ error: string, detail?: string }` from all API endpoints
- **Vertical slices** — each feature built end-to-end (data → service → API → UI → tests)

Read [`docs/guidelines/instructions.txt`](docs/guidelines/instructions.txt) for the full checklist.

## Project Structure

```
codedeck/
├── server/           # Express backend, WebSocket handler, PTY management
│   ├── index.js      # REST routes and server setup
│   ├── ws-handler.js # WebSocket connection handler
│   └── __tests__/    # Server tests (Vitest + supertest)
├── client/           # React frontend
│   └── src/
│       ├── App.jsx        # Top-level state and layout
│       └── components/    # UI components
├── docs/
│   ├── guidelines/   # Coding standards
│   ├── steering/     # Architecture and tech docs
│   └── specifications/ # Feature specs
└── server.sh         # Service manager (start/stop/restart)
```

See [`docs/steering/structure.md`](docs/steering/structure.md) for the full layout and conventions.

## Pull Requests

- Describe what changed and why
- Include tests if you're touching server code
- Every `fetch()` in the frontend needs error handling and toast feedback
- No `catch(() => {})` — errors must be handled or surfaced
