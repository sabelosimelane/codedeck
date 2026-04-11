#!/usr/bin/env bash
set -e

# ─── CodeDeck Dev Launcher ───────────────────────────────────────────
# Starts the backend (Express + node-pty) and frontend (Vite) servers
# concurrently. Ctrl-C kills both.
# ─────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Optional: prevent macOS idle sleep while CodeDeck is running.
# Set CODEDECK_CAFFEINATE=1 to enable. Re-executes self under caffeinate -i.
if [[ "$CODEDECK_CAFFEINATE" == "1" ]] && command -v caffeinate >/dev/null 2>&1; then
  if [[ -z "$CODEDECK_CAFFEINATED" ]]; then
    export CODEDECK_CAFFEINATED=1
    exec caffeinate -i "$0" "$@"
  fi
fi

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
echo "🖥  Backend  → http://localhost:43001  (server/)"
cd "$ROOT_DIR/server" && npm run dev &

# Start frontend
echo "🌐 Frontend → http://localhost:43000  (client/)"
cd "$ROOT_DIR/client" && npm run dev &

echo ""
echo "Press Ctrl-C to stop both servers."
echo ""

wait
