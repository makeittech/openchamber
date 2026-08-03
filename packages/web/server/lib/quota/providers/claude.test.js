import { afterEach, describe, expect, it } from 'bun:test';
import {
  CLAUDE_CLI_TOKEN_URL,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_SCOPE_ERROR,
  CLAUDE_SESSION_EXPIRED_ERROR,
  CLAUDE_USAGE_URL,
  CLAUDE_USAGE_USER_AGENT,
  OPENCODE_CLAUDE_TOKEN_URL,
  __resetClaudeRefreshLockForTests,
  buildClaudeUsageHeaders,
  classifyClaudeUsageHttpError,
  ensureClaudeUsageAccessToken,
  extractClaudeOAuthCredentials,
  isClaudeAccessExpired,
  mapClaudeRateLimitHeaders,
  refreshClaudeOAuthToken,
  resolveClaudeUsageCredential,
  writeClaudeCliOAuthCredentials,
} from '@openchamber/quota-core';
// mapClaudeUsageWindows/shouldSkipClaudeUsageEndpoint are re-exported from
// claude.js (thin passthrough to @openchamber/quota-core) — imported here to
// confirm that re-export contract still holds for anything else importing
// them from this module.
import { mapClaudeUsageWindows, providerName, shouldSkipClaudeUsageEndpoint } from './claude.js';

describe('claude quota provider', () => {
  afterEach(() => {
    __resetClaudeRefreshLockForTests();
  });

  it('labels the provider as Claude subscription usage', () => {
    expect(providerName).toBe('Claude subscription');
  });

  it('maps Anthropic oauth usage windows without inventing data', () => {
    const windows = mapClaudeUsageWindows({
      five_hour: { utilization: 12.5, resets_at: '2026-07-25T12:00:00Z' },
      seven_day: { utilization: 40, resets_at: '2026-08-01T00:00:00Z' },
    });

    expect(windows['5h']?.usedPercent).toBe(12.5);
    expect(windows['7d']?.usedPercent).toBe(40);
    expect(windows['7d-sonnet']).toBeUndefined();
  });

  it('returns an empty window map for empty payloads', () => {
    expect(mapClaudeUsageWindows(null)).toEqual({});
    expect(mapClaudeUsageWindows({})).toEqual({});
  });

  it('treats access tokens as expired inside the refresh buffer', () => {
    const now = 1_000_000;
    expect(isClaudeAccessExpired(now + 30_000, now)).toBe(true);
    expect(isClaudeAccessExpired(now + 120_000, now)).toBe(false);
    expect(isClaudeAccessExpired(null, now)).toBe(false);
  });

  it('extracts refresh + expiry from Claude CLI credentials', () => {
    expect(extractClaudeOAuthCredentials({
      claudeAiOauth: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresAt: 1_700_000_000_000,
      },
    })).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 1_700_000_000_000,
      scopes: null,
    });
  });

  it('resolves OpenCode auth credentials for refresh', () => {
    const resolved = resolveClaudeUsageCredential({
      env: {},
      homeDir: '/missing-home',
      existsSync: () => false,
      readFile: () => '',
      readAuth: () => ({
        anthropic: {
          type: 'oauth',
          access: 'stale-access',
          refresh: 'refresh-token',
          expires: Date.now() - 60_000,
        },
      }),
    });

    expect(resolved).toMatchObject({
      accessToken: 'stale-access',
      refreshToken: 'refresh-token',
      source: 'opencode-auth',
      tokenUrl: OPENCODE_CLAUDE_TOKEN_URL,
      authKey: 'anthropic',
    });
  });

  it('refreshes via the OpenCode Anthropic OAuth contract', async () => {
    const calls = [];
    const result = await refreshClaudeOAuthToken({
      refreshToken: 'refresh-token',
      tokenUrl: OPENCODE_CLAUDE_TOKEN_URL,
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init?.body || '{}')) });
        return new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'rotated-refresh',
          expires_in: 3600,
        }), { status: 200 });
      },
    });

    expect(calls[0]?.url).toBe(OPENCODE_CLAUDE_TOKEN_URL);
    expect(calls[0]?.body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    });
    expect(result.accessToken).toBe('new-access');
    expect(result.refreshToken).toBe('rotated-refresh');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('refreshes expired OpenCode tokens and persists the rotation', async () => {
    const auth = {
      anthropic: {
        type: 'oauth',
        access: 'expired-access',
        refresh: 'refresh-token',
        expires: Date.now() - 60_000,
      },
    };
    let wrote = null;

    const access = await ensureClaudeUsageAccessToken({
      env: {},
      homeDir: '/missing-home',
      existsSync: () => false,
      readFile: () => '',
      readAuth: () => auth,
      writeAuth: (next) => {
        wrote = next;
        Object.assign(auth, next);
      },
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 7200,
      }), { status: 200 }),
    });

    expect(access).toMatchObject({
      accessToken: 'fresh-access',
      source: 'opencode-auth',
      canRefresh: true,
    });
    expect(wrote?.anthropic).toMatchObject({
      type: 'oauth',
      access: 'fresh-access',
      refresh: 'fresh-refresh',
    });
    expect(typeof wrote?.anthropic?.expires).toBe('number');
    expect(wrote.anthropic.expires).toBeGreaterThan(Date.now());
  });

  it('single-flights concurrent Claude refreshes', async () => {
    let refreshCalls = 0;
    const auth = {
      anthropic: {
        type: 'oauth',
        access: 'expired-access',
        refresh: 'refresh-token',
        expires: Date.now() - 60_000,
      },
    };

    const options = {
      env: {},
      homeDir: '/missing-home',
      existsSync: () => false,
      readFile: () => '',
      readAuth: () => auth,
      writeAuth: (next) => Object.assign(auth, next),
      fetchImpl: async () => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({
          access_token: 'shared-access',
          refresh_token: 'shared-refresh',
          expires_in: 3600,
        }), { status: 200 });
      },
    };

    const [first, second] = await Promise.all([
      ensureClaudeUsageAccessToken(options),
      ensureClaudeUsageAccessToken(options),
    ]);

    expect(refreshCalls).toBe(1);
    expect(first?.accessToken).toBe('shared-access');
    expect(second?.accessToken).toBe('shared-access');
  });

  it('writes refreshed Claude CLI credentials without dropping other fields', () => {
    const files = new Map([
      ['/tmp/creds.json', JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old',
          refreshToken: 'old-refresh',
          expiresAt: 1,
          scopes: ['user:inference'],
        },
        other: true,
      })],
    ]);

    writeClaudeCliOAuthCredentials('/tmp/creds.json', {
      accessToken: 'new',
      refreshToken: 'new-refresh',
      expiresAt: 99,
    }, {
      existsSync: (filePath) => files.has(filePath) || filePath.endsWith('.tmp'),
      readFile: (filePath) => files.get(filePath) || '',
      writeFile: (filePath, data) => {
        files.set(filePath, String(data));
      },
      renameSync: (from, to) => {
        files.set(to, files.get(from) || '');
        files.delete(from);
      },
      chmodSync: () => {},
    });

    const written = JSON.parse(files.get('/tmp/creds.json'));
    expect(written.other).toBe(true);
    expect(written.claudeAiOauth).toEqual({
      accessToken: 'new',
      refreshToken: 'new-refresh',
      expiresAt: 99,
      scopes: ['user:inference'],
    });
  });

  it('uses the Claude CLI token URL for CLI credential sources', () => {
    const resolved = resolveClaudeUsageCredential({
      env: {},
      homeDir: '/home/u',
      existsSync: (filePath) => filePath.endsWith('.claude/.credentials.json'),
      readFile: () => JSON.stringify({
        claudeAiOauth: {
          accessToken: 'cli-access',
          refreshToken: 'cli-refresh',
          expiresAt: Date.now() + 120_000,
        },
      }),
      readAuth: () => ({}),
    });

    expect(resolved).toMatchObject({
      source: 'claude-cli',
      tokenUrl: CLAUDE_CLI_TOKEN_URL,
      refreshToken: 'cli-refresh',
    });
  });

  it('prefers Claude CLI credentials over inference-only env setup tokens', () => {
    const resolved = resolveClaudeUsageCredential({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'env-setup-token' },
      homeDir: '/home/u',
      existsSync: (filePath) => filePath.endsWith('.claude/.credentials.json'),
      readFile: () => JSON.stringify({
        claudeAiOauth: {
          accessToken: 'cli-access',
          refreshToken: 'cli-refresh',
          expiresAt: Date.now() + 120_000,
          scopes: ['user:inference', 'user:profile'],
        },
      }),
      readAuth: () => ({}),
    });

    expect(resolved?.source).toBe('claude-cli');
    expect(resolved?.accessToken).toBe('cli-access');
  });

  it('builds Claude Code User-Agent headers required by the usage endpoint', () => {
    const headers = buildClaudeUsageHeaders('token');
    expect(headers['User-Agent']).toBe(CLAUDE_USAGE_USER_AGENT);
    expect(headers['User-Agent'].startsWith('claude-code/')).toBe(true);
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
  });

  it('maps unified rate-limit header ratios into usage windows', () => {
    const windows = mapClaudeRateLimitHeaders({
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
      'anthropic-ratelimit-unified-5h-reset': '1785149400',
      'anthropic-ratelimit-unified-7d-utilization': '0.02',
      'anthropic-ratelimit-unified-7d-reset': '1785430800',
    });

    expect(windows['5h']?.usedPercent).toBe(25);
    expect(windows['5h']?.windowSeconds).toBe(5 * 60 * 60);
    expect(windows['5h']?.resetAt).toBe(1785149400 * 1000);
    expect(windows['7d']?.usedPercent).toBe(2);
    expect(windows['7d']?.windowSeconds).toBe(7 * 24 * 60 * 60);
  });

  it('classifies scope and auth failures for UI panels', () => {
    expect(classifyClaudeUsageHttpError(403, 'OAuth token does not meet scope requirement user:profile'))
      .toBe(CLAUDE_SCOPE_ERROR);
    expect(classifyClaudeUsageHttpError(401)).toBe(CLAUDE_SESSION_EXPIRED_ERROR);
    expect(CLAUDE_USAGE_URL).toContain('/api/oauth/usage');
    expect(CLAUDE_SESSION_EXPIRED_ERROR).toContain('re-authenticate');
  });

  it('skips the usage endpoint for env setup-tokens and inference-only scopes', () => {
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
