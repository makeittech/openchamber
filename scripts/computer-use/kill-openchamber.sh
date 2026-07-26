#!/usr/bin/env bash
# Close any running OpenChamber AppImage / desktop windows for computer-use.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$SCRIPT_DIR/_common.sh"

ensure_display

log "closing existing OpenChamber windows/processes"

# Prefer graceful window close first (computer-use friendly).
if command -v xdotool >/dev/null 2>&1; then
  mapfile -t windows < <(xdotool search --class openchamber 2>/dev/null || true)
  if ((${#windows[@]} == 0)); then
    mapfile -t windows < <(xdotool search --name 'OpenChamber' 2>/dev/null || true)
  fi
  if ((${#windows[@]} > 0)); then
    for wid in "${windows[@]}"; do
      [[ -n "$wid" ]] || continue
      xdotool windowkill "$wid" 2>/dev/null || true
    done
  fi
fi

# Tracked launch from these scripts.
if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
    sleep 0.4
    kill -9 "$old_pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# Broader cleanup for AppImage / Electron children left behind.
pkill -f 'OpenChamber-.*\.AppImage' 2>/dev/null || true
pkill -f '/tmp/\.mount_OpenC' 2>/dev/null || true
pkill -f 'openchamber-computer-use/OpenChamber\.AppImage' 2>/dev/null || true
# Packaged binary name inside AppImage extract dirs / electron-builder output.
pkill -f '/tmp/.*openchamber.*/openchamber' 2>/dev/null || true

# Wait briefly for processes to die so relaunch does not race.
for _ in 1 2 3 4 5; do
  if ! pgrep -af 'OpenChamber-.*\.AppImage|/tmp/\.mount_OpenC|openchamber-computer-use/OpenChamber\.AppImage' >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done

log "closed"
