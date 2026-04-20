#!/usr/bin/env bash
set -e

# ─── CodeDeck Dev Launcher ───────────────────────────────────────────
# Starts the backend (Express + node-pty) and frontend (Vite) servers
# concurrently. Ctrl-C kills both.
# ─────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ $# -gt 0 ]]; then
  echo "Usage: ./start.sh"
  echo "For service management use: ./server.sh {start|stop|restart|status|logs}"
  exit 1
fi

# Optional: prevent macOS idle sleep while CodeDeck is running.
# Set CODEDECK_CAFFEINATE=1 to enable. Re-executes self under caffeinate -i.
if [[ "$CODEDECK_CAFFEINATE" == "1" ]] && command -v caffeinate >/dev/null 2>&1; then
  if [[ -z "$CODEDECK_CAFFEINATED" ]]; then
    export CODEDECK_CAFFEINATED=1
    exec caffeinate -i "$0" "$@"
  fi
fi

BACKEND_PID=""
FRONTEND_PID=""
CLEANUP_RUNNING=0

cleanup() {
  if [[ "$CLEANUP_RUNNING" == "1" ]]; then
    return
  fi
  CLEANUP_RUNNING=1
  trap - EXIT INT TERM

  echo ""
  echo "⏹  Shutting down..."

  local pids=()
  [[ -n "$BACKEND_PID" ]] && pids+=("$BACKEND_PID")
  [[ -n "$FRONTEND_PID" ]] && pids+=("$FRONTEND_PID")

  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  if [[ ${#pids[@]} -gt 0 ]]; then
    wait "${pids[@]}" 2>/dev/null || true
  fi

  echo "✅ All servers stopped."
}
trap cleanup EXIT INT TERM

echo "🚀 Starting CodeDeck..."
echo ""

# Start backend
echo "🖥  Backend  → http://localhost:43001  (server/)"
(
  cd "$ROOT_DIR/server"
  exec npm run dev
) &
BACKEND_PID=$!

# Start frontend
echo "🌐 Frontend → http://localhost:43000  (client/)"
(
  cd "$ROOT_DIR/client"
  exec npm run dev
) &
FRONTEND_PID=$!

echo ""
echo "Press Ctrl-C to stop both servers."
echo ""

wait
