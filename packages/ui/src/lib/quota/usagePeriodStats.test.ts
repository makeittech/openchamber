import { describe, expect, test } from 'bun:test';
import {
  aggregateUsageRecords,
  averageCostPer1kTokens,
  buildPeriodUsageSummary,
  dayKeyFromMs,
  formatUsd,
  percentChange,
  resolveUsagePeriod,
  sessionTokenTotal,
} from './usagePeriodStats';

describe('sessionTokenTotal', () => {
  test('sums all token buckets', () => {
    expect(sessionTokenTotal({
      input: 10,
      output: 20,
      reasoning: 5,
      cache: { read: 3, write: 2 },
    })).toBe(40);
  });
});

const day = (offset: number, hour = 12) => {
  const base = new Date('2026-08-17T12:00:00');
  base.setDate(base.getDate() + offset);
  base.setHours(hour, 0, 0, 0);
  return base.getTime();
};

describe('resolveUsagePeriod', () => {
  test('builds inclusive day ranges for fixed presets', () => {
    const resolved = resolveUsagePeriod({ kind: 'days', days: 7 }, day(0));
    expect(resolved.days).toBe(7);
    expect(dayKeyFromMs(resolved.endMs)).toBe(dayKeyFromMs(day(0)));
    expect(dayKeyFromMs(resolved.startMs)).toBe(dayKeyFromMs(day(-6)));
  });

  test('clamps custom ranges into the available history horizon and today', () => {
    const resolved = resolveUsagePeriod({
      kind: 'range',
      startDay: '2010-01-01',
      endDay: '2999-01-01',
    }, day(0), '2023-01-01');
    expect(dayKeyFromMs(resolved.startMs)).toBe('2023-01-01');
    expect(dayKeyFromMs(resolved.endMs)).toBe(dayKeyFromMs(day(0)));
  });

  test('swaps an inverted custom range', () => {
    const resolved = resolveUsagePeriod({
      kind: 'range',
      startDay: dayKeyFromMs(day(0)),
      endDay: dayKeyFromMs(day(-2)),
    }, day(0));
    expect(resolved.days).toBe(3);
    expect(dayKeyFromMs(resolved.startMs)).toBe(dayKeyFromMs(day(-2)));
  });

  test('rejects invalid calendar dates', () => {
    const resolved = resolveUsagePeriod({
      kind: 'range',
      startDay: '2026-02-31',
      endDay: 'not-a-date',
    }, day(0));
    expect(resolved.days).toBe(1);
  });
});

describe('buildPeriodUsageSummary', () => {
  test('aggregates current and previous windows by provider and day', () => {
    const summary = buildPeriodUsageSummary(
      [
        { dayKey: dayKeyFromMs(day(0)), providerId: 'anthropic', cost: 2, tokens: 1000, requests: 3 },
        { dayKey: dayKeyFromMs(day(-1)), providerId: 'openrouter', cost: 1, tokens: 500, requests: 1 },
        { dayKey: dayKeyFromMs(day(-7)), providerId: 'anthropic', cost: 4, tokens: 2000, requests: 2 },
      ],
      { period: { kind: 'days', days: 7 }, nowMs: day(0) },
    );

    expect(summary.days).toHaveLength(7);
    expect(summary.totals.cost).toBe(3);
    expect(summary.totals.tokens).toBe(1500);
    expect(summary.totals.requests).toBe(4);
    expect(summary.previousTotals.cost).toBe(4);
    expect(summary.byProvider[0]?.providerId).toBe('claude');
    expect(summary.byProvider[0]?.cost).toBe(2);
  });

  test('keeps custom plugin providers as their own series', () => {
    const summary = buildPeriodUsageSummary(
      [{ dayKey: dayKeyFromMs(day(0)), providerId: 'CodeCommander', cost: 5, tokens: 50, requests: 2 }],
      { period: { kind: 'days', days: 7 }, nowMs: day(0) },
    );
    expect(summary.byProvider[0]?.providerId).toBe('codecommander');
  });

  test('respects provider filters', () => {
    const summary = buildPeriodUsageSummary(
      [
        { dayKey: dayKeyFromMs(day(0)), providerId: 'anthropic', cost: 2, tokens: 100, requests: 1 },
        { dayKey: dayKeyFromMs(day(0)), providerId: 'openrouter', cost: 9, tokens: 900, requests: 1 },
      ],
      { period: { kind: 'days', days: 7 }, nowMs: day(0), providerFilter: 'claude' },
    );

    expect(summary.totals.cost).toBe(2);
    expect(summary.byProvider).toHaveLength(1);
  });

  test('aggregates custom date ranges across month boundaries', () => {
    const nowMs = new Date('2026-08-03T12:00:00').getTime();
    const summary = buildPeriodUsageSummary(
      [
        { dayKey: '2026-07-30', providerId: 'xai', cost: 1, tokens: 10, requests: 1 },
        { dayKey: '2026-08-01', providerId: 'xai', cost: 2, tokens: 20, requests: 1 },
        { dayKey: '2026-07-29', providerId: 'xai', cost: 99, tokens: 99, requests: 9 },
      ],
      { period: { kind: 'range', startDay: '2026-07-30', endDay: '2026-08-03' }, nowMs },
    );

    expect(summary.days).toHaveLength(5);
    expect(dayKeyFromMs(summary.rangeEndMs)).toBe('2026-08-03');
    expect(summary.totals.cost).toBe(3);
    // The day just before the range belongs to the previous comparison window.
    expect(summary.previousTotals.cost).toBe(99);
  });
});

describe('aggregateUsageRecords', () => {
  test('merges duplicate day/provider buckets and keeps first display name', () => {
    const { records, providerNames } = aggregateUsageRecords([
      { dayKey: '2026-08-01', providerId: 'OpenRouter', cost: 1, tokens: 5, requests: 1 },
      { dayKey: '2026-08-01', providerId: 'openrouter', cost: 2, tokens: 5, requests: 1 },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.providerId).toBe('openrouter');
    expect(records[0]?.cost).toBe(3);
    expect(records[0]?.requests).toBe(2);
    expect(providerNames.get('openrouter')).toBe('OpenRouter');
  });

  test('drops zero-value and invalid rows', () => {
    const { records } = aggregateUsageRecords([
      { dayKey: '2026-08-01', providerId: 'xai', cost: 0, tokens: 0, requests: 0 },
      { dayKey: 'bogus', providerId: 'xai', cost: 1, tokens: 1, requests: 1 },
      { dayKey: '2026-08-01', providerId: '', cost: 1, tokens: 1, requests: 1 },
    ]);
    expect(records).toHaveLength(0);
  });
});

describe('percentChange / averageCostPer1kTokens', () => {
  test('computes percent deltas and average cost', () => {
    expect(percentChange(12, 10)).toBe(20);
    expect(percentChange(5, 0)).toBeNull();
    expect(averageCostPer1kTokens(4.4, 1_000_000)).toBe(0.0044);
    expect(formatUsd(0.0044)).toBe('$0.0044');
  });
});
