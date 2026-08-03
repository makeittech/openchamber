import { readAuthFile, writeAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
} from '../utils/index.js';
import {
  CLAUDE_SCOPE_ERROR,
  CLAUDE_SESSION_EXPIRED_ERROR,
  classifyClaudeUsageHttpError,
  ensureClaudeUsageAccessToken as ensureClaudeUsageAccessTokenCore,
  fetchClaudeUsagePayload,
  fetchClaudeUsageWindowsFromRateLimits,
  mapClaudeUsageWindows,
  readClaudeCliOAuthAccessToken,
  shouldSkipClaudeUsageEndpoint,
} from '@openchamber/quota-core';

export const providerId = 'claude';
export const providerName = 'Claude subscription';
const aliases = ['anthropic', 'claude'];

// Re-exported for backward compatibility: these are the actual shared
// implementations from @openchamber/quota-core, not local copies. Anything
// still importing them from this module (or from the deleted
// claude-oauth.js / claude-cli-auth.js siblings) gets the single source of
// truth.
export { mapClaudeUsageWindows, shouldSkipClaudeUsageEndpoint };

/**
 * Resolve a usable Claude subscription access token, refreshing when
 * expired. Wires this host's own OpenCode `auth.json` reader/writer
 * (shared with every other quota provider) into the shared quota-core
 * credential/refresh layer, so persistence behavior (backup file, status
 * logging) is unchanged from before the extraction.
 *
 * @param {Parameters<typeof ensureClaudeUsageAccessTokenCore>[0]} [options]
 */
function ensureClaudeUsageAccessToken(options = {}) {
  return ensureClaudeUsageAccessTokenCore({
    readAuth: readAuthFile,
    writeAuth: writeAuthFile,
    ...options,
  });
}

/**
 * Resolve whether Claude subscription usage can be probed.
 * Prefers Claude Code CLI OAuth (engine-aligned), then OpenCode auth.json.
 *
 * @returns {boolean}
 */
export const isConfigured = () => {
  if (readClaudeCliOAuthAccessToken()) return true;
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  const openCodeToken = entry?.access ?? entry?.token;
  return typeof openCodeToken === 'string' && Boolean(openCodeToken.trim());
};

/**
 * @param {string} accessToken
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
async function loadWindowsWithRateLimitFallback(accessToken, options = {}) {
  return fetchClaudeUsageWindowsFromRateLimits(accessToken, options);
}

/**
 * @param {string} accessToken
 * @param {number | null} [status]
 * @param {string} [bodyText]
 */
async function buildFallbackOrError(accessToken, status = null, bodyText = '') {
  try {
    const windows = await loadWindowsWithRateLimitFallback(accessToken);
    return buildResult({
      providerId,
      providerName,
      ok: true,
      configured: true,
      usage: { windows },
    });
  } catch {
    if (status === 401) {
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: CLAUDE_SESSION_EXPIRED_ERROR,
      });
    }
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: status == null
        ? CLAUDE_SCOPE_ERROR
        : classifyClaudeUsageHttpError(status, bodyText),
    });
  }
}

export const fetchQuota = async () => {
  let access;
  try {
    access = await ensureClaudeUsageAccessToken();
  } catch {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: CLAUDE_SESSION_EXPIRED_ERROR,
    });
  }

  if (!access?.accessToken) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  try {
    // Setup-tokens / inference-only credentials cannot call /api/oauth/usage
    // (403 scope or 429 from the non-profile bucket). Go straight to the
    // Messages unified rate-limit header probe.
    if (shouldSkipClaudeUsageEndpoint(access)) {
      return await buildFallbackOrError(access.accessToken);
    }

    let response = await fetchClaudeUsagePayload(access.accessToken);

    if (response.status === 401 && access.canRefresh) {
      try {
        access = await ensureClaudeUsageAccessToken({ forceRefresh: true });
      } catch {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: CLAUDE_SESSION_EXPIRED_ERROR,
        });
      }

      if (!access?.accessToken) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: CLAUDE_SESSION_EXPIRED_ERROR,
        });
      }

      response = await fetchClaudeUsagePayload(access.accessToken);
    }

    if (response.ok) {
      const payload = await response.json();
      const windows = mapClaudeUsageWindows(payload);
      if (Object.keys(windows).length > 0) {
        return buildResult({
          providerId,
          providerName,
          ok: true,
          configured: true,
          usage: { windows }
        });
      }
      // Empty payload — still try rate-limit headers.
      return await buildFallbackOrError(access.accessToken);
    }

    // 401/403/429/5xx: prefer Messages rate-limit headers over surfacing a raw
    // status. This is what keeps Services/Settings populated for setup-tokens
    // and when Anthropic rate-limits the undocumented usage endpoint.
    const bodyText = await response.text().catch(() => '');
    return await buildFallbackOrError(access.accessToken, response.status, bodyText);
  } catch (error) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: error instanceof Error ? error.message : 'Request failed'
    });
  }
};
