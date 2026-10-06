#!/usr/bin/env bash
# launch_all.sh — open 5 terminals for the Warehouse Robot Dashboard.
#
#   1. Zenoh Topics bridge   (REST 7777)
#   2. Zenoh Services bridge (REST 8888)
#   3. Zenoh Actions bridge  (REST 9999)
#   4. FastAPI backend       (8090)
#   5. Vite frontend         (5173)
#
# Usage:  ./launch_all.sh          start everything
#         ./launch_all.sh stop     stop everything
#
# Place this file in warehouse-robot-app/ (next to README.md) and chmod +x it.
# Every terminal stays open after its process exits, so you can read the error.
# Each service also writes to logs/<name>.log

set -u

# ── Configuration (edit if your paths differ) ─────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROS_SETUP="${ROS_SETUP:-/opt/ros/jazzy/setup.bash}"
WS_SETUP="${WS_SETUP:-$HOME/AGV/sim_ws/install/setup.bash}"
UVICORN="${UVICORN:-$HOME/.local/bin/uvicorn}"
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-88}"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# ── stop mode ─────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "stop" ]]; then
  echo "Stopping all services..."
  pkill -f zenoh-bridge-ros2dds 2>/dev/null
  pkill -f "uvicorn app.main:app" 2>/dev/null
  pkill -f "vite" 2>/dev/null
  echo "Done. (Close the terminal windows manually if you want them gone.)"
  exit 0
fi

# ── Pre-flight checks ─────────────────────────────────────────────────────────
missing=0
check() { command -v "$1" >/dev/null 2>&1 || { echo "MISSING: $1  ($2)"; missing=1; }; }
check zenoh-bridge-ros2dds "see app/zenoh_download_cmd.md"
check npm                  "sudo apt install npm"
[[ -x "$UVICORN" ]] || command -v uvicorn >/dev/null 2>&1 || {
  echo "MISSING: uvicorn (pip install --user --break-system-packages -r backend/requirements.txt)"; missing=1; }
[[ -f "$ROS_SETUP" ]] || { echo "MISSING: $ROS_SETUP"; missing=1; }
[[ -f "$WS_SETUP"  ]] || { echo "MISSING: $WS_SETUP (build sim_ws or set WS_SETUP=...)"; missing=1; }
(( missing )) && { echo "Fix the above and re-run."; exit 1; }
command -v uvicorn >/dev/null 2>&1 && UVICORN="$(command -v uvicorn)"

# ── Terminal detection ────────────────────────────────────────────────────────
open_term() {   # open_term <title> <inner-command-string>
  local title="$1" cmd="$2"
  # Wrapper: run the command, tee to log, then keep the shell open on exit/crash
  local wrapped="$cmd 2>&1 | tee -a '$LOG_DIR/${title// /_}.log'; rc=\${PIPESTATUS[0]}; echo; echo \"[\$rc] '$title' exited. Log: $LOG_DIR/${title// /_}.log\"; exec bash"

  if   command -v gnome-terminal   >/dev/null 2>&1; then gnome-terminal --title="$title" -- bash -c "$wrapped" &
  elif command -v konsole          >/dev/null 2>&1; then konsole --new-tab -p tabtitle="$title" -e bash -c "$wrapped" &
  elif command -v xfce4-terminal   >/dev/null 2>&1; then xfce4-terminal --title="$title" -e "bash -c \"$wrapped\"" &
  elif command -v x-terminal-emulator >/dev/null 2>&1; then x-terminal-emulator -T "$title" -e bash -c "$wrapped" &
  elif command -v xterm            >/dev/null 2>&1; then xterm -T "$title" -e bash -c "$wrapped" &
  else echo "No supported terminal emulator found (gnome-terminal/konsole/xfce4-terminal/xterm)."; exit 1
  fi
  sleep 0.4
}

SRC_ROS="source '$ROS_SETUP' && source '$WS_SETUP' && export ROS_DOMAIN_ID=$ROS_DOMAIN_ID"

echo "Launching 5 terminals from: $ROOT"

# 1-3: Zenoh bridges (start first, backend depends on them)
open_term "1 Zenoh Topics"   "$SRC_ROS && cd '$ROOT/zenoh_scripts' && zenoh-bridge-ros2dds -c zenoh_topics.json5"
open_term "2 Zenoh Services" "$SRC_ROS && cd '$ROOT/zenoh_scripts' && zenoh-bridge-ros2dds -c zenoh_services.json5"
open_term "3 Zenoh Actions"  "$SRC_ROS && cd '$ROOT/zenoh_scripts' && zenoh-bridge-ros2dds -c zenoh_actions.json5"

# Give the bridges a moment to bind their REST ports
sleep 3

# 4: Backend
open_term "4 Backend" "$SRC_ROS && cd '$ROOT/backend' && '$UVICORN' app.main:app --host :: --port 8090 --reload"

# 5: Frontend (auto npm install on first run)
open_term "5 Frontend" "cd '$ROOT/frontend' && { [ -d node_modules ] || npm install; } && FORCE_COLOR=1 npm run dev"

echo
echo "All terminals launched."
echo "  Dashboard : http://localhost:5173"
echo "  Logs      : $LOG_DIR/"
echo "  Stop all  : ./launch_all.sh stop"
