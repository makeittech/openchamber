import { describe, expect, it } from 'bun:test';
import { toNumber, toTimestamp, toUsageWindow } from './utils.js';

describe('quota-core utils', () => {
  it('coerces numeric strings and rejects non-numbers', () => {
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber(7)).toBe(7);
    expect(toNumber('nope')).toBeNull();
    expect(toNumber(null)).toBeNull();
  });

  it('normalizes epoch seconds vs milliseconds and ISO strings', () => {
    expect(toTimestamp(1785149400)).toBe(1785149400 * 1000);
    expect(toTimestamp(1785149400 * 1000)).toBe(1785149400 * 1000);
    expect(toTimestamp('2026-08-01T00:00:00Z')).toBe(Date.parse('2026-08-01T00:00:00Z'));
    expect(toTimestamp(null)).toBeNull();
    expect(toTimestamp('not a date')).toBeNull();
  });

  it('derives remainingPercent and resetAfterSeconds from a usage window', () => {
    const resetAt = Date.now() + 60_000;
    const window = toUsageWindow({ usedPercent: 25, windowSeconds: 3600, resetAt });
    expect(window.usedPercent).toBe(25);
    expect(window.remainingPercent).toBe(75);
    expect(window.windowSeconds).toBe(3600);
    expect(window.resetAt).toBe(resetAt);
    expect(window.resetAfterSeconds).toBeGreaterThanOrEqual(0);
    expect(window.resetAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('never lets resetAfterSeconds go negative for a past reset time', () => {
    const window = toUsageWindow({ usedPercent: 0, windowSeconds: null, resetAt: Date.now() - 60_000 });
    expect(window.resetAfterSeconds).toBe(0);
  });

  it('omits remainingPercent when usedPercent is not finite', () => {
    const window = toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null });
    expect(window.remainingPercent).toBeNull();
    expect(window.resetAt).toBeNull();
    expect(window.resetAfterSeconds).toBeNull();
  });

  it('carries an optional valueLabel through untouched', () => {
    const window = toUsageWindow({ usedPercent: null, windowSeconds: null, resetAt: null, valueLabel: '$1.23 left' });
    expect(window.valueLabel).toBe('$1.23 left');
  });
});
