# Harness (Engines) Module

## Purpose

Server-side **Engines** / harness adapter layer. OpenChamber keeps a single
session list (OpenCode session IDs as the UI shell) and routes non-OpenCode
execution through translators that emit **OpenCode-shaped** events into the
existing global UI event stream.

User-facing copy uses **Engine**. Internal IDs use `harnessId`.

Parent specs:

- `docs/engines-claude-code-spec.md`
- `docs/engines-claude-code-implementation-plan.md` §13

## Ownership

| Concern | Path |
| --- | --- |
| Descriptors / capabilities | `registry.js` |
| Binary + login detect | `detect.js` |
| Sticky session bindings | `session-bindings.js` (durable JSON + in-memory Map) |
| Prompt / abort / permission dispatch | `router.js` |
| HTTP routes | `routes.js` → `registerHarnessRoutes(app, deps)` |
| Claude SDK wrapper | `translators/claude-code/query.js` |
| Subscription env policy | `translators/claude-code/auth-env.js` |
| Attachment mapping | `translators/claude-code/attachments.js` |
| Claude permissions bridge | `translators/claude-code/permissions.js` |
| Claude prompt orchestration | `translators/claude-code/index.js` |
| Cursor Agent Run client / H2 bridge | `translators/cursor/agent-client.js`, `h2-bridge*.mjs` |
| Cursor OAuth (PKCE + refresh) | `translators/cursor/auth.js`, `login.js`, `credentials.js` |
| Cursor models | `translators/cursor/models.js` |
| Cursor prompt orchestration | `translators/cursor/index.js` |
| OpenCode stub (SDK path stays in UI) | `translators/opencode/index.js` |
| Claude → canonical events | `events/from-claude.js` |
| Cursor → canonical events | `events/from-cursor.js` |
| Broadcaster wrapper | `events/emit.js` |

Registration: `packages/web/server/lib/opencode/feature-routes-runtime.js`
calls `registerHarnessRoutes` next to quota / small-model, **before** the
generic OpenCode proxy. JSON body parsing for `/api/harness` is enabled in
`core-routes.js` common middleware.

## Boundary (ui-api-decoupling)

- OpenCode engine traffic stays on `@opencode-ai/sdk/v2` from the UI.
- Claude Code and Cursor engine traffic use OpenChamber routes `/api/harness/*`
  via `runtimeFetch` (`packages/ui/src/lib/harness/client.ts`).
- Never call Anthropic or Cursor Agent APIs from the UI for these engines.
- Never put Claude/Cursor OAuth tokens into `RuntimeAPIs` or OpenChamber settings JSON.
- Child Claude processes use subscription-only env (API keys stripped).
- Cursor uses `subscription-oauth` (no CLI binary); credentials live in the
  managed quota credential store / env, never in detect or login responses.

## Session shell model

1. UI creates an OpenCode session id (existing `session.create`).
2. First Claude prompt creates a sticky binding
   `{ sessionId, harnessId: 'claude-code', directory, target, foreignSessionId? }`.
3. Translator emits OpenCode-shaped events with that `sessionID`:
   - `message.updated`
   - `message.part.updated` / `message.part.delta`
   - `session.status` (`busy` / `idle`)
   - `session.error` on hard failures
   - `permission.asked` / `permission.replied` via the canUseTool bridge
4. Events fan out through `createGlobalUiEventBroadcaster` (same WS/SSE clients
   as other synthetic UI events), scoped with `{ directory }`.
5. Claude `session_id` is stored as `foreignSessionId` for resume.

Constraints:

- Do not also call OpenCode `session.promptAsync` for the same user turn.
- Abort interrupts the Claude query and tree-kills the process group.
- `harnessId` on a binding is sticky; engine switch requires a new session
  (handoff).

## Durable session bindings

File: `$OPENCHAMBER_DATA_DIR/harness-session-bindings.json`
(fallback `~/.config/openchamber/harness-session-bindings.json`).

| Rule | Behavior |
| --- | --- |
| Format | Versioned JSON `{ version: 1, bindings: [...] }` |
| Write | Atomic temp + rename, mode `0o600`, directory `0o700` |
| Load | `initSessionBindings()` on route registration (and lazy ensure) |
| Mutate | Debounced persist (~250ms); `flushSessionBindings()` for sync drain |
| Retention | Prune to ~200 entries by oldest `updatedAt` |
| Secrets | Never persisted — `sanitizeSessionBinding` allowlists fields |
| Tests | `configureSessionBindings({ filePath, persist })`; `resetSessionBindings({ clearDisk })` |

## HTTP API

All routes are authenticated like other OpenChamber runtime APIs. No secrets
in responses. Never log tokens, OAuth material, or attachment bytes.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/harness` | List engines + runtime status |
| GET | `/api/harness/:id` | Engine detail + catalog |
| POST | `/api/harness/:id/detect` | Force refresh detect |
| POST | `/api/harness/prompt` | Start engine turn (Claude / Cursor) |
| POST | `/api/harness/abort` | Abort active engine turn |
| POST | `/api/harness/permission/reply` | Resolve bridged Claude `canUseTool` prompt |
| POST | `/api/harness/cursor/login/start` | Start Cursor PKCE login (`loginId`, `loginUrl` only) |
| POST | `/api/harness/cursor/login/poll` | Poll Cursor login (`pending` / `complete` / `error`) |
| GET | `/api/harness/sessions/:sessionId` | Binding debug/UI |

### Prompt body

```json
{
  "sessionId": "ses_…",
  "directory": "/path/to/project",
  "target": {
    "harnessId": "claude-code",
    "modelRef": "sonnet",
    "permissionMode": "default"
  },
  "text": "…",
  "files": [{ "mime": "image/png", "url": "data:image/png;base64,…", "filename": "a.png" }],
  "messageId": "msg_…",
  "assistantMessageId": "msg_…"
}
```

Response `202` with `{ ok, sessionId, harnessId, messageId, assistantMessageId, status: "started" }`.
Streaming continues asynchronously via the event broadcaster.

### Permission reply body

```json
{
  "sessionId": "ses_…",
  "requestId": "perm_…",
  "reply": "once" | "always" | "reject",
  "directory": "/path/to/project"
}
```

### Detect statuses

| Status | Meaning |
| --- | --- |
| `ready` | Engine can accept prompts (Claude: binary + SDK + subscription; Cursor: valid OAuth access) |
| `needs-login` | Engine present but not authenticated (Claude API-key-only / logged out; Cursor missing/expired OAuth) |
| `missing-cli` | `claude` not on PATH (Claude only; Cursor has no CLI) |
| `unsupported-host` | Reserved (mobile-only / no exec host) — not emitted by v1 local detect |
| `error` | SDK/import/catalog failure or unexpected detect exception |

**Login probe (B6):** `claude auth status --json` with API-priority env stripped
(`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`). OAuth-like `authMethod` → ready;
API-key / logged-out → `needs-login`. If the CLI status probe fails, fall back to
structured presence of `claudeAiOauth.accessToken` in the Claude credentials file
(no secret values returned).

**Invariant:** detect failure never returns `status: "ready"` with an empty
success catalog. Error / missing-cli responses use `sections: []`.

### Cursor engine (`harnessId: cursor`)

- Auth mode: `subscription-oauth` (PKCE via `loginDeepControl` + managed credentials).
- Transport: Node `h2-bridge.mjs` child process → Cursor Agent Run (Connect/protobuf).
- Prompt binds `{ harnessId: 'cursor', … }` and streams OpenCode-shaped events with
  `providerID: 'cursor'`.
- Resume: conversation id + checkpoint bytes stored in `foreignSessionId`
  (`cursor:<conversationId>[:<base64url-checkpoint>]`).
- MVP gaps: native Cursor tools / MCP / images / attachments are not bridged;
  native tool exec requests are rejected with a host-tools message.
- Login responses never include verifiers, access tokens, or refresh tokens.

### Dependency injection

```js
registerHarnessRoutes(app, {
  getBroadcastGlobalUiEvent: () => broadcastGlobalUiEvent,
  getOpenCodeReady: () => isOpenCodeReady,
  sessionBindings: { filePath, persist, debounceMs, maxBindings },
});
```

`packages/web/server/index.js` wires broadcast + OpenCode ready. Tests may inject
a mocked `router` / `detectAll` / `detectOne`, and set `initBindings: false` or
`persist: false`.

## Permissions bridge

`translators/claude-code/permissions.js`:

1. `createCanUseTool({ sessionId, directory, getBroadcast })` → Agent SDK option.
2. On tool ask: emit OpenCode-shaped `permission.asked` (`PermissionRequest`-like:
   `id`, `sessionID`, `permission`, `patterns`, `metadata`, `always: []`).
3. Pending map: `requestId → { resolve, reject, sessionId, timer, … }`.
4. Timeout (~120s) and abort/turn-end → fail-closed deny + `permission.replied`.
5. `replyPermission({ sessionId, requestId, reply })`:
   - `once` → SDK `{ behavior: 'allow', updatedInput }`
   - `always` → allow + `updatedPermissions` from SDK suggestions when present
   - `reject` → `{ behavior: 'deny', message }`

UI: `harnessPermissionReply` → `respondToPermission` / `dismissPermission` branch
when `getSessionTarget(sessionId)?.harnessId === 'claude-code'`.

## Claude auth-env policy

`translators/claude-code/auth-env.js` builds child env from `process.env` and
deletes API-priority keys:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`

PATH and other inherited vars are preserved (`env` replaces the subprocess
environment in the Agent SDK, so the full spread is required).

## Claude Agent SDK

Dependency: `@anthropic-ai/claude-agent-sdk` in `packages/web/package.json`.

`query.js`:

- Lazy-imports the SDK; caches load failures.
- `startClaudeQuery({ prompt, cwd, model, resume, permissionMode, canUseTool, env })`
- `includePartialMessages: true` for streaming deltas
- `interrupt()` when available, plus `killProcessTree(pid)` on abort/close

If the SDK import fails:

- Detect → `error` (not ready)
- Prompt → HTTP `503` with `CLAUDE_SDK_UNAVAILABLE`

## Attachments (foundation)

OpenChamber `{ mime, url, filename }` data URLs → SDK content blocks:

| MIME | Mapping |
| --- | --- |
| `image/png|jpeg|gif|webp` | `image` base64 block |
| `text/*`, json/yaml-like | labeled `text` block |
| `application/pdf` | `document` base64 block |
| other binary (e.g. zip) | reject `400 ATTACHMENT_UNSUPPORTED_TYPE` |

Turns with attachments use `AsyncIterable<SDKUserMessage>`; text-only may use
a string prompt.

## Event transport choice (spec §21)

**Chosen approach:** emit OpenCode-shaped payloads through
`createGlobalUiEventBroadcaster` with `{ directory }`, so the existing message
stream WS clients deliver them into `event-pipeline` / `event-reducer` without
a parallel harness channel.

Message/part IDs: OpenCode-compatible `msg_*` / `prt_*`. Prompt may echo
client-provided `messageId` / `assistantMessageId` for optimistic reconcile.

## UI send path (shared UI)

- `packages/ui/src/lib/harness/client.ts` — `harnessPrompt` / `harnessAbort` /
  `harnessPermissionReply` via `runtimeFetch`
- `packages/ui/src/lib/harness/resolve-execution-target.ts` — sticky `ExecutionTarget` resolution
- `packages/ui/src/sync/session-ui-store.ts` — `routeMessage` branches `claude-code` → harness prompt (not OpenCode SDK)
- `packages/ui/src/sync/session-actions.ts` — permission reply/dismiss branches for Claude targets
- Model picker Engines section lives in `ModelControls` / `ModelPickerList`

## Out of scope (later slices)

- Codex CLI / Gemini CLI engines
- Cursor host-tool / MCP bridging, images, attachments
- Reverse handoff billing notice (Claude → OpenCode)
- Goal / MultiRun / OpenChamber injected tool on Claude

## Testing

```bash
bun test packages/web/server/lib/harness/registry.test.js
bun test packages/web/server/lib/harness/detect.test.js
bun test packages/web/server/lib/harness/routes.test.js
bun test packages/web/server/lib/harness/session-bindings.test.js
bun test packages/web/server/lib/harness/events/from-claude.test.js
bun test packages/web/server/lib/harness/events/from-cursor.test.js
bun test packages/web/server/lib/harness/translators/claude-code/auth-env.test.js
bun test packages/web/server/lib/harness/translators/claude-code/attachments.test.js
bun test packages/web/server/lib/harness/translators/claude-code/permissions.test.js
bun test packages/web/server/lib/harness/translators/cursor/auth.test.js
bun test packages/web/server/lib/harness/translators/cursor/credentials.test.js
bun test packages/ui/src/lib/harness/client.test.js
```

Or all harness tests:

```bash
bun test packages/web/server/lib/harness
```

## Notes for contributors

- Keep entrypoints thin; domain logic stays in focused modules under this folder.
- One failed Claude session must not clear or block OpenCode sessions.
- Prefer authoritative detect status over heuristics; never invent `ready`.
- Permission bridge fails closed; never auto-bypass unless Claude permission mode explicitly allows.
- Update this file when ownership, routes, or event contracts change.
