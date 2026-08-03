import { describe, expect, test } from 'bun:test';
import {
  deriveProviderAuthView,
  normalizeAuthType,
  oauthMethodEntries,
  type ProviderAuthMethod,
} from './providerAuth';

const CURSOR_METHODS: ProviderAuthMethod[] = [{ type: 'oauth', label: 'Login with Cursor' }];
const API_METHODS: ProviderAuthMethod[] = [{ type: 'api', label: 'API Key' }];
const MIXED_METHODS: ProviderAuthMethod[] = [
  { type: 'api', label: 'API Key' },
  { type: 'oauth', label: 'Sign in' },
];

const view = (
  methods: ProviderAuthMethod[],
  overrides: { credentialsResolved?: boolean; hasStoredCredentials?: boolean } = {},
) =>
  deriveProviderAuthView({
    methods,
    credentialsResolved: overrides.credentialsResolved ?? true,
    hasStoredCredentials: overrides.hasStoredCredentials ?? false,
  });

describe('normalizeAuthType', () => {
  test('classifies by type first, then by name or label', () => {
    expect(normalizeAuthType({ type: 'oauth' })).toBe('oauth');
    expect(normalizeAuthType({ type: 'api' })).toBe('api');
    expect(normalizeAuthType({ label: 'OAuth login' })).toBe('oauth');
    expect(normalizeAuthType({ name: 'API Key' })).toBe('api');
    expect(normalizeAuthType({ label: 'Login with Cursor' })).toBe('');
  });
});

describe('oauthMethodEntries', () => {
  test('keeps the index that oauth.authorize addresses', () => {
    expect(oauthMethodEntries(MIXED_METHODS)).toEqual([{ index: 1, method: MIXED_METHODS[1] }]);
    expect(oauthMethodEntries(API_METHODS)).toEqual([]);
  });
});

describe('deriveProviderAuthView', () => {
  test('OAuth-only provider without credentials shows sign-in instead of an API key', () => {
    const result = view(CURSOR_METHODS);

    expect(result.showApiKeyField).toBe(false);
    expect(result.signInRequired).toBe(true);
    expect(result.autoOpenPanel).toBe(true);
    expect(result.autoStartMethodIndex).toBe(0);
    expect(result.oauthEntries).toHaveLength(1);
  });

  test('OAuth-only provider with stored credentials keeps the connected summary', () => {
    const result = view(CURSOR_METHODS, { hasStoredCredentials: true });

    expect(result.showApiKeyField).toBe(false);
    expect(result.signInRequired).toBe(false);
    expect(result.autoOpenPanel).toBe(false);
    expect(result.autoStartMethodIndex).toBeNull();
  });

  test('unresolved provenance never claims a missing credential', () => {
    const result = view(CURSOR_METHODS, { credentialsResolved: false });

    expect(result.signInRequired).toBe(false);
    expect(result.autoOpenPanel).toBe(false);
    expect(result.autoStartMethodIndex).toBeNull();
  });

  test('api-only provider keeps the key field and no OAuth behavior', () => {
    const result = view(API_METHODS);

    expect(result.showApiKeyField).toBe(true);
    expect(result.oauthEntries).toEqual([]);
    expect(result.signInRequired).toBe(false);
    expect(result.autoOpenPanel).toBe(false);
    expect(result.autoStartMethodIndex).toBeNull();
  });

  test('provider offering both paths keeps the key field and does not auto-open', () => {
    const result = view(MIXED_METHODS);

    expect(result.showApiKeyField).toBe(true);
    expect(result.oauthEntries).toHaveLength(1);
    expect(result.oauthEntries[0]?.index).toBe(1);
    expect(result.signInRequired).toBe(false);
    expect(result.autoOpenPanel).toBe(false);
    expect(result.autoStartMethodIndex).toBeNull();
  });

  test('unknown methods keep the API key field available', () => {
    const result = view([]);

    expect(result.showApiKeyField).toBe(true);
    expect(result.oauthEntries).toEqual([]);
    expect(result.signInRequired).toBe(false);
  });
});
