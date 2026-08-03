# Engines & Claude Code — Implementation Plan (PR / Ticket Decomposition)

Parent spec: [`docs/engines-claude-code-spec.md`](./engines-claude-code-spec.md)

Status: planning only (no implementation in this doc)  
Ordering principle: each PR is mergeable, testable, and leaves the product safe if later slices slip.

---

## 1. How to read this plan

| Field | Meaning |
|---|---|
| **ID** | Stable ticket/PR slug |
| **Size** | S / M / L (relative invasiveness, not calendar time) |
| **Depends** | Must land before this slice starts |
| **Packages** | Primary touch surfaces |
| **Done when** | Concrete acceptance for the slice |

Parallel tracks are marked **∥**. Do not start Claude process spawning until contracts + router seam exist.

```text
A1 → A2 → A3 → A4
         ↘ A5 (∥ after A2)
B1 → B2 → B3 → B4 → B5
              ↘ B6 (∥ after B3)
C1 → C2 → C3
D1 → D2 → D3 → D4   (mostly after C)
```

---

## 2. Phase A — Contracts & UI shells

Goal: types, settings, Engines page, picker grouping — **OpenCode still executes everything**.

### A1 — Shared harness contracts

| | |
|---|---|
| **Size** | M |
| **Depends** | — |
| **Packages** | `packages/ui` (types), optionally thin shared constants used by web |

**Work**

- Add `HarnessId`, `ExecutionTarget`, `HarnessRuntimeStatus`, `HarnessCapability`, `CapabilityLevel`, `HarnessDescriptor` types.
- Add settings shape stub:
  - `engines.defaultHarnessId` (default `'opencode'`)
  - `engines.claudeCode.warnOnOpenCodeHandoff` (default `true`)
- Persist/sanitize new settings keys in existing persistence path (round-trip safe; unknown keys ignored by older builds if applicable).
- Unit tests for sanitize defaults + invalid harness ids fall back to `opencode`.

**Done when**

- Types compile; settings round-trip; no user-visible Engines UI yet required.
- OpenCode behavior unchanged.

**Out of scope**

- Server routes, SDK dependency, picker UX.

---

### A2 — Server harness registry + detect stubs

| | |
|---|---|
| **Size** | M |
| **Depends** | A1 (type names may be duplicated/mirrored in JS if no shared package yet — keep IDs identical) |
| **Packages** | `packages/web` |

**Work**

- Create `packages/web/server/lib/harness/` with `DOCUMENTATION.md`, `registry.js`, `detect.js` stubs.
- Register engines: `opencode` (always ready if OpenCode lifecycle ready), `claude-code` (detect binary; login probe can be stub returning `needs-login` / `missing-cli` / `unsupported-host`).
- Routes (authenticated):
  - `GET /api/harness`
  - `GET /api/harness/:id`
  - `POST /api/harness/:id/detect`
- Mount **before** OpenCode proxy.
- Tests: registry contents; detect missing binary; unknown id 404; failure ≠ empty ready catalog.

**Done when**

- API returns stable JSON for both engines without spawning Claude Agent SDK.
- Docs in module `DOCUMENTATION.md` describe ownership.

---

### A3 — `useHarnessStore` + catalog client

| | |
|---|---|
| **Size** | S |
| **Depends** | A1, A2 |
| **Packages** | `packages/ui` |

**Work**

- Store: engine list, status by id, loading/error per fetch, `refresh` / `detect`.
- Fetch via `runtimeFetch` (not OpenCode SDK).
- Directory/runtime scoping: refresh on project/runtime switch; do not treat fetch failure as ready+empty.
- Focused store tests with mocked fetch.

**Done when**

- UI can read harness status without Settings page (dev/test consumers OK).

---

### A4 — Settings → Engines page shell

| | |
|---|---|
| **Size** | M |
| **Depends** | A3 |
| **Packages** | `packages/ui` (+ locale) |

**Work**

- New settings slug `engines` (split page) in `settings/metadata.ts`.
- Sidebar: OpenCode, Claude Code (+ status meta).
- Detail panes:
  - OpenCode: short explanation + link to Providers/Agents.
  - Claude Code: status, version placeholder, Re-detect, login guidance CTA, capabilities list (static from descriptor), **Warnings** toggle bound to `warnOnOpenCodeHandoff`.
- Locale strings for all new copy (`settings.engines.*`).
- Follow settings-ui + locale + theme skills at implementation time.

**Done when**

- User can open Settings → Engines, see Claude status from detect API, toggle handoff warning, re-detect.
- No chat routing changes yet.

---

### A5 — Model picker engine grouping (OpenCode-only execution) ∥

| | |
|---|---|
| **Size** | M |
| **Depends** | A3 (A4 nice-to-have for “Manage engines…”) |
| **Packages** | `packages/ui` |

**Work**

- Extend ModelControls / ModelPickerList with **Engines** section.
- Selecting OpenCode keeps current provider/model behavior.
- Selecting Claude Code:
  - v1 interim: show models from catalog **or** disabled empty state “Coming online” if Phase B not present — **prefer**: allow selection of target in UI state but **block Send** with clear reason until B4 lands (feature flag OK).
- Footer: Manage engines… → Settings `engines`; Add provider… only for OpenCode.
- Session target field in selection store (persist `ExecutionTarget`); still route to OpenCode until B4.

**Recommended flag**

- `engines.claudeCode.enabled` or build-time/server flag default off in A5, flipped on in B4/B5.

**Done when**

- Picker shows top-level engines; OpenCode path 100% intact; Claude selection does not silently send via Anthropic API provider.

---

## 3. Phase B — Claude vertical slice

Goal: real subscription Claude sessions in the transcript.

### B1 — Dependency + Claude query wrapper

| | |
|---|---|
| **Size** | M |
| **Depends** | A2 |
| **Packages** | `packages/web` (root/workspace dependency approval required) |

**Work**

- Explicitly add `@anthropic-ai/claude-agent-sdk` (user must approve dependency add).
- `translators/claude-code/query.js`: thin wrapper around `query()` / interrupt / close.
- `auth-env.js`: strip `ANTHROPIC_API_KEY` (and agreed API-priority vars) for child env; subscription-only.
- Unit tests for env policy (no network).
- Tree-kill helper stub wired for close/abort.

**Done when**

- Wrapper can be integration-tested locally with mocked SDK; env policy covered.
- Not yet exposed to UI send path.

---

### B2 — Session bindings + prompt/abort routes

| | |
|---|---|
| **Size** | M |
| **Depends** | B1, A2 |
| **Packages** | `packages/web` |

**Work**

- `session-bindings.js` durable or in-memory+persist strategy (choose smallest correct; document).
- Routes:
  - `POST /api/harness/prompt`
  - `POST /api/harness/abort`
  - `GET /api/harness/sessions/:sessionId` (binding debug)
- Reject `claude-code` prompts when status ≠ ready.
- Reject API-key-only misconfig with explicit error code.
- Tests: binding sticky harness; abort unknown session; prompt validation.

**Done when**

- HTTP API can start/abort a Claude turn without UI.

---

### B3 — Canonical event mapper + stream ingest

| | |
|---|---|
| **Size** | L |
| **Depends** | B2 |
| **Packages** | `packages/web`, possibly `packages/ui` sync consumers |

**Work**

- `events/from-claude.js` → canonical events (text, tools, status, notices).
- Pipe into existing sync/event pipeline (implementation choice from spec §21 — pick one approach and document in harness `DOCUMENTATION.md`).
- Persist `foreignSessionId` on first session_id.
- Resume path uses foreign id.
- Fixtures/tests for mapper; isolation test: Claude error does not clear OpenCode session state.

**Done when**

- A Claude prompt produces assistant text in the same transcript UI used by OpenCode.
- Live status busy/idle accurate.

---

### B4 — `routeMessage` harness branch

| | |
|---|---|
| **Size** | M |
| **Depends** | B3, A5 |
| **Packages** | `packages/ui`, `packages/web` |

**Work**

- Branch in `routeMessage` / `sendMessage`:
  - `opencode` → existing SDK path
  - `claude-code` → `/api/harness/prompt`
- Optimistic send reconciliation for harness failures.
- Enable Claude engine in picker (flip flag).
- Block send when harness not ready; deep-link Engines.
- Focused tests for branch selection.

**Done when**

- End-to-end: pick Claude → send text → stream reply (on host with CLI login).
- OpenCode path regression-safe.

---

### B5 — Permissions bridge (basic)

| | |
|---|---|
| **Size** | L |
| **Depends** | B3 |
| **Packages** | `packages/web`, `packages/ui` |

**Work**

- `canUseTool` → OpenChamber permission request.
- `POST /api/harness/permission/reply`.
- Permission mode chip for Claude sessions (subset of modes).
- Fail closed when client cannot answer.
- Tests: allow/deny round-trip; disconnect deny.

**Done when**

- Tool permission prompts appear in existing permission UI for Claude turns.

---

### B6 — Detect login probe hardening ∥

| | |
|---|---|
| **Size** | S–M |
| **Depends** | B1 |
| **Packages** | `packages/web`, Settings UI copy tweaks |

**Work**

- Replace stub login detection with real CLI/SDK auth probe.
- Status matrix documented + tested: ready / needs-login / missing-cli / unsupported-host / error.
- Ensure API-key-only host ≠ ready.

**Done when**

- Engines page status matches real Claude login state on desktop/web host.

---

## 4. Phase C — Attachments & handoff

### C1 — Attachment translator

| | |
|---|---|
| **Size** | M |
| **Depends** | B4 |
| **Packages** | `packages/web`, light UI error surfacing |

**Work**

- `attachments.js`: map OpenChamber files → SDK content blocks.
- Enforce streaming user message path when files present.
- MIME allowlist + size clamps; HEIC via existing normalization where possible.
- Reject unknown binaries with named errors.
- Tests per MIME class.

**Done when**

- Image + text attachment round-trip on Claude engine; bad MIME fails clearly.

---

### C2 — Handoff duplicate + seed

| | |
|---|---|
| **Size** | L |
| **Depends** | B4 (C1 for attachment-on-handoff completeness) |
| **Packages** | `packages/ui`, `packages/web` |

**Work**

- Pending engine target on existing session; on Send create new session.
- Seed text turns with budget + truncation notice.
- `seedFromSessionId` on binding.
- Navigate to new session; source unchanged.
- Tests: handoff creates new id; source intact; empty session shortcut.

**Done when**

- OpenCode → Claude handoff works for text threads; sticky engine per session preserved.

---

### C3 — Billing handoff notice

| | |
|---|---|
| **Size** | S |
| **Depends** | C2, A4 (settings toggle already exists) |
| **Packages** | `packages/ui` (+ locale) |

**Work**

- `HandoffConfirmDialog` with Don’t show again (persist only on Continue).
- Gate on `engines.claudeCode.warnOnOpenCodeHandoff`.
- Settings toggle remains source of truth / re-enable.
- Tests: cancel no persist; continue+checkbox persists false; settings re-enable shows dialog again.

**Done when**

- Spec §10 acceptance met.

---

## 5. Phase D — Polish

### D1 — Favorites / recents / shortcuts by ExecutionTarget

| | |
|---|---|
| **Size** | M |
| **Depends** | B4 |
| **Packages** | `packages/ui` |

**Work**

- Migrate favorite/recent model refs to target-aware keys (compat read of old `{providerID,modelID}` as OpenCode targets).
- Cycle shortcuts skip unavailable engines/models.

**Done when**

- No collision between OpenCode Anthropic model and Claude model aliases.

---

### D2 — Session list engine glyph + mobile engine chips

| | |
|---|---|
| **Size** | S |
| **Depends** | A5, B4 |
| **Packages** | `packages/ui` |

**Work**

- Glyph/tooltip on session rows.
- Mobile engine chip row in model sheet.
- Theme-system compliant icons.

**Done when**

- User can see which engine owns a session at a glance on desktop + mobile.

---

### D3 — Capability gating for OpenCode-only features

| | |
|---|---|
| **Size** | M |
| **Depends** | B4 |
| **Packages** | `packages/ui` |

**Work**

- Disable/hide MultiRun, Goal entry points, OpenChamber-tool-dependent actions when current session engine is `claude-code`.
- MCP/Agents settings entry from Claude context → explain + link Engines/OpenCode as appropriate.
- One-line reasons; no silent no-ops.

**Done when**

- Claude session cannot launch OpenCode-only flows by accident.

---

### D4 — Usage probe alignment for Claude subscription

| | |
|---|---|
| **Size** | M |
| **Depends** | B6 |
| **Packages** | `packages/web` quota, `packages/ui` Usage |

**Work**

- Align Usage with Claude Code subscription auth when possible (do not require OpenCode API key).
- Label clearly as Claude subscription windows.
- Keep OpenCode Anthropic provider usage separate if both exist.

**Done when**

- Usage page is not misleading for Claude-engine users on subscription-only hosts.

---

## 6. Suggested PR sequencing (merge order)

| Order | PR | Title (suggested) | Blocks release? |
|---|---|---|---|
| 1 | A1 | feat(engines): add harness types and settings stubs | No |
| 2 | A2 | feat(engines): harness registry and detect API stubs | No |
| 3 | A3 | feat(engines): harness store client | No |
| 4 | A4 | feat(engines): Settings → Engines page | No |
| 5 | A5 | feat(engines): model picker engine grouping (flagged) | No |
| 6 | B1 | feat(engines): Claude Agent SDK wrapper + auth env policy | No (needs dep approval) |
| 7 | B2 | feat(engines): session bindings + prompt/abort routes | No |
| 8 | B3 | feat(engines): Claude event ingest into sync | **Yes for Claude chat** |
| 9 | B4 | feat(engines): routeMessage Claude branch + enable flag | **Yes** |
| 10 | B5 | feat(engines): Claude permissions bridge | Soft-yes (tools painful without) |
| 11 | B6 | feat(engines): real Claude login detect | Soft-yes |
| 12 | C1 | feat(engines): Claude attachments | Attachments milestone |
| 13 | C2 | feat(engines): cross-engine session handoff | Handoff milestone |
| 14 | C3 | feat(engines): handoff billing notice | Handoff milestone |
| 15 | D1–D4 | polish PRs (can split 1:1 with tickets) | Nice-to-have for v1.0 |

**MVP “Claude chat works”** = through **B4** (+ B5 strongly recommended).  
**MVP “spec v1 complete”** = through **C3**.  
**D\*** can trail a flagged beta.

---

## 7. Parallelization map

```text
After A2:     A3 ── A4
               └── A5 (∥ A4)

After B1:     B2 ── B3 ── B4
               │      └── B5 (∥ B4 once events exist)
               └── B6 (∥ B2/B3)

After B4:     C1 ── C2 ── C3
               └── D1 / D3 (∥ C*)

After C2:     D2
After B6:     D4
```

Avoid parallel edits to `routeMessage` / ModelControls without stacking on one owner branch.

---

## 8. Cross-cutting checklists (every PR)

Apply when the slice touches that surface:

| If you touch… | Load / follow |
|---|---|
| Any source change | `openchamber-change-discipline` |
| Settings page | `settings-ui-patterns`, `locale-ui-patterns`, `theme-system` |
| Chat picker / transcript | `locale-ui-patterns`, `theme-system`, `performance-engineering` (hot path) |
| `routeMessage` / sync / bindings | `sync-state-invariants`, `ui-api-decoupling` |
| Stream/events | `relay-transport` if using WS/SSE transport internals |
| New server module | nearest `DOCUMENTATION.md` update |

Validation defaults:

- Package-scoped typecheck/tests for touched packages.
- `bun run dead-code` when exports/files added.
- Real-host smoke for B4+ (CLI installed + subscription login).
- Report what was / was not runtime-validated.

---

## 9. Explicit non-tickets (defer)

Do not open implementation PRs for these under Claude v1:

- Codex CLI / Gemini CLI translators (registry placeholder OK in A2 only as “coming soon” without fake ready).
- Goal / MultiRun on Claude.
- OpenChamber injected tool on Claude.
- MCP settings editor for Claude.
- Import of interactive TTY Claude sessions.
- Reverse handoff notice Claude → OpenCode.
- `--bare` product mode.

---

## 10. Risk register → owning tickets

| Risk | Mitigation ticket |
|---|---|
| API key env steals billing | B1 auth-env + B6 ready criteria |
| Event pipeline mismatch | B3 design note in DOCUMENTATION.md before coding |
| Picker silently uses OpenCode Anthropic | A5 block + B4 branch tests |
| Orphan `claude`/MCP processes | B1/B2 tree-kill on abort/close |
| Handoff data loss expectations | C2 truncation notice + C3 copy |
| Mobile without CLI | A2/B6 `unsupported-host`; A5/B4 send block |
| Dependency policy | B1 blocked until explicit dep approval |

---

## 11. Ticket one-liners (copy/paste)

```text
A1  Shared HarnessId/ExecutionTarget types + engines settings sanitize
A2  Server harness registry + GET detect API stubs (+ DOCUMENTATION.md)
A3  useHarnessStore + runtimeFetch catalog client
A4  Settings → Engines split page (Claude detail + warn toggle)
A5  Model picker Engines section; Claude selection flagged/blocked until ready

B1  Add Claude Agent SDK; query wrapper; subscription auth-env policy
B2  Session bindings + /api/harness/prompt|abort
B3  Claude→canonical event mapper + sync ingest + resume id
B4  routeMessage harness branch; enable Claude sends
B5  canUseTool ↔ OpenChamber permissions + mode chip
B6  Real CLI login/detect status matrix

C1  Attachment MIME mapping + clamps for Claude streaming input
C2  Engine switch handoff: duplicate session + seed transcript
C3  OpenCode→Claude billing notice + don’t-show-again ↔ settings

D1  Favorites/recents/shortcuts keyed by ExecutionTarget
D2  Session engine glyph + mobile engine chips
D3  Gate OpenCode-only features on Claude sessions
D4  Usage probe aligned to Claude subscription auth
```

---

## 12. Definition of “Phase done”

| Phase | Done means |
|---|---|
| **A** | Engines visible in Settings + picker; Claude not falsely executing via API; detect API live |
| **B** | Text Claude subscription chat + tools/permissions in OpenChamber transcript |
| **C** | Attachments + handoff + notice complete per spec acceptance §22.5–7 |
| **D** | UX polish + usage honesty + feature gating |

Parent acceptance criteria remain those in spec §22.

---

## 13. Native OpenChamber architecture (binding to existing code)

This section is the implementation source of truth for *how* the spec maps onto OpenChamber. Prefer existing seams; do not invent a parallel app inside the app.

### 13.1 Boundary classification (ui-api-decoupling)

| Concern | Path |
|---|---|
| OpenCode providers/models/agents/prompt (engine=`opencode`) | `@opencode-ai/sdk/v2` via `opencodeClient` |
| Harness detect/catalog/prompt/abort/permissions | OpenChamber routes `/api/harness/*` via `runtimeFetch` |
| Platform shells | unchanged `RuntimeAPIs` (no Claude spawn in renderer/webview) |
| Event fan-out to UI | Existing message-stream WS/SSE + `createGlobalUiEventBroadcaster` |

Never call Anthropic HTTP from UI. Never put Claude OAuth into `RuntimeAPIs`.

### 13.2 Session shell model (critical)

Claude sessions **reuse OpenCode session IDs** for list/sync continuity:

1. **Create session** — existing OpenCode `session.create` (same as today).
2. **Bind** — server `session-bindings` records `{ sessionId, harnessId: 'claude-code', directory, target, foreignSessionId? }`.
3. **Send** — `routeMessage` sees binding/target `claude-code` → `POST /api/harness/prompt` (does **not** call `session.promptAsync`).
4. **Transcript** — translator emits **OpenCode-shaped** events with that `sessionID`:
   - `message.updated`
   - `message.part.updated` / `message.part.delta`
   - `session.status`
   - permission events compatible with existing UI where possible
5. Events are broadcast through the same global/directory stream path UI already consumes (`sync-context` / `event-reducer`).

Why this is native:

- Session sidebar, sync stores, optimistic send, directory scoping stay intact.
- No second session list.
- OpenCode remains the index; Claude is the executor behind a binding.

Constraints:

- Do not also prompt the OpenCode session for the same user turn.
- Abort must stop the Claude process tree; OpenCode session stays as the UI shell.
- If binding missing and target is Claude, create binding on first prompt (sticky thereafter).

### 13.3 Module ownership (mirror quota / small-model)

```text
packages/web/server/lib/harness/          # like quota/ and small-model/
  DOCUMENTATION.md
  index.js                               # public exports
  registry.js                            # engine descriptors
  detect.js                              # binary + login probe
  session-bindings.js
  router.js                              # prompt/abort/permission orchestration
  routes.js                              # registerHarnessRoutes(app, deps)
  events/
    emit.js                              # wrap broadcaster; OpenCode-shaped payloads
    from-claude.js                       # SDK message → events
  translators/
    opencode/index.js                    # identity: not used for HTTP (SDK path stays in UI)
    claude-code/
      index.js
      auth-env.js
      query.js
      attachments.js
      permissions.js
      catalog.js
```

Registration: `feature-routes-runtime.js` calls `registerHarnessRoutes` next to `registerQuotaRoutes` / `registerSmallModelRoutes`, **before** OpenCode proxy.

### 13.4 UI ownership

```text
packages/ui/src/types/harness.ts         # HarnessId, ExecutionTarget, descriptors
packages/ui/src/stores/useHarnessStore.ts
packages/ui/src/sync/selection-store.ts  # extend with sessionTargets / lastUsedTarget
packages/ui/src/lib/persistence.ts       # engines.* settings sanitize
packages/ui/src/lib/desktop.ts           # DesktopSettings engines fields
packages/ui/src/lib/settings/metadata.ts # slug `engines`
packages/ui/src/lib/settings/search.ts   # search items for Engines
packages/ui/src/components/sections/engines/*
packages/ui/src/components/chat/ModelControls.tsx  # engine section
packages/ui/src/sync/session-ui-store.ts # routeMessage branch
packages/ui/src/lib/i18n/messages/*      # all locales
```

Settings group: place **Engines** first in the `opencode` nav group (before Providers). User copy: Engines; code: harness.

### 13.5 Settings persistence pattern

Follow `smallModelOverride` / `defaultAgent` style:

- Fields on `DesktopSettings`: `enginesDefaultHarnessId`, `enginesClaudeCodeWarnOnOpenCodeHandoff` (flat keys OK if nested sanitize is awkward — prefer nested `engines` object only if persistence already supports nested objects cleanly).
- Sanitize in `persistence.ts` with defaults.
- Engines page writes via existing `updateDesktopSettings` / `reportSettingsSaveState`.

### 13.6 `routeMessage` branch (thin)

Keep orchestration thin in `session-ui-store.ts`:

```ts
// pseudocode
const target = getExecutionTarget(sessionId)
if (target.harnessId === 'claude-code') {
  return harnessSend({ sessionId, directory, target, content, files, ... })
}
// existing opencodeClient path
```

`harnessSend` lives in `packages/ui/src/lib/harness/client.ts` and only uses `runtimeFetch`.

### 13.7 Event emit contract

`harness/events/emit.js` must produce payloads the existing reducer already understands. Prefer cloning shapes from OpenCode fixtures / reducer tests rather than inventing new part types.

Message/part IDs: generate OpenCode-compatible ids (`msg_*`, `prt_*`) client- or server-side; optimistic UI should reconcile on the same ids when possible (echo `messageId` from prompt request like OpenCode path).

### 13.8 Auth-env (server only)

In `translators/claude-code/auth-env.js`:

- Build child `env` from `process.env`.
- Delete `ANTHROPIC_API_KEY` (and documented API-priority vars) for subscription mode.
- Never log env values.
- Detect readiness without requiring OpenCode `auth.json`.

### 13.9 Feature flag

`enginesClaudeCodeEnabled` setting or server env `OPENCHAMBER_ENGINE_CLAUDE_CODE=1` for safe rollout. Picker shows Claude when detect says binary exists **or** flag on; Send requires `ready`.

### 13.10 What “native” explicitly rejects

- New Electron sidecar for Claude.
- UI `fetch('https://api.anthropic.com')`.
- Treating Claude as an OpenCode `provider` row.
- Parallel chat app route (`/claude`) bypassing session sync.
- Storing Claude OAuth tokens in OpenChamber settings JSON.
