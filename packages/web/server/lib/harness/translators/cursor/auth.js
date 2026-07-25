/**
 * Cursor OAuth (PKCE loginDeepControl + token refresh).
 * Never log tokens, verifiers, or Authorization headers.
 */

import { generatePKCE } from './pkce.js';

const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl';
const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll';
const CURSOR_REFRESH_URL = process.env.CURSOR_REFRESH_URL
  ?? 'https://api2.cursor.sh/auth/exchange_user_api_key';

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10_000;
const POLL_BACKOFF_MULTIPLIER = 1.2;
const POLL_REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_REQUEST_TIMEOUT_MS = 30_000;

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @returns {Promise<{ verifier: string, challenge: string, uuid: string, loginUrl: string }>}
 */
export async function generateCursorAuthParams() {
  const { verifier, challenge } = await generatePKCE();
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'cli',
  });
  return {
    verifier,
    challenge,
    uuid,
    loginUrl: `${CURSOR_LOGIN_URL}?${params.toString()}`,
  };
}

/**
 * Single poll attempt. Returns null while pending (HTTP 404).
 *
 * @param {string} uuid
 * @param {string} verifier
 * @returns {Promise<{ accessToken: string, refreshToken: string } | null>}
 */
export async function pollCursorAuthOnce(uuid, verifier) {
  const response = await fetch(
    `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
    { signal: AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS) },
  );

  if (response.status === 404) return null;

  if (response.ok) {
    const data = await response.json();
    if (typeof data?.accessToken !== 'string' || !data.accessToken) {
      throw new Error('Cursor poll response missing access token');
    }
    return {
      accessToken: data.accessToken,
      refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : '',
    };
  }

  throw new Error(`Poll failed: ${response.status}`);
}

/**
 * Block until Cursor login completes or times out.
 *
 * @param {string} uuid
 * @param {string} verifier
 * @returns {Promise<{ accessToken: string, refreshToken: string }>}
 */
export async function pollCursorAuth(uuid, verifier) {
  let delay = POLL_BASE_DELAY;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay);
    try {
      const result = await pollCursorAuthOnce(uuid, verifier);
      if (!result) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
        continue;
      }
      return result;
    } catch {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        throw new Error('Too many consecutive errors during Cursor auth polling');
      }
    }
  }

  throw new Error('Cursor authentication polling timeout');
}

/**
 * Cursor refused the refresh token (permanent 4xx).
 */
export class RefreshTokenInvalidError extends Error {
  /**
   * @param {number} status
   * @param {string} body
   */
  constructor(status, body) {
    super(`Cursor token refresh rejected (HTTP ${status}): ${body || '<empty body>'}`);
    this.name = 'RefreshTokenInvalidError';
    this.status = status;
    this.body = body;
  }
}

/**
 * True when value looks like a three-part JWT (not an opaque API key).
 * @param {unknown} value
 * @returns {value is string}
 */
export function looksLikeJwt(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * Refresh via exchange_user_api_key. Never clobber a JWT refresh with an opaque key.
 *
 * @param {string} refreshToken
 * @returns {Promise<{ access: string, refresh: string, expires: number }>}
 */
export async function refreshCursorToken(refreshToken) {
  const response = await fetch(CURSOR_REFRESH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
    signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const isPermanent = response.status >= 400
      && response.status < 500
      && response.status !== 408
      && response.status !== 429;
    if (isPermanent) {
      throw new RefreshTokenInvalidError(response.status, body);
    }
    throw new Error(
      `Cursor token refresh failed (HTTP ${response.status}): ${body || '<empty body>'}`,
    );
  }

  const data = await response.json();
  if (typeof data?.accessToken !== 'string' || !data.accessToken) {
    throw new Error('Cursor refresh response did not include an access token');
  }

  const nextRefresh = looksLikeJwt(data.refreshToken)
    ? data.refreshToken
    : refreshToken;

  return {
    access: data.accessToken,
    refresh: nextRefresh,
    expires: getTokenExpiry(data.accessToken),
  };
}

/**
 * Extract JWT expiry with 5-minute safety margin.
 * Falls back to 1 hour from now if token can't be parsed.
 *
 * @param {string} token
 * @returns {number}
 */
export function getTokenExpiry(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) {
      return Date.now() + 3600 * 1000;
    }
    const decoded = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
    );
    if (decoded && typeof decoded === 'object' && typeof decoded.exp === 'number') {
      return decoded.exp * 1000 - 5 * 60 * 1000;
    }
  } catch {
    // ignore
  }
  return Date.now() + 3600 * 1000;
}
