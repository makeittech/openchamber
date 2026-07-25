import { describe, expect, it } from 'bun:test';
import { hasCursorCredentials, loadCursorAuthState } from './credentials.js';

describe('cursor credentials sanitize', () => {
  it('hasCursorCredentials returns boolean only (no secrets)', () => {
    const previous = {
      CURSOR_TOKEN: process.env.CURSOR_TOKEN,
      CURSOR_ACCESS_TOKEN: process.env.CURSOR_ACCESS_TOKEN,
      CURSOR_REFRESH_TOKEN: process.env.CURSOR_REFRESH_TOKEN,
      CURSOR_TOKEN_FILE: process.env.CURSOR_TOKEN_FILE,
      CURSOR_REFRESH_TOKEN_FILE: process.env.CURSOR_REFRESH_TOKEN_FILE,
    };

    delete process.env.CURSOR_TOKEN;
    delete process.env.CURSOR_ACCESS_TOKEN;
    delete process.env.CURSOR_REFRESH_TOKEN;
    delete process.env.CURSOR_TOKEN_FILE;
    delete process.env.CURSOR_REFRESH_TOKEN_FILE;

    try {
      const result = hasCursorCredentials();
      expect(typeof result).toBe('boolean');
      expect(JSON.stringify(result)).toMatch(/true|false/);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('loadCursorAuthState from env does not expose values via hasCursorCredentials', () => {
    const previous = process.env.CURSOR_ACCESS_TOKEN;
    process.env.CURSOR_ACCESS_TOKEN = 'secret-access-token-value';
    try {
      expect(hasCursorCredentials()).toBe(true);
      const state = loadCursorAuthState();
      expect(state.source).toBe('env');
      // Helper may hold the token internally; public detect path must not.
      expect(hasCursorCredentials()).not.toEqual(expect.objectContaining({
        accessToken: expect.anything(),
      }));
    } finally {
      if (previous === undefined) delete process.env.CURSOR_ACCESS_TOKEN;
      else process.env.CURSOR_ACCESS_TOKEN = previous;
    }
  });
});
