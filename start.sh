#!/usr/bin/env bash
set -e

# ─── CodeDeck Dev Launcher ───────────────────────────────────────────
# Starts the backend (Express + node-pty) and frontend (Vite) servers
# concurrently. Ctrl-C kills both.
# ─────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

cleanup() {
  echo ""
  echo "⏹  Shutting down..."
  kill 0 2>/dev/null
  wait 2>/dev/null
  echo "✅ All servers stopped."
}
trap cleanup EXIT INT TERM

echo "🚀 Starting CodeDeck..."
echo ""

# Start backend
echo "🖥  Backend  → http://localhost:3001  (server/)"
cd "$ROOT_DIR/server" && npm run dev &

# Start frontend
echo "🌐 Frontend → http://localhost:3000  (client/)"
cd "$ROOT_DIR/client" && npm run dev &

echo ""
echo "Press Ctrl-C to stop both servers."
echo ""

wait
