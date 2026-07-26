#!/usr/bin/env bash
# Rebuild OpenChamber AppImage for computer-use and relaunch it.
#
# Default flow (used when the agent is told «перебілдити» / rebuild):
#   1. git fetch + ff-only pull of the target branch
#   2. bun install
#   3. close existing OpenChamber window/process
#   4. bun run electron:build (native Linux AppImage)
#   5. launch the new AppImage
#
# Usage:
#   ./scripts/computer-use/rebuild-appimage.sh
#   OPENCHAMBER_REBUILD_BRANCH=my-branch ./scripts/computer-use/rebuild-appimage.sh
#   ./scripts/computer-use/rebuild-appimage.sh --no-pull
#   ./scripts/computer-use/rebuild-appimage.sh --skip-launch
#   ./scripts/computer-use/rebuild-appimage.sh --verify
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_common.sh
source "$SCRIPT_DIR/_common.sh"

DO_PULL=1
DO_INSTALL=1
DO_KILL=1
DO_BUILD=1
DO_LAUNCH=1
DO_VERIFY=0

for arg in "$@"; do
  case "$arg" in
    --no-pull) DO_PULL=0 ;;
    --no-install) DO_INSTALL=0 ;;
    --no-kill) DO_KILL=0 ;;
    --skip-build|--no-build) DO_BUILD=0 ;;
    --skip-launch|--no-launch) DO_LAUNCH=0 ;;
    --verify) DO_VERIFY=1 ;;
    -h|--help)
      cat <<'EOF'
Rebuild OpenChamber AppImage for computer-use and relaunch it.

Default: pull branch → bun install → kill old window → electron:build → launch

Env:
  OPENCHAMBER_REBUILD_BRANCH   branch to pull (default: current branch)
  OPENCHAMBER_TARGET_ARCH      x64|arm64 (default: host)
  DISPLAY                      X display (default: :1)
  APPIMAGE_EXTRACT_AND_RUN     set automatically when libfuse.so.2 is missing

Flags:
  --no-pull --no-install --no-kill --skip-build --skip-launch --verify
EOF
      exit 0
      ;;
    *)
      die "unknown arg: $arg (see --help)"
      ;;
  esac
done

cd "$REPO_ROOT"
export OPENCHAMBER_TARGET_ARCH="${OPENCHAMBER_TARGET_ARCH:-$(host_target_arch)}"
ensure_display

started_at="$(date +%s)"
log "repo=$REPO_ROOT arch=$OPENCHAMBER_TARGET_ARCH display=$DISPLAY"

if ((DO_PULL)); then
  branch="$(resolve_branch)"
  log "pull origin/$branch"
  git fetch --prune origin "$branch"
  # Stay on the requested branch if we are not already there.
  current="$(git rev-parse --abbrev-ref HEAD)"
  if [[ "$current" != "$branch" ]]; then
    git checkout "$branch"
  fi
  git pull --ff-only origin "$branch"
  log "HEAD=$(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
fi

if ((DO_INSTALL)); then
  log "bun install"
  bun install
fi

# Close the old UI before the long build so computer-use never drives a stale window.
if ((DO_KILL)); then
  "$SCRIPT_DIR/kill-openchamber.sh"
fi

if ((DO_BUILD)); then
  log "electron:build (AppImage)"
  bun run electron:build
  appimage="$(find_appimage)"
  log "built $appimage"
  if ((DO_VERIFY)); then
    log "verify:linux-appimage"
    bun run --cwd packages/electron verify:linux-appimage "$appimage"
  fi
fi

if ((DO_LAUNCH)); then
  "$SCRIPT_DIR/launch-appimage.sh"
fi

elapsed=$(( $(date +%s) - started_at ))
log "done in ${elapsed}s"
