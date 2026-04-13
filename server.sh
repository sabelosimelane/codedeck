#!/bin/bash
# ------------------------------------------------------------
# CodeDeck service manager — start/stop/restart/status/logs
# ------------------------------------------------------------

PORT="${PORT:-43001}"
START_COMMAND="./start.sh"
LOG_DIR="./logs"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/.server.pid"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

mkdir -p "$LOG_DIR"

# ── Helpers ──────────────────────────────────────────────────
is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid=$(cat "$PID_FILE")
    if ps -p "$pid" >/dev/null 2>&1; then
      return 0
    else
      rm -f "$PID_FILE"
    fi
  fi
  return 1
}

port_in_use() {
  lsof -i :"$PORT" -P -n 2>/dev/null | grep -q LISTEN
}

listener_pid() {
  lsof -ti :"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1
}

launch_detached() {
  local command="$1"
  if command -v python3 >/dev/null 2>&1; then
    DETACHED_PID="$(python3 -c 'import subprocess, sys
log_path, launch_command = sys.argv[1:3]
log_file = open(log_path, "ab", buffering=0)
process = subprocess.Popen(
    ["bash", "-c", launch_command],
    stdin=subprocess.DEVNULL,
    stdout=log_file,
    stderr=subprocess.STDOUT,
    start_new_session=True,
    close_fds=True,
)
print(process.pid)
' "$LOG_FILE" "$command")"
  else
    nohup bash -c "$command" >"$LOG_FILE" 2>&1 < /dev/null &
    DETACHED_PID=$!
    disown "$DETACHED_PID" 2>/dev/null || true
  fi
}

# ── Actions ──────────────────────────────────────────────────
start_server() {
  if is_running; then
    echo -e "${YELLOW}Server already running (PID: $(cat $PID_FILE), port: $PORT)${NC}"
    return 0
  fi

  if port_in_use; then
    echo -e "${RED}Port $PORT is already in use${NC}"
    lsof -i :"$PORT" -P -n | grep LISTEN || true
    return 1
  fi

  echo -e "${YELLOW}Starting CodeDeck on port $PORT...${NC}"
  rm -f "$LOG_DIR"/*.log

  if ! launch_detached "$START_COMMAND"; then
    echo -e "${RED}Failed to launch server${NC}"
    return 1
  fi
  echo "$DETACHED_PID" >"$PID_FILE"

  echo -n "Waiting for server"
  for i in {1..30}; do
    local active_pid
    active_pid="$(listener_pid)"
    if [[ -n "$active_pid" ]]; then
      echo "$active_pid" >"$PID_FILE"
      echo -e "\n${GREEN}CodeDeck started${NC}"
      echo -e "  URL:  ${GREEN}http://localhost:43000${NC}"
      echo -e "  PID:  ${GREEN}$active_pid${NC}"
      echo -e "  Logs: ${GREEN}$LOG_FILE${NC}"
      return 0
    fi
    echo -n "."
    sleep 1
  done

  echo -e "\n${RED}Server failed to start within 30s${NC}"
  tail -20 "$LOG_FILE" 2>/dev/null
  is_running && kill "$(cat $PID_FILE)" 2>/dev/null
  rm -f "$PID_FILE"
  return 1
}

stop_server() {
  if ! is_running; then
    echo -e "${YELLOW}Server is not running${NC}"
    return 0
  fi

  local pid
  pid=$(cat "$PID_FILE")
  echo -e "${YELLOW}Stopping server (PID: $pid)...${NC}"
  kill "$pid" 2>/dev/null

  for i in {1..10}; do
    if ! ps -p "$pid" >/dev/null 2>&1; then
      echo -e "${GREEN}Server stopped${NC}"
      rm -f "$PID_FILE"
      return 0
    fi
    sleep 1
  done

  kill -9 "$pid" 2>/dev/null
  rm -f "$PID_FILE"
  echo -e "${GREEN}Server force-killed${NC}"
}

check_status() {
  if is_running; then
    local pid
    pid=$(cat "$PID_FILE")
    echo -e "${GREEN}Server is running${NC} (PID: $pid, port: $PORT)"
    [[ -f "$LOG_FILE" ]] && { echo -e "\n${YELLOW}Recent logs:${NC}"; tail -5 "$LOG_FILE"; }
  else
    echo -e "${RED}Server is not running${NC}"
    port_in_use && echo -e "${YELLOW}Warning: port $PORT is in use by another process${NC}"
  fi
}

show_logs() {
  if [[ -f "$LOG_FILE" ]]; then
    tail -n 200 "$LOG_FILE"
  else
    echo -e "${RED}No log file found${NC}"
  fi
}

# ── CLI ──────────────────────────────────────────────────────
case "$1" in
  start)   start_server   ;;
  stop)    stop_server     ;;
  restart) is_running && stop_server; start_server ;;
  status)  check_status    ;;
  logs)    show_logs       ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac

exit $?
