# OpenChamber Fork + Features — Progress

**Plan:** Fork openchamber, add cron/heartbeat, Telegram, model modes, superwords, soul.md, provider duplication.

| Phase | Task | Status | Notes |
|-------|------|--------|--------|
| 0 | 0.1 Fork and clone OpenChamber | Done | Clone, install, build |
| 1 | 1.1 Cron/heartbeat config schema | Done | cronHeartbeatSchema.ts, openchamberConfig |
| 1 | 1.2 Cron scheduler in server | Done | job-store, scheduler, API, UI, skills, 32 tests |
| 1 | 1.3 Heartbeat loop | Done | runner.js, HEARTBEAT_OK, 26 tests |
| 1 | 1.4 Cron/heartbeat UI and API | Done | HeartbeatSettings, API routes, 36 tests |
| 2 | 2.1 Telegram bridge | Done | packages/web/server/lib/telegram, 28 tests |
| 2 | 2.2 Telegram config and UI | Done | TelegramSettings, GET/PATCH /api/telegram, 54 tests |
| 3 | 3.1 Model mode config and types | Done | modelModes.ts, 33 tests |
| 3 | 3.2 Model selector and failover | Done | selector.js, integration.js, 59 tests |
| 3 | 3.3 Model mode UI | Done | ModelModeSettings, GET/PATCH /api/model-mode, 97 tests |
| 4 | 4.1 Superwords config and parsing | Done | superwords.js, message path integration, 23 tests |
| 4 | 4.2 Superwords UI and docs | Done | SuperwordsSettings, docs/SUPERWORDS.md, 12 tests |
| 5 | 5.1 soul.md injection | Done | soul.js, /api/config/soul, 17 tests |
| 5 | 5.2 soul.md in UI | In progress | Special badge/icon, create from template |
| 6 | 6.1 Multi-account provider config | Pending | |
| 6 | 6.2 Usage tracking per account | Pending | |
| 6 | 6.3 Account selection and usage UI | Pending | |

**Verification:**
- **Build:** Passes after excluding `src/**/*.test.tsx` from UI tsconfig (test files use `bun:test`; build uses tsc).
- **Type-check:** Run `bun run type-check` (can be slow).
- **Lint:** Run `bun run lint`.
- **Tests:** `bun run --cwd packages/ui test`; server tests under `packages/web/server/lib/*/__tests__/`.
- **QA (one test suite per change):** Run `bun run qa` (executes `scripts/qa-per-change.sh` — one tester per phase/task).
