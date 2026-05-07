#!/usr/bin/env bash
set -e

# ─── CodeDeck Dev Launcher ───────────────────────────────────────────
# Starts the backend (Express + node-pty) and frontend (Vite) servers
# concurrently. Ctrl-C kills both.
# ─────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
EXIT_EVENT_FILE=""

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

EXIT_EVENT_FILE="$(mktemp "${TMPDIR:-/tmp}/codedeck-start-exit.XXXXXX")"
BACKEND_PID=""
FRONTEND_PID=""
CLEANUP_RUNNING=0
EXIT_STATUS=0
EXITED_SERVICE=""
EXITED_CHILD_PID=""

mkdir -p "$LOG_DIR"

run_service() {
  local label="$1"
  local dir="$2"

  (
    SERVICE_CHILD_PID=""

    stop_service_child() {
      trap - INT TERM
      if [[ -n "$SERVICE_CHILD_PID" ]] && kill -0 "$SERVICE_CHILD_PID" 2>/dev/null; then
        echo "[launcher] $label received shutdown signal; stopping child_pid=$SERVICE_CHILD_PID"
        kill "$SERVICE_CHILD_PID" 2>/dev/null || true
        wait "$SERVICE_CHILD_PID" 2>/dev/null || true
      fi
      exit 143
    }

    trap stop_service_child INT TERM

    cd "$dir"
    if [[ "$label" == "frontend" ]]; then
      # Vite treats stdin EOF as a normal shutdown unless CI=true; server.sh launches detached.
      CI=true npm run dev &
    else
      npm run dev &
    fi
    SERVICE_CHILD_PID=$!
    echo "[launcher] $label npm pid=$SERVICE_CHILD_PID"

    set +e
    wait "$SERVICE_CHILD_PID"
    local status=$?
    set -e

    trap - INT TERM
    echo "[launcher] $label exited child_pid=$SERVICE_CHILD_PID status=$status"
    printf '%s:%s:%s\n' "$label" "$status" "$SERVICE_CHILD_PID" >> "$EXIT_EVENT_FILE"
    exit "$status"
  ) &

  SERVICE_PID=$!
  echo "[launcher] $label supervisor pid=$SERVICE_PID"
}

wait_for_first_exit() {
  while [[ ! -s "$EXIT_EVENT_FILE" ]]; do
    sleep 1
  done

  local event
  IFS= read -r event < "$EXIT_EVENT_FILE"
  IFS=':' read -r EXITED_SERVICE EXIT_STATUS EXITED_CHILD_PID <<< "$event"

  if ! [[ "$EXIT_STATUS" =~ ^[0-9]+$ ]]; then
    EXIT_STATUS=1
  fi

  local supervisor_pid="unknown"
  case "$EXITED_SERVICE" in
    backend) supervisor_pid="$BACKEND_PID" ;;
    frontend) supervisor_pid="$FRONTEND_PID" ;;
  esac

  echo "[launcher] $EXITED_SERVICE stopped supervisor_pid=$supervisor_pid child_pid=$EXITED_CHILD_PID status=$EXIT_STATUS; stopping remaining services."
}

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

  rm -f "$EXIT_EVENT_FILE"
  echo "✅ All servers stopped."
}
trap cleanup EXIT INT TERM

echo "🚀 Starting CodeDeck..."
echo ""

# Start backend
echo "🖥  Backend  → http://localhost:43001  (server/)"
run_service "backend" "$ROOT_DIR/server"
BACKEND_PID=$SERVICE_PID

# Start frontend
echo "🌐 Frontend → http://localhost:43000  (client/)"
run_service "frontend" "$ROOT_DIR/client"
FRONTEND_PID=$SERVICE_PID

echo ""
echo "Press Ctrl-C to stop both servers."
echo ""

wait_for_first_exit
cleanup
exit "$EXIT_STATUS"
