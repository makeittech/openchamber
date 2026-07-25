/**
 * In-memory Cursor PKCE login sessions for harness routes.
 * Never returns verifiers or tokens to API callers.
 */

import { generateCursorAuthParams, pollCursorAuthOnce } from './auth.js';
import { persistCursorCredentials } from './credentials.js';

const SESSION_TTL_MS = 15 * 60 * 1000;

/** @type {Map<string, { uuid: string, verifier: string, createdAt: number, status: string, detail?: string }>} */
const pendingLogins = new Map();

function pruneExpired() {
  const now = Date.now();
  for (const [id, session] of pendingLogins) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      pendingLogins.delete(id);
    }
  }
}

/**
 * Start a Cursor OAuth login. Returns loginId + loginUrl only (no verifier).
 * @returns {Promise<{ loginId: string, loginUrl: string }>}
 */
export async function startLogin() {
  pruneExpired();
  const params = await generateCursorAuthParams();
  const loginId = crypto.randomUUID();
  pendingLogins.set(loginId, {
    uuid: params.uuid,
    verifier: params.verifier,
    createdAt: Date.now(),
    status: 'pending',
  });
  return {
    loginId,
    loginUrl: params.loginUrl,
  };
}

/**
 * Poll a pending login once. On complete, persists credentials and clears verifier.
 *
 * @param {string} loginId
 * @returns {Promise<{ status: 'pending' | 'complete' | 'error', detail?: string }>}
 */
export async function pollLogin(loginId) {
  pruneExpired();
  const id = typeof loginId === 'string' ? loginId.trim() : '';
  if (!id) {
    return { status: 'error', detail: 'loginId is required' };
  }

  const session = pendingLogins.get(id);
  if (!session) {
    return { status: 'error', detail: 'Unknown or expired login session' };
  }

  if (session.status === 'complete') {
    return { status: 'complete' };
  }
  if (session.status === 'error') {
    return { status: 'error', detail: session.detail || 'Login failed' };
  }

  try {
    const result = await pollCursorAuthOnce(session.uuid, session.verifier);
    if (!result) {
      return { status: 'pending' };
    }

    await persistCursorCredentials({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
    });

    // Drop verifier; keep a short-lived complete marker.
    pendingLogins.set(id, {
      uuid: session.uuid,
      verifier: '',
      createdAt: session.createdAt,
      status: 'complete',
    });
    return { status: 'complete' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Login poll failed';
    pendingLogins.set(id, {
      uuid: session.uuid,
      verifier: '',
      createdAt: session.createdAt,
      status: 'error',
      detail,
    });
    return { status: 'error', detail };
  }
}

/** @internal test helper */
export function resetPendingLogins() {
  pendingLogins.clear();
}

/** @internal test helper */
export function getPendingLoginCount() {
  return pendingLogins.size;
}
