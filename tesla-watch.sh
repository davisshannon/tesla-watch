#!/usr/bin/env bash
set -euo pipefail

# ── Constants ───────────────────────────────────────────────────────────────
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER_LABEL="com.tesla-watch.checker"
SERVER_LABEL="com.tesla-watch.server"
CHECKER_PLIST="$HOME/Library/LaunchAgents/${CHECKER_LABEL}.plist"
SERVER_PLIST="$HOME/Library/LaunchAgents/${SERVER_LABEL}.plist"
CONFIG="$DIR/tesla-watch.config.json"
DASHBOARD="http://localhost:3737"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}→${RESET} $*"; }
success() { echo -e "${GREEN}✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}!${RESET} $*"; }
error()   { echo -e "${RED}✗${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── Helpers ─────────────────────────────────────────────────────────────────
node_path() {
  local n
  n=$(command -v node 2>/dev/null || true)
  if [[ -z "$n" ]]; then
    for p in __NODE__ /usr/local/bin/node; do
      [[ -x "$p" ]] && echo "$p" && return
    done
    error "Node.js not found. Install it from https://nodejs.org or via Homebrew: brew install node"
    exit 1
  fi
  echo "$n"
}

install_plist() {
  local src="$1" dest="$2" node="$3"
  sed \
    -e "s|__NODE__|${node}|g" \
    -e "s|__INSTALL_DIR__|${DIR}|g" \
    "$src" > "$dest"
  success "Installed $(basename "$dest")"
}

plist_running() {
  launchctl list "$1" 2>/dev/null | grep -q '"PID"'
}

plist_loaded() {
  launchctl list "$1" &>/dev/null
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_setup() {
  header "Tesla Watch — Setup"

  # 1. Node
  local node; node=$(node_path)
  success "Node.js: $node ($($node --version))"

  # 2. Dependencies
  if [[ ! -d "$DIR/node_modules" ]]; then
    info "Installing npm dependencies…"
    (cd "$DIR" && npm install --silent)
    success "Dependencies installed"
  else
    success "Dependencies already installed"
  fi

  # 3. Config
  if [[ ! -f "$CONFIG" ]]; then
    info "Creating config from example…"
    cp "$DIR/tesla-watch.config.example.json" "$CONFIG"
    warn "Config created at: $CONFIG"
    warn "Edit it to set your iMessage destination (notify.imessage.to)"
    warn "Or configure everything in the dashboard Settings tab after starting."
  else
    success "Config exists: $CONFIG"
  fi

  # 4. Data directory
  mkdir -p "$DIR/data"
  success "Data directory ready"

  # 5. Plists
  info "Installing launchd jobs…"
  install_plist "$DIR/tesla-watch.plist"        "$CHECKER_PLIST" "$node"
  install_plist "$DIR/tesla-watch-server.plist"  "$SERVER_PLIST"  "$node"

  # 6. Load
  info "Loading launchd jobs…"
  if plist_loaded "$CHECKER_LABEL"; then
    launchctl unload "$CHECKER_PLIST" 2>/dev/null || true
  fi
  launchctl load "$CHECKER_PLIST"
  success "Checker loaded (runs every 5 min)"

  if plist_loaded "$SERVER_LABEL"; then
    launchctl unload "$SERVER_PLIST" 2>/dev/null || true
  fi
  launchctl load "$SERVER_PLIST"
  success "Web server loaded"

  sleep 2
  header "Setup complete"
  echo -e "  Dashboard: ${CYAN}${DASHBOARD}${RESET}"
  echo -e "  Config:    ${CYAN}${CONFIG}${RESET}"
  echo -e "  Logs:      ${CYAN}${DIR}/data/${RESET}"
  echo ""
  echo -e "  Run ${BOLD}./tesla-watch.sh status${RESET} to check everything is running."
}

cmd_start() {
  header "Starting Tesla Watch"

  if ! plist_loaded "$CHECKER_LABEL"; then
    [[ ! -f "$CHECKER_PLIST" ]] && { error "Not set up yet. Run: ./tesla-watch.sh setup"; exit 1; }
    launchctl load "$CHECKER_PLIST"
  fi
  success "Checker loaded"

  if ! plist_loaded "$SERVER_LABEL"; then
    launchctl load "$SERVER_PLIST"
  fi
  success "Web server loaded"

  sleep 1
  cmd_status
}

cmd_stop() {
  header "Stopping Tesla Watch"

  if plist_loaded "$SERVER_LABEL"; then
    launchctl unload "$SERVER_PLIST" 2>/dev/null && success "Web server stopped" || warn "Server wasn't running"
  else
    warn "Web server not loaded"
  fi

  if plist_loaded "$CHECKER_LABEL"; then
    launchctl unload "$CHECKER_PLIST" 2>/dev/null && success "Checker stopped" || warn "Checker wasn't loaded"
  else
    warn "Checker not loaded"
  fi
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_status() {
  header "Tesla Watch — Status"

  # Checker
  if plist_loaded "$CHECKER_LABEL"; then
    local exit_code
    exit_code=$(launchctl list "$CHECKER_LABEL" 2>/dev/null | grep '"LastExitStatus"' | grep -oE '[0-9]+' || echo "?")
    if [[ "$exit_code" == "0" || "$exit_code" == "?" ]]; then
      success "Checker      loaded (last exit: ${exit_code})"
    else
      warn    "Checker      loaded (last exit: ${exit_code} — check logs)"
    fi
  else
    error   "Checker      not loaded"
  fi

  # Server
  if plist_running "$SERVER_LABEL"; then
    local pid
    pid=$(launchctl list "$SERVER_LABEL" 2>/dev/null | grep '"PID"' | grep -oE '[0-9]+' || echo "?")
    success "Web server   running (PID ${pid}) — ${DASHBOARD}"
  elif plist_loaded "$SERVER_LABEL"; then
    warn    "Web server   loaded but not running (crashed?)"
  else
    error   "Web server   not loaded"
  fi

  # Chrome
  if pgrep -f "remote-debugging-port=9222" &>/dev/null; then
    success "Chrome       running (CDP on 9222)"
  else
    warn    "Chrome       not running (will launch on next check)"
  fi

  # DB
  if [[ -f "$DIR/data/tesla-watch.db" ]]; then
    local size; size=$(du -sh "$DIR/data/tesla-watch.db" | cut -f1)
    success "Database     $DIR/data/tesla-watch.db (${size})"
  else
    warn    "Database     not created yet (runs on first check)"
  fi

  echo ""
}

cmd_logs() {
  local target="${1:-all}"
  case "$target" in
    checker|check) tail -50f "$DIR/data/tesla-watch.log" ;;
    server)        tail -50f "$DIR/data/server.log" ;;
    launchd)       tail -50f "$DIR/data/launchd.log" ;;
    all|*)
      echo -e "${BOLD}=== Checker log (last 20 lines) ===${RESET}"
      tail -20 "$DIR/data/tesla-watch.log" 2>/dev/null || warn "No checker log yet"
      echo -e "\n${BOLD}=== Server log (last 10 lines) ===${RESET}"
      tail -10 "$DIR/data/server.log" 2>/dev/null || warn "No server log yet"
      ;;
  esac
}

cmd_run_now() {
  info "Running one-shot inventory check…"
  local node; node=$(node_path)
  "$node" "$DIR/src/cli.mjs" run --config "$CONFIG"
}

cmd_uninstall() {
  header "Uninstalling Tesla Watch launchd jobs"
  read -rp "This will unload and remove the launchd plists. Continue? [y/N] " confirm
  [[ "$confirm" != "y" && "$confirm" != "Y" ]] && { info "Aborted."; exit 0; }

  if plist_loaded "$SERVER_LABEL"; then
    launchctl unload "$SERVER_PLIST" 2>/dev/null || true
  fi
  rm -f "$SERVER_PLIST" && success "Removed $SERVER_PLIST"

  if plist_loaded "$CHECKER_LABEL"; then
    launchctl unload "$CHECKER_PLIST" 2>/dev/null || true
  fi
  rm -f "$CHECKER_PLIST" && success "Removed $CHECKER_PLIST"

  warn "Config and database kept. Remove $DIR/data/ and $CONFIG manually if needed."
}

cmd_help() {
  echo -e "${BOLD}tesla-watch.sh${RESET} — Tesla AU inventory monitor"
  echo ""
  echo -e "${BOLD}Usage:${RESET}"
  echo "  ./tesla-watch.sh <command>"
  echo ""
  echo -e "${BOLD}Commands:${RESET}"
  echo "  setup       Install dependencies, create config, install & load launchd jobs"
  echo "  start       Load launchd jobs (checker + web server)"
  echo "  stop        Unload launchd jobs"
  echo "  restart     Stop then start"
  echo "  status      Show running state of all components"
  echo "  logs        Tail recent logs (checker + server)"
  echo "  logs check  Follow checker log"
  echo "  logs server Follow server log"
  echo "  run         Run one inventory check right now"
  echo "  uninstall   Unload and remove launchd plists"
  echo "  help        Show this help"
  echo ""
  echo -e "  Dashboard: ${CYAN}${DASHBOARD}${RESET}"
}

# ── Dispatch ─────────────────────────────────────────────────────────────────
case "${1:-help}" in
  setup)     cmd_setup ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs "${2:-all}" ;;
  run)       cmd_run_now ;;
  uninstall) cmd_uninstall ;;
  help|--help|-h) cmd_help ;;
  *) error "Unknown command: $1"; cmd_help; exit 1 ;;
esac
