#!/usr/bin/env bash
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Killing process on port 8888..."
fuser -k 8888/tcp 2>/dev/null || true
sleep 1

echo "==> Building web UI..."
cd "$REPO"
bun run build:web

echo "==> Starting server from local code on 192.168.1.19:8888..."
OPENCHAMBER_DIST_DIR="$REPO/packages/web/dist" \
  nohup bun "$REPO/packages/web/server/index.js" \
    --port 8888 \
    --host 192.168.1.19 \
    > /tmp/openchamber-server.log 2>&1 &

echo "==> Server PID: $!"
echo "==> Logs: tail -f /tmp/openchamber-server.log"
