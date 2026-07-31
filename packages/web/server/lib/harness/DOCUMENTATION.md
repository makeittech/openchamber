# Harness Module

## Purpose

Server-side **harness** adapter layer. OpenChamber keeps a single
session list (OpenCode session IDs as the UI shell) and routes non-OpenCode
execution through translators that emit **OpenCode-shaped** events into the
existing global UI event stream.

User-facing copy uses **Harness**. Internal IDs use `harnessId`.

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
| OpenCode agent → Claude prompt/permissions/subagents | `translators/claude-code/opencode-agents.js` |
| Claude-native agent discovery | `translators/claude-code/claude-agents.js` |
| Claude questions bridge | `translators/claude-code/questions.js` |
| Claude prompt orchestration | `translators/claude-code/index.js` |
| OpenCode command → Claude prompt text | `translators/claude-code/opencode-command.js` |
| Claude local project/chat import | `translators/claude-code/import-from-disk.js` |
| Claude transcript JSONL → message replay | `translators/claude-code/transcript-messages.js` |
| Claude session-limit recovery analyzer + projection | `translators/claude-code/recovery-transcript.js` |
| Durable Claude session-limit retry journal / policy / scheduler | `pending-retry-store.js`, `retry-policy.js`, `retry-runtime.js` |
| OpenCode stub (SDK path stays in UI) | `translators/opencode/index.js` |
| Claude → canonical events | `events/from-claude.js` |
| Broadcaster wrapper | `events/emit.js` |

Registration: `packages/web/server/lib/opencode/feature-routes-runtime.js`
calls `registerHarnessRoutes` next to quota / small-model, **before** the
generic OpenCode proxy. JSON body parsing for `/api/harness` is enabled in
`core-routes.js` common middleware.

## Boundary (ui-api-decoupling)

- OpenCode harness traffic stays on `@opencode-ai/sdk/v2` from the UI.
- Claude Code harness traffic uses OpenChamber routes `/api/harness/*` via
  `runtimeFetch` (`packages/ui/src/lib/harness/client.ts`).
- Never call Anthropic HTTP from the UI for this harness.
- Never put Claude OAuth into `RuntimeAPIs` or OpenChamber settings JSON.
- Child Claude processes use subscription-only env (API keys stripped).

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
   - `question.asked` / `question.replied` / `question.rejected` for the
     `AskUserQuestion` tool (clarifying questions)

    Assistant output streams as two segment kinds, `text` and `reasoning`.
   Claude `thinking` blocks and `thinking_delta` stream events map to
   `reasoning` parts (extended thinking is requested via `effort`, so dropping
   it would silently discard requested output). A tool closes both open
   segments, so the transcript keeps text → tool → text order.

   Tool parts carry their `tool_use` arguments on the completed/error state as
   well as while running: the UI reducer replaces `part.state` wholesale, so
   omitting `input` blanks the arguments the moment a tool finishes.
4. Events fan out through `createGlobalUiEventBroadcaster` (same WS/SSE clients
   as other synthetic UI events), scoped with `{ directory }`.
5. Claude `session_id` is stored as `foreignSessionId` for resume.

Constraints:

- Do not also call OpenCode `session.promptAsync` for the same user turn.
- Abort interrupts the Claude query and tree-kills the process group. It also
  emits terminal events for every part the turn left open (running tools →
  `error`, open text/reasoning → final text) before the `MessageAbortedError`
  marker; without those the aborted parts keep spinning in the transcript.
- Attachments are validated before any optimistic user-message event is
  broadcast, so a rejected attachment cannot leave a sent-and-busy turn on
  screen that never receives a reply.
- `harnessId` on a binding is sticky; harness switch requires a new session
  (handoff).

## Harness switch (UI flow)

Switching harness on a session with messages goes through
`useHarnessSwitchStore.requestHarnessSwitch` (model picker, favorite-target
shortcuts):

- Empty session or same harness: target persists in place — no dialog.
- Warn disabled (`harnessWarnOnSwitch: false`): legacy silent pending handoff;
  the destination session is created on the next sent message with a hidden
  synthetic seed.
- Warn enabled (default): `HarnessSwitchDialog` opens immediately and explains
  that switching starts a new session. On confirm,
  `performHarnessHandoff` (`packages/ui/src/lib/harness/perform-handoff.ts`)
  creates the destination session right away, navigates to it, and posts the
  transferred context as a **visible** first user message
  (`lib/harness/handoff-context.ts` markers render as a collapsible card):
  - `duplicate` — budgeted transcript of the source session.
  - `summarize` — OpenCode `session.summarize` for OpenCode sources or
    Claude-native `/compact` for Claude Code sources; the summary text is
    extracted via `extractCompactionSummary` (compaction part →
    parentID-linked/first assistant summary).

OpenCode destinations receive the context via `session.prompt_async` with
`noReply: true` (no model turn); Claude Code destinations receive it as a
normal harness prompt that asks for a one-line acknowledgment.

Catalog JSON (`GET /api/harness`, `/api/harness/:id`) uses
`{ descriptor, status, statusDetail?, version?, sections }`; the list payload
is `{ catalogs }`.

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
| Agent selection | `agentsMode`, `agentName`, `claudeAgentName` re-stamped every user turn |
| Tests | `configureSessionBindings({ filePath, persist })`; `resetSessionBindings({ clearDisk })` |

## HTTP API

All routes are authenticated like other OpenChamber runtime APIs. No secrets
in responses. Never log tokens, OAuth material, or attachment bytes.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/harness` | List harness catalogs + runtime status (`{ catalogs }`) |
| GET | `/api/harness/:id` | Harness detail + catalog |
| POST | `/api/harness/:id/detect` | Force refresh detect |
| POST | `/api/harness/prompt` | Start Claude turn |
| POST | `/api/harness/abort` | Abort active Claude turn |
| POST | `/api/harness/permission/reply` | Resolve bridged `canUseTool` permission prompt |
| POST | `/api/harness/question/reply` | Resolve bridged `AskUserQuestion` prompt |
| GET | `/api/harness/sessions/:sessionId` | Binding debug/UI |
| GET | `/api/harness/sessions/:sessionId/capabilities` | Claude slash/MCP/agents snapshot (built-in defaults before init) |
| GET | `/api/harness/claude-code/agents` | Claude-native agents for a directory (`?directory=`) |
| GET | `/api/harness/claude-code/import/candidates` | List local Claude Code projects/chats |
| POST | `/api/harness/claude-code/import` | Import selected chats (OpenCode shell + binding) |

### Claude Code import

Reads transcripts under `$CLAUDE_CONFIG_DIR/projects` (fallback `~/.claude/projects`
then `~/.config/claude/projects`). Listing never treats a missing config dir as
an authoritative empty failure of the harness — the response is
`{ projects: [] }` with null roots.

Import creates an OpenCode session per selected Claude chat, then
`bindSession` with `foreignSessionId` so the next Claude prompt resumes the
native transcript. JSONL is **not** written into OpenCode message stores
(format is Anthropic-internal and unstable); instead the transcript is replayed
read-only into `GET /api/session/:id/message` responses (see below), so
imported sessions show their full text history. One failed chat does not roll
back others; already-bound `foreignSessionId` values are skipped. Batch limit:
100 sessions.

Import candidate titles inherit Claude's own naming: custom user-set name →
latest `ai-title` record → `summary` record → first user text.

### Transcript replay (message overlay)

`translators/claude-code/transcript-messages.js` parses the bound session's
Claude JSONL into OpenCode-shaped `{ info, parts }` messages (text, reasoning
from thinking blocks, tool parts settled by matching `tool_result`; tools left
running at transcript end become `error`). Harness-injected
`<task-notification>` user records (orphaned background shell tasks surfaced
on resume) are model context, not user turns, and are skipped. Synthetic
recovery continuation records injected by the Claude session-limit recovery
flow (`<openchamber-continuation …>` prefix, `isSynthetic: true`) are also
skipped, but unlike task-notifications they do **not** close the current
turn — the post-recovery assistant stays grouped under the original real
user turn (see *Claude session-limit recovery*). Ids are deterministic and
ascending from record timestamps, and results are cached per transcript
mtime+size. `session-messages.js` merges, in ascending precedence:
transcript replay → OpenCode shell messages → live turn snapshot. The live
snapshot wins the tail turn it already covers (role+text match within a
15-minute window) so a turn flushed to disk mid-stream never renders twice.
Replay is read-only — nothing is written to OpenCode storage — and a
missing/malformed transcript degrades to the previous behavior instead of
failing the route.

Import ids are client-supplied, so a well-formed UUID is not enough: each
`foreignSessionId` must match a `<uuid>.jsonl` transcript actually present
under the resolved projects root, otherwise the row fails with
`SESSION_NOT_FOUND`. Without that check the endpoint would create and
permanently bind sessions no transcript backs.

Owning module: `translators/claude-code/import-from-disk.js`.

### Prompt body

```json
{
  "sessionId": "ses_…",
  "directory": "/path/to/project",
  "target": {
    "harnessId": "claude-code",
    "modelRef": "sonnet",
    "permissionMode": "acceptEdits",
    "effort": "high"
  },
  "text": "…",
  "agentsMode": "opencode",
  "agent": "build",
  "claudeAgent": "code-reviewer",
  "command": { "name": "pr-review", "arguments": "2480" },
  "files": [{ "mime": "image/png", "url": "data:image/png;base64,…", "filename": "a.png" }],
  "messageId": "msg_…",
  "assistantMessageId": "msg_…"
}
```

`command` is optional. When present the server expands the OpenCode command
template and prepends it to `text` (see *OpenCode command translation*).

`agent` names the OpenCode agent to inherit in `agentsMode: 'opencode'`;
`claudeAgent` names the native Claude main-thread agent in `agentsMode:
'claude'`. Both are names only — prompts, permissions and validity are resolved
server-side (see *Agents mode*).

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

### Question reply body

```json
{
  "sessionId": "ses_…",
  "requestId": "qst_…",
  "answers": [["Option A"], ["Option B", "Option C"]],
  "reject": false,
  "directory": "/path/to/project"
}
```

`answers` is an array of per-question selections; each inner array contains the
selected option labels (single for single-select, one or more for multi-select).
Set `reject: true` (and omit `answers`) to dismiss the question without answering.

### Detect statuses

| Status | Meaning |
| --- | --- |
| `ready` | Binary found, SDK importable, subscription login probe positive |
| `needs-login` | Binary + SDK OK; no subscription login (includes API-key-only hosts) |
| `missing-cli` | `claude` not on PATH |
| `unsupported-host` | Reserved (mobile-only / no exec host) — not emitted by v1 local detect |
| `error` | SDK import failure or unexpected detect exception |

**Login probe (B6):** `claude auth status --json` with API-priority env stripped
(`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`). OAuth-like `authMethod` → ready;
API-key / logged-out → continue to credential fallbacks. Fallbacks (in order):

1. Non-empty `CLAUDE_CODE_OAUTH_TOKEN` (Cursor Use Environment / CI secret)
2. Structured `claudeAiOauth.accessToken` in credentials under `CLAUDE_CONFIG_DIR`
   or `~/.claude/.credentials.json` (no secret values returned)

Child Claude processes keep `CLAUDE_CODE_OAUTH_TOKEN` via `auth-env.js` so Desktop
and cloud hosts that inject the secret authenticate without an interactive login.

**Invariant:** detect failure never returns `status: "ready"` with an empty
success catalog. Error / missing-cli responses use `sections: []`.

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

Capability: `permissions: full`.

`translators/claude-code/permissions.js`:

1. `createCanUseTool({ sessionId, directory, getBroadcast, assistantMessageId })`
   → Agent SDK option.
2. On tool ask: emit OpenCode-shaped `permission.asked` (`PermissionRequest`-like:
   `id`, `sessionID`, `permission`, `patterns`, `metadata`, `always`, optional
   `tool: { messageID, callID }`).
3. `always` is populated from concrete command/path patterns, or falls back to
   the tool name so PermissionCard “Always Allow” stays labeled and available.
4. Pending map: `requestId → { resolve, reject, sessionId, timer, … }`.
5. Timeout (~120s) and abort/turn-end → fail-closed deny + `permission.replied`.
6. `replyPermission({ sessionId, requestId, reply })`:
   - `once` → SDK `{ behavior: 'allow', updatedInput }`
   - `always` → allow + `updatedPermissions` from SDK suggestions when present
   - `reject` → `{ behavior: 'deny', message }`

UI: `harnessPermissionReply` → `respondToPermission` / `dismissPermission` branch
when `getSessionTarget(sessionId)?.harnessId === 'claude-code'`.

## Questions bridge

`AskUserQuestion` also reaches the `canUseTool` callback. It is routed to
`translators/claude-code/questions.js` instead of the permission bridge:

1. `createAskUserQuestionHandler({ sessionId, directory, getBroadcast, assistantMessageId })`
   is created by `createCanUseTool` for each turn.
2. On `AskUserQuestion`: emit OpenCode-shaped `question.asked`
   (`QuestionRequest`-like: `id`, `sessionID`, `questions`, optional
   `tool: { messageID, callID }`).
3. Pending map: `requestId → { resolve, reject, sessionId, … }`.
4. Abort / turn-end → fail-closed deny + `question.rejected`.
5. `replyQuestion({ sessionId, requestId, answers?, reject? })`:
   - With `answers` → SDK `{ behavior: 'allow', updatedInput: { questions, answers } }`
   - With `reject: true` → `{ behavior: 'deny', message: 'User declined' }`

The `AskUserQuestion` `tool_use` / `tool_result` blocks are suppressed in
`events/from-claude.js` so the transcript shows the native question card, not a
running/completed generic tool part.

UI: `harnessQuestionReply` → `respondToQuestion` / `rejectQuestion` branch when
`getSessionTarget(sessionId)?.harnessId === 'claude-code'`.

### Agents mode (`harnessClaudeCodeAgentsMode`)

Settings → Harnesses → Claude Code → **Agents to use**:

| Mode | Behavior |
| --- | --- |
| `opencode` (default) | The selected OpenCode agent is inherited onto the Claude turn: its **full permission ruleset** decides every tool call, its `prompt` is appended to the Claude Code preset, and user-authored OpenCode subagents are registered as Claude `agents`. Composer shows the OpenCode agent picker. |
| `claude` | Native Claude Code prompts and permission settings. Composer shows **Claude's own** agent list (`.claude/agents` + built-ins) and the selection is forwarded as the SDK `agent` option; sticky/OpenCode-derived `permissionMode` is not forwarded. |

#### OpenCode agent inheritance

Owning module: `translators/claude-code/opencode-agents.js`.

Before this module, `opencode` mode only mapped the agent's `edit` rule onto a
Claude `permissionMode`, so an agent with `bash: allow` still produced a
PermissionCard for every command. Now the whole ruleset participates.

| Step | Where |
| --- | --- |
| Composer sends only the agent **name** (`agent` in the prompt body) | `lib/harness/claude-agents-mode.ts` → `lib/harness/client.ts` |
| Server re-reads `GET /agent?directory=` from OpenCode | `fetchOpenCodeAgents` |
| Ruleset → per-tool decision | `createOpenCodeToolPolicy` |
| Subagents → Claude `AgentDefinition`s | `buildClaudeAgentDefinitions` |
| Policy consulted before any PermissionCard | `permissions.js` `createCanUseTool({ resolveToolPolicy })` |

Tool mapping: Claude tool names are translated to OpenCode permission keys
(`Bash`/`BashOutput` → `bash`, `Edit`/`Write`/`MultiEdit`/`NotebookEdit` →
`edit`, `WebFetch` → `webfetch`, `Task`/`Agent` → `task`, …); an unmapped tool
falls back to its lowercased name, and `mcp__server__tool` keeps its full name.
The pattern is matched against the tool's own argument (`command` for bash,
`file_path` for edits, `url` for webfetch, …) as a glob.

Resolution order matches `packages/ui/src/stores/utils/permissionUtils.ts`: the
last rule naming the permission explicitly wins; only when none matches does the
last global `*` rule apply. `allow` runs the tool with no prompt, `deny` refuses
with a message naming the agent, and `ask` (or no matching rule) falls through to
the existing PermissionCard bridge.

Invariants:

- **The ruleset never comes from the client.** Only the agent name travels. A
  prompt body carrying `{"*": "allow"}` would otherwise disable the permission
  bridge outright — the same attack the `bypassPermissions` allowlist prevents.
- A concrete pattern with no corresponding tool argument does **not** match
  (fail closed); only `*` matches an absent argument.
- Lookup failure degrades to `ask` for everything and logs; it never fails the
  turn and never silently allows. An unmatched agent name inherits nothing.
- The policy can only decide tools that actually reach `canUseTool`. Bridged
  MCP wildcards in `allowedTools` (`mcp__<server>__*`) are auto-approved by the
  SDK before the callback runs — it warns with
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — so an agent rule denying a bridged MCP
  tool is **not** enforced. Gating those would require a `PreToolUse` hook.
- Only **non-built-in** OpenCode agents with a real `prompt` and
  `mode: subagent | all` are registered as Claude agents. A Claude
  `AgentDefinition.prompt` *replaces* that agent's whole system prompt, so
  registering OpenCode's built-ins (whose `prompt` is usually a one-line config
  addendum) would gut Claude's own general-purpose/Explore agents. Native
  `.claude/agents` still load — the SDK merges both sources.

#### Claude-native agents

Owning module: `translators/claude-code/claude-agents.js`;
route `GET /api/harness/claude-code/agents?directory=`.

Scans `<claudeConfigRoot>/agents/**.md` and `<directory>/.claude/agents/**.md`
(frontmatter `name` / `description` / `model` only) and merges them over the
built-in types. A missing directory contributes nothing and reports a `null`
root — it is never an authoritative empty failure. Scanning is bounded (200
files, depth 5, 500-char descriptions) and shares one budget across both roots.

#### Server-driven turns

A turn started by the server has no composer to read the agent selection from,
and a Claude assistant message carries no `agent`. Every user turn therefore
re-stamps `agentsMode` / `agentName` / `claudeAgentName` onto the durable
binding, and the server-side callers replay them:

| Caller | Path |
| --- | --- |
| Session goal auto-continuation | `session-goal/runtime.js` → `sendContinuation` |
| Agent control tool (`session.send` on a Claude session) | `openchamber-sessions/routes.js` |

Without this a goal loop or a tool-dispatched turn silently reverts to asking
for every tool halfway through a session that was running unattended. Bindings
written before this field existed simply carry none of it and degrade to the
previous behavior — the next user turn re-stamps them.

The composer reads the same fields back through
`GET /api/harness/sessions/:sessionId` (`useClaudeAgentsStore.hydrateSelection`)
so a reload does not reset the Claude agent chip to "Claude default" while the
binding still names an agent. Nothing is written to client storage — the binding
is the authority. Hydration runs once per session and never overwrites a pick
made in the current tab, and a missing binding or failed lookup leaves the
selection untouched rather than asserting "default".

The same re-stamping is why the client-side callers must send the agent name on
**every** path, not only the plain composer send: harness handoff
(`sync/session-ui-store.ts`) and MultiRun (`stores/useMultiRunStore.ts`) used to
strip it for Claude targets, which left the first turn of a handed-off or
multi-run session inheriting nothing.

The translator re-validates `claudeAgent` against this same discovery before
forwarding it as the SDK `agent` option: the SDK fails the whole turn on an
unknown agent name, and the client's picker can be stale because agent files
change on disk. An unknown name is dropped (logged) and the default main-thread
agent runs.

That inheritance is enforced server-side for `permissionMode` allowlisting: `query.js` only
forwards `default` / `acceptEdits` / `plan` to the SDK and drops anything else.
A client-supplied `bypassPermissions` would otherwise disable the `canUseTool`
bridge outright — and with it auto-accept, which answers through that bridge.
`ClaudePermissionMode` in `packages/ui/src/types/harness.ts` is narrowed to the
same three values, so no surface can produce a bypass mode.

## Goal on Claude

Capability `goal: full`. Session-goal listens to harness events through
`addHarnessEventObserver` and reads last-turn text from
`turn-snapshot.js` (OpenCode `/session/:id/message` is empty for harness
turns). Continuations call `harnessRouter.prompt` / `/api/harness/prompt`.
Claude SDK `result.usage` is mapped into OpenCode-shaped
`assistant.info.tokens` (and `total_cost_usd` → `cost`) so goal token
budgets use the same counters as OpenCode sessions.

## OpenChamber tool on Claude

Capability `openchamber-tool: full`. When `agentControlToolEnabled` is not
`false`, each Claude turn injects an in-process SDK MCP server
(`createSdkMcpServer`) named `openchamber` via
`packages/web/server/lib/agent-tool/claude-mcp.js`. The adapter calls the
same control-service action allowlist as the managed OpenCode plugin.
Claude session status / messages / wait overlay harness turn-snapshots so
`wait` works for Claude-bound sessions. Session create/send/fork with
`claude-code/<modelRef>` dispatch through `/api/harness/prompt`.

Injected `mcp__openchamber__*` tool asks are auto-allowed in
`permissions.js` (no PermissionCard) — the tool is already gated by the
settings flag and a fixed action allowlist, matching OpenCode's managed
plugin (which has no equivalent second prompt).

Each turn owns an `AbortController` whose signal is handed to
`createOpenChamberMcpServers` and reaches `executeAction` → `waitForIdle`.
The turn aborts it on user abort, on stream end, and when `startQuery` fails.
Without that, a control action started with `wait: true` keeps polling for its
whole `timeout` (up to 24h) after the turn is gone; the control service
rejects with `499` once the signal fires.

## MultiRun on Claude

Capability `multirun: full`. The MultiRun launcher model picker includes
Claude Code harnesses/models. Each run persists an `ExecutionTarget` and
`routeMessage` sends Claude runs through `/api/harness/prompt`.

## Slash commands / MCP / subagents

Capabilities: `slash-commands: full`, `mcp: full`, `subagents: full`.

| Concern | Behavior |
| --- | --- |
| Slash | Claude-native `/command` (from `system/init.slash_commands` + built-ins) is sent as harness prompt text. UI autocomplete switches to Claude commands on Claude sessions. OpenCode/OpenChamber commands are **translated** into prompt text (see below). `/compact` uses Claude compaction, not OpenCode summarize. |
| MCP | OpenChamber MCP configs (`opencode` mcp entries) convert to Claude `mcpServers` (`stdio` / `http`). Project `.mcp.json` still loads via `settingSources`. Status from `system/init.mcp_servers` is stored in `session-capabilities.js`. |
| Subagents | `Agent` is allowed; nested `parent_tool_use_id` streams map into synthetic child sessions (`session.created` with `parentID`) so the sidebar shows subagent work. |

### OpenCode command translation

Owning module: `translators/claude-code/opencode-command.js`.

Claude Code has no concept of an OpenCode command, so `/pr-review` (and every
other `.opencode/command` / OpenChamber command, including OpenCode skills,
which OpenCode registers as commands) is translated into ordinary prompt text
before the turn starts.

| Step | Where |
| --- | --- |
| Detect that the slash token is an OpenCode command, not Claude-native | `session-ui-store.routeMessage` |
| Send `command: { name, arguments }` in the prompt body | `lib/harness/client.ts` |
| Resolve the authoritative template (`GET /command?directory=`) | `resolveOpenCodeCommandDefinition` |
| Expand the template | `expandOpenCodeCommandTemplate` |
| Use the expanded text for the SDK prompt **and** the user message event | `translators/claude-code/index.js` |

Template syntax:

| Token | Behavior |
| --- | --- |
| `$ARGUMENTS` | Replaced with the text typed after the command name (every occurrence). Arguments with no placeholder are appended instead of dropped. |
| ``!`cmd` `` | Replaced with the command's output, run in the session cwd (30s timeout, 100KB output, max 20 substitutions per template). A failed substitution is inlined as `[command failed: …]` so one broken command does not discard the template. |
| `@file` | Left as-is — intentional runtime difference: Claude Code resolves `@path` mentions natively and can `Read` the file, so inlining would only duplicate bytes. |

Invariants:

- The **template never comes from the client**. Only the command name and
  arguments travel, and the server re-reads the definition from OpenCode per
  turn — otherwise a prompt body could hand the server arbitrary shell to run.
- Lookup failure is not "command not found": an unreachable OpenCode returns
  `COMMAND_LOOKUP_FAILED` (502) / `COMMAND_UNAVAILABLE` (503), never a 404 that
  looks like a command the user never defined.
- Translation runs **before** `bindSession` and before any optimistic user
  message is broadcast, so a failed lookup leaves no half-started turn and the
  client rolls its optimistic message back.
- `text` in the prompt body carries only the sections *around* the command
  (handoff seed, queued follow-ups); the server joins them after the expanded
  template rather than dropping that user input.
- The command's own `agent` / `model` fields are ignored — the turn runs on the
  session's Claude target and OpenChamber agent selection.

Invariants that are easy to break here:

- `openchamber` is a **reserved** `mcpServers` key. `permissions.js` auto-allows
  every `mcp__openchamber__*` tool by name, and `.opencode/opencode.json` lives
  inside the opened repository — so a bridged config claiming that name is
  dropped in `mcp-config.js`. Merge order is not a guard: the in-process control
  server is absent whenever `agentControlToolEnabled` is off or its construction
  throws.
- Subagent tool parts and text segments live in `ctx.subagentByToolUseId`, not
  `ctx.toolParts`. Both abort and the terminal `result` message close every
  child context first (`buildSubagentClosureEvents`), or a nested transcript
  spins forever.
- Subagent errors surface on their own `message.updated`; only the parent turn
  emits session `busy`/`idle`.
- Subagent session ids (`ses_claude_sub_*`) are transcript-only and are excluded
  from `turn-snapshot.js` — they never report status, so snapshotting them would
  evict real sessions once the bounded budget fills.
- `session-capabilities.js` bounds its per-session map the same way
  `turn-snapshot.js` does; dropping an entry is safe because the next
  `system/init` repopulates it and lookups fall back to built-in defaults.

`GET /api/harness/sessions/:sessionId/capabilities` returns the latest snapshot
(built-in slash defaults before the first init). UI:
`useClaudeSessionCapabilitiesStore` + `harnessSessionCapabilities`.

## Follow-ups while busy

Claude rejects a second `prompt` for the same session with HTTP `409`
`TURN_IN_PROGRESS` (no second Claude process), including while a durable Claude
session-limit retry exists. The UI must not steer into an active Claude turn.
Follow-ups use the OpenChamber message queue (reorder + idle auto-send). That
queue is durable only in the same browser/Desktop profile; it is not a server
queue and does not synchronize across clients or devices. Abort/Stop interrupts
an active turn or cancels a waiting recovery and clears activity via
`session.status: idle` without deleting queued follow-ups.

Harness events stamp `properties.directory` and SSE fan-out preserves the
directory envelope so UI directory stores receive busy/idle (Stop + queue
auto-send). `GET /api/session/status` overlays active Claude busy entries so
OpenCode status polls cannot clear harness turns. `GET /api/session/:id/message`
overlays the transcript replay and the live turn snapshot so OpenCode's empty
message list cannot wipe Claude chat on materialization/refetch.

## Session titles on Claude

Claude prompts bypass OpenCode `session.promptAsync`, so upstream
`ensureTitle` never runs. `session-title/runtime.js` listens to harness idle
events and names the session once: it first inherits Claude's own `ai-title`
transcript record (`readClaudeTranscriptTitle`, with bounded retries because
the CLI can write the record slightly after idle), and falls back to the
small-model helper from harness turn text when no native title exists. The
title is PATCHed onto the OpenCode shell session. Manual rename still uses
`session.update`.

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
- `startClaudeQuery({ prompt, cwd, model, resume, permissionMode, effort, systemPrompt, canUseTool, mcpServers, allowedTools, skills, settingSources, forwardSubagentText, agentProgressSummaries, env, hooks })`
  - `hooks` is **server-internal only** (`Partial<Record<HookEvent, HookCallbackMatcher[]>>`):
    the translator forwards SDK hook callbacks such as the recovery
    `PreToolUse` fingerprint guard. The public prompt route never supplies it
    and the wrapper reads it only from the top-level `params.hooks`, never from a
    client body, so a client cannot inject hooks. Only forwarded when non-empty.
- Resolves `pathToClaudeCodeExecutable` via `executable-path.js` (PATH / env /
  `app.asar.unpacked` native package) so Electron does not spawn a path inside
  `app.asar` (that fails with `ENOTDIR`).
- Validates `cwd` is a real directory before starting the query.
- `includePartialMessages: true` for streaming deltas
- Defaults: `skills: 'all'`, `settingSources: ['user','project','local']`,
  `forwardSubagentText: true`, `agentProgressSummaries: true`
- Bridges OpenChamber MCP configs via `mcp-config.js` into `mcpServers` and
  `allowedTools` MCP wildcards only (`mcp__name__*`; bare Agent/Skill omitted so
  they do not shadow `canUseTool`)
- `interrupt()` when available, plus `killProcessTree(pid)` on abort/close

If the SDK import fails:

- Detect → `error` (not ready)
- Prompt → HTTP `503` with `CLAUDE_SDK_UNAVAILABLE`

Packaged Desktop also sets electron-builder `asarUnpack` for
`@anthropic-ai/claude-agent-sdk-*` native packages.

## Attachments

Capability: `file-attachments: full`.

OpenChamber `{ mime, url, filename }` → SDK content blocks:

| Source | Mapping |
| --- | --- |
| `data:` image (`png|jpeg|gif|webp`) | `image` base64 block |
| `data:` text-like / json/yaml/svg | labeled `text` block |
| `data:` `application/pdf` | `document` base64 block |
| `file://` or absolute path under session cwd | path reference text (`Attached project file: …`) after sandbox + MIME/size checks; Claude can `Read` the file natively |
| `file://` with `preferPathReferences: false` | embed bytes like `data:` |
| path outside cwd | reject `400 ATTACHMENT_PATH_OUTSIDE_CWD` |
| symlink inside cwd resolving outside | reject `400 ATTACHMENT_PATH_OUTSIDE_CWD` |
| other binary (e.g. zip) | reject `400 ATTACHMENT_UNSUPPORTED_TYPE` |

User message events also emit OpenCode-shaped `file` parts so the transcript
reconciles optimistic attachments.

Turns with attachments use `AsyncIterable<SDKUserMessage>`; text-only may use
a string prompt.

## Event transport choice (spec §21)

**Chosen approach:** emit OpenCode-shaped payloads through
`createGlobalUiEventBroadcaster` with `{ directory }`, so the existing message
stream WS clients deliver them into `event-pipeline` / `event-reducer` without
a parallel harness channel.

Message/part IDs: OpenCode-compatible **ascending** `msg_*` / `prt_*` (timestamp
+ counter prefix, same shape as UI `ascendingId`). The UI sorts parts by id via
`Binary.search`, so random UUIDs reorder tool/text blocks in the transcript.
After each `tool_use`, the mapper starts a **new text part** so post-tool reply
text sorts after tools (`text → tool → text`), not merged above them.

Prompt may echo client-provided `messageId` / `assistantMessageId` for
optimistic reconcile.

## UI send path (shared UI)

- `packages/ui/src/lib/harness/client.ts` — `harnessPrompt` / `harnessAbort` /
  `harnessPermissionReply` / `harnessQuestionReply` / `harnessSessionBinding` via `runtimeFetch`
- `packages/ui/src/lib/harness/resolve-execution-target.ts` — sticky `ExecutionTarget` resolution
- `packages/ui/src/sync/session-ui-store.ts` — `routeMessage` branches `claude-code` → harness prompt (not OpenCode SDK)
- `packages/ui/src/sync/session-actions.ts` — permission and question reply/dismiss branches for Claude targets
- `packages/ui/src/lib/harness/composer-attachment-model.ts` — composer attachment modality warnings use the active `ExecutionTarget` (Claude catalog), not leftover OpenCode `currentModel`
- Model picker Harnesses section lives in `ModelControls` / `ModelPickerList`
- `ModelControls` derives the displayed Claude effort from the persisted
  `ExecutionTarget` (single source of truth — a local copy would drift from
  what the next prompt sends) and hydrates a missing session target from
  `GET /api/harness/sessions/:sessionId`, so imported sessions and fresh
  browsers keep the Claude harness/effort instead of being stamped OpenCode.

## Out of scope (later slices)

- Codex CLI / Gemini CLI harnesses
- Reverse handoff billing notice (Claude → OpenCode)
- MCP settings editor for Claude

## Claude session-limit auto-resume

Owning modules: `events/from-claude.js`, `pending-retry-store.js`,
`retry-policy.js`, `retry-runtime.js`, and
`translators/claude-code/recovery-transcript.js` / `index.js`.

Scheduling never parses assistant prose. It requires the parent assistant's
structured `error: 'rate_limit'` to correlate with a rejected structured
`rate_limit_event`; English error text, warning/allowed metadata, and nested
assistant failures are non-authoritative. `system/api_retry` is different: the
SDK already owns that short retry. OpenChamber projects its `retry` status and
the next SDK activity restores `busy`, but does not create a journal obligation
or launch a competing request.

The visible hard-quota lifecycle is `busy -> retry -> busy -> idle`; another
limit produces `busy -> retry -> busy -> retry`. There is no idle edge while a
persisted wait exists. The journal write precedes the first retry event, and a
failed initial write makes the translator use normal hard-error/idle handling
instead of claiming auto-resume. Retry snapshots and `/api/session/status`
overlay both preserve the complete retry payload (`attempt`, stable `message`
reason, and optional absolute-millisecond `next`).

### Durable retry journal

File: `$OPENCHAMBER_DATA_DIR/harness-pending-retries.json` (fallback
`~/.config/openchamber/harness-pending-retries.json`). It is distinct from the
debounced binding store.

| Rule | Behavior |
| --- | --- |
| Format | Versioned JSON `{ version: 1, retries: [...] }`; states are `observed`, `waiting`, `launching`, or `blocked` |
| Contents | Allowlisted session/directory/foreign-session identity, sanitized Claude target and agent selection, generation/attempt, rate-limit/reset/deadline metadata, transcript-tail/launch UUIDs, timestamps, and blocked reason |
| Excluded | Prompts, attachments, tool output, queue bodies, credentials, tokens, and environment values |
| Bounds | At most 500 records and 1 MiB; strings and numeric fields are clamped/validated |
| Security | Parent directory `0700`, journal/temp files `0600`; ownership/mode checked on POSIX; no-follow opens where supported |
| Durability | Synchronous process-coordinated lock, complete temp write + fsync + rename + parent-directory sync; memory publishes only after persistence |
| Failure | Malformed, unsupported, oversized, insecure, contended, or failed I/O raises `RETRY_STORE_UNAVAILABLE`, never authoritative empty; failed critical writes retain/restore the prior snapshot where possible |

Reset input accepts epoch seconds, epoch milliseconds, and the SDK's small
relative-millisecond values, normalizing all of them to absolute epoch
milliseconds. A reset more than eight days (`691_200_000` ms) in the future is
rejected. Valid future resets receive five seconds of grace plus stable
per-session jitter; past resets wait at least one second. Missing/invalid resets
fall back to five-minute exponential delays capped at one hour. Timers use one
earliest-deadline scheduler, chunk at `2_147_483_647` ms, and re-read the wall
clock after wake. The policy contains a seven-day stale-unknown blocked result,
but the integrated runtime does not currently persist/pass its unknown-reset
age marker, so that age-based transition is not reached; transcript safety can
still put a record in `blocked`. Blocked status has no invented deadline and
remains stoppable.

When a Claude Agent SDK turn is rejected mid-stream by a session-limit rate
limit, the parent assistant message that hit the limit is what the user sees
as the unfinished turn. Recovery resumes the same `foreignSessionId` so the
SDK rebuilds model context from the durable transcript on disk. Resuming is
only structurally safe when every `tool_use` that rate-limited assistant
issued already has a matching `tool_result` on disk — otherwise the replayed
context would hand the model a call whose effects it never observed settle.

The transcript module implements analysis + projection + replay hiding. The
scheduler persists `waiting -> launching` before invoking Claude, uses a maximum
of two concurrent launches, deletes the obligation before final idle, and moves
another confirmed limit back to waiting with an incremented attempt.

API:

- `buildRecoveryUserMessage(launchUuid)` — the synthetic SDK `user` message
  that prompts the model to continue. `priority: 'now'`, `isSynthetic: true`,
  and a single text block prefixed with
  `<openchamber-continuation version="1" reason="claude-session-limit">`.
- `fingerprintToolCall(toolName, input)` — canonical JSON `{ tool, input }`
  fingerprint. Stable across object-key order; preserves array order and
  value types so two structurally-equal tool calls produce the same string.
- `inspectRecoveryTranscript({ foreignSessionId, expectedTailUuid, launchUuid })`
  — reads the bounded transcript through the same `findClaudeTranscriptPath`
  the replay parser uses, anchors the analysis at the last real (non-sidechain
  / non-meta / non-internal) user turn, pairs every `tool_use` with a matching
  `tool_result`, returns `{ safe: false, reason: 'unsettled-tool' }` if any
  call is unmatched, otherwise
  `{ safe: true, fingerprints: [{ toolName, fingerprint }], tailPresent: boolean }`
  where `tailPresent` reports whether the caller-correlated rate-limit
  assistant `uuid` appears in the window. Both success and error
  `tool_result`s count as settled; missing / empty / oversize / unreadable
  transcripts fail closed with `{ safe: false, reason: 'transcript-unreadable' }`.
- `createRecoveryToolGuard(fingerprints)` — returns an SDK `PreToolUse` hook
  callback that denies an exact pre-limit fingerprint replay
  (`hookSpecificOutput.permissionDecision: 'deny'`) and allows everything
  else (`{ continue: true }`). Accepts either `{ toolName, fingerprint }`
  shapes or bare fingerprint strings.
- `isRecoveryContinuationRecord(record)` — true only when the record is
  `isSynthetic === true` AND the user text content exactly starts with the
  marker. A real user message that merely starts with similar text but is
  not synthetic stays visible — only both conditions trigger hiding.

Invariants:

- This module writes nothing — it is read-only with respect to Claude JSONL,
  the durable binding store, and OpenCode message storage.
- The analysis window never includes sidechain / meta / task-notification /
  synthetic recovery continuation records; an unmatched tool from a prior,
  pre-window turn is irrelevant to recovering the current rate-limited tail
  and is not reported as unsafe.
- The synthetic continuation this feature injects is invisible on the replay
  surface (hidden by `transcript-messages.js`) and does not close the active
  turn so the post-recovery assistant inherits the original user message as
  its `parentID`.
- The exact-fingerprint guard prevents literal duplicate tool calls, including
  calls whose previous result was an error, but cannot guarantee semantic
  exactly-once effects when Claude expresses an equivalent operation
  differently. There is no transactional/idempotency boundary across arbitrary
  shell, MCP, filesystem, or network tools.

### Recovery lifecycle ownership and current limitations

- Stop works while waiting or launching: harness ownership removes the journal
  record, clears scheduling, aborts a launch, rejects pending permission/question
  callbacks, emits the abort marker/idle through the translator, and leaves the
  client queue intact. Generation checks make stale finalizers inert.
- Authoritative session deletion delegates to harness ownership and removes the
  retry, active recovery, binding, turn snapshot, capabilities, and callbacks
  without emitting into the deleted session. Startup orphan checks preserve a
  record on transient lookup failure and remove only a definitive deletion.
- Server startup starts the harness recovery runtime before authoritative status
  publication and reconstructs retry snapshots. Waiting records resume
  scheduling. The current implementation converts an unresolved persisted
  `launching` record back to `waiting` unless inspection reports a safe tail as
  present (then it removes the record); it does not implement the design's
  fail-closed `blocked` classification for every ambiguous crash state.
- Graceful web shutdown stops the harness before OpenCode/message transport and
  preserves waiting records. A launching record is synchronously rewritten to
  waiting before its controller is aborted. The current runtime's `stop()` is
  synchronous and persistence failures in that rewrite are swallowed, so
  shutdown awaiting guarantees ordering, not proof that every failed write was
  made restart-safe.

## Testing

```bash
bun test packages/web/server/lib/harness/registry.test.js
bun test packages/web/server/lib/harness/detect.test.js
bun test packages/web/server/lib/harness/routes.test.js
bun test packages/web/server/lib/harness/session-bindings.test.js
bun test packages/web/server/lib/harness/events/from-claude.test.js
bun test packages/web/server/lib/harness/translators/claude-code/auth-env.test.js
bun test packages/web/server/lib/harness/translators/claude-code/attachments.test.js
bun test packages/web/server/lib/harness/translators/claude-code/permissions.test.js
bun test packages/web/server/lib/harness/translators/claude-code/questions.test.js
bun test packages/web/server/lib/harness/translators/claude-code/transcript-messages.test.js
bun test packages/web/server/lib/harness/translators/claude-code/recovery-transcript.test.js
bun test packages/web/server/lib/harness/translators/claude-code/opencode-command.test.js
bun test packages/web/server/lib/harness/translators/claude-code/opencode-agents.test.js
bun test packages/web/server/lib/harness/translators/claude-code/claude-agents.test.js
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
