/**
 * Pure deterministic helpers for interpreting Claude SDK rate-limit metadata and
 * computing retry deadlines. No I/O, no timers, no scheduler. All clock input is
 * injected (`now` defaults to `Date.now()` only at the API boundary so callers
 * can stub it; nothing else reads the wall clock).
 *
 * Constants are exported so callers (scheduler / pending-retry-store consumers)
 * never hardcode tuning values.
 */

/**
 * Furthest a normalized absolute reset may sit in the future before it is
 * rejected as implausible. 8 days = 8 * 24 * 60 * 60 * 1000 = 691_200_000 ms.
 * (The prose bound "8 days" is authoritative; the value is in ms, not us.)
 */
export const MAX_RESET_DISTANCE_MS = 8 * 24 * 60 * 60 * 1000; // 691_200_000

/** Extra slack added on top of a known future reset before retrying. */
export const RESET_GRACE_MS = 5_000;

/** Smallest delay applied even when the reset already lies in the past. */
export const MIN_PAST_RESET_DELAY_MS = 1_000;

/** Base delay for exponential backoff when no usable reset is known. */
export const FALLBACK_BASE_MS = 5 * 60 * 1000; // 5 min

/** Cap for the exponential backoff delay. */
export const FALLBACK_MAX_MS = 60 * 60 * 1000; // 1 hour

/** How long an unknown reset may stay pending before the record is blocked. */
export const MAX_STALE_UNKNOWN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 604_800_000

/** Exclusive upper bound for deterministic jitter (jitter in [0, JITTER_MAX_MS)). */
export const JITTER_MAX_MS = 1_000;

/** Largest value accepted by a 32-bit signed setTimeout chunk. */
export const MAX_TIMER_CHUNK_MS = 2_147_483_647;

const SECONDS_THRESHOLD = 1_000_000_000;
const MILLIS_THRESHOLD = 1_000_000_000_000;

/**
 * FNV-1a 32-bit hash. Deterministic for the same input string across platforms
 * (uses only charCodeAt + integer math via Math.imul and an unsigned coerce).
 *
 * @param {string} str
 * @returns {number}
 */
function hashString32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Normalize a raw reset value to an absolute epoch-ms timestamp.
 *
 * - `>= 1e12` treated as epoch milliseconds (used as-is)
 * - `>= 1e9 and < 1e12` treated as epoch seconds (multiplied by 1000)
 * - otherwise treated as a relative delay in ms (`now + value`)
 *
 * Rejected (returns null) when `value` is not a finite positive number or when
 * the resulting absolute reset is more than {@link MAX_RESET_DISTANCE_MS} in the
 * future relative to `now`. Past resets are accepted (handled by
 * {@link computeNextAttempt}).
 *
 * @param {number} value Raw reset value.
 * @param {number} [now] Wall clock in epoch ms. Defaults to `Date.now()`.
 * @returns {number | null}
 */
export function normalizeResetTimestamp(value, now = Date.now()) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  let absolute;
  if (value >= MILLIS_THRESHOLD) {
    absolute = value;
  } else if (value >= SECONDS_THRESHOLD) {
    absolute = value * 1000;
  } else {
    absolute = now + value;
  }

  if (absolute - now > MAX_RESET_DISTANCE_MS) {
    return null;
  }
  return absolute;
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

  const candidates = [];

  if (info.status === 'rejected') {
    const resetAt = normalizeResetTimestamp(info.resetsAt, now);
    if (resetAt !== null) {
      const rateLimitType = typeof info.rateLimitType === 'string' && info.rateLimitType
        ? info.rateLimitType
        : 'unknown';
      candidates.push({ rateLimitType, resetAt });
    }
  }

  if (info.overageStatus === 'rejected') {
    const resetAt = normalizeResetTimestamp(info.overageResetsAt, now);
    if (resetAt !== null) {
      candidates.push({ rateLimitType: 'overage', resetAt });
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((latest, candidate) =>
    candidate.resetAt > latest.resetAt ? candidate : latest,
  );
}

/**
 * @param {{ resetAt?: number, attempt?: number, createdAt?: number, sessionId?: string, firstUnknownAt?: number }} record
 * @param {{ now?: number }} [options]
 * @returns {{ nextAttemptAt: number } | { blocked: true, blockedReason: 'stale-unknown-reset' }}
 */
export function computeNextAttempt(record, { now = Date.now() } = {}) {
  const rec = record && typeof record === 'object' ? record : {};

  const attempt = Number.isInteger(rec.attempt) && rec.attempt >= 1
    ? rec.attempt
    : 1;

  const hasValidReset = typeof rec.resetAt === 'number'
    && Number.isFinite(rec.resetAt)
    && rec.resetAt > 0;

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

  // Missing / invalid reset -> this is an "unknown" reset. A record whose
  // unknown state has outlasted MAX_STALE_UNKNOWN_AGE_MS is blocked rather than
  // retried forever.
  if (typeof rec.firstUnknownAt === 'number' && Number.isFinite(rec.firstUnknownAt)) {
    if (now - rec.firstUnknownAt > MAX_STALE_UNKNOWN_AGE_MS) {
      return { blocked: true, blockedReason: 'stale-unknown-reset' };
    }
  }

  const delay = Math.min(
    FALLBACK_BASE_MS * 2 ** (attempt - 1),
    FALLBACK_MAX_MS,
  );
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