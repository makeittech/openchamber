import { describe, expect, it } from 'bun:test';
import { looksLikeJwt, refreshCursorToken, RefreshTokenInvalidError } from './auth.js';

describe('looksLikeJwt', () => {
  it('accepts three non-empty segments', () => {
    expect(looksLikeJwt('aaa.bbb.ccc')).toBe(true);
    expect(looksLikeJwt('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe(true);
  });

  it('rejects opaque API keys and incomplete values', () => {
    expect(looksLikeJwt('key_abc123')).toBe(false);
    expect(looksLikeJwt('a.b')).toBe(false);
    expect(looksLikeJwt('a..c')).toBe(false);
    expect(looksLikeJwt('')).toBe(false);
    expect(looksLikeJwt(null)).toBe(false);
    expect(looksLikeJwt(undefined)).toBe(false);
  });
});

describe('refreshCursorToken JWT clobber protection', () => {
  it('keeps the original refresh JWT when response refreshToken is opaque', async () => {
    const originalRefresh = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig';
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => /** @type {Response} */ ({
      ok: true,
      status: 200,
      async json() {
        return {
          accessToken: 'opaque-api-key-not-a-jwt',
          refreshToken: 'opaque-api-key-not-a-jwt',
        };
      },
      async text() {
        return '';
      },
    });

    try {
      const result = await refreshCursorToken(originalRefresh);
      expect(result.access).toBe('opaque-api-key-not-a-jwt');
      expect(result.refresh).toBe(originalRefresh);
      expect(looksLikeJwt(result.refresh)).toBe(true);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('adopts a JWT refreshToken when Cursor returns one', async () => {
    const originalRefresh = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.old';
    const nextRefresh = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.new';
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => /** @type {Response} */ ({
      ok: true,
      status: 200,
      async json() {
        return {
          accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.access',
          refreshToken: nextRefresh,
        };
      },
      async text() {
        return '';
      },
    });

    try {
      const result = await refreshCursorToken(originalRefresh);
      expect(result.refresh).toBe(nextRefresh);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('throws RefreshTokenInvalidError on permanent 4xx', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => /** @type {Response} */ ({
      ok: false,
      status: 401,
      async text() {
        return 'unauthorized';
      },
      async json() {
        return null;
      },
    });

    try {
      await expect(refreshCursorToken('eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.sig'))
        .rejects
        .toBeInstanceOf(RefreshTokenInvalidError);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
