# @openchamber/quota-core

## Purpose

Single source of truth for Claude subscription OAuth / usage-quota logic that
was previously near-1:1 duplicated between the web server
(`packages/web/server/lib/quota/providers/claude-oauth.js` +
`claude-cli-auth.js`) and the VS Code extension
(`packages/vscode/src/claudeOauth.ts`). That duplication drifted twice before
this package existed; both hosts now import the same implementation instead
of maintaining parallel copies.

## Hard constraints (do not violate)

- **Plain JS ESM, no build step.** The web server runs as un-transpiled
  Node ESM (`node bin/cli.js serve`). This package ships hand-written `.js`
  with JSDoc types — never TypeScript source.
- **Hand-written `.d.ts`.** `packages/vscode/tsconfig.json` has no `allowJs`
  and uses `moduleResolution: "bundler"`. `src/index.d.ts` is what makes this
  package type-check there; keep it in sync with `src/*.js` by hand when the
  public API changes.
- **Zero runtime dependencies.** No package dependencies, and no hardcoded
  `node:fs` / `fetch` / clock access at call sites that can't be swapped —
  every credential-reading, network, and time function accepts an `options`
  object with injectable overrides (see `ensureClaudeUsageAccessToken`,
  `readClaudeCliOAuthCredentials`, `writeClaudeCliOAuthCredentials`).
- **Never log, persist, or return raw tokens** beyond what a caller already
  needs to authenticate its own request.

## Module layout

- `src/claude-cli-auth.js`: read/write the Claude Code CLI's own
  `.credentials.json` (or `CLAUDE_CODE_OAUTH_TOKEN` env). Atomic 0600 writes.
- `src/opencode-auth.js`: default reader/writer for OpenCode's shared
  `auth.json`, used only as the built-in default for
  `ensureClaudeUsageAccessToken`'s `readAuth`/`writeAuth` options. Hosts that
  already own an auth.json accessor (the web server has one at
  `packages/web/server/lib/opencode/auth.js`, shared by every other quota
  provider) should keep passing their own `readAuth`/`writeAuth` instead of
  relying on this default, so there is still exactly one auth.json accessor
  per host.
- `src/claude-oauth.js`: credential resolution/preference order, token
  refresh, the 60s-cached single-flight rate-limit probe, and the
  single-flight refresh lock (`ensureClaudeUsageAccessToken`).
- `src/claude-usage.js`: pure transforms for the `/api/oauth/usage` payload
  (`mapClaudeUsageWindows`) and the decision helper
  (`shouldSkipClaudeUsageEndpoint`) for whether a credential can call that
  endpoint at all.
- `src/utils.js`: dependency-free `toNumber`/`toTimestamp`/`toUsageWindow`
  (with locale-formatted `resetAtFormatted`/`resetAfterFormatted`, matching
  every other OpenChamber quota provider's window shape) plus tiny
  `auth.json`-entry helpers used internally by `claude-oauth.js`.
- `src/index.js`: the only import path consumers should use
  (`@openchamber/quota-core`); re-exports the public surface above.

## What is intentionally NOT here

`fetchQuota()`/`fetchClaudeQuota()` — the per-host orchestration that wraps
the functions above into each host's own `ProviderResult`/`buildResult`
shape — stays in `packages/web/server/lib/quota/providers/claude.js` and
`packages/vscode/src/quotaProviders.ts` respectively. That orchestration is
thin (~50 lines) and depends on each host's generic, non-Claude-specific
provider-result contract (used by every other quota provider too), so moving
it here would mean this package taking on a generic "provider result" shape
it doesn't otherwise need.

## Consumers

- `packages/web/server/lib/quota/providers/claude.js` imports directly from
  `@openchamber/quota-core` and passes its own `readAuthFile`/`writeAuthFile`
  (from `packages/web/server/lib/opencode/auth.js`) as the `readAuth`/
  `writeAuth` overrides, so web's Claude persistence behavior (backup file,
  status logging) is unchanged.
- `packages/vscode/src/quotaProviders.ts` imports directly from
  `@openchamber/quota-core` and relies on this package's built-in
  `opencode-auth.js` default (equivalent atomic-write behavior, without the
  extra console logging web relies on for its `--quiet`/CLI output
  contract).

## Adding new shared Claude behavior

Add it here first, export it from `src/index.js`, mirror the shape in
`src/index.d.ts`, then update both consumers to call it. Do not let a third
copy of this logic appear in either host.
