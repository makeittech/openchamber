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
  `status`, `assignee`, `aiAnalysis`, `linkedLinearId`/`linkedLinearUrl`,
  `closeReason`, or other lifecycle fields on an item it has already seen —
  only source-owned fields (title, `body`, url, labels) refresh. `body` and
  `reviewComments` are length-capped because the store is a single JSON file.
  Review comments only refresh when the sync actually fetched some, so a
  failed comment fetch cannot erase known reviews.
- `settings.js` — tracked `owner/repo` list for GitHub aggregation, stored in
  `settings.json` as `workqueueRepos`. Also stores the user-selected Cursor API
  version (`cursorApiVersion`: `v0` or `v1`) and resolves effective version
  with `OPENCHAMBER_CURSOR_API_VERSION` env precedence. Also stores three
  user-authored prompt fields (Settings > AI Workflow):
  `workqueueAnalysisPromptExtra`, `workqueueAlreadySolvedPromptExtra`,
  `workqueueRemoteAgentPromptSuffix` — each defaults to `''` and is exposed via
  `getWorkQueuePromptSettings()`/`setWorkQueuePromptSettings()`. Also stores an
  optional default analysis model (`workqueueAnalysisModel`, `provider/model`,
  validated with the `small-model` module's `parseModelRef()`) via
  `getWorkQueueAnalysisModel()`/`setWorkQueueAnalysisModel()` — empty/invalid
  clears it so analysis stays on the small-model module's normal
  auto-resolution chain rather than being locked to one provider.
- `sources.js` — `syncGitHub()` (iterates tracked repos via the GitHub
  module's `getOctokitOrNull()`, one repo's failure does not block the
  others) and `syncLinear()` (reuses the Linear module's `issuesList` query
  and stored auth). `syncAll()` runs both and reports each independently.
  `syncLinear()` also filters out any Linear issue already linked from a
  GitHub item's `linkedLinearId` (see `routes.js` below) so a mirrored issue
  never appears as a second, separate card. `resolveDefaultLinearTeam()`
  picks a team for a brand-new mirrored issue: the team already used by this
  workspace's synced Linear items (authoritative — most-used wins), falling
  back to the connection's first visible team only when no Linear item has
  synced yet.
- `dedup.js` — `extractLinearRef()` (GitHub body → Linear identifier, used by
  `applyLinearDedup()` above) and `findDuplicateCandidates()`: a cheap
  lexical prefilter (title token Jaccard similarity, threshold 0.3, top 5)
  over other open, non-PR, non-archived items, feeding `analysis.js`'s
  duplicate-detection prompt. This is only ever a prefilter — the actual
  "is it a duplicate, and which one is the parent" judgment is the model's,
  grounded against this candidate list.
- `staleness.js` — `checkItemStaleness()` searches the repo's commit log for
  commits that may have already fixed the item. Two-stage: first a `--grep`
  on the item's `sourceId`/`identifier` (authoritative — a commit that
  references the issue is the strongest signal); when that finds nothing and
  a `generateSmallModelText` callback is provided, an AI similarity pass asks
  the model to pick, from the repo's recent log (across all refs, commits
  older than the issue are filtered out), commits that look like they fix the
  same problem. Similar-commit picks are grounded: only hashes actually
  present in the fetched log are returned, an invented hash is dropped, and a
  failed log read or model call yields `[]` — never an error. Used both by
  the standalone `/staleness` route and, when a directory is available, folded
  straight into `analyzeItem()`'s "already solved?" signal.
- `analysis.js` — `analyzeItem()` calls `generateSmallModelText()` from the
  `small-model` module (no chat session is created) with a strict-JSON system
  prompt, the item's synced description, and two grounding sections when
  available: commits found by `staleness.js` (for "already solved?") and
  candidates found by `dedup.js` (for "possible duplicate, and which one is
  the parent?"). The commit section can contain both direct references and
  model-picked similar commits, because `analyzeItem()` hands its own model
  callback to `checkItemStaleness()` when a directory is active. The model may
  only reference a commit hash or item id that was actually listed —
  `groundDuplicateAndStalenessClaims()` drops anything else before it reaches
  storage, so a hallucinated reference can never be persisted. Issues and pull
  requests are analyzed the same way. `buildSystemPrompt()` appends the
  user-authored `analysisPromptExtra`/`alreadySolvedPromptExtra` (from
  `settings.js`) after the fixed `ANALYSIS_SYSTEM_PROMPT` — always additive,
  never a replacement, so the required JSON response schema stays intact
  regardless of what the user writes. A malformed response *or* a reasoning
  model that spent its whole output budget before answering gets one retry
  with a larger budget; anything else (auth, network) is reported without a
  retry. A persistent failure stores the real reason in `aiAnalysisError`,
  never a guess. `analyzeAllPending()` is the bulk pass: it skips
  already-analyzed items, runs with bounded concurrency, and one failed item
  never aborts the rest. Both `analyzeItem()` and `analyzeAllPending()` accept
  an optional `model` (`provider/model`) forwarded straight to
  `generateSmallModelText()`; the route layer resolves it (explicit per-call
  choice, else the persisted default from `settings.js`, else the small-model
  module's own auto-resolution) so analysis is never pinned to one
  provider/model unless the user explicitly picked or defaulted to one.
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
- `finish.js` — the Finish action takes a `closeReason`
  (`'completed' | 'duplicate' | 'not_planned'`, default `'completed'`)
  mirroring GitHub's own close reasons. GitHub: closes with the matching
  `state_reason` (GitHub has no native "duplicate" reason, so a duplicate
  close uses `'not_planned'` plus an explicit comment linking to
  `duplicateOfUrl`, GitHub's own UI convention). Linear: `'completed'` moves
  to the first `completed`-type state as before; `'duplicate'`/`'not_planned'`
  move to a `canceled`-type state, preferring one whose name actually says
  "Duplicate" / "Won't fix" over just the first canceled state. A GitHub item
  with a mirrored Linear issue (`linkedLinearId`, see `routes.js`) closes
  both sides. Each side is attempted and reported independently; the card
  archives once at least one succeeds (or immediately when the item has no
  external lifecycle to close).
- `routes.js` — HTTP surface (below).

## Routes

All routes require normal OpenChamber UI auth.

- `GET /api/workqueue/items?status=&repo=&assignee=&type=&source=`
- `GET /api/workqueue/items/:id`
- `POST /api/workqueue/sync` → `{ github: {...}, linear: {...} }`
- `POST /api/workqueue/items/:id/staleness` `{ directory }` — advisory
  "already fixed?" check; uses the AI similar-commit search when the small
  model is available, otherwise falls back to exact references only.
- `POST /api/workqueue/items/:id/analyze` `{ directory?, model? }` — issues
  and pull requests are analyzed the same way; `model` (`provider/model`)
  overrides the persisted default for this call only
- `POST /api/workqueue/analyze-bulk` `{ directory?, model? }` →
  `{ total, done, failed }`; long-running by nature; `model` overrides the
  persisted default for the whole pass
- `PATCH /api/workqueue/items/:id` `{ status?, assignee? }` — a transition
  into `in_progress` on an item with no assignee yet self-assigns it at the
  source (GitHub `addAssignees` or Linear `issueUpdate(assigneeId)`) as a
  best-effort follow-up; failure returns `assigneeSyncWarning` without
  undoing the already-applied status change (same non-blocking pattern as
  `linearSyncWarning`). A GitHub-sourced item taken into `in_progress` for
  the first time (no `linkedLinearId` yet) is also mirrored into Linear —
  created, assigned to the viewer, moved to the team's first `started` state
  — so it becomes visible outside OpenChamber the same way a Linear-sourced
  item already is; skipped silently when Linear isn't connected, otherwise a
  failure returns `linearCreateWarning` without undoing the status change.
- `POST /api/workqueue/items/:id/finish` `{ mergePr?, closeReason?, duplicateOfUrl? }` →
  `{ prMerged, issueClosedGitHub, linearMoved, archived }` — `closeReason`
  defaults to `'completed'`; `duplicateOfUrl` falls back to the item's own
  AI-flagged `aiAnalysis.duplicateOfUrl` when omitted.
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
- `GET /api/workqueue/settings/prompts` →
  `{ analysisPromptExtra, alreadySolvedPromptExtra, remoteAgentPromptSuffix }`
- `PUT /api/workqueue/settings/prompts` — patches only the string-typed fields
  present in the body; returns the full triple.
- `GET /api/workqueue/settings/model` → `{ model }` — the persisted default
  analysis model (`provider/model`), or `''` when unset.
- `PUT /api/workqueue/settings/model` `{ model }` — sets the persisted
  default; an empty or malformed value clears it back to auto-resolution.

## Invariants

- A sync failure on one source (GitHub down, a repo renamed/private, Linear
  disconnected) must not erase or block the other source's items — each is
  synced and reported independently.
- Analysis results are only ever produced by the model or explicitly marked
  as failed; a parse failure never silently becomes a fabricated/default
  analysis.
- Pull requests are analyzed the same way issues are, both in the server
  action and in the UI. The PR detail view additionally shows the automated
  `openchamber-bot[bot]` review comments on its own Review tab.
- Analysis is never hardcoded to a single provider/model: the detail panel
  lets the user pick any authenticated provider/model per analysis run, and
  a separate "set as default" action (Settings > AI Workflow, or the panel's
  own toggle) persists a preferred model — both read/write the same
  `workqueueAnalysisModel` setting. Leaving it unset keeps analysis on the
  small-model module's own auto-resolution chain across authenticated
  providers.
- User-configured prompt text (Settings > AI Workflow) is additive-only: it is
  always appended after the hardcoded `ANALYSIS_SYSTEM_PROMPT` and the
  generated Cursor dispatch prompt, and never replaces any part of either —
  the JSON response schema the model must follow stays authoritative
  regardless of what the user writes.
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
- A model-flagged "already solved" or "duplicate of" claim is only ever
  stored when it references a commit hash or item id the model was actually
  shown as evidence; an unrecognized reference is dropped, never persisted.
  This covers similar commits surfaced by the staleness AI search too — they
  are real log entries the model was shown, and any hash outside that list is
  discarded before it reaches storage.
- Mirroring a GitHub item into Linear is one-way and one-time: it only
  triggers on the first `in_progress` transition (`linkedLinearId` unset),
  never re-creates, and the mirrored issue is filtered out of normal Linear
  syncs so it can't also appear as an unrelated second card.

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
- The default Linear team for a newly mirrored GitHub issue is resolved
  automatically (most-used synced team, else the connection's first team);
  there is no per-workspace team picker yet.
- GitHub has no native "duplicate" close reason, so a duplicate close there
  uses `'not_planned'` plus a comment — GitHub's own UI does the same.
- The duplicate prefilter is lexical (title token overlap), not semantic; it
  will miss duplicates phrased very differently and the model only ever
  judges within what the prefilter surfaced.
