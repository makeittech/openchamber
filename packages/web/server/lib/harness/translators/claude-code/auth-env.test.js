import { describe, expect, it } from 'bun:test';
import {
  API_PRIORITY_ENV_KEYS,
  buildClaudeCodeChildEnv,
  hasApiPriorityCredential,
} from './auth-env.js';

describe('claude-code auth-env', () => {
  it('strips ANTHROPIC_API_KEY and preserves PATH', () => {
    const child = buildClaudeCodeChildEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-secret',
      ANTHROPIC_AUTH_TOKEN: 'token-secret',
      HOME: '/home/user',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-keep',
    });

    expect(child.PATH).toBe('/usr/bin');
    expect(child.HOME).toBe('/home/user');
    expect(child.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-keep');
    expect(child.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(API_PRIORITY_ENV_KEYS).toContain('ANTHROPIC_API_KEY');
  });

  it('does not mutate the source env object', () => {
    const source = { ANTHROPIC_API_KEY: 'sk-secret', PATH: '/bin' };
    buildClaudeCodeChildEnv(source);
    expect(source.ANTHROPIC_API_KEY).toBe('sk-secret');
  });

  it('detects API-priority credentials without logging values', () => {
    expect(hasApiPriorityCredential({ ANTHROPIC_API_KEY: 'x' })).toBe(true);
    expect(hasApiPriorityCredential({ PATH: '/bin' })).toBe(false);
  });
});
