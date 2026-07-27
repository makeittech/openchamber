/**
 * Claude subscription OAuth access for Usage probes.
 * Refreshes expired tokens using the same public client as Claude Code /
 * OpenCode Anthropic auth, persists rotated credentials, and single-flights
 * concurrent renewals. Never logs token values.
 *
 * Usage endpoint quirks:
 * - Requires `User-Agent: claude-code/...` or Anthropic rate-limits the call.
 * - Requires OAuth scope `user:profile`. Inference-only setup tokens
 *   (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) get HTTP 403.
 * - When the usage endpoint rejects for scope, fall back to unified rate-limit
 *   headers from a tiny Messages API probe (works with inference scope).
 */

import { readAuthFile, writeAuthFile } from '../../opencode/auth.js';
import { getAuthEntry, normalizeAuthEntry, toNumber, toTimestamp, toUsageWindow } from '../utils/index.js';
import {
  readClaudeCliOAuthCredentials,
  writeClaudeCliOAuthCredentials,
} from './claude-cli-auth.js';

/** Public Claude Code / OpenCode Anthropic OAuth client id (not a secret). */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** OpenCode Anthropic plugin token endpoint. */
export const OPENCODE_CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

/** Claude Code CLI token endpoint. */
export const CLAUDE_CLI_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_API_VERSION = '2023-06-01';
/** Anthropic buckets non-`claude-code/` UAs into an aggressive usage rate limit. */
export const CLAUDE_USAGE_USER_AGENT = 'claude-code/2.1.72';
export const CLAUDE_SESSION_EXPIRED_ERROR = 'Session expired — please re-authenticate with Claude';
export const CLAUDE_SCOPE_ERROR =
  'Claude usage requires a full Claude Code login (user:profile scope). Run `claude auth login`, then refresh.';

const AUTH_ALIASES = ['anthropic', 'claude'];
const REFRESH_BUFFER_MS = 60_000;
const RATE_LIMIT_PROBE_MODEL = 'claude-haiku-4-5-20251001';

/** @type {Promise<ClaudeUsageAccess> | null} */
let claudeRefreshPromise = null;

/**
 * @typedef {{
 *   accessToken: string,
 *   refreshToken: string | null,
 *   expiresAt: number | null,
 *   source: 'env' | 'claude-cli' | 'opencode-auth',
 *   tokenUrl: string | null,
 *   authKey?: string,
 *   credentialsPath?: string,
 *   scopes?: string[] | null,
 * }} ClaudeUsageCredential
 */

/**
 * @typedef {{
 *   accessToken: string,
 *   source: ClaudeUsageCredential['source'],
 *   canRefresh: boolean,
 *   scopes?: string[] | null,
 * }} ClaudeUsageAccess
 */

/**
 * @param {number | null | undefined} expiresAt
 * @param {number} [now]
 * @returns {boolean}
 */
export function isClaudeAccessExpired(expiresAt, now = Date.now()) {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return false;
  }
  return expiresAt - REFRESH_BUFFER_MS <= now;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function toExpiresMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

/**
 * @param {string[] | null | undefined} scopes
 * @returns {boolean}
 */
export function hasClaudeProfileScope(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  return scopes.some((scope) => typeof scope === 'string' && scope.trim() === 'user:profile');
}

/**
 * @param {unknown} value
 * @returns {string[] | null}
 */
function normalizeScopes(value) {
  if (!Array.isArray(value)) return null;
  const scopes = value
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim());
  return scopes.length > 0 ? scopes : null;
}

/**
 * @returns {Record<string, string>}
 */
export function buildClaudeUsageHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': CLAUDE_OAUTH_BETA,
    'User-Agent': CLAUDE_USAGE_USER_AGENT,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * @param {{
 *   refreshToken: string,
 *   tokenUrl: string,
 *   fetchImpl?: typeof fetch,
 * }} input
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresAt: number }>}
 */
export async function refreshClaudeOAuthToken(input) {
  const fetchImpl = input.fetchImpl || fetch;
  const response = await fetchImpl(input.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': CLAUDE_USAGE_USER_AGENT,
      'anthropic-beta': CLAUDE_OAUTH_BETA,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Claude token refresh failed: ${response.status}`);
  }

  const payload = await response.json();
  const accessToken = typeof payload?.access_token === 'string' ? payload.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('Claude token refresh returned no access token');
  }

  const refreshToken = typeof payload?.refresh_token === 'string' && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : input.refreshToken;
  const expiresIn = Number(payload?.expires_in);
  const expiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;

  return { accessToken, refreshToken, expiresAt };
}

/**
 * List Claude usage credential candidates.
 * Prefer Claude Code credentials files / OpenCode OAuth (usually include
 * `user:profile`) over `CLAUDE_CODE_OAUTH_TOKEN` setup-tokens (inference-only).
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   homeDir?: string,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 *   readAuth?: () => Record<string, unknown>,
 * }} [options]
 * @returns {ClaudeUsageCredential[]}
 */
function listClaudeUsageCredentials(options = {}) {
  /** @type {ClaudeUsageCredential[]} */
  const candidates = [];

  const cli = readClaudeCliOAuthCredentials({
    env: { ...(options.env || process.env), CLAUDE_CODE_OAUTH_TOKEN: '' },
    homeDir: options.homeDir,
    readFile: options.readFile,
    existsSync: options.existsSync,
  });
  if (cli?.accessToken && cli.source === 'file') {
    candidates.push({
      accessToken: cli.accessToken,
      refreshToken: cli.refreshToken,
      expiresAt: cli.expiresAt,
      source: 'claude-cli',
      tokenUrl: CLAUDE_CLI_TOKEN_URL,
      credentialsPath: cli.credentialsPath || undefined,
      scopes: cli.scopes ?? null,
    });
  }

  const readAuth = options.readAuth || readAuthFile;
  const auth = readAuth();
  for (const alias of AUTH_ALIASES) {
    const entry = normalizeAuthEntry(getAuthEntry(auth, [alias]));
    if (!entry || typeof entry !== 'object') continue;
    const access = typeof entry.access === 'string' && entry.access.trim()
      ? entry.access.trim()
      : typeof entry.token === 'string' && entry.token.trim()
        ? entry.token.trim()
        : null;
    if (!access) continue;
    const refresh = typeof entry.refresh === 'string' && entry.refresh.trim()
      ? entry.refresh.trim()
      : null;
    candidates.push({
      accessToken: access,
      refreshToken: refresh,
      expiresAt: toExpiresMs(entry.expires),
      source: 'opencode-auth',
      tokenUrl: OPENCODE_CLAUDE_TOKEN_URL,
      authKey: alias,
      scopes: normalizeScopes(entry.scopes),
    });
    break;
  }

  const envToken = readClaudeCliOAuthCredentials({
    env: options.env || process.env,
    homeDir: options.homeDir,
    readFile: () => '',
    existsSync: () => false,
  });
  if (envToken?.source === 'env' && envToken.accessToken) {
    candidates.push({
      accessToken: envToken.accessToken,
      refreshToken: null,
      expiresAt: null,
      source: 'env',
      tokenUrl: null,
      scopes: null,
    });
  }

  return candidates;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   homeDir?: string,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 *   readAuth?: () => Record<string, unknown>,
 *   preferProfileScope?: boolean,
 * }} [options]
 * @returns {ClaudeUsageCredential | null}
 */
export function resolveClaudeUsageCredential(options = {}) {
  const candidates = listClaudeUsageCredentials(options);
  if (candidates.length === 0) return null;

  if (options.preferProfileScope !== false) {
    const withProfile = candidates.find((candidate) => hasClaudeProfileScope(candidate.scopes));
    if (withProfile) return withProfile;
    // Prefer non-env sources when scopes are unknown — setup-token env often lacks profile.
    const nonEnv = candidates.find((candidate) => candidate.source !== 'env');
    if (nonEnv) return nonEnv;
  }

  return candidates[0] ?? null;
}

/**
 * @param {ClaudeUsageCredential} credential
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number }} tokens
 * @param {{
 *   writeAuth?: (auth: Record<string, unknown>) => void,
 *   readAuth?: () => Record<string, unknown>,
 *   writeCliCredentials?: typeof writeClaudeCliOAuthCredentials,
 * }} [options]
 */
function persistRefreshedCredential(credential, tokens, options = {}) {
  if (credential.source === 'claude-cli' && credential.credentialsPath) {
    const writeCli = options.writeCliCredentials || writeClaudeCliOAuthCredentials;
    writeCli(credential.credentialsPath, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
    return;
  }

  if (credential.source === 'opencode-auth' && credential.authKey) {
    const readAuth = options.readAuth || readAuthFile;
    const writeAuth = options.writeAuth || writeAuthFile;
    const auth = readAuth();
    const previous = normalizeAuthEntry(auth[credential.authKey]) || {};
    auth[credential.authKey] = {
      ...previous,
      type: 'oauth',
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: tokens.expiresAt,
    };
    writeAuth(auth);
  }
}

/**
 * Resolve a usable Claude subscription access token, refreshing when expired.
 *
 * @param {{
 *   forceRefresh?: boolean,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   homeDir?: string,
 *   readFile?: (path: string, encoding: BufferEncoding) => string,
 *   existsSync?: (path: string) => boolean,
 *   readAuth?: () => Record<string, unknown>,
 *   writeAuth?: (auth: Record<string, unknown>) => void,
 *   writeCliCredentials?: typeof writeClaudeCliOAuthCredentials,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   preferProfileScope?: boolean,
 * }} [options]
 * @returns {Promise<ClaudeUsageAccess | null>}
 */
export async function ensureClaudeUsageAccessToken(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const now = options.now || Date.now;

  const load = () => resolveClaudeUsageCredential(options);

  const credential = load();
  if (!credential) return null;

  const canRefresh = Boolean(credential.refreshToken && credential.tokenUrl);
  const needsRefresh = forceRefresh || !credential.accessToken || isClaudeAccessExpired(credential.expiresAt, now());

  if (!needsRefresh) {
    return {
      accessToken: credential.accessToken,
      source: credential.source,
      canRefresh,
      scopes: credential.scopes ?? null,
    };
  }

  if (!canRefresh || !credential.refreshToken || !credential.tokenUrl) {
    return credential.accessToken
      ? {
          accessToken: credential.accessToken,
          source: credential.source,
          canRefresh: false,
          scopes: credential.scopes ?? null,
        }
      : null;
  }

  if (!claudeRefreshPromise) {
    claudeRefreshPromise = (async () => {
      const latest = load() || credential;
      if (
        !forceRefresh
        && latest.accessToken
        && !isClaudeAccessExpired(latest.expiresAt, now())
      ) {
        return {
          accessToken: latest.accessToken,
          source: latest.source,
          canRefresh: Boolean(latest.refreshToken && latest.tokenUrl),
          scopes: latest.scopes ?? null,
        };
      }

      const refreshToken = latest.refreshToken || credential.refreshToken;
      const tokenUrl = latest.tokenUrl || credential.tokenUrl;
      if (!refreshToken || !tokenUrl) {
        throw new Error('Claude OAuth entry has no refresh token');
      }

      const tokens = await refreshClaudeOAuthToken({
        refreshToken,
        tokenUrl,
        fetchImpl: options.fetchImpl,
      });

      persistRefreshedCredential({ ...latest, refreshToken, tokenUrl }, tokens, options);

      return {
        accessToken: tokens.accessToken,
        source: latest.source,
        canRefresh: true,
        scopes: latest.scopes ?? null,
      };
    })().finally(() => {
      claudeRefreshPromise = null;
    });
  }

  return claudeRefreshPromise;
}

/**
 * @param {string} accessToken
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export async function fetchClaudeUsagePayload(accessToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  return fetchImpl(CLAUDE_USAGE_URL, {
    method: 'GET',
    headers: buildClaudeUsageHeaders(accessToken),
    signal: AbortSignal.timeout(30_000),
  });
}

/**
 * Convert Anthropic unified rate-limit header ratios into Usage windows.
 * Header utilization is a 0..1+ ratio; Usage UI expects 0..100 percent.
 *
 * @param {Headers | Record<string, string | null | undefined>} headers
 * @returns {Record<string, ReturnType<typeof toUsageWindow>>}
 */
export function mapClaudeRateLimitHeaders(headers) {
  const get = (name) => {
    if (headers && typeof headers.get === 'function') {
      return headers.get(name) ?? headers.get(name.toLowerCase());
    }
    const record = /** @type {Record<string, string | null | undefined>} */ (headers);
    return record[name] ?? record[name.toLowerCase()];
  };

  /** @type {Record<string, ReturnType<typeof toUsageWindow>>} */
  const windows = {};

  const fiveUtil = toNumber(get('anthropic-ratelimit-unified-5h-utilization'));
  const fiveReset = toNumber(get('anthropic-ratelimit-unified-5h-reset'));
  if (fiveUtil !== null) {
    windows['5h'] = toUsageWindow({
      usedPercent: fiveUtil * 100,
      windowSeconds: 5 * 60 * 60,
      resetAt: toTimestamp(fiveReset),
    });
  }

  const sevenUtil = toNumber(get('anthropic-ratelimit-unified-7d-utilization'));
  const sevenReset = toNumber(get('anthropic-ratelimit-unified-7d-reset'));
  if (sevenUtil !== null) {
    windows['7d'] = toUsageWindow({
      usedPercent: sevenUtil * 100,
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: toTimestamp(sevenReset),
    });
  }

  return windows;
}

/**
 * Lightweight Messages probe used when `/api/oauth/usage` rejects inference-only tokens.
 *
 * @param {string} accessToken
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Record<string, ReturnType<typeof toUsageWindow>>>}
 */
export async function fetchClaudeUsageWindowsFromRateLimits(accessToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(CLAUDE_MESSAGES_URL, {
    method: 'POST',
    headers: {
      ...buildClaudeUsageHeaders(accessToken),
      'anthropic-version': CLAUDE_API_VERSION,
    },
    body: JSON.stringify({
      model: RATE_LIMIT_PROBE_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Claude rate-limit probe failed: ${response.status}`);
  }

  const windows = mapClaudeRateLimitHeaders(response.headers);
  if (Object.keys(windows).length === 0) {
    throw new Error('Claude rate-limit probe returned no usage headers');
  }
  return windows;
}

/**
 * @param {number} status
 * @param {string} [bodyText]
 */
export function classifyClaudeUsageHttpError(status, bodyText = '') {
  if (status === 401) return CLAUDE_SESSION_EXPIRED_ERROR;
  if (status === 403 && /user:profile|permission_error|scope/i.test(bodyText)) {
    return CLAUDE_SCOPE_ERROR;
  }
  if (status === 403) return CLAUDE_SCOPE_ERROR;
  return `API error: ${status}`;
}

/** @internal test helper */
export function __resetClaudeRefreshLockForTests() {
  claudeRefreshPromise = null;
}
