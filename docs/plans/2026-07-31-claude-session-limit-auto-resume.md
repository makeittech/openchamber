# Claude Session-Limit Auto-Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist confirmed Claude subscription-limit waits, safely resume the interrupted turn after reset (including after server/Desktop restart), keep Stop functional, and preserve queued follow-ups until recovery completes.

**Architecture:** The web harness owns a versioned private retry journal plus a condition-based scheduler. The Claude translator correlates structured SDK quota events with the parent `rate_limit` error, suppresses the premature idle/error edge, and delegates a synthetic full-session continuation to the scheduler. Raw transcript validation and a recovery-only `PreToolUse` guard fail closed around ambiguous or duplicate tool effects; existing UI queue persistence remains the owner of follow-ups.

**Tech Stack:** Bun tests, Node.js ESM, Express, `@anthropic-ai/claude-agent-sdk`, React 19, Zustand, Electron.

**Repository policy:** Do not run git commands. This repository forbids them unless the user explicitly requests them, so the usual per-task commit steps are intentionally omitted.

**Required skills before source edits:** `openchamber-change-discipline`, `sync-state-invariants`, `ui-api-decoupling`, `performance-engineering`, `desktop-shell`, `theme-system`, and `locale-ui-patterns`. Use `test-driven-development` for every behavior below and `verification-before-completion` before the final report.

---

### Task 1: Add the durable pending-retry journal

**Files:**
- Create: `packages/web/server/lib/harness/pending-retry-store.js`
- Create: `packages/web/server/lib/harness/pending-retry-store.test.js`
- Modify: `packages/web/server/lib/harness/index.js`

**Step 1: Write failing store tests**

Cover these observable contracts with a temporary directory:

```js
it('round-trips only allowlisted recovery metadata with mode 0600', () => {
  const store = createPendingRetryStore({ filePath });
  store.init();
  store.put({
    sessionId: 'ses_1',
    directory: '/repo',
    foreignSessionId: 'claude-1',
    state: 'waiting',
    generation: 1,
    attempt: 1,
    nextAttemptAt: 1234,
    target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    prompt: 'must not persist',
    files: [{ url: 'secret' }],
  });

  expect(createPendingRetryStore({ filePath }).init().records).toEqual([
    expect.objectContaining({ sessionId: 'ses_1', state: 'waiting' }),
  ]);
  expect(readFileSync(filePath, 'utf8')).not.toContain('must not persist');
  expect(statSync(filePath).mode & 0o777).toBe(0o600);
});
```

Also test:

- versioned `{ version: 1, retries: [...] }` format;
- `observed | waiting | launching | blocked` state validation;
- target/agent fields are clamped and unknown fields are removed;
- duplicate session IDs collapse to the newest generation;
- `put`, `delete`, and `replace` are synchronous and atomic;
- temporary files are cleaned after write failure;
- malformed, unsupported-version, and oversized files return/throw `RETRY_STORE_UNAVAILABLE`, not an authoritative empty list;
- a failed critical write leaves the prior in-memory and disk record intact;
- no prompt, attachment, tool output, token, or environment field reaches disk.

**Step 2: Run the test and verify RED**

Run:

```bash
bun test packages/web/server/lib/harness/pending-retry-store.test.js
```

Expected: FAIL because `pending-retry-store.js` does not exist.

**Step 3: Implement the minimal store**

Use a factory plus a production singleton:

```js
export function resolvePendingRetryStorePath() {
  const root = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(root, 'harness-pending-retries.json');
}

export function createPendingRetryStore(options = {}) {
  // init(), get(sessionId), list(), put(record), delete(sessionId), replace(records)
  // Critical mutations sanitize first, write a complete next Map atomically,
  // then publish that Map in memory only after rename succeeds.
}
```

Keep `MAX_STORE_BYTES`, record count, string lengths, numeric ranges, and target fields explicit. Create directories with `0700`, files with `0600`, and use temp-write + rename. Do not reuse debounced `session-bindings.js`; pending recovery is a critical obligation and cannot be pruned by its 200-binding retention.

Export only APIs consumed by the retry runtime through `harness/index.js`.

**Step 4: Run the test and verify GREEN**

Run the focused test again. Expected: PASS with no warnings.

---

### Task 2: Define quota interpretation and condition-based deadlines

**Files:**
- Create: `packages/web/server/lib/harness/retry-policy.js`
- Create: `packages/web/server/lib/harness/retry-policy.test.js`

**Step 1: Write failing pure-policy tests**

Define the wished-for API:

```js
expect(normalizeResetTimestamp(1_800_000_000, now)).toBe(1_800_000_000_000);
expect(normalizeResetTimestamp(1_800_000_000_000, now)).toBe(1_800_000_000_000);

expect(selectRejectedRateLimit({
  status: 'rejected',
  resetsAt: 1_800_000_000,
  rateLimitType: 'five_hour',
})).toEqual({ rateLimitType: 'five_hour', resetAt: 1_800_000_000_000 });

expect(selectRejectedRateLimit({ status: 'allowed_warning' })).toBeNull();
```

Test all policy boundaries:

- epoch seconds and milliseconds;
- non-finite, non-positive, and more-than-eight-days-away resets rejected;
- primary and rejected overage windows choose the latest valid deadline;
- allowed/warning-only metadata never becomes a hard wait;
- an in-use allowed overage window is not mistaken for a primary hard stop;
- future reset adds fixed grace plus stable per-record jitter;
- past reset uses a minimum delay and never loops at zero;
- missing reset uses 5-minute exponential fallback capped at one hour;
- stale unknown-reset records become `blocked` after the configured maximum age;
- timeout chunks never exceed `2_147_483_647` ms;
- waking after sleep re-evaluates `Date.now()` instead of trusting elapsed timer duration.

**Step 2: Verify RED**

Run `bun test packages/web/server/lib/harness/retry-policy.test.js`.

**Step 3: Implement pure helpers**

Keep policy deterministic and injectable:

```js
export function normalizeResetTimestamp(value, now = Date.now()) { /* seconds/ms */ }
export function selectRejectedRateLimit(info, now = Date.now()) { /* latest hard window */ }
export function computeNextAttempt(record, { now = Date.now() } = {}) { /* reset/fallback */ }
export function nextTimerChunk(deadline, now = Date.now()) { /* max timeout */ }
```

Do not parse Claude's English error sentence. Do not schedule `allowed_warning`. Preserve an explicit reason when no reset exists so the runtime can show an honest fallback rather than inventing a precise reset time.

**Step 4: Verify GREEN**

Run the focused policy test. Expected: PASS.

---

### Task 3: Map structured Claude rate-limit and SDK-owned retry events

**Files:**
- Modify: `packages/web/server/lib/harness/events/from-claude.js`
- Modify: `packages/web/server/lib/harness/events/from-claude.test.js`

**Step 1: Add failing mapper tests**

Add separate tests for:

1. `rate_limit_event` stores/returns sanitized structured metadata and emits no visible event by itself.
2. `system/api_retry` emits canonical retry with absolute `next` and the SDK attempt, but does not request a second operation.
3. The first later SDK activity emits `busy` before content; successful result yields `retry -> busy -> idle`.
4. Parent `assistant.error === 'rate_limit'` is recorded without immediate `idle`.
5. Parent rate-limit error plus rejected metadata makes terminal `result` return `terminal: { type: 'rate-limit', ... }` and emits neither `idle` nor `session.error`.
6. A nested/subagent rate-limit error never schedules the parent.
7. A rate-limit error without correlated structured metadata follows normal hard-error settlement.
8. `overloaded` and ordinary errors retain existing retryable/error behavior without premature queue-dispatch edges.

Example assertion:

```js
const terminal = mapClaudeMessageToEvents(ctx, {
  type: 'result', subtype: 'error_during_execution', is_error: true,
});
expect(terminal.terminal).toMatchObject({
  type: 'rate-limit',
  rateLimitType: 'five_hour',
});
expect(terminal.events.some((event) => event.type === 'session.status')).toBe(false);
expect(terminal.events.some((event) => event.type === 'session.error')).toBe(false);
```

**Step 2: Verify RED**

Run `bun test packages/web/server/lib/harness/events/from-claude.test.js` and confirm failures are specifically the missing structured behavior.

**Step 3: Implement minimal context and return metadata**

Extend `ClaudeMapperContext` with bounded fields such as:

```js
latestRateLimitInfo: null,
parentRateLimitError: null,
sdkRetryActive: false,
```

Extend the mapper result shape to include optional `rateLimitInfo` and `terminal`. Correlate by the parent turn and SDK message identities; never scan assistant text. Keep terminal status ownership in the translator/runtime so durable persistence can happen before a visible retry event.

**Step 4: Verify GREEN**

Run the focused mapper suite. Expected: PASS, including all pre-existing mapper tests.

---

### Task 4: Add transcript safety analysis and hidden continuation projection

**Files:**
- Create: `packages/web/server/lib/harness/translators/claude-code/recovery-transcript.js`
- Create: `packages/web/server/lib/harness/translators/claude-code/recovery-transcript.test.js`
- Modify: `packages/web/server/lib/harness/translators/claude-code/transcript-messages.js`
- Modify: `packages/web/server/lib/harness/translators/claude-code/transcript-messages.test.js`
- Modify: `packages/web/server/lib/harness/session-messages.test.js`

**Step 1: Write failing raw-transcript safety tests**

Use JSONL fixtures to prove:

- analysis starts at the last real non-meta/non-sidechain/non-internal user turn;
- every `tool_use` must have a matching `tool_result`;
- both successful and error results count as settled but remain guarded;
- unmatched tools return `{ safe: false, reason: 'unsettled-tool' }`;
- expected rate-limit assistant UUID/tail must be present;
- canonical fingerprints are stable across object-key order but preserve array order, value types, tool name, and nested inputs;
- malformed/oversized transcript fails closed;
- a launch UUID can be classified as absent, terminal success, terminal rate-limit, or ambiguous after crash.

Define a strict internal marker and synthetic message builder:

```js
export const RECOVERY_MARKER = '<openchamber-continuation version="1" reason="claude-session-limit">';

export function buildRecoveryUserMessage(launchUuid) {
  return {
    type: 'user',
    uuid: launchUuid,
    parent_tool_use_id: null,
    isSynthetic: true,
    priority: 'now',
    message: {
      role: 'user',
      content: [{ type: 'text', text: `${RECOVERY_MARKER}\nContinue ...` }],
    },
  };
}
```

**Step 2: Write failing replay/merge tests**

Prove that:

- only `record.isSynthetic === true` plus the exact versioned marker is hidden;
- an ordinary user message containing similar text remains visible;
- hiding the continuation does not call `closeTurn()`;
- later assistant text and settled tools stay grouped under the original real user turn;
- hydrated deterministic message IDs let transcript/live merge replace rather than duplicate the recovery tail.

**Step 3: Verify RED**

Run:

```bash
bun test packages/web/server/lib/harness/translators/claude-code/recovery-transcript.test.js
bun test packages/web/server/lib/harness/translators/claude-code/transcript-messages.test.js
bun test packages/web/server/lib/harness/session-messages.test.js
```

**Step 4: Implement bounded raw analysis and projection rules**

Read the same bounded transcript path authority used by replay. Export only focused operations:

```js
inspectRecoveryTranscript({ foreignSessionId, expectedTailUuid, launchUuid? })
fingerprintToolCall(toolName, input)
buildRecoveryUserMessage(launchUuid)
createRecoveryToolGuard(fingerprints)
```

The `PreToolUse` callback denies an exact fingerprint using:

```js
return {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'OpenChamber blocked an exact pre-limit tool replay.',
  },
};
```

Do not treat the replay parser's converted `error` tool state as safety evidence; raw `tool_result` records are authoritative.

**Step 5: Verify GREEN**

Run all three focused suites. Expected: PASS.

---

### Task 5: Forward recovery hooks and synthetic SDK messages

**Files:**
- Modify: `packages/web/server/lib/harness/translators/claude-code/query.js`
- Modify: `packages/web/server/lib/harness/translators/claude-code/query.test.js`

**Step 1: Add failing query-wrapper tests**

Assert that:

- internal `hooks.PreToolUse` reaches SDK `options.hooks` unchanged;
- no client body can inject hooks through the public prompt route;
- synthetic `AsyncIterable<SDKUserMessage>` retains `uuid`, `isSynthetic`, `priority`, and marker content;
- existing permission-mode allowlisting and MCP/agent options remain unchanged.

**Step 2: Verify RED**

Run `bun test packages/web/server/lib/harness/translators/claude-code/query.test.js`.

**Step 3: Implement the narrow option pass-through**

Add only the internal `hooks` parameter to `startClaudeQuery` JSDoc/options. Do not expose it in `routes.js` or accept arbitrary hook configuration from the client.

**Step 4: Verify GREEN**

Run the focused query tests. Expected: PASS.

---

### Task 6: Implement the durable retry scheduler/runtime

**Files:**
- Create: `packages/web/server/lib/harness/retry-runtime.js`
- Create: `packages/web/server/lib/harness/retry-runtime.test.js`

**Step 1: Write failing state-machine tests with fake clock/timers**

Create the runtime with injected store, clock, timer functions, launch callback, status emitter, and session existence check. Test:

- `schedule()` writes `waiting` before emitting retry;
- duplicate rate-limit UUID/generation produces one record and one launch;
- only one obligation exists per OpenCode session;
- one earliest-deadline wake timer is used and long waits are chunked;
- wake after clock jump launches overdue work after startup grace;
- launch concurrency is bounded (two), and other due sessions remain independent;
- transition to `launching` is persisted before invoking Claude;
- success deletes durable state before idle;
- a second rate limit increments attempt and returns directly to waiting/retry;
- hard error deletes state then emits normal error/idle;
- safety ambiguity persists `blocked`, emits retry with a stable blocked reason and no `next`, and never launches;
- cancel invalidates generation, clears scheduling, interrupts an active recovery once, deletes record, then emits idle;
- stale callbacks/finalizers cannot reinstall a canceled record;
- `stop()` preserves waiting records, converts cleanly interrupted `launching` work back to waiting, and clears timers;
- startup reconstructs waiting/retry status, handles overdue records, and classifies persisted `launching` records through transcript evidence;
- definitive 404 removes an orphan; transient fetch failure preserves it.

Key API:

```js
const runtime = createHarnessRetryRuntime({
  store,
  now,
  setTimer,
  clearTimer,
  inspectTranscript,
  launchRecovery,
  emitStatus,
  sessionExists,
});

await runtime.start();
runtime.schedule(observation);
await runtime.cancel(sessionId);
await runtime.deleteSession(sessionId);
await runtime.stop();
runtime.hasPending(sessionId);
```

**Step 2: Verify RED**

Run `bun test packages/web/server/lib/harness/retry-runtime.test.js`.

**Step 3: Implement the minimal runtime**

Use record generations as compare-and-swap ownership around every async boundary. Keep one scheduler wake timer instead of one long timer per record; sort due records only when the journal changes/wakes. A persistence error must reject `schedule()` so the translator cannot claim automatic recovery exists.

Represent user-visible status with the existing OpenCode contract:

```js
{ type: 'retry', attempt, message: 'claude-session-limit', next: nextAttemptAt }
{ type: 'retry', attempt, message: 'claude-recovery-blocked' }
```

The strings are stable reason codes; UI localization owns user-facing copy.

**Step 4: Verify GREEN**

Run the runtime suite. Expected: PASS with fake timers fully drained and no leaked handles.

---

### Task 7: Integrate retry/recovery into Claude turn orchestration

**Files:**
- Modify: `packages/web/server/lib/harness/translators/claude-code/index.js`
- Modify: `packages/web/server/lib/harness/translators/claude-code/index.test.js`
- Modify: `packages/web/server/lib/harness/router.js`
- Modify: `packages/web/server/lib/harness/index.js`

**Step 1: Add failing translator tests**

Add controlled-stream tests for:

- confirmed rate-limit terminal persists waiting and emits exactly `busy -> retry`, never idle/error;
- retry persistence failure falls back to explicit hard error/idle and records binding error;
- pending durable retry makes public `prompt()` reject `TURN_IN_PROGRESS` even with no active process;
- due recovery uses `resume: foreignSessionId`, a synthetic message, no `buildUserMessageEvents`, and no repeated attachments/prompt text;
- same-process recovery reuses mapper context; restart recovery hydrates the last real user/assistant IDs from transcript replay;
- recovery receives the exact-call `PreToolUse` hook plus normal MCP/permission/agent configuration;
- successful recovery removes pending state before idle;
- another limit returns to retry without an idle edge;
- unsafe transcript never calls `startQuery` and remains stoppable;
- Stop while waiting returns `{ aborted: true }`, deletes the retry, emits one abort marker and one idle, and does not clear UI queue data;
- Stop while launching interrupts/closes once and stale stream cleanup is inert;
- both `rejectPendingPermissions` and `rejectPendingQuestions` are invoked (regression for the current undefined `rejectPendingForSession` call);
- translator `stop()` closes every active ordinary/recovery handle and preserves durable waiting obligations.

**Step 2: Verify RED**

Run `bun test packages/web/server/lib/harness/translators/claude-code/index.test.js`.

**Step 3: Extract a shared internal turn launcher**

Keep `prompt(body)` as the public validation/visible-user path, but move common server-resolved execution setup into a private function used by both normal and recovery turns. Recovery must not recursively call `prompt()`.

The internal recovery path must:

```js
await startPreparedTurn({
  sessionId,
  directory,
  bindingOrRetrySnapshot,
  ctx,
  promptInput: singleMessageAsyncIterable(buildRecoveryUserMessage(launchUuid)),
  emitUserMessage: false,
  recoveryToolFingerprints,
});
```

Do not persist or reconstruct the original user prompt. Revalidate detection, cwd, selected native agent, OpenCode agent inheritance, permissions, MCP, and setting sources at launch time. A no-longer-ready CLI/login state becomes blocked/action-required rather than silently idle.

Have the router expose `start()`, `stop()`, `hasPendingRetry(sessionId)`, and `deleteSession(sessionId)` by delegation to Claude ownership.

**Step 4: Verify GREEN**

Run translator, mapper, query, transcript, and retry-runtime tests together.

---

### Task 8: Make retry authoritative in snapshots, routes, goals, startup, and deletion

**Files:**
- Modify: `packages/web/server/lib/harness/turn-snapshot.js`
- Modify: `packages/web/server/lib/harness/turn-snapshot.test.js`
- Modify: `packages/web/server/lib/harness/session-status.js`
- Modify: `packages/web/server/lib/harness/session-status.test.js`
- Modify: `packages/web/server/lib/harness/routes.js`
- Modify: `packages/web/server/lib/harness/routes.test.js`
- Modify: `packages/web/server/lib/harness/session-capabilities.js`
- Modify: `packages/web/server/lib/harness/index.js`
- Modify: `packages/web/server/lib/session-goal/harness-continuation.test.js`
- Modify: `packages/web/server/index.js`
- Modify: `packages/web/server/lib/opencode/shutdown-runtime.js`
- Modify: `packages/web/server/lib/opencode/shutdown-runtime.test.js`

**Step 1: Add failing authoritative-status tests**

Prove:

- snapshot stores the full retry payload (`attempt`, `message`, `next`);
- `isHarnessSessionWorking()` is true for busy and retry;
- active eviction never removes busy or retry records;
- status merge overlays retry over OpenCode idle/absence and preserves all fields;
- route polling never clears retry;
- goal continuation/audit remains paused during retry and only resumes after final idle;
- direct prompt route returns 409 while a durable retry exists;
- session deletion clears retry, binding, turn snapshot, capabilities, permission/question callbacks, and active recovery without emitting into the deleted session;
- graceful shutdown awaits harness stop before OpenCode process/server teardown.

Prefer renaming misleading helpers to `listHarnessActiveStatuses` and `mergeHarnessActiveIntoSessionStatuses`; update all internal consumers/exports in the same task.

**Step 2: Verify RED**

Run:

```bash
bun test packages/web/server/lib/harness/turn-snapshot.test.js
bun test packages/web/server/lib/harness/session-status.test.js
bun test packages/web/server/lib/harness/routes.test.js
bun test packages/web/server/lib/session-goal/harness-continuation.test.js
bun test packages/web/server/lib/opencode/shutdown-runtime.test.js
```

**Step 3: Implement lifecycle wiring**

- Initialize/start retry recovery inside `main()` after dependencies exist but before the server can publish authoritative status responses.
- Subscribe the existing global event hub to `session.deleted` and delegate to `harnessRouter.deleteSession()`.
- Pass `harnessRuntime: harnessRouter` to `createGracefulShutdownRuntime` and `await harnessRuntime.stop()` before stopping OpenCode/message transport.
- Add focused `clearHarnessTurnSnapshot(sessionId)` and use existing/new `clearSessionCapabilities(sessionId)`; do not reset unrelated sessions.
- Preserve transient upstream/session-fetch failures as unknown.

**Step 4: Verify GREEN**

Run the five focused suites again, then `bun test packages/web/server/lib/harness`.

---

### Task 9: Gate queue auto-send on authoritative bootstrap and reject capacity overflow

**Files:**
- Modify: `packages/ui/src/hooks/useQueuedMessageAutoSend.ts`
- Modify: `packages/ui/src/hooks/useQueuedMessageAutoSend.test.ts`
- Modify: `packages/ui/src/stores/messageQueueStore.ts`
- Modify: `packages/ui/src/stores/messageQueueStore.test.ts`
- Modify: `packages/ui/src/components/chat/ChatInput.tsx`

**Step 1: Write failing queue tests**

Replace the old silent-truncation expectation with:

```ts
const result = useMessageQueueStore.getState().addToQueue(target, { content: 'overflow' });
expect(result).toEqual({ ok: false, reason: 'queue-full' });
expect(useMessageQueueStore.getState().getQueueForTarget(target)[0]?.content)
  .toBe('message-0');
```

Also test:

- adding a 51st target rejects the new item and preserves all existing targets;
- accepted enqueue returns `{ ok: true, id }`;
- queue reorder/delete and persisted migration remain unchanged;
- status resolver returns unknown before `sessionStatusLoaded === true` when neither live global busy/retry nor directory authority exists;
- a live global retry blocks dispatch even before directory bootstrap;
- `retry -> busy` does not dispatch;
- final `busy -> idle` sends exactly the first queue item;
- cold-start hydration does not auto-send until authoritative status load;
- cancellation's idle edge still honors the existing recent-abort guard.

**Step 2: Verify RED**

Run:

```bash
bun test packages/ui/src/stores/messageQueueStore.test.ts
bun test packages/ui/src/hooks/useQueuedMessageAutoSend.test.ts
```

**Step 3: Implement minimal queue contract**

Change `addToQueue` to return a discriminated result and never delete an already accepted message to admit another one. In `ChatInput`, clear composer text/attachments only on `{ ok: true }`; on failure, keep the draft intact and show the localized capacity toast added in Task 10.

Make `resolveQueuedSessionStatusType` return `undefined`/`unknown` until the target directory's status snapshot is authoritative. Subscribe to the current directory's `sessionStatusLoaded` field so bootstrap completion wakes the hook. Inactive, never-bootstrapped directory queues should remain safely parked rather than guessing idle.

**Step 4: Verify GREEN**

Run both focused suites. Expected: PASS.

---

### Task 10: Localize retry/blocked state and queue-capacity feedback

**Files:**
- Modify: `packages/ui/src/hooks/useAssistantStatus.ts`
- Modify: `packages/ui/src/components/chat/message/parts/WorkingPlaceholder.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/en.ts`
- Modify: `packages/ui/src/lib/i18n/messages/es.ts`
- Modify: `packages/ui/src/lib/i18n/messages/fr.ts`
- Modify: `packages/ui/src/lib/i18n/messages/ja.ts`
- Modify: `packages/ui/src/lib/i18n/messages/ko.ts`
- Modify: `packages/ui/src/lib/i18n/messages/pl.ts`
- Modify: `packages/ui/src/lib/i18n/messages/pt-BR.ts`
- Modify: `packages/ui/src/lib/i18n/messages/uk.ts`
- Modify: `packages/ui/src/lib/i18n/messages/zh-CN.ts`
- Modify: `packages/ui/src/lib/i18n/messages/zh-TW.ts`
- Modify: `packages/ui/src/lib/i18n/messages.test.ts`

**Step 1: Add failing logic/locale tests**

Extract/export pure retry-label helpers if needed so Bun can test without a DOM. Cover:

- countdown from absolute milliseconds;
- attempt suffix only after attempt 1;
- unknown deadline copy;
- stable reason `claude-recovery-blocked` maps to a clear cancellable blocked message;
- every locale contains the new keys and no UI string is hardcoded;
- queue-full and queue-target-limit feedback use locale keys.

Suggested keys:

```text
chat.statusRow.retrying
chat.statusRow.retryingIn
chat.statusRow.retryAttempt
chat.statusRow.recoveryBlocked
chat.chatInput.toast.queueFull
chat.chatInput.toast.queueTargetsFull
```

**Step 2: Verify RED**

Run `bun test packages/ui/src/lib/i18n/messages.test.ts` plus the focused helper test (place it next to `WorkingPlaceholder.tsx` if one is added).

**Step 3: Implement presentation**

Carry `currentSessionStatus.message` through `retryInfo`. Preserve the existing theme tokens, `role="status"`, `aria-live`, BusyDots, and countdown behavior. A blocked retry has no fake countdown, still counts as working, and leaves Stop available through `useSessionActivity`.

**Step 4: Verify GREEN**

Run locale and focused UI logic tests. Expected: PASS.

---

### Task 11: Await in-process web shutdown from Electron

**Files:**
- Create: `packages/electron/server-shutdown.mjs`
- Create: `packages/electron/server-shutdown.test.mjs`
- Modify: `packages/electron/main.mjs`
- Modify: `packages/electron/package.json`

**Step 1: Write failing sequencing tests**

Use `node:test` to assert:

```js
test('waits for web stop before exiting', async () => {
  const order = [];
  const stop = deferred();
  const quit = stopInProcessServer({
    handle: { stop: () => { order.push('stop-called'); return stop.promise; } },
    launchFallback: () => order.push('fallback'),
  });
  order.push('after-call');
  stop.resolve();
  await quit;
  order.push('exit');
  assert.deepEqual(order, ['stop-called', 'after-call', 'exit']);
});
```

Also cover:

- stop is idempotent across duplicate quit/signal paths;
- fallback killer is armed only for the managed OpenCode process and cannot target an external server;
- timeout/failure still permits exit after logging;
- ordinary confirmed quit and hard-signal shutdown both initiate `serverHandle.stop()`;
- updater-specific behavior remains intentional.

**Step 2: Verify RED**

Run:

```bash
node --test packages/electron/server-shutdown.test.mjs
```

**Step 3: Implement and wire the helper**

Make `killSidecar()` return/share a promise. Call `handle.stop({ exitProcess: false })` before clearing the final ownership reference; then keep the detached managed-OpenCode killer only as a crash/timeout backstop. Make `performConfirmedQuit()` await background shutdown before `app.exit(0)`. Signal handlers should initiate the same promise and use a bounded final fallback rather than immediately bypassing server cleanup.

Add the focused test to the appropriate Electron test script without adding dependencies.

**Step 4: Verify GREEN**

Run the node test and `bun run type-check:electron` (`node --check` through the package script).

---

### Task 12: Update owning documentation and run cumulative verification

**Files:**
- Modify: `packages/web/server/lib/harness/DOCUMENTATION.md`
- Modify: `packages/web/server/lib/opencode/DOCUMENTATION.md`
- Modify: `packages/ui/src/sync/DOCUMENTATION.md`
- Modify: `packages/ui/src/stores/DOCUMENTATION.md`
- Modify: `packages/electron/README.md`
- Modify: `docs/engines-claude-code-spec.md`
- Modify: `docs/plans/2026-07-31-claude-session-limit-auto-resume-design.md` (mark implementation status and any validated limitation)

**Step 1: Update contracts, not just changelog prose**

Document:

- structured rate-limit correlation and why English text is non-authoritative;
- retry journal path/schema/security and persistence-failure behavior;
- `busy -> retry -> busy -> idle` ordering;
- reset normalization/fallback and blocked behavior;
- synthetic continuation/transcript hiding/tool guard and the semantic exactly-once limitation;
- Stop, deletion, startup, shutdown, and Desktop ownership;
- same-client queue durability and explicit non-goal of cross-device queue sync;
- SDK-owned `api_retry` versus OpenChamber-owned hard quota wait.

**Step 2: Run focused server tests**

```bash
bun test packages/web/server/lib/harness
bun test packages/web/server/lib/session-goal/harness-continuation.test.js
bun test packages/web/server/lib/opencode/shutdown-runtime.test.js
```

Expected: all PASS, no unhandled rejection or leaked timer/process warning.

**Step 3: Run focused UI and Electron tests**

```bash
bun test packages/ui/src/stores/messageQueueStore.test.ts
bun test packages/ui/src/hooks/useQueuedMessageAutoSend.test.ts
bun test packages/ui/src/sync/session-deletion-cleanup.test.ts
bun test packages/ui/src/lib/i18n/messages.test.ts
node --test packages/electron/server-shutdown.test.mjs
```

Expected: all PASS.

**Step 4: Run syntax/type/lint checks**

```bash
node --check packages/web/server/lib/harness/pending-retry-store.js
node --check packages/web/server/lib/harness/retry-policy.js
node --check packages/web/server/lib/harness/retry-runtime.js
node --check packages/web/server/lib/harness/translators/claude-code/recovery-transcript.js
bun run type-check:web
bun run lint:web
bun run type-check:ui
bun run lint:ui
bun run type-check:electron
bun run lint:electron
```

Expected: exit 0. Note that web lint covers `src` TypeScript, so focused Bun tests and `node --check` remain required evidence for server JS.

**Step 5: Run affected builds and docs validation**

```bash
bun run build:web
bun run --cwd packages/electron bundle:main
bun run docs:validate
```

Expected: exit 0.

**Step 6: Run dead-code analysis for new files/exports**

```bash
bun run dead-code
```

Expected: command exits successfully (non-blocking by design); inspect the report and resolve any newly reported retry/recovery files or exports.

**Step 7: Optional real-Claude integration smoke (do not claim if unavailable)**

On a host with an authenticated Claude subscription and a controlled test project:

1. Trigger or fixture a structured `rate_limit_event` with a short reset.
2. Verify UI countdown, Stop, queue reorder/delete, and no idle gap.
3. Restart web/Desktop before reset; verify retry status and queue rehydrate.
4. Let reset pass; verify one hidden synthetic continuation and one recovery assistant tail.
5. Verify the supplied UUID and `isSynthetic` are present in Claude JSONL.
6. Exercise a pre-limit settled harmless tool and confirm exact replay is denied.

If a real account cannot safely reach a limit, report this integration boundary as not run; unit/type/lint/build checks must not be presented as proof of live Claude subscription behavior.
