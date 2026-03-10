#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

run() {
  echo "  $*"
  "$@" || { echo "FAILED: $*"; exit 1; }
}

echo "=== QA: one test suite per change ==="
echo ""

echo "[1.1] Cron/heartbeat config schema (type-check ui)..."
run bun run --cwd packages/ui type-check
echo ""

echo "[1.2] Cron scheduler (job-store + scheduler)..."
run bun test packages/web/server/lib/cron/__tests__/job-store.test.js packages/web/server/lib/cron/__tests__/scheduler.test.js
echo ""

echo "[1.3] Heartbeat loop (runner)..."
run bun test packages/web/server/lib/heartbeat/__tests__/runner.test.js
echo ""

echo "[1.4] Heartbeat API..."
run bun test packages/web/server/lib/heartbeat/__tests__/api.test.js
echo ""

echo "[2.1] Telegram bridge..."
run bun test packages/web/server/lib/telegram/__tests__/bot.test.js packages/web/server/lib/telegram/__tests__/session-manager.test.js packages/web/server/lib/telegram/__tests__/message-formatter.test.js packages/web/server/lib/telegram/__tests__/integration.test.js
echo ""

echo "[2.2] Telegram config..."
run bun test packages/web/server/lib/telegram/__tests__/config.test.js
echo ""

echo "[3.1] Model mode config and types..."
run bun test packages/ui/src/lib/modelModes.test.ts
echo ""

echo "[3.2] Model selector and failover..."
run bun test packages/web/server/lib/model/__tests__/selector.test.js packages/web/server/lib/model/__tests__/integration.test.js
echo ""

echo "[3.3] Model mode UI and API..."
run bun test packages/web/server/lib/model/__tests__/api.test.js
run bun test packages/ui/src/components/sections/openchamber/ModelModeSettings.test.tsx
echo ""

echo "[4.1] Superwords parsing..."
run bun test packages/web/server/lib/skills/superwords.test.js
echo ""

echo "[4.2] Superwords UI..."
run bun test packages/ui/src/components/sections/openchamber/SuperwordsSettings.test.tsx
echo ""

echo "[5.1] soul.md injection..."
run bun test packages/web/server/lib/opencode/soul.test.js packages/web/server/lib/opencode/soul.api.test.js
echo ""

echo "=== All per-change QA passed ==="
