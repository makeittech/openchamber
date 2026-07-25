/**
 * Cursor engine credentials — managed store + env, no secrets in return values
 * from hasCursorCredentials / detect paths.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  readManagedCredential,
  writeManagedCredential,
} from '../../../quota/credentials/providers.js';
import {
  getTokenExpiry,
  refreshCursorToken,
  RefreshTokenInvalidError,
} from './auth.js';

const PROVIDER_ID = 'cursor';
const OAUTH_TOKEN_URL = 'https://api2.cursor.sh/oauth/token';
const OAUTH_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * @param {string | null | undefined} path
 * @returns {string | null}
 */
function readFileToken(path) {
  try {
    if (!path || !existsSync(path)) return null;
    const content = readFileSync(path, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Load auth material without logging values.
 * @returns {{ accessToken: string | null, refreshToken: string | null, source: string }}
 */
export function loadCursorAuthState() {
  const envAccessToken = process.env.CURSOR_TOKEN || process.env.CURSOR_ACCESS_TOKEN || null;
  const envRefreshToken = process.env.CURSOR_REFRESH_TOKEN || null;
  if (envAccessToken || envRefreshToken) {
    return {
      accessToken: envAccessToken,
      refreshToken: envRefreshToken,
      source: 'env',
    };
  }

  const fileAccessToken = readFileToken(process.env.CURSOR_TOKEN_FILE || null);
  const fileRefreshToken = readFileToken(process.env.CURSOR_REFRESH_TOKEN_FILE || null);
  if (fileAccessToken || fileRefreshToken) {
    return {
      accessToken: fileAccessToken,
      refreshToken: fileRefreshToken,
      source: 'file',
    };
  }

  const managed = readManagedCredential(PROVIDER_ID);
  return {
    accessToken: managed?.accessToken || null,
    refreshToken: managed?.refreshToken || null,
    source: 'managed',
  };
}

/**
 * True when any Cursor credential material is present (no secret values).
 * @returns {boolean}
 */
export function hasCursorCredentials() {
  const auth = loadCursorAuthState();
  return Boolean(auth.accessToken || auth.refreshToken);
}

/**
 * @param {string | null} token
 * @returns {boolean}
 */
function tokenNeedsRefresh(token) {
  if (!token) return true;
  const expiresAt = getTokenExpiry(token);
  // getTokenExpiry already subtracts 5 minutes; compare to now with small buffer.
  return expiresAt - Date.now() <= REFRESH_BUFFER_MS;
}

/**
 * Fallback OAuth token refresh (quota path).
 * @param {string} refreshToken
 * @returns {Promise<string | null>}
 */
async function refreshViaOauthToken(refreshToken) {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token) {
    return null;
  }
  return body.access_token;
}

/**
 * Persist credentials to the managed store (never logs values).
 * @param {{ accessToken?: string, refreshToken?: string }} creds
 */
export async function persistCursorCredentials(creds = {}) {
  const accessToken = typeof creds.accessToken === 'string' ? creds.accessToken : '';
  const refreshToken = typeof creds.refreshToken === 'string' ? creds.refreshToken : '';
  if (!accessToken && !refreshToken) {
    throw new Error('Cursor credentials require an access or refresh token');
  }
  return writeManagedCredential(PROVIDER_ID, { accessToken, refreshToken });
}

/**
 * Resolve a usable access token, refreshing when needed.
 * Prefers exchange_user_api_key; falls back to oauth/token.
 *
 * @returns {Promise<string | null>}
 */
export async function resolveCursorAccessToken() {
  const auth = loadCursorAuthState();
  if (!auth.accessToken && !auth.refreshToken) return null;

  if (!tokenNeedsRefresh(auth.accessToken)) {
    return auth.accessToken;
  }

  if (!auth.refreshToken) {
    return auth.accessToken || null;
  }

  try {
    const refreshed = await refreshCursorToken(auth.refreshToken);
    if (auth.source === 'managed') {
      await persistCursorCredentials({
        accessToken: refreshed.access,
        refreshToken: refreshed.refresh,
      });
    }
    return refreshed.access;
  } catch (error) {
    if (error instanceof RefreshTokenInvalidError) {
      // Try oauth/token once before giving up.
      const oauthAccess = await refreshViaOauthToken(auth.refreshToken).catch(() => null);
      if (oauthAccess) {
        if (auth.source === 'managed') {
          await persistCursorCredentials({
            accessToken: oauthAccess,
            refreshToken: auth.refreshToken,
          });
        }
        return oauthAccess;
      }
      return null;
    }

    const oauthAccess = await refreshViaOauthToken(auth.refreshToken).catch(() => null);
    if (oauthAccess) {
      if (auth.source === 'managed') {
        await persistCursorCredentials({
          accessToken: oauthAccess,
          refreshToken: auth.refreshToken,
        });
      }
      return oauthAccess;
    }

    // Transient failure: return existing access if still present.
    return auth.accessToken || null;
  }
}
