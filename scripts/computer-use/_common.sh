#!/usr/bin/env bash
# Shared helpers for AppImage computer-use rebuild/launch scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer explicit repo root so these scripts can live outside the worktree
# (needed when rebuild checks out a branch that does not contain them).
if [[ -n "${OPENCHAMBER_REPO_ROOT:-}" ]]; then
  REPO_ROOT="$OPENCHAMBER_REPO_ROOT"
elif git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO_ROOT="$(git -C "$SCRIPT_DIR/../.." rev-parse --show-toplevel)"
elif git rev-parse --show-toplevel >/dev/null 2>&1; then
  REPO_ROOT="$(git rev-parse --show-toplevel)"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi
STATE_DIR="${OPENCHAMBER_CU_STATE_DIR:-/tmp/openchamber-computer-use}"
PID_FILE="$STATE_DIR/app.pid"
LOG_FILE="$STATE_DIR/app.log"
APPIMAGE_LINK="$STATE_DIR/OpenChamber.AppImage"
DIST_DIR="$REPO_ROOT/packages/electron/dist"

mkdir -p "$STATE_DIR"

log() { printf '[appimage] %s\n' "$*"; }
die() { printf '[appimage] ERROR: %s\n' "$*" >&2; exit 1; }

host_target_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    *) die "unsupported host arch: $(uname -m)" ;;
  esac
}

linux_appimage_suffix() {
  case "${1:-$(host_target_arch)}" in
    x64) printf 'x86_64\n' ;;
    arm64) printf 'arm64\n' ;;
    *) die "unsupported target arch: $1" ;;
  esac
}

ensure_display() {
  export DISPLAY="${DISPLAY:-:1}"
}

resolve_branch() {
  if [[ -n "${OPENCHAMBER_REBUILD_BRANCH:-}" ]]; then
    printf '%s\n' "$OPENCHAMBER_REBUILD_BRANCH"
    return
  fi
  local branch
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
  if [[ "$branch" == "HEAD" ]]; then
    die "detached HEAD; set OPENCHAMBER_REBUILD_BRANCH=<branch>"
  fi
  printf '%s\n' "$branch"
}

find_appimage() {
  local arch_suffix version expected newest
  arch_suffix="$(linux_appimage_suffix "${OPENCHAMBER_TARGET_ARCH:-$(host_target_arch)}")"
  version="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || true)"

  if [[ -n "$version" ]]; then
    expected="$DIST_DIR/OpenChamber-${version}-linux-${arch_suffix}.AppImage"
    if [[ -f "$expected" ]]; then
      printf '%s\n' "$expected"
      return
    fi
  fi

  newest="$(ls -1t "$DIST_DIR"/OpenChamber-*-linux-"${arch_suffix}".AppImage 2>/dev/null | head -n1 || true)"
  [[ -n "$newest" ]] || die "no AppImage found in $DIST_DIR (arch=$arch_suffix)"
  printf '%s\n' "$newest"
}

appimage_launch_env() {
  # Cloud/computer-use VMs often lack FUSE; extract-and-run is the reliable default.
  if [[ -z "${APPIMAGE_EXTRACT_AND_RUN:-}" ]]; then
    if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
      export APPIMAGE_EXTRACT_AND_RUN=1
    fi
  fi
}
