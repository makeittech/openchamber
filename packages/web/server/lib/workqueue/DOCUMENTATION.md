# AI Work Queue (Server)

Aggregates GitHub issues/PRs and Linear issues into a single triage queue,
runs a background AI analysis pass on each item, and can hand a task off to a
Cursor Cloud Agent or archive it once finished.

## Ownership

Everything under `packages/web/server/lib/workqueue/` is owned by this
module. Routes are registered lazily from `feature-routes-runtime.js` (same
pattern as `small-model`), and JSON body parsing for `/api/workqueue/*` is
enabled in `core-routes.js`.

## Files

- `store.js` — `workqueue-items.json` (OpenChamber data dir, `0600`, atomic
  writes, pruned to 1000 entries — archived items are pruned first). Items are
  keyed by `source:sourceId`. A sync **upserts**: it never overwrites
  `status`, `assignee`, `aiAnalysis`, or lifecycle fields on an item it has
  already seen — only source-owned fields (title, `body`, url, labels)
  refresh. `body` and `reviewComments` are length-capped because the store is
  a single JSON file. Review comments only refresh when the sync actually
  fetched some, so a failed comment fetch cannot erase known reviews.
- `settings.js` — tracked `owner/repo` list for GitHub aggregation, stored in
  `settings.json` as `workqueueRepos`. Also stores the user-selected Cursor API
  version (`cursorApiVersion`: `v0` or `v1`) and resolves effective version
  with `OPENCHAMBER_CURSOR_API_VERSION` env precedence.
- `sources.js` — `syncGitHub()` (iterates tracked repos via the GitHub
  module's `getOctokitOrNull()`, one repo's failure does not block the
  others) and `syncLinear()` (reuses the Linear module's `issuesList` query
  and stored auth). `syncAll()` runs both and reports each independently.
- `analysis.js` — `analyzeItem()` calls `generateSmallModelText()` from the
  `small-model` module (no chat session is created) with a strict-JSON system
  prompt and the item's synced description. Pull requests are refused
  (`ANALYSIS_NOT_APPLICABLE`) — their review signal is the automated PR review
  comments, not a model pass. A malformed response *or* a reasoning model that
  spent its whole output budget before answering gets one retry with a larger
  budget; anything else (auth, network) is reported without a retry. A
  persistent failure stores the real reason in `aiAnalysisError`, never a
  guess. `analyzeAllPending()` is the bulk pass: it skips PRs and
  already-analyzed items, runs with bounded concurrency, and one failed item
  never aborts the rest.
- `cursor/auth.js` — Cursor API key storage (`cursor-auth.json`, `0600`,
  atomic), resolved from `OPENCHAMBER_CURSOR_API_KEY` env or the stored key.
- `cursor/client.js` — version-aware REST client for the Cursor Cloud Agents
  API. Supports v0 (`POST /v0/agents`, string `model`, `source.repository`)
  and v1 (`POST /v1/agents`, `model: { id }`, `repos: [{ url }]`). Version
  selected from settings or env; respected for status lookups too. Requests use
  Basic auth, a 60 s default timeout (overridable via
  `OPENCHAMBER_CURSOR_REQUEST_TIMEOUT_MS`), and classify timeouts as
  `CURSOR_API_TIMEOUT` with no automatic retry. Normalizes v0 flat and v1
  `{ agent, run }` responses into the same `cloudAgent` shape including
  `apiVersion`. v1 status uses the persisted `runId` and run-level data. No
  SSE streaming yet.
- `finish.js` — the Finish action: merges/closes the GitHub side and moves
  the Linear issue to its first "completed" workflow state independently;
  either side's failure does not block the other, and the card archives once
  at least one succeeds (or immediately when the item has no external
  lifecycle to close).
- `routes.js` — HTTP surface (below).

## Routes

All routes require normal OpenChamber UI auth.

- `GET /api/workqueue/items?status=&repo=&assignee=&type=&source=`
- `GET /api/workqueue/items/:id`
- `POST /api/workqueue/sync` → `{ github: {...}, linear: {...} }`
- `POST /api/workqueue/items/:id/analyze` `{ directory? }` — `400` for PRs
- `POST /api/workqueue/analyze-bulk` `{ directory? }` →
  `{ total, done, failed }`; long-running by nature
- `PATCH /api/workqueue/items/:id` `{ status?, assignee? }` — a transition
  into `in_progress` on an item with no assignee yet self-assigns it at the
  source (GitHub `addAssignees` or Linear `issueUpdate(assigneeId)`) as a
  best-effort follow-up; failure returns `assigneeSyncWarning` without
  undoing the already-applied status change (same non-blocking pattern as
  `linearSyncWarning`).
- `POST /api/workqueue/items/:id/finish` `{ mergePr? }` →
  `{ prMerged, issueClosedGitHub, linearMoved, archived }`
- `GET /api/workqueue/items/:id/cloud-agent/draft` →
  `{ prompt, model, repository, connected, apiVersion }` — what *would* be
  sent, so the client can show and edit it before dispatch.
- `POST /api/workqueue/items/:id/cloud-agent` `{ prompt?, model?, repository? }`
  — launches a Cursor agent (GitHub items only). Omitted fields fall back to
  the same draft the client was shown. A dispatched agent moves a `todo` card
  to `in_progress`.
- `GET /api/workqueue/items/:id/cloud-agent/status` — polls and persists the
  latest Cursor run status. Uses the `cloudAgent.apiVersion` so changing the
  persistent version setting does not break existing agents.
- `GET/PUT /api/workqueue/settings/repos`
- `GET/POST/DELETE /api/workqueue/settings/cursor-auth` — now also returns
  `apiVersion` and `versionConfiguredViaEnv`.
- `PUT /api/workqueue/settings/cursor-version` `{ apiVersion: 'v0'|'v1' }` —
  persists the user-selected Cursor API version. Ignored when the env override
  is active.

## Invariants

- A sync failure on one source (GitHub down, a repo renamed/private, Linear
  disconnected) must not erase or block the other source's items — each is
  synced and reported independently.
- Analysis results are only ever produced by the model or explicitly marked
  as failed; a parse failure never silently becomes a fabricated/default
  analysis.
- Pull requests are never AI-analyzed, in the server action and in the UI.
  The PR detail view shows the GitHub description and the automated
  `openchamber-bot[bot]` review comments and nothing else.
- The card Overview is populated from the synced source description alone, so
  it has real content immediately after the first sync, with no dependency on
  an analysis pass having run.
- Nothing is dispatched to Cursor without the user first seeing the exact
  prompt and model in the review dialog.
- Cursor and Linear/GitHub credentials never leave the server; the client
  only ever sends a prompt or a status/settings request.
- The Finish action's GitHub and Linear legs are independent — a Linear
  failure does not prevent an already-merged/closed GitHub side from
  archiving the card, and vice versa.

## Runtime parity

The routes run wherever the OpenChamber server runs (web, desktop/Electron
in-process, hosted mobile backend). The VS Code extension host does not
register a Work Queue runtime API; the shared UI treats the capability as
unavailable there, same as Linear.

## Known limitations (v1)

- Cursor Cloud Agent status is polled on demand, not streamed via SSE.
- Silent `CURSOR_API_TIMEOUT` after POST means Cursor may have accepted the
  request; the server does not retry to avoid duplicate agents.
- GitHub aggregation is scoped to an explicit tracked-repo list, not
  org-wide discovery.
- Matrix and Calendar views are not implemented; the client renders them as
  disabled/"coming soon".
