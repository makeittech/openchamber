import { describe, expect, it } from 'bun:test';
import {
  detectClaudeCode,
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

  it('uses credentials / env token when auth status reports logged-out', () => {
    const result = probeClaudeLogin({
      probeAuthStatus: () => ({ loggedIn: false, detail: 'auth-status-logged-out' }),
      hasCredentials: () => true,
      env: {},
    });
    expect(result).toEqual({
      loggedIn: true,
      detail: 'credentials-oauth-present',
      authMethod: 'oauth_credentials_file',
    });
  });

  it('treats CLAUDE_CODE_OAUTH_TOKEN as subscription login', () => {
    const result = probeClaudeLogin({
      probeAuthStatus: () => null,
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
    });
    expect(result).toEqual({
      loggedIn: true,
      detail: 'env-oauth-token',
      authMethod: 'oauth_token_env',
    });
  });

  it('falls back to structured credentials when auth status probe fails', () => {
    const result = probeClaudeLogin({
      probeAuthStatus: () => null,
      hasCredentials: () => true,
      env: {},
    });
    expect(result).toEqual({
      loggedIn: true,
      detail: 'credentials-oauth-present',
      authMethod: 'oauth_credentials_file',
    });
  });
});
