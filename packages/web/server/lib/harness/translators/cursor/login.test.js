import { afterEach, describe, expect, it } from 'bun:test';
import { pollLogin, resetPendingLogins, startLogin } from './login.js';

afterEach(() => {
  resetPendingLogins();
});

describe('cursor login', () => {
  it('startLogin returns loginId and loginUrl without verifier', async () => {
    const result = await startLogin();
    expect(typeof result.loginId).toBe('string');
    expect(result.loginId.length).toBeGreaterThan(0);
    expect(result.loginUrl).toMatch(/^https:\/\/cursor\.com\/loginDeepControl\?/);
    expect(result).not.toHaveProperty('verifier');
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(result)).not.toMatch(/verifier|accessToken|refreshToken/);
  });

  it('pollLogin reports error for unknown loginId without secrets', async () => {
    const result = await pollLogin('missing-id');
    expect(result.status).toBe('error');
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('verifier');
  });
});
