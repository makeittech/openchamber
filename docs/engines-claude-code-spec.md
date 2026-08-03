# Claude Code Harness Product and Architecture Specification

Status: **implemented**  
Primary non-OpenCode harness: `claude-code`  
Implementation details and current limitations:
[`packages/web/server/lib/harness/DOCUMENTATION.md`](../packages/web/server/lib/harness/DOCUMENTATION.md)

## Product decisions

| Decision | Contract |
| --- | --- |
| Product model | Harness is a top-level execution backend, not an OpenCode provider. OpenCode remains the default harness. |
| First alternate harness | Claude Code, using the official Agent SDK and native `claude` CLI. |
| Authentication and billing | Claude harness execution is subscription-only. Anthropic API keys remain on OpenCode's Providers path. |
| Session identity | OpenCode session IDs remain the UI/list shell; Claude's native session ID is private resume state. |
| Switching | A used session never changes harness in place. Switching creates a new session and transfers duplicate or summarized context; the source remains unchanged. Confirmation is enabled by default and can be disabled/re-enabled in Harness settings. |
| Transcript UX | Native output is translated to OpenCode-shaped messages, parts, status, permissions, questions, and child sessions. |
| Input | Images, common text, PDF, and sandboxed project-file references are supported; unsupported binary data fails visibly. |
| Agents | OpenCode mode inherits the selected OpenCode agent's prompt and permission policy; Claude mode uses native Claude agents and permissions. |
| Capabilities | Claude supports prompt, abort, resume, streaming text/tools, permissions, images/files, shell, slash commands, MCP, subagents, MultiRun, Goal, and the gated OpenChamber tool. |

Codex and Gemini CLI harnesses, full interactive TTY parity, editing Claude MCP
configuration in OpenChamber, and lossless OpenCode-to-Claude transcript cloning
are outside this contract.

## Architecture contract

```text
Shared UI
  |-- OpenCode target ----> @opencode-ai/sdk/v2
  `-- Claude target ------> authenticated /api/harness/*
                               |
                         harness router
                               |
                   Claude Agent SDK -> claude CLI
                               |
                   OpenCode-shaped global events
                               |
                        existing WS/SSE sync
```

1. The UI never invokes Claude or Anthropic directly. Claude work executes on
   the connected web/Desktop/backend host, not on a UI-only device.
2. The first Claude turn creates a durable, sticky session binding. All later
   turns resume the same foreign session until the user hands off to a new one.
3. A turn reaches exactly one harness. Claude prompt, abort, permission, and
   question traffic uses authenticated OpenChamber routes through `runtimeFetch`;
   OpenCode continues using its SDK path.
4. Claude output enters the existing global event stream with directory scope.
   Live harness state and transcript overlays prevent OpenCode polling or empty
   message reads from erasing Claude activity/history.
5. OpenCode-compatible ascending IDs and explicit segment boundaries preserve
   chronological text, reasoning, tool, and subagent presentation.
6. The server is the authority for command templates, agent policies, native
   agent validity, attachment sandboxing, process ownership, and recovery.
   Client-supplied authority or bypass modes are rejected.
7. Import creates an OpenCode shell bound to an existing Claude transcript.
   Claude JSONL remains read-only and is projected at message-read time rather
   than copied into OpenCode storage.

The owning runtime document defines route payloads, module ownership, event
mapping, persistence formats, import/replay behavior, and recovery mechanics.

## Runtime behavior

### Detection and execution hosts

The catalog exposes `ready`, `needs-login`, `missing-cli`, `error`, and reserved
`unsupported-host`. `ready` requires the CLI, SDK, and subscription auth on the
execution host. Local web and Desktop are supported when that host is prepared;
VS Code, SSH, tunnel, and mobile clients depend on their connected backend host.
Host status must never imply that a UI-only mobile device owns a local CLI.

Detect/upstream failure cannot appear as ready with an empty catalog. One Claude
failure cannot clear or block unrelated Claude or OpenCode sessions.

### Turn lifecycle

- One active Claude turn or durable recovery is allowed per session.
- Prompt acceptance returns asynchronously while canonical events stream.
- Abort interrupts and tree-kills the owned process, closes pending UI/tool
  state, fails permissions/questions closed, and ends idle.
- Working directory must exist. File paths resolve beneath it, including after
  symlink resolution.
- Unsupported attachments and command lookup failures happen before an
  optimistic turn is accepted.
- Follow-ups while busy/retrying use the existing same-profile client queue;
  that queue is not synchronized across clients or devices.

### Session-limit recovery

A durable wait is created only by correlation of a parent assistant
`rate_limit` error with structured rejected quota metadata. SDK-owned short
`system/api_retry` events do not create a competing OpenChamber request.

Confirmed hard-limit recovery preserves `busy -> retry -> busy -> idle`, stores
only bounded recovery metadata, survives restart, remains stoppable, and resumes
the full foreign Claude session with a hidden synthetic continuation. It never
persists or replays the original prompt or attachments. Recovery validates that
current-turn tools settled and denies exact repeated calls; ambiguous transcript
state blocks. This reduces duplicate effects but does not provide semantic
exactly-once execution. Detailed guarantees and validated limitations are in the
owning runtime document.

## Security and privacy requirements

1. Never send extracted subscription credentials to Anthropic HTTP or expose
   them through the UI, runtime APIs, settings, responses, or logs.
2. Remove API-priority Anthropic keys from Claude child environments while
   preserving the remaining environment needed by the CLI and tools.
3. Never log credential material, attachment bytes, prompts/tool output from
   recovery, or queue content.
4. Resolve permission, command, agent, and MCP authority server-side. Permission
   timeout, abort, lookup failure, and invalid bypass requests fail closed.
5. Sandbox project-file attachments by real path and reject escapes or opaque
   unsupported binaries rather than silently reading/dropping them.
6. Keep session bindings and retry metadata private, allowlisted, versioned,
   bounded, and free of credentials. Recovery persistence failure must not be
   presented as a scheduled retry.
7. Tree-kill owned Claude/MCP processes and cancel long-running OpenChamber tool
   waits when their turn ends.

## Acceptance criteria

- Users can select Claude Code as a top-level harness and see host-scoped status
  and a static Claude model catalog.
- A host with the CLI and subscription login streams text, reasoning, tools,
  permissions, questions, subagents, and terminal status in the normal session
  transcript; OpenCode Provider/API-key behavior remains unchanged.
- Resume uses the stored Claude session ID. A used-session harness switch creates
  a new destination with visible duplicate/summary context when confirmed and
  never mutates the source.
- Images, text-like files, PDF, and sandboxed project files work; unsupported,
  oversized, or outside-project input fails clearly without a phantom turn.
- Native Claude and translated OpenCode commands, MCP, agent modes, MultiRun,
  Goal accounting, and the gated OpenChamber tool follow advertised capability
  and permission contracts.
- Local Claude chats can be imported independently and replayed without copying
  or mutating Claude JSONL; malformed/missing replay data does not fail unrelated
  message reads.
- Missing CLI/login, SDK/process failure, abort, permission timeout, and one-row
  import failure remain isolated and recoverable without corrupting other
  sessions.
- Confirmed subscription hard limits expose authoritative retry state across
  polling/restart, remain cancellable, and never persist prompt or credential
  content. Unsafe continuation blocks rather than guessing.
- Focused harness and shared-UI contract tests pass. Production claims also
  require a smoke test on a real execution host with a logged-in Claude CLI;
  static checks alone are insufficient.
