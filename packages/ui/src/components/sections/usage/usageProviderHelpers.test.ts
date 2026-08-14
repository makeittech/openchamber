import { describe, expect, test } from 'bun:test';
import type { ProviderResult } from '@/types';
import {
  buildUsageProviderCatalog,
  getProviderRemainingDisplay,
  getProviderUsedPercent,
  isIncludedUsageProvider,
} from './usageProviderHelpers';

describe('buildUsageProviderCatalog', () => {
  test('includes plugin providers and merges known aliases', () => {
    expect(buildUsageProviderCatalog({
      configProviders: [
        { id: 'codecommander', name: 'Configured CodeCommander' },
        { id: 'anthropic', name: 'Anthropic' },
        { id: 'openrouter', name: 'OpenRouter API' },
      ],
      quotaResults: [],
      usageProviderNames: new Map([['codecommander', 'Historical CodeCommander'], ['claude', 'Claude']]),
    })).toEqual([
      { id: 'codecommander', name: 'Configured CodeCommander', quotaProviderId: null, connected: true },
      { id: 'claude', name: 'Claude', quotaProviderId: 'claude', connected: true },
      { id: 'openrouter', name: 'OpenRouter', quotaProviderId: 'openrouter', connected: true },
    ]);
  });

  test('retains historical providers that are no longer connected', () => {
    expect(buildUsageProviderCatalog({
      configProviders: [],
      quotaResults: [],
      usageProviderNames: new Map([['former-plugin', 'former-plugin']]),
    })).toEqual([
      { id: 'former-plugin', name: 'former-plugin', quotaProviderId: null, connected: false },
    ]);
  });
});

describe('isIncludedUsageProvider', () => {
  test('includes quota-configured providers', () => {
    expect(isIncludedUsageProvider('claude', { configured: true })).toBe(true);
  });

  test('includes OpenCode-connected providers mapped to quota IDs', () => {
    expect(isIncludedUsageProvider('google', {
      configured: false,
      connectedQuotaProviderIds: new Set(['google', 'github-copilot']),
    })).toBe(true);
  });

  test('excludes providers that are neither configured nor connected', () => {
    expect(isIncludedUsageProvider('claude', {
      configured: false,
      connectedQuotaProviderIds: new Set(['google']),
    })).toBe(false);
  });
});

describe('getProviderRemainingDisplay', () => {
  const usage = (
    windows: NonNullable<ProviderResult['usage']>['windows'],
  ): ProviderResult['usage'] => ({ windows });

  test('prefers remaining percent when available', () => {
    expect(getProviderRemainingDisplay(usage({
      '5h': {
        usedPercent: 40,
        remainingPercent: 60,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: '$12.00',
      },
    }))).toEqual({ kind: 'percent', percent: 60 });
  });

  test('falls back to cost valueLabel when percent is unavailable', () => {
    expect(getProviderRemainingDisplay(usage({
      credits: {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: '$12.35',
      },
    }))).toEqual({ kind: 'amount', label: '$12.35' });
  });

  test('uses authoritative remaining percent when used percent is unavailable', () => {
    const remainingOnly = usage({
      credits: {
        usedPercent: null,
        remainingPercent: 42,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: null,
      },
    });
    expect(getProviderRemainingDisplay(remainingOnly)).toEqual({ kind: 'percent', percent: 42 });
    expect(getProviderUsedPercent(remainingOnly)).toBe(58);
  });

  test('prefers credits_balance window for cost remaining', () => {
    expect(getProviderRemainingDisplay(usage({
      other: {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: 'ignore',
      },
      credits_balance: {
        usedPercent: null,
        remainingPercent: null,
        windowSeconds: null,
        resetAfterSeconds: null,
        resetAt: null,
        resetAtFormatted: null,
        resetAfterFormatted: null,
        valueLabel: '$32.68',
      },
    }))).toEqual({ kind: 'amount', label: '$32.68' });
  });

  test('returns null when neither percent nor valueLabel exists', () => {
    expect(getProviderRemainingDisplay(usage({}))).toBeNull();
    expect(getProviderRemainingDisplay(null)).toBeNull();
  });
});
