import crypto from 'crypto';

const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
const LINEAR_DEFAULT_SCOPES = 'read,write';

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 100;

// Pending OAuth states, keyed by the opaque state value. In-memory on purpose:
// a server restart simply aborts in-flight flows (the user retries), and no
// unexpired state survives to be replayed later.
const pendingStates = new Map();

const pruneStates = (nowMs = Date.now()) => {
  for (const [state, entry] of pendingStates) {
    if (nowMs - entry.createdAt > STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }
  while (pendingStates.size > MAX_PENDING_STATES) {
    const oldest = pendingStates.keys().next().value;
    if (oldest === undefined) break;
    pendingStates.delete(oldest);
  }
};

export const createOAuthState = ({ redirectUri }) => {
  pruneStates();
  const state = crypto.randomBytes(24).toString('base64url');
  pendingStates.set(state, {
    createdAt: Date.now(),
    redirectUri: typeof redirectUri === 'string' ? redirectUri : '',
  });
  return state;
};

// Single-use: a consumed state can never be redeemed again, which bounds the
// damage of a leaked callback URL.
export const consumeOAuthState = (state) => {
  if (typeof state !== 'string' || !state) {
    return null;
  }
  const entry = pendingStates.get(state);
  if (!entry) {
    return null;
  }
  pendingStates.delete(state);
  if (Date.now() - entry.createdAt > STATE_TTL_MS) {
    return null;
  }
  return entry;
};

export const buildAuthorizeUrl = ({ clientId, redirectUri, state, scope }) => {
  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', typeof scope === 'string' && scope.trim() ? scope.trim() : LINEAR_DEFAULT_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
};

const parseTokenResponse = async (response) => {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body.access_token !== 'string' || !body.access_token) {
    const description = typeof body?.error_description === 'string'
      ? body.error_description
      : (typeof body?.error === 'string' ? body.error : `token request failed (${response.status})`);
    const error = new Error(description);
    error.status = response.status;
    throw error;
  }
  return body;
};

const tokenRequest = async ({ fetchImpl, form }) => {
  const response = await fetchImpl(LINEAR_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
  });
  return parseTokenResponse(response);
};

export const exchangeCodeForTokens = async ({ code, redirectUri, clientId, clientSecret, fetchImpl = fetch }) => {
  const body = await tokenRequest({
    fetchImpl,
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    scope: typeof body.scope === 'string' ? body.scope : '',
    expiresAt: typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : null,
  };
};

export const refreshAccessToken = async ({ refreshToken, clientId, clientSecret, fetchImpl = fetch }) => {
  const body = await tokenRequest({
    fetchImpl,
    form: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
  });
  return {
    accessToken: body.access_token,
    // Linear rotates refresh tokens when it issues them; keep the old one only
    // when the response omits a replacement.
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : refreshToken,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    scope: typeof body.scope === 'string' ? body.scope : '',
    expiresAt: typeof body.expires_in === 'number' ? Date.now() + body.expires_in * 1000 : null,
  };
};
