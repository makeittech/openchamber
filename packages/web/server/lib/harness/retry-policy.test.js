import { describe, expect, it } from 'bun:test';
import {
  MAX_RESET_DISTANCE_MS,
  RESET_GRACE_MS,
  MIN_PAST_RESET_DELAY_MS,
  FALLBACK_BASE_MS,
  FALLBACK_MAX_MS,
  MAX_STALE_UNKNOWN_AGE_MS,
  MAX_TIMER_CHUNK_MS,
  JITTER_MAX_MS,
  normalizeResetTimestamp,
  selectRejectedRateLimit,
  computeNextAttempt,
  nextTimerChunk,
} from './retry-policy.js';

const NOW = 1_800_000_000_000; // fixed injected clock for determinism

describe('exported constants', () => {
  it('locks the documented tuning values', () => {
    expect(MAX_RESET_DISTANCE_MS).toBe(691_200_000); // 8 * 24 * 60 * 60 * 1000 (8 days)
    expect(RESET_GRACE_MS).toBe(5_000);
    expect(MIN_PAST_RESET_DELAY_MS).toBe(1_000);
    expect(FALLBACK_BASE_MS).toBe(5 * 60 * 1000); // 5 min
    expect(FALLBACK_MAX_MS).toBe(60 * 60 * 1000); // 1 hour
    expect(MAX_STALE_UNKNOWN_AGE_MS).toBe(604_800_000); // 7 * 24 * 60 * 60 * 1000 (7 days)
    expect(MAX_TIMER_CHUNK_MS).toBe(2_147_483_647);
    expect(JITTER_MAX_MS).toBe(1_000);
  });
});

describe('normalizeResetTimestamp', () => {
  it('treats values >= 1e12 as epoch milliseconds, used as-is', () => {
    expect(normalizeResetTimestamp(1_800_000_000_000, NOW)).toBe(1_800_000_000_000);
  });

  it('treats values >= 1e9 and < 1e12 as epoch seconds, multiplied by 1000', () => {
    expect(normalizeResetTimestamp(1_800_000_000, NOW)).toBe(1_800_000_000_000);
  });

  it('treats small values as a relative delay in ms added to now', () => {
    expect(normalizeResetTimestamp(60_000, NOW)).toBe(1_800_000_060_000);
  });

  it('rejects non-finite or non-positive values with null', () => {
    expect(normalizeResetTimestamp(-1, NOW)).toBeNull();
    expect(normalizeResetTimestamp(0, NOW)).toBeNull(); // not positive
    expect(normalizeResetTimestamp(Number.NaN, NOW)).toBeNull();
    expect(normalizeResetTimestamp(Number.POSITIVE_INFINITY, NOW)).toBeNull();
    expect(normalizeResetTimestamp(Number.NEGATIVE_INFINITY, NOW)).toBeNull();
  });

  it('rejects non-number inputs with null', () => {
    expect(normalizeResetTimestamp('1800000000', NOW)).toBeNull();
    expect(normalizeResetTimestamp(null, NOW)).toBeNull();
    expect(normalizeResetTimestamp(undefined, NOW)).toBeNull();
    expect(normalizeResetTimestamp(true, NOW)).toBeNull();
  });

  it('rejects resets more than 8 days in the future', () => {
    // 1_800_000_000 seconds -> 1_800_000_000_000 ms; now is 1_700_000_000_000.
    // diff = 100_000_000_000 ms >> 8 days -> null.
    expect(normalizeResetTimestamp(1_800_000_000, 1_700_000_000_000)).toBeNull();
  });

  it('keeps a reset exactly at the 8-day boundary (diff == MAX)', () => {
    const at = NOW + MAX_RESET_DISTANCE_MS; // ms value, used as-is
    expect(normalizeResetTimestamp(at, NOW)).toBe(at);
  });

  it('rejects a reset one ms past the 8-day boundary', () => {
    expect(normalizeResetTimestamp(NOW + MAX_RESET_DISTANCE_MS + 1, NOW)).toBeNull();
  });

  it('keeps past resets (future-bound only rejects forward outliers)', () => {
    expect(normalizeResetTimestamp(1_700_000_000_000, NOW)).toBe(1_700_000_000_000);
  });

  it('defaults now to Date.now() when omitted (still a finite absolute)', () => {
    const before = Date.now();
    const got = normalizeResetTimestamp(Math.floor(Date.now() / 1000)); // ~now in seconds
    const after = Date.now();
    expect(typeof got).toBe('number');
    expect(Number.isFinite(got)).toBe(true);
    // seconds->ms lands within a second of the live clock.
    expect(got).toBeGreaterThanOrEqual(before - 1000);
    expect(got).toBeLessThanOrEqual(after + 1000);
  });

  it('is pure: depends only on injected now (relative branch tracks now)', () => {
    expect(normalizeResetTimestamp(60_000, 1_700_000_000_000)).toBe(1_700_000_060_000);
    expect(normalizeResetTimestamp(60_000, 1_900_000_000_000)).toBe(1_900_000_060_000);
  });
});

describe('selectRejectedRateLimit', () => {
  it('returns null for null/undefined info', () => {
    expect(selectRejectedRateLimit(null, NOW)).toBeNull();
    expect(selectRejectedRateLimit(undefined, NOW)).toBeNull();
  });

  it('returns null when the primary limit is only allowed', () => {
    expect(selectRejectedRateLimit({ status: 'allowed', resetsAt: NOW + 60_000 }, NOW)).toBeNull();
  });

  it('returns null when the primary limit is only allowed_warning', () => {
    expect(
      selectRejectedRateLimit({ status: 'allowed_warning', resetsAt: NOW + 60_000 }, NOW),
    ).toBeNull();
  });

  it('returns the primary hard window when status is rejected and resetsAt is valid', () => {
    expect(
      selectRejectedRateLimit(
        { status: 'rejected', resetsAt: NOW + 60_000, rateLimitType: 'five_hour' },
        NOW,
      ),
    ).toEqual({ rateLimitType: 'five_hour', resetAt: NOW + 60_000 });
  });

  it('defaults rateLimitType to unknown when missing on a rejected primary', () => {
    expect(
      selectRejectedRateLimit({ status: 'rejected', resetsAt: NOW + 60_000 }, NOW),
    ).toEqual({ rateLimitType: 'unknown', resetAt: NOW + 60_000 });
  });

  it('yields no hard window when a rejected primary carries an invalid resetsAt', () => {
    expect(
      selectRejectedRateLimit({ status: 'rejected', resetsAt: Number.NaN }, NOW),
    ).toBeNull();
    expect(
      selectRejectedRateLimit({ status: 'rejected', resetsAt: -1 }, NOW),
    ).toBeNull();
    // far-future out-of-bounds also invalidates the primary window
    expect(
      selectRejectedRateLimit(
        { status: 'rejected', resetsAt: NOW + MAX_RESET_DISTANCE_MS + 1 },
        NOW,
      ),
    ).toBeNull();
  });

  it('returns the overage hard window when overageStatus is rejected', () => {
    expect(
      selectRejectedRateLimit(
        { overageStatus: 'rejected', overageResetsAt: NOW + 120_000 },
        NOW,
      ),
    ).toEqual({ rateLimitType: 'overage', resetAt: NOW + 120_000 });
  });

  it('ignores an allowed / in-use overage (no hard wait from overage alone)', () => {
    expect(
      selectRejectedRateLimit(
        { overageStatus: 'allowed', overageResetsAt: NOW + 120_000, overageInUse: true, isUsingOverage: true },
        NOW,
      ),
    ).toBeNull();
  });

  it('returns the window with the latest resetAt when both primary and overage are valid', () => {
    // overage resets later -> overage wins
    expect(
      selectRejectedRateLimit(
        {
          status: 'rejected',
          resetsAt: NOW + 60_000,
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          overageResetsAt: NOW + 120_000,
        },
        NOW,
      ),
    ).toEqual({ rateLimitType: 'overage', resetAt: NOW + 120_000 });

    // primary resets later -> primary wins
    expect(
      selectRejectedRateLimit(
        {
          status: 'rejected',
          resetsAt: NOW + 200_000,
          rateLimitType: 'five_hour',
          overageStatus: 'rejected',
          overageResetsAt: NOW + 120_000,
        },
        NOW,
      ),
    ).toEqual({ rateLimitType: 'five_hour', resetAt: NOW + 200_000 });
  });

  it('does not let an in-use/allowed overage override a rejected primary', () => {
    expect(
      selectRejectedRateLimit(
        {
          status: 'rejected',
          resetsAt: NOW + 60_000,
          rateLimitType: 'five_hour',
          overageStatus: 'allowed',
          overageResetsAt: NOW + 999_999_999,
          overageInUse: true,
          isUsingOverage: true,
        },
        NOW,
      ),
    ).toEqual({ rateLimitType: 'five_hour', resetAt: NOW + 60_000 });
  });

  it('normalizes seconds-shaped resetsAt before comparing', () => {
    // resetsAt given in epoch seconds equal to NOW/1000 -> resets to NOW exactly.
    const result = selectRejectedRateLimit(
      { status: 'rejected', resetsAt: Math.floor(NOW / 1000), rateLimitType: 'five_hour' },
      NOW,
    );
    expect(result).toEqual({ rateLimitType: 'five_hour', resetAt: NOW });
  });

  it('falls back to a single valid window when the other is invalid', () => {
    expect(
      selectRejectedRateLimit(
        {
          status: 'rejected',
          resetsAt: Number.NaN,
          overageStatus: 'rejected',
          overageResetsAt: NOW + 90_000,
        },
        NOW,
      ),
    ).toEqual({ rateLimitType: 'overage', resetAt: NOW + 90_000 });
  });
});

describe('computeNextAttempt', () => {
  describe('future reset', () => {
    it('schedules resetAt + RESET_GRACE_MS + jitter with jitter in [0, 1000)', () => {
      const resetAt = NOW + 10_000;
      const result = computeNextAttempt(
        { resetAt, attempt: 1, sessionId: 'ses_alpha' },
        { now: NOW },
      );
      const delta = result.nextAttemptAt - (resetAt + RESET_GRACE_MS);
      expect(result).toEqual({ nextAttemptAt: resetAt + RESET_GRACE_MS + delta });
      expect(Number.isInteger(delta)).toBe(true);
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThan(JITTER_MAX_MS);
    });

    it('is deterministic and repeatable for the same sessionId', () => {
      const record = { resetAt: NOW + 10_000, attempt: 1, sessionId: 'ses_repeat' };
      const a = computeNextAttempt(record, { now: NOW });
      const b = computeNextAttempt(record, { now: NOW });
      expect(a).toEqual(b);
    });

    it('computes deterministic jitter without a sessionId using attempt/createdAt', () => {
      const record = { resetAt: NOW + 10_000, attempt: 2, createdAt: NOW - 5_000 };
      const a = computeNextAttempt(record, { now: NOW });
      const b = computeNextAttempt(record, { now: NOW });
      expect(a).toEqual(b);
      const delta = a.nextAttemptAt - (record.resetAt + RESET_GRACE_MS);
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThan(JITTER_MAX_MS);
    });
  });

  describe('past reset', () => {
    it('schedules max(now + MIN_PAST_RESET_DELAY_MS, resetAt) (never zero-delay)', () => {
      const result = computeNextAttempt(
        { resetAt: NOW - 60_000, attempt: 1 },
        { now: NOW },
      );
      expect(result).toEqual({ nextAttemptAt: NOW + MIN_PAST_RESET_DELAY_MS });
    });

    it('treats resetAt == now as past and applies the minimum delay', () => {
      const result = computeNextAttempt({ resetAt: NOW, attempt: 1 }, { now: NOW });
      expect(result).toEqual({ nextAttemptAt: NOW + MIN_PAST_RESET_DELAY_MS });
    });
  });

  describe('missing or invalid reset -> exponential fallback', () => {
    it('defaults attempt to 1 when missing (delay = FALLBACK_BASE_MS)', () => {
      const result = computeNextAttempt({ sessionId: 'ses_x' }, { now: NOW });
      expect(result).toEqual({ nextAttemptAt: NOW + FALLBACK_BASE_MS });
    });

    it('exponentiates: attempt 2 -> 2 * FALLBACK_BASE_MS', () => {
      const result = computeNextAttempt({ attempt: 2 }, { now: NOW });
      expect(result).toEqual({ nextAttemptAt: NOW + 2 * FALLBACK_BASE_MS });
    });

    it('exponentiates: attempt 4 -> 8 * FALLBACK_BASE_MS (under the cap)', () => {
      const result = computeNextAttempt({ attempt: 4 }, { now: NOW });
      expect(result).toEqual({ nextAttemptAt: NOW + 8 * FALLBACK_BASE_MS });
    });

    it('caps the fallback delay at FALLBACK_MAX_MS', () => {
      const result = computeNextAttempt({ attempt: 5 }, { now: NOW });
      expect(result).toEqual({ nextAttemptAt: NOW + FALLBACK_MAX_MS });
    });

    it('treats an invalid reset (NaN) as missing and uses fallback', () => {
      const result = computeNextAttempt({ resetAt: Number.NaN, attempt: 1 }, { now: NOW });
      expect(result).toEqual({ nextAttemptAt: NOW + FALLBACK_BASE_MS });
    });

    it('coerces a non-positive / non-integer attempt back to 1', () => {
      expect(computeNextAttempt({ attempt: 0 }, { now: NOW })).toEqual({
        nextAttemptAt: NOW + FALLBACK_BASE_MS,
      });
      expect(computeNextAttempt({ attempt: -3 }, { now: NOW })).toEqual({
        nextAttemptAt: NOW + FALLBACK_BASE_MS,
      });
      expect(computeNextAttempt({ attempt: 2.5 }, { now: NOW })).toEqual({
        nextAttemptAt: NOW + FALLBACK_BASE_MS,
      });
    });
  });

  describe('stale unknown reset', () => {
    it('blocks when an unknown reset has been pending longer than 7 days', () => {
      const firstUnknownAt = NOW - MAX_STALE_UNKNOWN_AGE_MS - 1;
      const result = computeNextAttempt(
        { firstUnknownAt, attempt: 1 },
        { now: NOW },
      );
      expect(result).toEqual({
        blocked: true,
        blockedReason: 'stale-unknown-reset',
      });
    });

    it('still computes fallback when the unknown reset is not yet stale', () => {
      const firstUnknownAt = NOW - MAX_STALE_UNKNOWN_AGE_MS + 10_000;
      const result = computeNextAttempt(
        { firstUnknownAt, attempt: 1 },
        { now: NOW },
      );
      expect(result).toEqual({ nextAttemptAt: NOW + FALLBACK_BASE_MS });
    });

    it('does not block on firstUnknownAt when a valid future reset is present', () => {
      const firstUnknownAt = NOW - MAX_STALE_UNKNOWN_AGE_MS - 1; // would be stale
      const resetAt = NOW + 10_000;
      const result = computeNextAttempt(
        { resetAt, firstUnknownAt, attempt: 1, sessionId: 'ses_future' },
        { now: NOW },
      );
      expect(result.blocked).toBeUndefined();
      const delta = result.nextAttemptAt - (resetAt + RESET_GRACE_MS);
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(delta).toBeLessThan(JITTER_MAX_MS);
    });

    it('treats an invalid firstUnknownAt as absent (fallback, not blocked)', () => {
      const result = computeNextAttempt(
        { firstUnknownAt: Number.NaN, attempt: 3 },
        { now: NOW },
      );
      expect(result).toEqual({ nextAttemptAt: NOW + 4 * FALLBACK_BASE_MS });
    });
  });

  it('is pure: identical record + now produce identical output', () => {
    const record = { resetAt: NOW + 30_000, attempt: 1, sessionId: 'ses_purity' };
    expect(computeNextAttempt(record, { now: NOW })).toEqual(
      computeNextAttempt(record, { now: NOW }),
    );
  });
});

describe('nextTimerChunk', () => {
  it('returns the remaining ms when the deadline is in the future', () => {
    expect(nextTimerChunk(NOW + 5_000, NOW)).toBe(5_000);
  });

  it('returns 0 when the deadline is now or in the past', () => {
    expect(nextTimerChunk(NOW, NOW)).toBe(0);
    expect(nextTimerChunk(NOW - 5_000, NOW)).toBe(0);
  });

  it('chunks to never exceed MAX_TIMER_CHUNK_MS', () => {
    expect(nextTimerChunk(NOW + 3_000_000_000, NOW)).toBe(MAX_TIMER_CHUNK_MS);
    expect(MAX_TIMER_CHUNK_MS).toBeLessThanOrEqual(2_147_483_647);
  });

  it('returns a nonnegative integer', () => {
    const value = nextTimerChunk(NOW + 4_321, NOW);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 for a non-finite / non-number deadline', () => {
    expect(nextTimerChunk(Number.NaN, NOW)).toBe(0);
    expect(nextTimerChunk(Number.POSITIVE_INFINITY, NOW)).toBe(0);
    expect(nextTimerChunk(undefined, NOW)).toBe(0);
    expect(nextTimerChunk(null, NOW)).toBe(0);
  });

  it('defaults now to Date.now() when omitted', () => {
    const before = Date.now();
    const got = nextTimerChunk(Date.now() + 250);
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(0);
    expect(got).toBeLessThanOrEqual(after - before + 250 + 1);
  });
});