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
 * @param {string} accessToken
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
async function loadWindowsWithRateLimitFallback(accessToken, options = {}) {
  return fetchClaudeUsageWindowsFromRateLimits(accessToken, options);
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
    const knownMissingProfile = access.scopes != null && !hasClaudeProfileScope(access.scopes);

    // Inference-only setup tokens cannot call /api/oauth/usage. Skip straight to
    // the Messages rate-limit header probe when scopes are known to lack profile.
    if (knownMissingProfile) {
      const windows = await loadWindowsWithRateLimitFallback(access.accessToken);
      return buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: { windows },
      });
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
    }

    // 403 scope errors (and empty usage payloads) fall back to unified rate-limit
    // headers from a tiny Messages call — works with inference-only tokens.
    if (!response.ok && response.status !== 403 && response.status !== 401) {
      const bodyText = await response.text().catch(() => '');
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: classifyClaudeUsageHttpError(response.status, bodyText),
      });
    }

    try {
      const windows = await loadWindowsWithRateLimitFallback(access.accessToken);
      return buildResult({
        providerId,
        providerName,
        ok: true,
        configured: true,
        usage: { windows },
      });
    } catch {
      if (response.status === 401) {
        return buildResult({
          providerId,
          providerName,
          ok: false,
          configured: true,
          error: CLAUDE_SESSION_EXPIRED_ERROR,
        });
      }
      const bodyText = await response.clone().text().catch(() => '');
      return buildResult({
        providerId,
        providerName,
        ok: false,
        configured: true,
        error: response.ok
          ? CLAUDE_SCOPE_ERROR
          : classifyClaudeUsageHttpError(response.status, bodyText),
      });
    }
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
