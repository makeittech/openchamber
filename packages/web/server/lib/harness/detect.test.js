import { describe, expect, it } from 'bun:test';
import {
  detectClaudeCode,
  detectCursor,
  detectHarness,
  detectOpenCode,
  interpretClaudeAuthStatus,
  probeClaudeAuthStatusCli,
  probeClaudeLogin,
} from './detect.js';

describe('harness detect', () => {
  it('reports missing-cli when claude binary is absent', async () => {
    const result = await detectClaudeCode({
      findClaudeBinary: () => null,
      probeSdk: async () => ({ available: true }),
      probeLogin: () => ({ loggedIn: true }),
    });

    expect(result.status).toBe('missing-cli');
    expect(result.sections).toEqual([]);
    expect(result.statusDetail).toMatch(/not found/i);
  });

  it('does not return ready with empty sections on SDK failure', async () => {
    const result = await detectClaudeCode({
      findClaudeBinary: () => '/usr/bin/claude',
      probeSdk: async () => ({ available: false, error: 'import failed' }),
      probeLogin: () => ({ loggedIn: true }),
    });

    expect(result.status).toBe('error');
    expect(result.sections).toEqual([]);
    expect(result.status).not.toBe('ready');
  });

  it('reports needs-login when credentials are absent', async () => {
    const result = await detectClaudeCode({
      findClaudeBinary: () => '/usr/bin/claude',
      probeSdk: async () => ({ available: true }),
      probeLogin: () => ({ loggedIn: false, detail: 'no-credentials-file' }),
    });

    expect(result.status).toBe('needs-login');
    expect(result.sections[0]?.models?.length).toBeGreaterThan(0);
  });

  it('reports needs-login for API-key-only auth status', async () => {
    const result = await detectClaudeCode({
      findClaudeBinary: () => '/usr/bin/claude',
      probeSdk: async () => ({ available: true }),
      probeLogin: () => ({ loggedIn: false, detail: 'api-key-only', authMethod: 'api_key' }),
    });

    expect(result.status).toBe('needs-login');
    expect(result.statusDetail).toMatch(/subscription/i);
  });

  it('returns ready only when binary, SDK, and login succeed', async () => {
    const result = await detectClaudeCode({
      findClaudeBinary: () => '/usr/bin/claude',
      probeSdk: async () => ({ available: true }),
      probeLogin: () => ({ loggedIn: true }),
    });

    expect(result.status).toBe('ready');
    expect(result.sections[0]?.models?.length).toBeGreaterThan(0);
  });

  it('detects OpenCode ready/error without empty-ready masquerade', () => {
    expect(detectOpenCode({ openCodeReady: true }).status).toBe('ready');
    expect(detectOpenCode({ openCodeReady: false }).status).toBe('error');
  });

  it('returns null for unknown harness ids', async () => {
    expect(await detectHarness('nope')).toBeNull();
  });
});

describe('detectCursor', () => {
  it('reports needs-login when credentials are absent (with fallback catalog)', async () => {
    const result = await detectCursor({
      hasCredentials: () => false,
      resolveAccessToken: async () => null,
    });
    expect(result.status).toBe('needs-login');
    expect(result.sections[0]?.models?.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/accessToken|refreshToken|Bearer /i);
  });

  it('never returns ready with empty sections', async () => {
    const result = await detectCursor({
      hasCredentials: () => true,
      resolveAccessToken: async () => 'token',
      fetchModels: async () => [],
    });
    // Empty discovery falls back to FALLBACK_MODELS → ready with catalog,
    // unless fallback somehow empty. Force empty via patched path:
    expect(result.status === 'ready' ? result.sections[0]?.models?.length > 0 : true).toBe(true);
    if (result.status === 'ready') {
      expect(result.sections.length).toBeGreaterThan(0);
      expect(result.sections[0].models.length).toBeGreaterThan(0);
    }
  });

  it('returns ready with sanitized model catalog and no secrets', async () => {
    const result = await detectCursor({
      hasCredentials: () => true,
      resolveAccessToken: async () => 'secret-access-token',
      fetchModels: async () => ([
        { id: 'composer-1.5', name: 'Composer 1.5', reasoning: true },
      ]),
    });
    expect(result.status).toBe('ready');
    expect(result.sections[0].models[0].id).toBe('composer-1.5');
    expect(JSON.stringify(result)).not.toContain('secret-access-token');
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('reports needs-login when access token cannot be resolved', async () => {
    const result = await detectCursor({
      hasCredentials: () => true,
      resolveAccessToken: async () => null,
    });
    expect(result.status).toBe('needs-login');
    expect(result.sections[0]?.models?.length).toBeGreaterThan(0);
  });

  it('reports error without ready+empty masquerade on throw', async () => {
    const result = await detectCursor({
      hasCredentials: () => {
        throw new Error('boom');
      },
    });
    expect(result.status).toBe('error');
    expect(result.sections).toEqual([]);
    expect(result.status).not.toBe('ready');
  });
});

describe('interpretClaudeAuthStatus', () => {
  it('rejects logged-out and API-key-only payloads', () => {
    expect(interpretClaudeAuthStatus({ loggedIn: false, authMethod: 'none' })).toEqual({
      loggedIn: false,
      detail: 'auth-status-logged-out',
      authMethod: 'none',
    });
    expect(interpretClaudeAuthStatus({ loggedIn: true, authMethod: 'api_key' }).loggedIn).toBe(false);
    expect(interpretClaudeAuthStatus({ loggedIn: true, authMethod: 'api_key' }).detail).toBe('api-key-only');
  });

  it('accepts oauth_token and other oauth-like methods', () => {
    expect(interpretClaudeAuthStatus({ loggedIn: true, authMethod: 'oauth_token' })).toMatchObject({
      loggedIn: true,
      detail: 'auth-status-oauth',
    });
  });
});

describe('probeClaudeAuthStatusCli / probeClaudeLogin', () => {
  it('parses JSON stdout from claude auth status', () => {
    const result = probeClaudeAuthStatusCli({
      binaryPath: '/usr/bin/claude',
      spawnSyncFn: () => ({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }),
        stderr: '',
        status: 0,
      }),
    });
    expect(result?.loggedIn).toBe(true);
    expect(result?.detail).toBe('auth-status-oauth');
  });

  it('prefers auth status over credentials fallback', () => {
    const result = probeClaudeLogin({
      probeAuthStatus: () => ({ loggedIn: false, detail: 'auth-status-logged-out' }),
      hasCredentials: () => true,
    });
    expect(result.loggedIn).toBe(false);
    expect(result.detail).toBe('auth-status-logged-out');
  });

  it('falls back to structured credentials when auth status probe fails', () => {
    const result = probeClaudeLogin({
      probeAuthStatus: () => null,
      hasCredentials: () => true,
    });
    expect(result).toEqual({ loggedIn: true, detail: 'credentials-oauth-present' });
  });
});
