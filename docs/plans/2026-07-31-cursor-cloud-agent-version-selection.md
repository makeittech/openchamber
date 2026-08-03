# Cursor Cloud Agent Version Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Cursor Cloud Agent launches resilient to slow responses and let users choose between the compatible v0 and run-based v1 APIs without changing the Work Queue UI contract.

**Architecture:** Keep v0 as the default and isolate v0/v1 request and status mapping inside the server-side Cursor client. Persist the effective API version on each cloud-agent record, expose validated version settings through the Work Queue API, and use a bounded 60-second default request timeout with an environment override.

**Tech Stack:** Node.js ESM server modules, Express routes, Vitest, React/TypeScript shared UI, Zustand-compatible runtime API contracts, existing i18n and Settings components.

---

## Task 1: Add failing server-side regression coverage

**Files:**
- Modify: `packages/web/server/lib/workqueue/workqueue.test.js` in the `cursor client` and `cursor auth storage` sections
- Test: `packages/web/server/lib/workqueue/workqueue.test.js`

### Step 1: Write the failing tests

Add tests for the approved behavior before changing implementation:

- `getCursorApiVersion()` returns `v0` by default and rejects an invalid stored value.
- A stored `v1` setting is returned and can be replaced with `v0`.
- v0 launch uses `/v0/agents`, the legacy `source.repository` payload, and the legacy string model.
- v1 launch uses `/v1/agents`, `repos`, and `model: { id: ... }`, then normalizes the separate `agent` and `run` response IDs.
- A thrown timeout-shaped fetch error becomes a `CursorApiError` with a timeout code and a message containing the configured timeout; the fetch is invoked once.
- A v1 status lookup uses the stored run ID and merges run status/branch data.

Use the per-test temporary `OPENCHAMBER_DATA_DIR` already established by the file. Mock `fetchImpl` rather than using a real API key or network request. Include a legacy record without `apiVersion` and assert it follows v0 behavior.

### Step 2: Run the focused tests to verify they fail

Run:

```bash
bun run --cwd packages/web test -- server/lib/workqueue/workqueue.test.js
```

Expected: the current suite's existing 19 tests pass, while the new version, v1, timeout, or settings assertions fail because the APIs and mappings do not exist yet.

## Task 2: Implement validated Cursor settings and timeout resolution

**Files:**
- Modify: `packages/web/server/lib/workqueue/settings.js`
- Modify: `packages/web/server/lib/workqueue/workqueue.test.js` (only if test imports need adjustment)

### Step 1: Implement the smallest settings API

In `packages/web/server/lib/workqueue/settings.js`:

- Define the `v0`/`v1` allowed values and default `v0`.
- Add `getCursorApiVersion()` with precedence `OPENCHAMBER_CURSOR_API_VERSION` → persisted `cursorApiVersion` → `v0`.
- Add `isCursorApiVersionConfiguredViaEnv()`.
- Add `setCursorApiVersion(version)` that validates the value before writing the existing settings JSON.
- Preserve unrelated settings keys and existing file permissions.

In the Cursor client or a focused helper in `packages/web/server/lib/workqueue/cursor/client.js`:

- Parse `OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS`.
- Use a 60,000 ms default and clamp explicit values to a finite safe range such as 1,000–300,000 ms.
- Export only the helper(s) that tests and routes need; do not expose credentials.

### Step 2: Run the settings tests

Run:

```bash
bun run --cwd packages/web test -- server/lib/workqueue/workqueue.test.js
```

Expected: settings assertions pass; client payload, timeout, and v1 status assertions remain red.

## Task 3: Implement versioned Cursor client requests

**Files:**
- Modify: `packages/web/server/lib/workqueue/cursor/client.js`
- Test: `packages/web/server/lib/workqueue/workqueue.test.js`

### Step 1: Implement version-specific request construction

Update the client without changing its public launch/status intent:

- Select the effective version using `getCursorApiVersion()` unless an explicit version is supplied for persisted-agent status checks.
- Build the base URL as `https://api.cursor.com/v0` or `https://api.cursor.com/v1`.
- Use server-side Basic authentication (`apiKey:` encoded in the Authorization header) for both documented APIs; never include the key in an error.
- Attach `AbortSignal.timeout(resolveCursorRequestTimeoutMs())` to each request.
- On timeout/abort caused by that signal, throw `CursorApiError` with `code = 'CURSOR_API_TIMEOUT'` and an actionable bounded message. Do not retry.
- Keep non-2xx response parsing and `CURSOR_NOT_CONNECTED` behavior intact.

### Step 2: Implement v0 and v1 launch normalization

- v0 launch sends `{ prompt: { text }, source: { repository }, model }` and normalizes the existing flat response.
- v1 launch sends `{ prompt: { text }, repos: [{ url: repoUrl }], model: { id: model } }` and normalizes `{ agent, run }` into `{ agentId, runId, status, url, branchName, name, createdAt, apiVersion }`.
- Preserve caller-selected model values; use the existing `default` model for the draft.
- Add `apiVersion` to normalized results and default missing legacy values to v0.

### Step 3: Implement version-aware status lookup

- For v0, fetch `/v0/agents/:agentId` and map `status`/`target` as today.
- For v1, fetch the agent metadata, choose the persisted `runId` or `latestRunId`, then fetch `/v1/agents/:agentId/runs/:runId`.
- Use run status as authoritative and read the first matching `git.branches` entry for `branchName`.
- Preserve the stored URL/name/branch when the upstream response omits optional values.

### Step 4: Run the focused tests

Run:

```bash
bun run --cwd packages/web test -- server/lib/workqueue/workqueue.test.js
```

Expected: all Cursor client tests and the existing Work Queue tests pass.

## Task 4: Wire routes and persisted/shared contracts

**Files:**
- Modify: `packages/web/server/lib/workqueue/routes.js`
- Modify: `packages/web/server/lib/workqueue/store.js`
- Modify: `packages/ui/src/lib/api/types.ts`
- Modify: `packages/web/src/api/workqueue.ts`
- Test: `packages/web/server/lib/workqueue/workqueue.test.js`

### Step 1: Extend the shared contract

- Add `CursorApiVersion = 'v0' | 'v1'`.
- Add optional/persisted `apiVersion` to `WorkQueueCloudAgent` and the server store normalizer, treating missing values as v0.
- Add `apiVersion` and `versionConfiguredViaEnv` to `WorkQueueCursorAuthStatus`.
- Add `cursorApiVersionSet(version)` to `WorkQueueAPI`.

### Step 2: Wire the server routes

- Import the settings getters/setter in `routes.js`.
- Extend `GET /api/workqueue/settings/cursor-auth` with the effective version and env-control flag.
- Add `PUT /api/workqueue/settings/cursor-version` with strict v0/v1 validation.
- Include the effective version in the draft response.
- Pass the effective version to launch and persist it in `cloudAgent`.
- Use persisted `cloudAgent.apiVersion` and `runId` for status requests.
- Map `CURSOR_API_TIMEOUT` to HTTP 504; preserve 401 and 502 behavior for other errors.

### Step 3: Wire the web runtime API

Implement `cursorApiVersionSet` in `packages/web/src/api/workqueue.ts`, using JSON and the same error extraction convention as the existing methods.

### Step 4: Add route/contract regression assertions

If a lightweight route harness is needed, assert the status code mapping and version persistence without starting the full server. Keep secrets out of all fixtures.

### Step 5: Run focused checks

Run:

```bash
bun run --cwd packages/web test -- server/lib/workqueue/workqueue.test.js
bun run type-check:web
```

Expected: tests pass and web TypeScript reports no contract errors.

## Task 5: Add the Settings version selector and localized copy

**Files:**
- Modify: `packages/ui/src/components/sections/openchamber/CursorSettings.tsx`
- Modify: the locale message files that define the Cursor Settings keys, using the repository's locale pattern
- Read before editing: `.agents/skills/settings-ui-patterns/SKILL.md`, `.agents/skills/theme-system/SKILL.md`, `.agents/skills/locale-ui-patterns/SKILL.md`

### Step 1: Add the UI behavior

- Read the version from `cursorAuthStatus()` with the existing auth status load.
- Render an accessible, theme-consistent v0/v1 selector near the connected Cursor status.
- Disable it when `versionConfiguredViaEnv` is true.
- Save changes through `cursorApiVersionSet` and show localized success/failure feedback.
- Do not display or retain the API key value.
- Keep the selector available to the user even if Cursor is currently disconnected, so configuration can be prepared before connecting.

### Step 2: Add locale keys

Add the label, v0/v1 descriptions, env-locked hint, save feedback, and failure feedback through the established message catalog. Do not hard-code new user-facing strings in the component.

### Step 3: Run UI checks

Run:

```bash
bun run type-check:ui
bun run lint:ui
```

Expected: both commands pass without unlocalized strings or theme violations.

## Task 6: Update owning documentation

**Files:**
- Modify: `packages/web/server/lib/workqueue/DOCUMENTATION.md`
- Modify: `docs/plans/2026-07-31-cursor-cloud-agent-version-selection-design.md` (only if implementation decisions materially differ)

### Step 1: Document the final behavior

Update the Cursor client file list, routes, invariants, and known limitations to describe:

- v0 default and Settings/env selection;
- v0/v1 payload and status differences hidden by normalization;
- the 60-second default and `OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS` override;
- timeout behavior and the deliberate no-retry rule.

### Step 2: Run documentation validation

Run:

```bash
bun run docs:validate
```

Expected: documentation validation passes.

## Task 7: Full focused verification

**Files:**
- No new files; inspect all modified files and generated reports.

### Step 1: Run the complete relevant checks

Run:

```bash
bun run --cwd packages/web test -- server/lib/workqueue/workqueue.test.js
bun run type-check:web
bun run type-check:ui
bun run lint:web
bun run lint:ui
bun run docs:validate
bun run dead-code
```

Expected: all blocking checks pass. `dead-code` is non-blocking by repository policy; inspect and report any findings rather than suppressing them.

### Step 2: Perform manual configuration checks when a Cursor key is available

- Select v0, launch a small GitHub work item, and confirm the persisted status shows v0.
- Select v1, launch a small GitHub work item, and confirm separate agent/run IDs are persisted.
- Use a deliberately slow/mock response to verify the client waits beyond 15 seconds and surfaces a timeout only after the configured limit.
- Switch versions and confirm old records still use their recorded version.

Do not record or print any API key, repository credential, or private response content.

> **Repository note:** The root agent guide forbids running git commands unless the user explicitly asks. Do not create commits during implementation; report the uncommitted changes instead.
