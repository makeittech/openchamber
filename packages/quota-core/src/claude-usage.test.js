import { describe, expect, it } from 'bun:test';
import { mapClaudeUsageWindows, shouldSkipClaudeUsageEndpoint } from './claude-usage.js';

describe('claude-usage', () => {
  it('maps Anthropic oauth usage windows without inventing data', () => {
    const windows = mapClaudeUsageWindows({
      five_hour: { utilization: 12.5, resets_at: '2026-07-25T12:00:00Z' },
      seven_day: { utilization: 40, resets_at: '2026-08-01T00:00:00Z' },
    });

    expect(windows['5h']?.usedPercent).toBe(12.5);
    expect(windows['7d']?.usedPercent).toBe(40);
    expect(windows['7d-sonnet']).toBeUndefined();
  });

  it('maps sonnet/opus 7-day windows when present', () => {
    const windows = mapClaudeUsageWindows({
      seven_day_sonnet: { utilization: 10, resets_at: '2026-08-01T00:00:00Z' },
      seven_day_opus: { utilization: 90, resets_at: '2026-08-01T00:00:00Z' },
    });

    expect(windows['7d-sonnet']?.usedPercent).toBe(10);
    expect(windows['7d-opus']?.usedPercent).toBe(90);
  });

  it('returns an empty window map for empty payloads', () => {
    expect(mapClaudeUsageWindows(null)).toEqual({});
    expect(mapClaudeUsageWindows({})).toEqual({});
  });

  it('skips the usage endpoint for env setup-tokens and inference-only scopes', () => {
    expect(shouldSkipClaudeUsageEndpoint(null)).toBe(true);
    expect(shouldSkipClaudeUsageEndpoint({ source: 'env', scopes: null })).toBe(true);
    expect(shouldSkipClaudeUsageEndpoint({
      source: 'claude-cli',
      scopes: ['user:inference'],
    })).toBe(true);
    expect(shouldSkipClaudeUsageEndpoint({
      source: 'claude-cli',
      scopes: ['user:inference', 'user:profile'],
    })).toBe(false);
  });
});
