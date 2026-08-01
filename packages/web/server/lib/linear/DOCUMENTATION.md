# Linear Integration (Server)

Server-side Linear integration: OAuth authorization of a Linear workspace,
issue lookup/search, and linking OpenChamber sessions to Linear issues with
lifecycle status comments posted back to the issue.

## Ownership

Everything under `packages/web/server/lib/linear/` is owned by this module.
Routes are registered from `opencode/feature-routes-runtime.js` (before the
generic OpenCode proxy), JSON body parsing for `/api/linear/*` is enabled in
`opencode/core-routes.js`, and the status tracker is fed from the global
message stream hub in `server/index.js`.

## Files

- `auth.js` — token storage (`linear-auth.json` in the OpenChamber data dir,
  `0600`, atomic writes), OAuth client configuration
  (`OPENCHAMBER_LINEAR_CLIENT_ID` / `OPENCHAMBER_LINEAR_CLIENT_SECRET`, falling
  back to `linearClientId` / `linearClientSecret` in `settings.json`), and the
  automation toggles (`linearMoveToInProgressOnStart`,
  `linearMoveToDoneOnComplete` in `settings.json`). Tokens and the client
  secret never leave the server. Each stored connection has a `kind`:
  `oauth` (access + refresh token) or `api_key` (Linear personal API key, no
  refresh — keys are long-lived by design).
- `oauth.js` — authorize URL building, code exchange, refresh, and the
  in-memory, single-use OAuth state store (10 minute TTL).
- `client.js` — minimal GraphQL client for `https://api.linear.app/graphql`
  with transparent access-token refresh (OAuth connections only), a 15 s
  request timeout, workflow-state transitions (`moveIssueToStateType`: team's
  lowest-position state of a given type), and `assignIssueToViewer` (assigns
  an issue to the connected account via `issueUpdate(assigneeId)`, used by the
  Work Queue's take-into-progress flow).
- `links.js` — `linear-sessions.json` mapping of Linear issue ↔ OpenChamber
  session (one link per session, pruned to 500 entries). Records keep the
  issue `teamId` so lifecycle transitions can resolve workflow states later.
- `tracker.js` — maps OpenCode global events (`session.idle`, `session.error`,
  `permission.asked`, `question.asked`) to Linear status comments. Each status
  is posted at most once per session; after a terminal status (`completed`,
  `error`) no further comments are posted. Failed comment posts are retried on
  the next matching event (the notification state is only advanced on success).
- `routes.js` — HTTP surface (below).

## Routes

All routes require normal OpenChamber UI auth **except**
`GET /api/linear/auth/callback`, which is exempt in `requireApiAuth` because
Linear's redirect is a cross-site top-level navigation and the
`SameSite=Strict` session cookie is not attached; the single-use OAuth `state`
parameter is the credential for that request.

- `GET /api/linear/auth/status` → `{ configured, connected, kind, user, organization, scope, automation }`
- `POST /api/linear/auth/start` `{ redirectUri? }` → `{ authorizeUrl }`.
  The redirect URI defaults to `<request origin>/api/linear/auth/callback` and
  can be overridden with `OPENCHAMBER_LINEAR_REDIRECT_URI` (tunnels).
- `POST /api/linear/auth/apikey` `{ apiKey }` — alternative to OAuth for
  setups without a registered Linear OAuth app. The key must match the
  `lin_api_…` format and is validated against the `viewer` query before being
  stored (`401` when Linear rejects it, `400` on malformed input).
- `PUT /api/linear/auth/settings` `{ moveToInProgressOnStart?, moveToDoneOnComplete? }`
  → updates the automation toggles, returns `{ automation }`.
- `GET /api/linear/auth/callback` — exchanges the code, stores tokens, then
  redirects to `/?linearAuth=connected` (or `?linearAuth=error&reason=...`).
- `DELETE /api/linear/auth` → disconnects.
- `GET /api/linear/issues?query=&cursor=` → issues assigned to the viewer, or
  full-text search when `query` is set. Returns `{ connected: false }` instead
  of an error when Linear is not connected.
- `GET /api/linear/issue?id=` — issue detail. `id` accepts a `TEAM-123`
  identifier, UUID, or full Linear issue URL.
- `GET /api/linear/sessions?issueId=|sessionId=` → recorded links.
- `POST /api/linear/sessions` `{ issue, session: { id, directory?, title?, url? } }`
  — re-fetches the issue (authoritative), records the link, posts a
  "session started" comment and an attachment with the session URL.
  `commentPosted` / `attachmentPosted` flags report partial Linear failures;
  the link record is authoritative and the attach does not fail on them.
  When `moveToInProgressOnStart` is enabled and the issue is still in a
  triage/backlog/unstarted state, it is also moved to the team's first
  started state (`stateChanged` / `stateName` report the outcome).

## Workflow state automation

- Session start (via `POST /api/linear/sessions`) moves the issue to the
  team's first `started` state (e.g. "In Progress") — default on.
- Session completion (tracked via `session.idle`) posts a "completed" comment
  and, only when `moveToDoneOnComplete` is explicitly enabled, moves the issue
  to the team's first `completed` state. Default off: OpenCode fires
  `session.idle` after every agent turn, so auto-closing on idle would mark
  issues Done long before the work is actually finished.

## Invariants

- Access to issue content is bounded by the Linear OAuth token of the
  connecting user: private teams/issues simply do not resolve through the API.
- Status comments are only posted for sessions recorded in `links.js`; a
  server restart loses in-flight events (no replay), which is deliberate for
  v1 (no catch-up spam on old sessions).
- The OAuth client secret is server-side only; `/api/linear/auth/status`
  exposes only whether it is configured.

## Runtime parity

The routes run wherever the OpenChamber server runs (web, desktop/Electron
in-process, hosted mobile backend). The VS Code extension host does not
register a Linear runtime API; the shared UI treats the capability as
unavailable there.
