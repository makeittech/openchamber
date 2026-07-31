# Claude Session-Limit Auto-Resume Design

Date: 2026-07-31
Status: Implemented with validated limitations (Tasks 1–11 complete; documentation updated in Task 12)

## Goal

When Claude rejects a harness turn because a session limit has been reached, OpenChamber must preserve the interrupted work, expose an authoritative retry countdown, and safely continue after the reset time. The wait must survive web-server and Desktop restarts, remain cancellable, and continue accepting follow-up messages into the existing per-client durable queue.

## Existing Gap

Claude Agent SDK emits structured `rate_limit_event` messages containing `status`, `resetsAt`, `rateLimitType`, and overage information. The current Claude event mapper ignores those messages, projects the assistant's `rate_limit` error, and then emits `idle` and `session.error`. The structured reset timestamp is lost, polling can overwrite transient retry state, and queued messages can dispatch before recovery is established.

## Chosen Approach

Add a harness-owned durable retry journal and recovery runtime. A confirmed terminal rate limit ends the current Claude process, but keeps the OpenCode session in canonical `retry` status. At the due time, the runtime validates the raw Claude transcript, resumes the complete foreign Claude session, and sends a strictly marked synthetic continuation message that is hidden from the projected OpenCode transcript.

The original prompt and attachments are never replayed. This avoids duplicate visible user messages and reduces the chance of repeating work already completed before the limit.

Rejected alternatives:

1. Keeping one SDK query alive cannot survive process restart, retains resources for potentially long waits, and requires a broad query-lifecycle rewrite.
2. Replaying the original request or rewinding with `resumeSessionAt` can repeat filesystem, shell, MCP, network, or other side effects and would require persisting sensitive prompt and attachment data.

## Durable Ownership

The web harness owns a dedicated versioned journal under `OPENCHAMBER_DATA_DIR`. It follows existing private-data persistence conventions:

- atomic temporary-file write and rename;
- directory mode `0700` and file mode `0600`;
- synchronous writes for state transitions that create or remove recovery obligations;
- bounded and allowlisted records;
- malformed, unsupported, or oversized data fails closed instead of appearing as an empty journal.

A record contains only recovery metadata:

- OpenCode session ID and directory;
- foreign Claude session ID;
- sanitized execution target, agent selection, and permission configuration needed to resume;
- state (`observed`, `waiting`, `launching`, or `blocked`), generation, and attempt;
- rate-limit type and normalized reset/deadline timestamps;
- expected transcript tail and recovery launch UUIDs;
- creation and update timestamps.

It must not contain prompt text, attachments, tool output, OAuth material, bearer tokens, queued follow-up bodies, or other user content already owned elsewhere.

The existing client message queue remains the owner of follow-up messages. It persists for the same browser/Desktop profile but is intentionally not a cross-device server queue.

## State Machine and Ordering

The durable retry state machine is:

```text
none
  -> observed
  -> waiting
  -> launching
       -> success: remove record, then idle
       -> another rate limit: waiting with attempt + 1
       -> terminal non-rate error: remove record, then normal error/idle
       -> ambiguous safety or crash state: blocked
```

Required visible status sequences are:

```text
busy -> retry -> busy -> idle
busy -> retry -> busy -> retry
```

There is no intermediate `idle` while a durable retry exists. The record is persisted before `retry` is emitted and removed before terminal `idle` is emitted. Duplicate SDK events are idempotent by assistant identity and record generation.

The harness status snapshot and `/api/session/status` overlay treat both `busy` and `retry` as authoritative working states. Retry fields (`attempt`, `message`, and `next`) survive polling and bootstrap. Session-goal logic must not interpret a pending retry as a completed or failed goal turn.

## Rate-Limit Detection

English assistant text is never authoritative. Scheduling requires correlation between the parent assistant's `error === "rate_limit"` and structured rate-limit metadata. Informational warnings, nested/subagent failures, and overage-eligible states must not incorrectly schedule a hard wait.

`system/api_retry` is separate: it reports a transient retry already owned by the SDK. OpenChamber may project its countdown but must not start a competing request or durable long-wait timer.

## Deadline Handling

Reset values are normalized to absolute epoch milliseconds and accept the SDK's epoch seconds as well as milliseconds. Non-finite, non-positive, and implausibly distant values are rejected.

- Valid future reset: schedule reset plus a small grace and stable persisted jitter.
- Past reset: use a short minimum delay to avoid a zero-delay loop.
- Missing or invalid reset: use bounded exponential fallback delays.
- Repeated unknown resets: cap the delay and eventually enter `blocked` after a bounded stale age.
- Long deadlines: chunk timers to the platform maximum timeout.
- Timer callback: re-read the clock to handle sleep and wall-clock changes.
- Startup-overdue records: launch after a small startup grace once dependencies are ready, never during module evaluation.

If multiple rejected quota windows apply, recovery uses the latest valid reset.

## Safe Continuation

Recovery uses full `resume: foreignSessionId`; it does not use `resumeSessionAt` and does not invoke the ordinary visible `prompt()` path. The internal SDK user message has a stable launch UUID, `isSynthetic: true`, immediate priority, and a versioned OpenChamber continuation marker. Transcript projection hides only messages satisfying both the synthetic flag and the strict marker, while subsequent assistant output remains grouped with the interrupted real user turn.

Before launching, the runtime inspects raw Claude JSONL from the last real user turn:

1. Every `tool_use` must have a matching `tool_result`.
2. Any unmatched or otherwise ambiguous invocation moves recovery to `blocked`.
3. Settled tool calls are canonically fingerprinted from tool name and recursively sorted input.
4. A recovery-only `PreToolUse` hook denies exact repeats, including calls that previously returned errors because they may have partially applied effects.

The guard is applied at `PreToolUse`, not only `canUseTool`, so it also covers edit-permission and MCP-wildcard paths that can bypass the latter.

This design prevents literal replay of the request and exact duplicate tool calls. It cannot guarantee semantic exactly-once behavior when Claude produces a differently expressed command with equivalent external effects; such a guarantee would require transactional or idempotent tool APIs. Ambiguous transcript/process state therefore fails closed.

## Follow-Up Queue

While status is `retry`, ChatInput continues accepting messages into the existing persisted per-client queue. Users may reorder or delete them. Logical execution order is:

1. synthetic continuation of the interrupted Claude turn;
2. the first queued follow-up in current user order;
3. remaining queued follow-ups, one per completed idle transition.

Queue auto-send must not infer `idle` before the directory's authoritative session-status bootstrap has succeeded. `retry -> busy` never dispatches a queued item; only the final `busy -> idle` does. A direct prompt while retry is pending returns `TURN_IN_PROGRESS`, allowing existing UI fallback to queue it.

Queue limits must reject a new item visibly instead of silently discarding a previously accepted item. Cancellation leaves follow-up queue entries intact so the user can edit, delete, or send them intentionally afterward.

## Cancellation, Deletion, and Shutdown

Stop/abort is valid even when no Claude child process is currently active:

1. synchronously invalidate and remove the journal generation;
2. clear its timer;
3. interrupt and close a launching/running recovery query;
4. reject pending permission and question callbacks;
5. emit one abort marker and `idle`.

Session deletion removes retry state, timers, binding, snapshots, capabilities, and callbacks without emitting new events into the deleted session. A definitive session-not-found response removes an orphan startup record; a transient fetch failure leaves it pending.

Graceful shutdown clears timers without deleting waiting obligations, durably settles active recovery state, prevents stale finalizers from reinstalling canceled records, and interrupts child processes only after restart-safe state is written. The web shutdown path awaits harness shutdown before OpenCode and HTTP teardown. Electron awaits the in-process server's `stop()` before exiting.

On startup, waiting records immediately seed retry snapshots before status can be reported. An overdue waiting record is scheduled after startup grace. A cleanly interrupted launch becomes recoverable. An unclean `launching` record with no provable terminal transcript state becomes `blocked` rather than risking duplicate execution.

## User-Visible Failure Behavior

- Waiting shows the reset/countdown and keeps Stop available.
- Missing reset uses a bounded fallback rather than silently idling.
- Unsafe or ambiguous recovery shows a localized blocked-wait state and remains cancellable; queued messages do not bypass it.
- A genuine non-rate terminal error exits durable retry and follows normal error handling.
- Persistence failure prevents claiming that automatic recovery is scheduled.

## Implementation Status and Validated Limitations

The structured correlation, private journal, status overlay, hidden synthetic
continuation, exact-call `PreToolUse` guard, same-client queue gating, lifecycle
wiring, and awaited Desktop shutdown are implemented and covered by focused
tests. The implementation preserves the intended `busy -> retry -> busy -> idle`
ordering for confirmed hard-quota recovery and keeps SDK `system/api_retry`
transient and SDK-owned.

The following design claims are not yet fully implemented and must not be read
as current guarantees:

1. The policy can return `blocked` after seven days of an unknown reset, but the
   integrated runtime does not persist/pass a first-unknown timestamp, so this
   age-based block is currently unreachable. Missing resets continue with the
   capped fallback; transcript-unsafety blocking is implemented.
2. On startup, an ambiguous persisted `launching` record is currently converted
   to `waiting` (or removed when inspection reports a safe present tail), rather
   than always becoming `blocked` as designed.
3. `retry-runtime.stop()` rewrites launching records before aborting controllers,
   but it is synchronous and swallows rewrite failures. The outer shutdown
   sequence awaits the harness call, but cannot prove restart-safe persistence
   if that critical write fails.
4. Exact canonical tool fingerprints prevent literal duplicate calls only.
   Semantically equivalent commands can still repeat external effects; arbitrary
   tools do not provide a general exactly-once transaction boundary.

## Validation

Tests must cover:

- journal round-trip, permissions, sanitization, corruption, size bounds, and restart reconstruction;
- seconds/milliseconds normalization, past and invalid times, fallback backoff, timer chunking, clock changes, and startup grace;
- confirmed versus informational/nested/overage rate-limit events and SDK-owned transient retries;
- exact status ordering, duplicate event idempotency, polling overlays, and session-goal suppression;
- hidden synthetic continuation, full-session resume, stable IDs, and no visible duplicate user event;
- transcript ambiguity, exact duplicate tool denial, and novel tool allowance;
- queue hydration, ordering, reorder/delete, capacity rejection, cancellation, and same-client persistence;
- abort during waiting/launching, session deletion, stale callbacks, and clean/unclean shutdown recovery;
- web graceful shutdown and Electron's awaited in-process server stop;
- a focused SDK integration check that the installed Claude version persists supplied UUID and `isSynthetic` fields as its types promise.

Executable server and UI changes require focused tests plus package-scoped type-check and lint. Cross-workspace runtime/status contract changes require the affected workspace checks and builds. Added source files or exports also require `bun run dead-code` with report inspection.
