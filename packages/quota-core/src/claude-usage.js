/**
 * Pure transforms for the `/api/oauth/usage` payload and the access-decision
 * helper that decides whether a credential can call that endpoint at all.
 * Shared verbatim by the web server's `claude` quota provider and the VS Code
 * extension's Claude usage probe.
 */

import { toNumber, toTimestamp, toUsageWindow } from './utils.js';
import { hasClaudeProfileScope } from './claude-oauth.js';

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
 * @returns {boolean}
 */
export function shouldSkipClaudeUsageEndpoint(access) {
  if (!access) return true;
  if (access.source === 'env') return true;
  if (access.scopes != null && !hasClaudeProfileScope(access.scopes)) return true;
  return false;
}
