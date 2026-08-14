import { describe, expect, test } from 'bun:test';
import {
  collectConnectedQuotaProviderIds,
  isQuotaProviderId,
  resolveQuotaProviderId,
  resolveUsageProviderId,
} from './providerAliases';

describe('resolveQuotaProviderId', () => {
  test('maps OpenCode provider aliases onto quota IDs', () => {
    expect(resolveQuotaProviderId('google')).toBe('google');
    expect(resolveQuotaProviderId('github-copilot')).toBe('github-copilot');
    expect(resolveQuotaProviderId('anthropic')).toBe('claude');
    expect(resolveQuotaProviderId('gemini')).toBe('google');
  });

  test('returns null for OpenCode Zen (no quota provider)', () => {
    expect(resolveQuotaProviderId('opencode')).toBeNull();
  });
});

describe('resolveUsageProviderId', () => {
  test('keeps custom and plugin providers while canonicalizing known aliases', () => {
    expect(resolveUsageProviderId(' Anthropic ')).toBe('claude');
    expect(resolveUsageProviderId('CodeCommander')).toBe('codecommander');
    expect(resolveUsageProviderId('')).toBeNull();
  });

  test('identifies only providers supported by the quota API', () => {
    expect(isQuotaProviderId('openrouter')).toBe(true);
    expect(isQuotaProviderId('codecommander')).toBe(false);
  });
});

describe('collectConnectedQuotaProviderIds', () => {
  test('collects unique mapped quota IDs from OpenCode provider list', () => {
    expect(collectConnectedQuotaProviderIds(['google', 'github-copilot', 'opencode', 'google']))
      .toEqual(new Set(['google', 'github-copilot']));
  });
});
