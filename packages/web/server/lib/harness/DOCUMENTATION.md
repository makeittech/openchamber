# Harness Runtime

This module owns server-side execution harnesses. OpenCode remains the default
UI/API path; Claude Code runs through the official Agent SDK and local `claude`
CLI, then translates its output into OpenCode-shaped events. Product decisions
and acceptance criteria live in
[`docs/engines-claude-code-spec.md`](../../../../../docs/engines-claude-code-spec.md).

User-facing copy uses **Harness**. Internal contracts use `harnessId`.

## Invariants

- The OpenCode session ID is the UI shell and event `sessionID`. A durable
  binding stores Claude's native `session_id` as `foreignSessionId` for resume.
- A binding's `harnessId` is immutable. Switching a used session creates a new
  session and transfers context; it never rewrites the source binding.
- A user turn is routed to exactly one backend. Claude turns never also call
  OpenCode `session.promptAsync`.
- Claude emits through `createGlobalUiEventBroadcaster` with `{ directory }`.
  The existing WS/SSE event pipeline remains the only live transcript/status
  channel; `/api/session/status` and message reads overlay harness state.
- Detect, transcript, or upstream fetch failure must not become authoritative
  empty success. One failed Claude session must not affect unrelated sessions.
- IDs are OpenCode-compatible and ascending. Text/reasoning segments close at
  tool boundaries, preserving `text -> tool -> text`; completed tool states
  retain their input because the UI replaces tool state wholesale.
- Attachment validation and OpenCode-command expansion happen before binding or
  optimistic user events. Rejected input cannot leave a phantom busy turn.
- Abort interrupts the SDK, tree-kills the process group, fails pending
  permissions/questions closed, settles open parts, emits the abort marker, and
  returns the session to idle. Only one active or waiting recovery turn is
  allowed per session (`409 TURN_IN_PROGRESS`).

## Ownership

| Concern | Owner |
| --- | --- |
| Descriptors, model catalog, capabilities | `registry.js` |
| Binary, SDK, and subscription-login detection | `detect.js`, `binary-path.js` |
| Sticky session bindings | `session-bindings.js` |
| Dispatch and HTTP registration | `router.js`, `routes.js` |
| Active status, messages, turn data, capabilities | `session-status.js`, `session-messages.js`, `turn-snapshot.js`, `session-capabilities.js` |
| Claude orchestration and SDK process | `translators/claude-code/index.js`, `query.js`, `auth-env.js` |
| Event translation | `events/from-claude.js`, `events/emit.js` |
| Attachments, permissions, questions | `translators/claude-code/attachments.js`, `permissions.js`, `questions.js` |
| OpenCode commands and agents; native Claude agents | `translators/claude-code/opencode-command.js`, `opencode-agents.js`, `claude-agents.js` |
| Claude import and transcript replay | `translators/claude-code/import-from-disk.js`, `transcript-messages.js` |
| Session-limit journal, policy, runtime, transcript safety | `pending-retry-store.js`, `retry-policy.js`, `retry-runtime.js`, `translators/claude-code/recovery-transcript.js` |

`feature-routes-runtime.js` registers these routes before the generic OpenCode
proxy. `core-routes.js` enables JSON parsing for `/api/harness`. Shared UI calls
Claude routes with `runtimeFetch`; OpenCode traffic stays on
`@opencode-ai/sdk/v2`.

## Session and event contract

The first Claude prompt creates a binding containing `sessionId`,
`harnessId: 'claude-code'`, directory, target, optional handoff source, and the
latest agent selection. Each real user turn re-stamps `agentsMode`,
`agentName`, and `claudeAgentName`, allowing server-driven Goal and agent-tool
turns to preserve the selected behavior. The SDK-reported `session_id` is then
stored for subsequent resume.

The translator emits `message.updated`, `message.part.updated`,
`message.part.delta`, `session.status`, hard `session.error`, permission events,
and question events. Claude thinking maps to `reasoning`; suppressing it would
discard output requested with `effort`. `AskUserQuestion` uses native question
events rather than a generic tool card. Claude result usage maps to
`assistant.info.tokens` and cost for Goal accounting.

Claude's subagent tools (`Agent`, `Task`) are normalized to the OpenCode `task`
tool id in both the live mapper and transcript replay so the Agent Task row,
nested summary, and "Open subtask" link render like an OpenCode session; the
completed/error part keeps the synthetic child session id + title in
`state.metadata` (set at tool_use time) and shows the human "Agent Task" title.

Harness switching is owned by the UI switch store and `perform-handoff.ts`:

- Empty or same-harness sessions update in place.
- With confirmation enabled (default), the dialog creates and navigates to the
  destination immediately. `duplicate` transfers a bounded visible transcript;
  `summarize` uses OpenCode summarize or Claude `/compact` as appropriate.
- With confirmation disabled, the destination is created on the next send with
  the legacy hidden seed.
- OpenCode destinations receive context with `noReply`; Claude destinations run
  a normal prompt requesting a short acknowledgement.

Follow-ups while Claude is busy or retrying use the existing durable
browser/Desktop-profile queue. It is not a server or cross-device queue. Stop
does not delete queued follow-ups.

## HTTP API

All routes use normal OpenChamber runtime authentication. Responses and logs
must not expose credentials, tokens, prompts from the retry journal, or
attachment bytes.

| Method | Route | Contract |
| --- | --- | --- |
| `GET` | `/api/harness` | `{ catalogs }` with descriptor, status, optional detail/version, and sections |
| `GET` | `/api/harness/:id` | Detect and return one catalog |
| `POST` | `/api/harness/:id/detect` | Force the same uncached detection |
| `POST` | `/api/harness/prompt` | Validate and start an asynchronous Claude turn; returns `202` |
| `POST` | `/api/harness/abort` | Abort an active turn or waiting/launching recovery |
| `POST` | `/api/harness/permission/reply` | Reply `once`, `always`, or `reject` to `canUseTool` |
| `POST` | `/api/harness/question/reply` | Answer or reject `AskUserQuestion` |
| `GET` | `/api/harness/sessions/:sessionId` | Return the durable binding |
| `GET` | `/api/harness/sessions/:sessionId/capabilities` | Return slash/MCP/agent snapshot, with built-in defaults before init |
| `GET` | `/api/harness/claude-code/agents?directory=` | Discover native Claude agents |
| `GET` | `/api/harness/claude-code/import/candidates` | List local Claude projects/chats |
| `POST` | `/api/harness/claude-code/import` | Import up to 100 selected chats independently |

Prompt input includes `sessionId`, `directory`, a Claude execution `target`,
text, optional attachments, optimistic message IDs, agent mode/name, and an
optional OpenCode command name/arguments. Command templates and agent rules are
always resolved server-side; the client may not supply either authority.

Detect states are `ready`, `needs-login`, `missing-cli`, `error`, and reserved
`unsupported-host`. `ready` requires a resolvable CLI, importable SDK, and
subscription authentication. Detection strips API-priority env before
`claude auth status --json`, then checks `CLAUDE_CODE_OAUTH_TOKEN` and Claude's
structured OAuth credential. API-key-only hosts are `needs-login`.

## Claude behavior

### SDK, tools, and agents

`query.js` lazy-loads `@anthropic-ai/claude-agent-sdk`, validates cwd, resolves
an Electron-safe executable outside `app.asar`, enables partial messages, and
loads user/project/local settings. SDK unavailability is detect `error` and
prompt `503 CLAUDE_SDK_UNAVAILABLE`.

`agentsMode: 'opencode'` is the default. The server fetches the named OpenCode
agent, appends its prompt, applies the full permission ruleset, and registers
eligible user-authored subagents. Last matching explicit permission rule wins;
the last global `*` rule is fallback. Lookup failure or no match asks rather
than allows. Concrete rules without a corresponding tool argument do not match.
SDK-auto-approved bridged MCP wildcards do not reach `canUseTool`, so an
OpenCode deny rule cannot currently block those calls.

Each registered subagent carries its own inherited tool policy: blanket `deny`
rules (wildcard pattern) become Claude SDK `disallowedTools` on the
`AgentDefinition` so the SDK refuses before `canUseTool` is asked, and a
lowercased-name → policy map is exposed for permission checks made *inside* a
running subagent. A per-turn runtime correlates the SDK's subagent ids
(`SubagentStart` `agent_id`/`agent_type`, `canUseTool` `agentID`) back to the
Agent/Task tool_use that spawned them (handling the hook racing the parent
tool's own permission check), so nested calls resolve against that subagent's
ruleset instead of the parent's. Permission asks raised inside a subagent are
stamped on the synthetic `ses_claude_sub_*` child session id with
`metadata.fromSubagent` and `metadata.parentSessionID` so the PermissionCard
shows the localized "From subagent" badge and replies route back to the parent
session; abort/turn-end cleanup settles those child-stamped asks too.

`agentsMode: 'claude'` uses native Claude prompts/permissions and a discovered
agent. Discovery scans bounded user and project `.claude/agents` trees; stale or
unknown selections are dropped rather than failing the turn.

Permissions and questions are held in pending maps and fail closed on
timeout, abort, or turn end. `bypassPermissions` is never accepted from the
client; only `default`, `acceptEdits`, and `plan` may reach the SDK. The reserved
`openchamber` MCP name cannot be supplied by project config. When enabled, the
in-process OpenChamber MCP server uses the same fixed control-action allowlist
as the managed OpenCode plugin and is aborted with its owning turn.

Claude-native slash commands are sent directly. OpenCode/OpenChamber commands
are resolved from OpenCode and expanded server-side: `$ARGUMENTS`, bounded
``!`command` `` substitutions, and native `@file` references. Lookup failures
remain upstream failures rather than false “not found” responses.

### Attachments and transcript replay

Supported `data:` payloads are PNG/JPEG/GIF/WebP images, text-like data, and
PDF. Absolute or `file://` project paths are sandboxed by real path beneath cwd
and normally become path references; symlink escapes and outside paths are
rejected. Other binaries are rejected, never silently dropped. Attachment
turns use streaming SDK user messages and emit canonical file parts.

Import validates that every client-supplied foreign UUID names a transcript
under the resolved Claude projects root. It creates an OpenCode shell and
binding but never copies unstable Claude JSONL into OpenCode storage. Candidate
titles follow Claude's custom name, `ai-title`, summary, then first user text.
One failed import does not roll back successful rows; existing foreign bindings
are skipped.

Replay parses bound JSONL read-only into deterministic messages, including
reasoning and settled tools. Task notifications and marked synthetic recovery
messages are hidden. Merge precedence is replay, OpenCode shell, then live turn
snapshot; the live tail wins matching recent turns to prevent duplicates.
Missing or malformed transcripts degrade without failing message reads.

## Persistence and security

### Session bindings

`$OPENCHAMBER_DATA_DIR/harness-session-bindings.json` (fallback
`~/.config/openchamber/`) is versioned `{ version: 1, bindings: [...] }`, pruned
to about 200 entries, sanitized through an allowlist, and written by debounced
temp-file rename (about 250 ms). The directory is `0700` and file `0600` where
supported. `flushSessionBindings()` drains synchronously. Binding persistence
logs write/load failure and continues with available in-memory state.

### Subscription-only process policy

Claude child processes inherit the full host environment for PATH and normal
tool behavior, except `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are removed.
OAuth remains in Claude's own credential store or `CLAUDE_CODE_OAUTH_TOKEN`;
OpenChamber settings and runtime APIs never persist or return it. Never call
Anthropic HTTP directly with extracted subscription credentials.

### Session-limit recovery

Only a parent assistant `error: 'rate_limit'` correlated with a structured
rejected rate-limit window creates durable recovery. English prose, warning or
allowed windows, and nested failures are not authority. `system/api_retry` is
SDK-owned: OpenChamber projects retry status but launches no competing request.

The Claude Agent SDK delivers the structured rate-limit messages
(`rate_limit_event`, parent `error: 'rate_limit'`, `result`) and then throws
its own `Claude Code returned an error result: ...` exit error after the
stream. The translator treats a correlated structured terminal as
authoritative even when that exit error lands in the turn's catch path, so the
durable obligation is still scheduled (never a generic `CLAUDE_TURN_ERROR`).

The visible hard-limit lifecycle is `busy -> retry -> busy -> idle`, or back to
`retry` on another limit. There is no intermediate idle while an obligation
exists. Persistence precedes the first retry event; deletion precedes terminal
idle. Retry snapshots preserve attempt, stable reason, and optional absolute
deadline across polling and restart.

`$OPENCHAMBER_DATA_DIR/harness-pending-retries.json` is a separate synchronous,
versioned journal with states `observed`, `waiting`, `launching`, and `blocked`.
It stores only bounded, allowlisted identity, sanitized target/agent selection,
generation/attempt, rate-limit/deadline, transcript-tail/launch IDs, and
timestamps. It never stores prompts, attachments, tool output, queue bodies,
credentials, tokens, or environment values. Hard bounds are 500 records and
1 MiB. POSIX owner/mode checks, no-follow opens where available, a
process-coordinated lock, full temp write, fsync, rename, and directory sync
protect updates. Corrupt, insecure, contended, oversized, or failed storage
raises `RETRY_STORE_UNAVAILABLE`; it never becomes empty success.

Reset timestamps accept epoch seconds, epoch milliseconds, or SDK relative
milliseconds. Values over eight days ahead are invalid. Valid future resets add
five seconds and stable jitter; past resets wait at least one second; unknown
resets use five-minute exponential fallback capped at one hour. One scheduler
uses the earliest deadline, chunks platform-long timers, rechecks wall time,
and runs at most two recoveries concurrently.

Recovery resumes the full foreign session with a strictly marked synthetic
message; it never replays the original prompt or attachments. Before launch,
the bounded raw transcript must show every current-turn `tool_use` settled by a
`tool_result`. Unsafe/unreadable state blocks without a fake deadline. A
recovery-only `PreToolUse` hook denies exact canonical repeats of settled calls,
including prior errors. Projection hides only records carrying both the
synthetic flag and exact marker and keeps recovered assistant output under the
original real user turn.

Stop removes the journal generation, clears scheduling, aborts launches and
callbacks, and emits abort/idle while preserving queued follow-ups. Authoritative
session deletion removes all harness state without emitting into the deleted
session; transient startup lookup failure preserves the record. Shutdown keeps
waiting obligations and rewrites launching records before aborting controllers.

## Current limitations

- `unsupported-host` is reserved but local detection does not emit it.
- The static Claude model catalog and fixed picker order are not dynamically
  discovered/configurable. Historical handoff attachments are not transferred.
- The retry policy supports blocking after seven days of unknown reset data,
  but the runtime does not persist/pass `firstUnknownAt`; capped retries can
  continue indefinitely unless transcript safety blocks them.
- Startup converts ambiguous persisted `launching` records to `waiting` (or
  removes them when a safe expected tail is present) instead of always blocking.
- `retry-runtime.stop()` is synchronous and swallows a failed launching-to-waiting
  journal rewrite. Shutdown ordering is awaited, but restart-safe persistence
  cannot be guaranteed after that write failure.
- Exact fingerprints prevent literal duplicate tool calls, not semantically
  equivalent side effects. Arbitrary shell, MCP, filesystem, and network tools
  have no general exactly-once transaction boundary.

## Tests and validation

Every implementation module has focused adjacent tests, including registry and
detect status, routes and overlays, bindings, event ordering, process/env,
attachments, permissions/questions, command and agent translation, import and
replay, retry storage/policy/runtime, and recovery transcript safety.

Run all harness tests:

```bash
bun test packages/web/server/lib/harness
```

Shared UI contracts also require the focused tests under
`packages/ui/src/lib/harness`, route-message and session-action harness tests,
plus package-scoped type-check/lint for executable changes. A real logged-in
Claude CLI host smoke test is required before claiming runtime behavior from
static checks alone.

Keep entrypoints thin, domain behavior in this directory's focused modules,
permission and recovery failures fail-closed, and this document current when a
route, persistence format, ownership boundary, invariant, or limitation changes.
