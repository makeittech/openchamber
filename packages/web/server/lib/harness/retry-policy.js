export const MAX_RESET_DISTANCE_MS = 8 * 24 * 60 * 60 * 1000;
export const RESET_GRACE_MS = 5_000;
export const MIN_PAST_RESET_DELAY_MS = 1_000;
export const FALLBACK_BASE_MS = 5 * 60 * 1000;
export const FALLBACK_MAX_MS = 60 * 60 * 1000;
export const MAX_STALE_UNKNOWN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const JITTER_MAX_MS = 1_000;
export const MAX_TIMER_CHUNK_MS = 2_147_483_647;

const SECONDS_THRESHOLD = 1_000_000_000;
const MILLIS_THRESHOLD = 1_000_000_000_000;

function hashString32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function normalizeResetTimestamp(value, now = Date.now()) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;

  let absolute;
  if (value >= MILLIS_THRESHOLD) absolute = value;
  else if (value >= SECONDS_THRESHOLD) absolute = value * 1000;
  else absolute = now + value;

  return absolute - now > MAX_RESET_DISTANCE_MS ? null : absolute;
}

/**
 * Select the active hard rate-limit window from SDK `rate_limit_info`.
 *
 * Only `status === 'rejected'` (primary) and `overageStatus === 'rejected'`
 * (overage) windows count as hard waits; `allowed`/`allowed_warning` and any
 * in-use/allowed overage do not. When both windows are valid, the one with the
 * latest resetAt wins.
 *
 * @param {{ status?: string, resetsAt?: number, rateLimitType?: string, overageStatus?: string, overageResetsAt?: number, overageInUse?: unknown, isUsingOverage?: unknown } | null | undefined} info
 * @param {number} [now]
 * @returns {{ rateLimitType: string, resetAt: number } | null}
 */
export function selectRejectedRateLimit(info, now = Date.now()) {
  if (!info || typeof info !== 'object') return null;

  let selected = null;

  if (info.status === 'rejected') {
    const resetAt = normalizeResetTimestamp(info.resetsAt, now);
    if (resetAt !== null) {
      const rateLimitType = typeof info.rateLimitType === 'string' && info.rateLimitType
        ? info.rateLimitType
        : 'unknown';
      selected = { rateLimitType, resetAt };
    }
  }

  if (info.overageStatus === 'rejected') {
    const resetAt = normalizeResetTimestamp(info.overageResetsAt, now);
    if (resetAt !== null && (!selected || resetAt > selected.resetAt)) {
      selected = { rateLimitType: 'overage', resetAt };
    }
  }

  return selected;
}

/**
 * @param {{ resetAt?: number, attempt?: number, createdAt?: number, sessionId?: string, firstUnknownAt?: number }} record
 * @param {{ now?: number }} [options]
 * @returns {{ nextAttemptAt: number } | { blocked: true, blockedReason: 'stale-unknown-reset' }}
 */
export function computeNextAttempt(record, { now = Date.now() } = {}) {
  const rec = record && typeof record === 'object' ? record : {};

  const attempt = Number.isInteger(rec.attempt) && rec.attempt >= 1 ? rec.attempt : 1;
  const hasValidReset = typeof rec.resetAt === 'number' && Number.isFinite(rec.resetAt) && rec.resetAt > 0;

  if (hasValidReset) {
    const resetAt = /** @type {number} */ (rec.resetAt);
    if (resetAt > now) {
      const jitterKey = rec.sessionId != null && rec.sessionId !== ''
        ? `sid:${rec.sessionId}`
        : `attempt:${attempt}|created:${rec.createdAt ?? ''}`;
      const jitter = hashString32(jitterKey) % JITTER_MAX_MS;
      return { nextAttemptAt: resetAt + RESET_GRACE_MS + jitter };
    }
    return { nextAttemptAt: Math.max(now + MIN_PAST_RESET_DELAY_MS, resetAt) };
  }

  if (
    typeof rec.firstUnknownAt === 'number'
    && Number.isFinite(rec.firstUnknownAt)
    && now - rec.firstUnknownAt > MAX_STALE_UNKNOWN_AGE_MS
  ) {
    return { blocked: true, blockedReason: 'stale-unknown-reset' };
  }

  const delay = Math.min(FALLBACK_BASE_MS * 2 ** (attempt - 1), FALLBACK_MAX_MS);
  return { nextAttemptAt: now + delay };
}

/**
 * Nonnegative integer ms delay to a deadline, chunked to never exceed the
 * 32-bit signed `setTimeout` ceiling.
 *
 * @param {number} deadline
 * @param {number} [now]
 * @returns {number}
 */
export function nextTimerChunk(deadline, now = Date.now()) {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) return 0;
  const remaining = Math.floor(deadline - now);
  if (!Number.isFinite(remaining)) return 0;
  return Math.max(0, Math.min(remaining, MAX_TIMER_CHUNK_MS));
}
