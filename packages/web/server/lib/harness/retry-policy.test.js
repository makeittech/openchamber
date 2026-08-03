import { describe, expect, it } from 'bun:test';
import {
  FALLBACK_BASE_MS,
  FALLBACK_MAX_MS,
  JITTER_MAX_MS,
  MAX_RESET_DISTANCE_MS,
  MAX_STALE_UNKNOWN_AGE_MS,
  MAX_TIMER_CHUNK_MS,
  MIN_PAST_RESET_DELAY_MS,
  RESET_GRACE_MS,
  computeNextAttempt,
  nextTimerChunk,
  normalizeResetTimestamp,
  selectRejectedRateLimit,
} from './retry-policy.js';

const NOW = 1_800_000_000_000;

describe('retry policy constants', () => {
  it('keeps the public tuning values stable', () => {
    expect({
      MAX_RESET_DISTANCE_MS,
      RESET_GRACE_MS,
      MIN_PAST_RESET_DELAY_MS,
      FALLBACK_BASE_MS,
      FALLBACK_MAX_MS,
      MAX_STALE_UNKNOWN_AGE_MS,
      MAX_TIMER_CHUNK_MS,
      JITTER_MAX_MS,
    }).toEqual({
      MAX_RESET_DISTANCE_MS: 691_200_000,
      RESET_GRACE_MS: 5_000,
      MIN_PAST_RESET_DELAY_MS: 1_000,
      FALLBACK_BASE_MS: 300_000,
      FALLBACK_MAX_MS: 3_600_000,
      MAX_STALE_UNKNOWN_AGE_MS: 604_800_000,
      MAX_TIMER_CHUNK_MS: 2_147_483_647,
      JITTER_MAX_MS: 1_000,
    });
  });
});

describe('normalizeResetTimestamp', () => {
  it('handles timestamp forms, invalid values, and distance boundaries', () => {
    const cases = [
      ['epoch milliseconds', NOW, NOW],
      ['epoch seconds', NOW / 1000, NOW],
      ['relative milliseconds', 60_000, NOW + 60_000],
      ['past reset', 1_700_000_000_000, 1_700_000_000_000],
      ['maximum future reset', NOW + MAX_RESET_DISTANCE_MS, NOW + MAX_RESET_DISTANCE_MS],
      ['future outlier', NOW + MAX_RESET_DISTANCE_MS + 1, null],
      ['far-future epoch seconds', 1_800_000_000, null, 1_700_000_000_000],
      ['negative', -1, null],
      ['zero', 0, null],
      ['NaN', Number.NaN, null],
      ['positive infinity', Number.POSITIVE_INFINITY, null],
      ['negative infinity', Number.NEGATIVE_INFINITY, null],
      ['string', '1800000000', null],
      ['null', null, null],
      ['undefined', undefined, null],
      ['boolean', true, null],
    ];
    for (const [name, value, expected, now = NOW] of cases) {
      expect(normalizeResetTimestamp(value, now)).toBe(expected);
    }
  });

  it('uses the injected clock for relative values', () => {
    expect(normalizeResetTimestamp(60_000, 1_700_000_000_000)).toBe(1_700_000_060_000);
    expect(normalizeResetTimestamp(60_000, 1_900_000_000_000)).toBe(1_900_000_060_000);
  });

  it('defaults to the wall clock', () => {
    const before = Date.now();
    const result = normalizeResetTimestamp(Math.floor(Date.now() / 1000));
    expect(result).toBeGreaterThanOrEqual(before - 1000);
    expect(result).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('selectRejectedRateLimit', () => {
  it('selects only valid rejected windows and prefers the latest reset', () => {
    const cases = [
      ['null info', null, null],
      ['undefined info', undefined, null],
      ['allowed primary', { status: 'allowed', resetsAt: NOW + 60_000 }, null],
      ['warning primary', { status: 'allowed_warning', resetsAt: NOW + 60_000 }, null],
      ['invalid primary reset', { status: 'rejected', resetsAt: Number.NaN }, null],
      ['negative primary reset', { status: 'rejected', resetsAt: -1 }, null],
      [
        'future primary outlier',
        { status: 'rejected', resetsAt: NOW + MAX_RESET_DISTANCE_MS + 1 },
        null,
      ],
      [
        'rejected primary',
        { status: 'rejected', resetsAt: NOW + 60_000, rateLimitType: 'five_hour' },
        { rateLimitType: 'five_hour', resetAt: NOW + 60_000 },
      ],
      [
        'primary without a type',
        { status: 'rejected', resetsAt: NOW + 60_000 },
        { rateLimitType: 'unknown', resetAt: NOW + 60_000 },
      ],
      [
        'rejected overage',
        { overageStatus: 'rejected', overageResetsAt: NOW + 120_000 },
        { rateLimitType: 'overage', resetAt: NOW + 120_000 },
      ],
      [
        'allowed in-use overage',
        { overageStatus: 'allowed', overageResetsAt: NOW + 120_000, overageInUse: true },
        null,
      ],
      [
        'later overage',
        {
          status: 'rejected', resetsAt: NOW + 60_000, rateLimitType: 'five_hour',
          overageStatus: 'rejected', overageResetsAt: NOW + 120_000,
        },
        { rateLimitType: 'overage', resetAt: NOW + 120_000 },
      ],
      [
        'later primary',
        {
          status: 'rejected', resetsAt: NOW + 200_000, rateLimitType: 'five_hour',
          overageStatus: 'rejected', overageResetsAt: NOW + 120_000,
        },
        { rateLimitType: 'five_hour', resetAt: NOW + 200_000 },
      ],
      [
        'allowed overage beside rejected primary',
        {
          status: 'rejected', resetsAt: NOW + 60_000, rateLimitType: 'five_hour',
          overageStatus: 'allowed', overageResetsAt: NOW + 999_999_999, isUsingOverage: true,
        },
        { rateLimitType: 'five_hour', resetAt: NOW + 60_000 },
      ],
      [
        'seconds-shaped primary reset',
        { status: 'rejected', resetsAt: NOW / 1000, rateLimitType: 'five_hour' },
        { rateLimitType: 'five_hour', resetAt: NOW },
      ],
      [
        'valid overage beside invalid primary',
        { status: 'rejected', resetsAt: Number.NaN, overageStatus: 'rejected', overageResetsAt: NOW + 90_000 },
        { rateLimitType: 'overage', resetAt: NOW + 90_000 },
      ],
    ];
    for (const [name, info, expected] of cases) {
      expect(selectRejectedRateLimit(info, NOW)).toEqual(expected);
    }
  });
});

describe('computeNextAttempt', () => {
  it('adds grace and stable bounded jitter to a future reset', () => {
    const record = { resetAt: NOW + 10_000, attempt: 1, sessionId: 'ses_repeat' };
    const first = computeNextAttempt(record, { now: NOW });
    const jitter = first.nextAttemptAt - record.resetAt - RESET_GRACE_MS;
    expect(computeNextAttempt(record, { now: NOW })).toEqual(first);
    expect(Number.isInteger(jitter)).toBe(true);
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThan(JITTER_MAX_MS);
  });

  it('uses attempt and creation time for stable jitter without a session ID', () => {
    const record = { resetAt: NOW + 10_000, attempt: 2, createdAt: NOW - 5_000 };
    const first = computeNextAttempt(record, { now: NOW });
    const jitter = first.nextAttemptAt - record.resetAt - RESET_GRACE_MS;
    expect(computeNextAttempt(record, { now: NOW })).toEqual(first);
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThan(JITTER_MAX_MS);
  });

  it('applies the minimum delay to current and past resets', () => {
    for (const resetAt of [NOW - 60_000, NOW]) {
      expect(computeNextAttempt({ resetAt }, { now: NOW })).toEqual({
        nextAttemptAt: NOW + MIN_PAST_RESET_DELAY_MS,
      });
    }
  });

  it('uses bounded exponential fallback for missing and invalid reset data', () => {
    const cases = [
      ['missing attempt', {}, FALLBACK_BASE_MS],
      ['attempt 2', { attempt: 2 }, 2 * FALLBACK_BASE_MS],
      ['attempt 4', { attempt: 4 }, 8 * FALLBACK_BASE_MS],
      ['capped attempt', { attempt: 5 }, FALLBACK_MAX_MS],
      ['invalid reset', { resetAt: Number.NaN }, FALLBACK_BASE_MS],
      ['zero attempt', { attempt: 0 }, FALLBACK_BASE_MS],
      ['negative attempt', { attempt: -3 }, FALLBACK_BASE_MS],
      ['fractional attempt', { attempt: 2.5 }, FALLBACK_BASE_MS],
      ['invalid unknown timestamp', { firstUnknownAt: Number.NaN, attempt: 3 }, 4 * FALLBACK_BASE_MS],
    ];
    for (const [name, record, delay] of cases) {
      expect(computeNextAttempt(record, { now: NOW })).toEqual({ nextAttemptAt: NOW + delay });
    }
  });

  it('blocks only a stale unknown reset', () => {
    expect(computeNextAttempt({
      firstUnknownAt: NOW - MAX_STALE_UNKNOWN_AGE_MS - 1,
    }, { now: NOW })).toEqual({ blocked: true, blockedReason: 'stale-unknown-reset' });
    expect(computeNextAttempt({
      firstUnknownAt: NOW - MAX_STALE_UNKNOWN_AGE_MS + 10_000,
    }, { now: NOW })).toEqual({ nextAttemptAt: NOW + FALLBACK_BASE_MS });
  });

  it('prefers a valid reset over a stale unknown marker', () => {
    const result = computeNextAttempt({
      resetAt: NOW + 10_000,
      firstUnknownAt: NOW - MAX_STALE_UNKNOWN_AGE_MS - 1,
      sessionId: 'ses_future',
    }, { now: NOW });
    expect(result.blocked).toBeUndefined();
    expect(result.nextAttemptAt).toBeGreaterThanOrEqual(NOW + 15_000);
    expect(result.nextAttemptAt).toBeLessThan(NOW + 15_000 + JITTER_MAX_MS);
  });
});

describe('nextTimerChunk', () => {
  it('handles deadline boundaries, long timers, and invalid values', () => {
    const cases = [
      ['future deadline', NOW + 5_000, 5_000],
      ['current deadline', NOW, 0],
      ['past deadline', NOW - 5_000, 0],
      ['long deadline', NOW + 3_000_000_000, MAX_TIMER_CHUNK_MS],
      ['NaN', Number.NaN, 0],
      ['infinity', Number.POSITIVE_INFINITY, 0],
      ['undefined', undefined, 0],
      ['null', null, 0],
    ];
    for (const [name, deadline, expected] of cases) {
      expect(nextTimerChunk(deadline, NOW)).toBe(expected);
    }
  });

  it('returns a nonnegative integer using the wall clock by default', () => {
    const delay = nextTimerChunk(Date.now() + 250);
    expect(Number.isInteger(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(251);
  });
});
