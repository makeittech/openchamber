/**
 * @openchamber/quota-core
 *
 * Single source of truth for Claude subscription OAuth / usage-quota logic
 * shared by the OpenChamber web server (plain Node ESM, no build step) and
 * the VS Code extension (bundled via esbuild). Zero runtime dependencies;
 * every `fs`, `fetch`, and clock access is injectable via an `options`
 * object so hosts and tests can substitute their own I/O.
 *
 * Never logs, persists, or returns raw tokens beyond what each host already
 * needs to authenticate its own requests.
 */

export {
  CLAUDE_OAUTH_CLIENT_ID,
  OPENCODE_CLAUDE_TOKEN_URL,
  CLAUDE_CLI_TOKEN_URL,
  CLAUDE_USAGE_URL,
  CLAUDE_USAGE_USER_AGENT,
  CLAUDE_SESSION_EXPIRED_ERROR,
  CLAUDE_SCOPE_ERROR,
  isClaudeAccessExpired,
  hasClaudeProfileScope,
  buildClaudeUsageHeaders,
  refreshClaudeOAuthToken,
  resolveClaudeUsageCredential,
  ensureClaudeUsageAccessToken,
  fetchClaudeUsagePayload,
  mapClaudeRateLimitHeaders,
  fetchClaudeUsageWindowsFromRateLimits,
  classifyClaudeUsageHttpError,
  __resetClaudeRefreshLockForTests,
} from './claude-oauth.js';

export {
  readClaudeCodeOAuthTokenFromEnv,
  listClaudeCredentialsCandidates,
  extractClaudeOAuthCredentials,
  extractClaudeOAuthAccessToken,
  readClaudeCliOAuthCredentials,
  readClaudeCliOAuthAccessToken,
  writeClaudeCliOAuthCredentials,
  hasClaudeCliOAuthCredentials,
} from './claude-cli-auth.js';

export {
  mapClaudeUsageWindows,
  shouldSkipClaudeUsageEndpoint,
} from './claude-usage.js';

export {
  toNumber,
  toTimestamp,
  toUsageWindow,
} from './utils.js';
