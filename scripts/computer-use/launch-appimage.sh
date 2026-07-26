#!/usr/bin/env bash
# Launch the latest built OpenChamber AppImage for computer-use.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$SCRIPT_DIR/_common.sh"

ensure_display
export OPENCHAMBER_TARGET_ARCH="${OPENCHAMBER_TARGET_ARCH:-$(host_target_arch)}"
appimage_launch_env

APPIMAGE="${1:-}"
if [[ -z "$APPIMAGE" ]]; then
  APPIMAGE="$(find_appimage)"
fi
[[ -f "$APPIMAGE" ]] || die "AppImage not found: $APPIMAGE"
chmod +x "$APPIMAGE"

ln -sfn "$APPIMAGE" "$APPIMAGE_LINK"

# Ensure previous instance is gone before starting a new one.
"$SCRIPT_DIR/kill-openchamber.sh" >/dev/null

log "launching $APPIMAGE"
log "display=$DISPLAY extract_and_run=${APPIMAGE_EXTRACT_AND_RUN:-0} log=$LOG_FILE"

: >"$LOG_FILE"
nohup "$APPIMAGE" >>"$LOG_FILE" 2>&1 &
pid=$!
echo "$pid" >"$PID_FILE"

# Fail fast if the process dies immediately.
sleep 1
if ! kill -0 "$pid" 2>/dev/null; then
  die "AppImage exited immediately; see $LOG_FILE"
fi

# Best-effort wait for a window (does not fail the launch).
if command -v xdotool >/dev/null 2>&1; then
  for _ in $(seq 1 40); do
    if xdotool search --class openchamber >/dev/null 2>&1 \
      || xdotool search --name 'OpenChamber' >/dev/null 2>&1; then
      log "window ready pid=$pid"
      printf '%s\n' "$APPIMAGE"
      exit 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      die "AppImage exited before window appeared; see $LOG_FILE"
    fi
    sleep 0.5
  done
  log "pid=$pid (window not detected yet; app still running)"
else
  log "pid=$pid"
fi

printf '%s\n' "$APPIMAGE"
