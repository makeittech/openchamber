import { describe, expect, it } from 'bun:test';
import {
  detectClaudeCode,
  detectHarness,
  detectOpenCode,
  interpretClaudeAuthStatus,
  probeClaudeAuthStatusCli,
  probeClaudeLogin,
} from './detect.js';

const detect = (options = {}) => detectClaudeCode({
  findClaudeBinary: () => '/usr/bin/claude',
  probeSdk: async () => ({ available: true }),
  probeLogin: () => ({ loggedIn: true }),
  ...options,
});

describe('harness detect', () => {
  const cases = [
    {
      name: 'reports a missing CLI',
      options: { findClaudeBinary: () => null },
      status: 'missing-cli',
      sections: 0,
      detail: /not found/i,
    },
    {
      name: 'reports SDK load failures without a ready catalog',
      options: { probeSdk: async () => ({ available: false, error: 'import failed' }) },
      status: 'error',
      sections: 0,
    },
    {
      name: 'requires login when credentials are absent',
      options: { probeLogin: () => ({ loggedIn: false, detail: 'no-credentials-file' }) },
      status: 'needs-login',
      sections: 1,
    },
    {
      name: 'requires subscription login for API-key auth',
      options: { probeLogin: () => ({ loggedIn: false, detail: 'api-key-only', authMethod: 'api_key' }) },
      status: 'needs-login',
      sections: 1,
      detail: /subscription/i,
    },
    { name: 'is ready when every probe succeeds', options: {}, status: 'ready', sections: 1 },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const result = await detect(testCase.options);
      expect(result.status).toBe(testCase.status);
      expect(result.sections).toHaveLength(testCase.sections);
      if (testCase.sections) expect(result.sections[0].models.length).toBeGreaterThan(0);
      if (testCase.detail) expect(result.statusDetail).toMatch(testCase.detail);
    });
  }

  it('reports OpenCode lifecycle state and rejects unknown harnesses', async () => {
    expect(detectOpenCode({ openCodeReady: true }).status).toBe('ready');
    expect(detectOpenCode({ openCodeReady: false }).status).toBe('error');
    expect(await detectHarness('nope')).toBeNull();
  });
});

describe('Claude login probes', () => {
  const authCases = [
    [{ loggedIn: false, authMethod: 'none' }, false, 'auth-status-logged-out'],
    [{ loggedIn: true, authMethod: 'api_key' }, false, 'api-key-only'],
    [{ loggedIn: true, authMethod: 'oauth_token' }, true, 'auth-status-oauth'],
  ];
  for (const [payload, loggedIn, detail] of authCases) {
    it(`interprets ${payload.authMethod}`, () => {
      expect(interpretClaudeAuthStatus(payload)).toMatchObject({ loggedIn, detail });
    });
  }

  it('parses auth status JSON from the CLI', () => {
    expect(probeClaudeAuthStatusCli({
      binaryPath: '/usr/bin/claude',
      spawnSyncFn: () => ({
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token' }),
        stderr: '',
        status: 0,
      }),
    })).toMatchObject({ loggedIn: true, detail: 'auth-status-oauth' });
  });

  const credentialCases = [
    {
      name: 'credentials file after logged-out status',
      options: { probeAuthStatus: () => ({ loggedIn: false }), hasCredentials: () => true, env: {} },
      detail: 'credentials-oauth-present',
      authMethod: 'oauth_credentials_file',
    },
    {
      name: 'environment OAuth token',
      options: { probeAuthStatus: () => null, env: { CLAUDE_CODE_OAUTH_TOKEN: 'token' } },
      detail: 'env-oauth-token',
      authMethod: 'oauth_token_env',
    },
    {
      name: 'credentials file after unavailable status',
      options: { probeAuthStatus: () => null, hasCredentials: () => true, env: {} },
      detail: 'credentials-oauth-present',
      authMethod: 'oauth_credentials_file',
    },
  ];
  for (const testCase of credentialCases) {
    it(`accepts ${testCase.name}`, () => {
      expect(probeClaudeLogin(testCase.options)).toEqual({
        loggedIn: true,
        detail: testCase.detail,
        authMethod: testCase.authMethod,
      });
    });
  }
});
