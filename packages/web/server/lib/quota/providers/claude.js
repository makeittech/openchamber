import { readAuthFile } from '../../opencode/auth.js';
import {
  getAuthEntry,
  normalizeAuthEntry,
  buildResult,
  toUsageWindow,
  toNumber,
  toTimestamp
} from '../utils/index.js';
import {
  CLAUDE_SCOPE_ERROR,
  CLAUDE_SESSION_EXPIRED_ERROR,
  classifyClaudeUsageHttpError,
  ensureClaudeUsageAccessToken,
  fetchClaudeUsagePayload,
  fetchClaudeUsageWindowsFromRateLimits,
  hasClaudeProfileScope,
} from './claude-oauth.js';
import { readClaudeCliOAuthAccessToken } from './claude-cli-auth.js';

export const providerId = 'claude';
export const providerName = 'Claude subscription';
const aliases = ['anthropic', 'claude'];

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
 * @param {unknown} payload
 * @returns {Record<string, ReturnType<typeof toUsageWindow>>}
 */
export function mapClaudeUsageWindows(payload) {
  const windows = {};
  const fiveHour = payload?.five_hour ?? null;
  const sevenDay = payload?.seven_day ?? null;
  const sevenDaySonnet = payload?.seven_day_sonnet ?? null;
  const sevenDayOpus = payload?.seven_day_opus ?? null;

  if (fiveHour && typeof fiveHour === 'object') {
    windows['5h'] = toUsageWindow({
      usedPercent: toNumber(fiveHour.utilization),
      windowSeconds: 5 * 60 * 60,
      resetAt: toTimestamp(fiveHour.resets_at)
    });
  }
  if (sevenDay && typeof sevenDay === 'object') {
    windows['7d'] = toUsageWindow({
      usedPercent: toNumber(sevenDay.utilization),
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: toTimestamp(sevenDay.resets_at)
    });
  }
  if (sevenDaySonnet && typeof sevenDaySonnet === 'object') {
    windows['7d-sonnet'] = toUsageWindow({
      usedPercent: toNumber(sevenDaySonnet.utilization),
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: toTimestamp(sevenDaySonnet.resets_at)
    });
  }
  if (sevenDayOpus && typeof sevenDayOpus === 'object') {
    windows['7d-opus'] = toUsageWindow({
      usedPercent: toNumber(sevenDayOpus.utilization),
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: toTimestamp(sevenDayOpus.resets_at)
    });
  }

  return windows;
}

/**
 * True when this credential cannot use `/api/oauth/usage` successfully.
 * Env setup-tokens and known inference-only scopes should skip that endpoint.
 *
 * @param {{ source?: string, scopes?: string[] | null } | null | undefined} access
 */
export function shouldSkipClaudeUsageEndpoint(access) {
  if (!access) return true;
  if (access.source === 'env') return true;
  if (access.scopes != null && !hasClaudeProfileScope(access.scopes)) return true;
  return false;
}

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
