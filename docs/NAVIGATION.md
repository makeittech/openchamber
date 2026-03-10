# OpenChamber Fork — Code Navigation

Key files by feature for agents and developers.

## Phase 0 — Baseline
- Root: `/home/ubuntu/projects/openchamber`
- Build: `bun run build` (root), `bun run --cwd packages/web build`, `bun run --cwd packages/ui build`

## Phase 1 — Cron & Heartbeat
- Config types: `packages/ui/src/lib/cronHeartbeatSchema.ts`, `packages/ui/src/lib/openchamberConfig.ts`
- Cron: `packages/web/server/lib/cron/job-store.js`, `packages/web/server/lib/cron/scheduler.js`, `packages/web/server/lib/cron/index.js`
- Cron tests: `packages/web/server/lib/cron/__tests__/job-store.test.js`, `packages/web/server/lib/cron/__tests__/scheduler.test.js`
- Heartbeat: `packages/web/server/lib/heartbeat/runner.js`, `packages/web/server/lib/heartbeat/index.js`
- Heartbeat tests: `packages/web/server/lib/heartbeat/__tests__/runner.test.js`, `packages/web/server/lib/heartbeat/__tests__/api.test.js`
- UI: `packages/ui/src/components/sections/openchamber/CronSettings.tsx`, `HeartbeatSettings.tsx`
- API: cron routes and heartbeat routes in `packages/web/server/index.js`
- LLM skill: `.opencode/skills/cron/SKILL.md`

## Phase 2 — Telegram
- Bridge: `packages/web/server/lib/telegram/index.js`, `bot.js`, `session-manager.js`, `message-formatter.js`
- Tests: `packages/web/server/lib/telegram/__tests__/*.test.js`
- UI: `packages/ui/src/components/sections/openchamber/TelegramSettings.tsx`
- API: GET/PATCH `/api/telegram` in `packages/web/server/index.js`

## Phase 3 — Model Modes
- Types: `packages/ui/src/lib/modelModes.ts`, `packages/ui/src/lib/modelModes.test.ts`
- Selector: `packages/web/server/lib/model/selector.js`, `integration.js`, `index.js`
- Tests: `packages/web/server/lib/model/__tests__/selector.test.js`, `integration.test.js`
- UI: `packages/ui/src/components/sections/openchamber/ModelModeSettings.tsx`
- API: GET/PATCH `/api/model-mode` in `packages/web/server/index.js`

## Phase 4 — Superwords
- Parser: `packages/web/server/lib/skills/superwords.js`, `packages/web/server/lib/skills/superwords.test.js`
- Config: `superwords` in `packages/ui/src/lib/openchamberConfig.ts`
- Integration: message path in `packages/web/server/index.js` (session message handler)
- UI: `packages/ui/src/components/sections/openchamber/SuperwordsSettings.tsx`
- Docs: `docs/SUPERWORDS.md`

## Phase 5 — soul.md
- Loader: `packages/web/server/lib/opencode/soul.js`
- Tests: `packages/web/server/lib/opencode/soul.test.js`, `soul.api.test.js`
- API: GET `/api/config/soul` in `packages/web/server/index.js`
- Docs: `docs/soul-md-guide.md`, `docs/soul.md.template`

## Phase 6 — Provider duplication (pending)
- To add: multi-account provider config, usage store, usage API, usage UI

## Verification commands (from repo root)
- `bun run build`
- `bun run type-check`
- `bun run lint`
- `bun run --cwd packages/ui test`
- Server tests: run test scripts under `packages/web/server/lib/*/__tests__/`
