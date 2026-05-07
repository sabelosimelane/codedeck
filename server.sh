#!/bin/bash
# ------------------------------------------------------------
# CodeDeck service manager — start/stop/restart/status/logs
# ------------------------------------------------------------

PORT="${PORT:-43001}"
FRONTEND_PORT="${FRONTEND_PORT:-43000}"
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
  local port="$1"
  lsof -i :"$port" -P -n 2>/dev/null | grep -q LISTEN
}

listener_pid() {
  local port="$1"
  lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null | head -n 1
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

  if port_in_use "$PORT"; then
    echo -e "${RED}Port $PORT is already in use${NC}"
    lsof -i :"$PORT" -P -n | grep LISTEN || true
    return 1
  fi

  if port_in_use "$FRONTEND_PORT"; then
    echo -e "${RED}Port $FRONTEND_PORT is already in use${NC}"
    lsof -i :"$FRONTEND_PORT" -P -n | grep LISTEN || true
    return 1
  fi

  echo -e "${YELLOW}Starting CodeDeck on port $PORT...${NC}"
  rm -f "$LOG_DIR"/*.log

  if ! launch_detached "$START_COMMAND"; then
    echo -e "${RED}Failed to launch server${NC}"
    return 1
  fi
  echo "$DETACHED_PID" >"$PID_FILE"

  echo -n "Waiting for servers"
  for i in {1..30}; do
    if ! ps -p "$DETACHED_PID" >/dev/null 2>&1; then
      echo -e "\n${RED}Launcher exited before both servers became ready${NC}"
      tail -20 "$LOG_FILE" 2>/dev/null
      rm -f "$PID_FILE"
      return 1
    fi

    local backend_pid
    local frontend_pid
    backend_pid="$(listener_pid "$PORT")"
    frontend_pid="$(listener_pid "$FRONTEND_PORT")"
    if [[ -n "$backend_pid" && -n "$frontend_pid" ]]; then
      echo -e "\n${GREEN}CodeDeck started${NC}"
      echo -e "  Frontend URL: ${GREEN}http://localhost:$FRONTEND_PORT${NC}"
      echo -e "  Backend URL:  ${GREEN}http://localhost:$PORT${NC}"
      echo -e "  Launcher PID: ${GREEN}$DETACHED_PID${NC}"
      echo -e "  Frontend PID: ${GREEN}$frontend_pid${NC}"
      echo -e "  Backend PID:  ${GREEN}$backend_pid${NC}"
      echo -e "  Logs:         ${GREEN}$LOG_FILE${NC}"
      return 0
    fi
    echo -n "."
    sleep 1
  done

  echo -e "\n${RED}Servers failed to start within 30s${NC}"
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
    local backend_pid
    local frontend_pid
    local missing=0
    pid=$(cat "$PID_FILE")
    backend_pid="$(listener_pid "$PORT")"
    frontend_pid="$(listener_pid "$FRONTEND_PORT")"
    if [[ -n "$backend_pid" && -n "$frontend_pid" ]]; then
      echo -e "${GREEN}Server is running${NC} (launcher PID: $pid, backend port: $PORT, frontend port: $FRONTEND_PORT)"
    else
      missing=1
      echo -e "${YELLOW}Server is degraded${NC} (launcher PID: $pid, backend port: $PORT, frontend port: $FRONTEND_PORT)"
    fi

    if [[ -n "$frontend_pid" ]]; then
      echo -e "${GREEN}Frontend listener PID:${NC} $frontend_pid"
    else
      echo -e "${RED}Frontend listener missing:${NC} port $FRONTEND_PORT is not accepting connections"
    fi

    if [[ -n "$backend_pid" ]]; then
      echo -e "${GREEN}Backend listener PID:${NC} $backend_pid"
    else
      echo -e "${RED}Backend listener missing:${NC} port $PORT is not accepting connections"
    fi

    [[ -f "$LOG_FILE" ]] && { echo -e "\n${YELLOW}Recent logs:${NC}"; tail -5 "$LOG_FILE"; }
    return "$missing"
  else
    echo -e "${RED}Server is not running${NC}"
    port_in_use "$PORT" && echo -e "${YELLOW}Warning: backend port $PORT is in use by another process${NC}"
    port_in_use "$FRONTEND_PORT" && echo -e "${YELLOW}Warning: frontend port $FRONTEND_PORT is in use by another process${NC}"
    return 1
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
