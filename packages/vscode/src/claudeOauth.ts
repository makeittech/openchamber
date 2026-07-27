/**
 * Claude subscription OAuth access for VS Code Usage probes.
 * Mirrors packages/web/server/lib/quota/providers/claude-oauth.js + claude.js.
 * Never logs token values.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OPENCODE_CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_CLI_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_API_VERSION = '2023-06-01';
const CLAUDE_USAGE_USER_AGENT = 'claude-code/2.1.72';
export const CLAUDE_SESSION_EXPIRED_ERROR = 'Session expired — please re-authenticate with Claude';
export const CLAUDE_SCOPE_ERROR =
  'Claude usage requires a full Claude Code login (user:profile scope). Run `claude auth login`, then refresh.';

const AUTH_ALIASES = ['anthropic', 'claude'] as const;
const REFRESH_BUFFER_MS = 60_000;
const RATE_LIMIT_PROBE_MODEL = 'claude-haiku-4-5-20251001';

type AuthFile = Record<string, Record<string, unknown>>;

export type ClaudeUsageCredential = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  source: 'env' | 'claude-cli' | 'opencode-auth';
  tokenUrl: string | null;
  authKey?: string;
  credentialsPath?: string;
  scopes?: string[] | null;
};

export type ClaudeUsageAccess = {
  accessToken: string;
  source: ClaudeUsageCredential['source'];
  canRefresh: boolean;
  scopes?: string[] | null;
};

type UsageWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
};

let claudeRefreshPromise: Promise<ClaudeUsageAccess> | null = null;

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const toTimestamp = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value < 1_000_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

const toUsageWindow = ({
  usedPercent,
  windowSeconds,
  resetAt,
}: {
  usedPercent: number | null;
  windowSeconds: number | null;
  resetAt: number | null;
}): UsageWindow => {
  const hasFinite = typeof usedPercent === 'number' && Number.isFinite(usedPercent);
  const resetAfterSeconds = typeof resetAt === 'number'
    ? Math.max(0, Math.floor((resetAt - Date.now()) / 1000))
    : null;
  return {
    usedPercent,
    remainingPercent: hasFinite ? Math.max(0, 100 - usedPercent) : null,
    windowSeconds,
    resetAfterSeconds,
    resetAt,
    resetAtFormatted: null,
    resetAfterFormatted: null,
  };
};

const readAuthFile = (): AuthFile => {
  if (!fs.existsSync(AUTH_FILE)) return {};
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed) as AuthFile;
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
};

const writeAuthFile = (auth: AuthFile): void => {
  if (!fs.existsSync(OPENCODE_DATA_DIR)) {
    fs.mkdirSync(OPENCODE_DATA_DIR, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(OPENCODE_DATA_DIR, 0o700); } catch { /* best-effort */ }
  }
  if (fs.existsSync(AUTH_FILE)) {
    const backupFile = `${AUTH_FILE}.openchamber.backup`;
    fs.copyFileSync(AUTH_FILE, backupFile);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(backupFile, 0o600); } catch { /* best-effort */ }
    }
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(AUTH_FILE, 0o600); } catch { /* best-effort */ }
  }
};

const listClaudeCredentialsCandidates = (
  homeDir = os.homedir(),
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string[] => {
  const candidates: string[] = [];
  const configDir = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  if (configDir) {
    candidates.push(path.join(configDir, '.credentials.json'));
    candidates.push(path.join(configDir, 'credentials.json'));
  }
  candidates.push(
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json'),
    path.join(homeDir, '.config', 'claude', '.credentials.json'),
  );
  return candidates;
};

const toExpiresAtMs = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
};

const extractClaudeOAuthCredentials = (parsed: unknown): {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[] | null;
} | null => {
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  const block = (root.claudeAiOauth && typeof root.claudeAiOauth === 'object'
    ? root.claudeAiOauth
    : root.claude_ai_oauth && typeof root.claude_ai_oauth === 'object'
      ? root.claude_ai_oauth
      : null) as Record<string, unknown> | null;
  if (!block) return null;

  const accessRaw = block.accessToken ?? block.access_token;
  if (typeof accessRaw !== 'string' || !accessRaw.trim()) return null;
  const refreshRaw = block.refreshToken ?? block.refresh_token;
  const scopes = Array.isArray(block.scopes)
    ? block.scopes.filter((scope): scope is string => typeof scope === 'string' && Boolean(scope.trim())).map((scope) => scope.trim())
    : null;
  return {
    accessToken: accessRaw.trim(),
    refreshToken: typeof refreshRaw === 'string' && refreshRaw.trim() ? refreshRaw.trim() : null,
    expiresAt: toExpiresAtMs(block.expiresAt ?? block.expires_at),
    scopes: scopes && scopes.length > 0 ? scopes : null,
  };
};

const writeClaudeCliOAuthCredentials = (
  filePath: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
): void => {
  let root: Record<string, unknown> = {};
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') root = parsed as Record<string, unknown>;
      }
    } catch {
      root = {};
    }
  }

  const useSnake = Boolean(root.claude_ai_oauth) && !root.claudeAiOauth;
  const previous = (useSnake
    ? root.claude_ai_oauth
    : root.claudeAiOauth) as Record<string, unknown> | undefined;
  const base = previous && typeof previous === 'object' ? previous : {};
  const nextBlock = useSnake
    ? {
        ...base,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_at: tokens.expiresAt,
      }
    : {
        ...base,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      };
  const nextRoot = useSnake
    ? { ...root, claude_ai_oauth: nextBlock }
    : { ...root, claudeAiOauth: nextBlock };

  const tempPath = `${filePath}.openchamber.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(nextRoot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(tempPath, 0o600); } catch { /* best-effort */ }
  }
  fs.renameSync(tempPath, filePath);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  }
};

const hasClaudeProfileScope = (scopes: string[] | null | undefined): boolean => {
  if (!Array.isArray(scopes) || scopes.length === 0) return false;
  return scopes.some((scope) => scope.trim() === 'user:profile');
};

const isClaudeAccessExpired = (expiresAt: number | null | undefined, now = Date.now()): boolean => {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return expiresAt - REFRESH_BUFFER_MS <= now;
};

const buildClaudeUsageHeaders = (accessToken: string): Record<string, string> => ({
  Authorization: `Bearer ${accessToken}`,
  'anthropic-beta': CLAUDE_OAUTH_BETA,
  'User-Agent': CLAUDE_USAGE_USER_AGENT,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

const listClaudeUsageCredentials = (): ClaudeUsageCredential[] => {
  const candidates: ClaudeUsageCredential[] = [];

  for (const candidate of listClaudeCredentialsCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      if (!raw.trim()) continue;
      const creds = extractClaudeOAuthCredentials(JSON.parse(raw));
      if (!creds) continue;
      candidates.push({
        ...creds,
        source: 'claude-cli',
        tokenUrl: CLAUDE_CLI_TOKEN_URL,
        credentialsPath: candidate,
      });
      break;
    } catch {
      // continue
    }
  }

  const auth = readAuthFile();
  for (const alias of AUTH_ALIASES) {
    const entry = auth[alias];
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
    const scopes = Array.isArray(entry.scopes)
      ? entry.scopes.filter((scope): scope is string => typeof scope === 'string' && Boolean(scope.trim())).map((scope) => scope.trim())
      : null;
    candidates.push({
      accessToken: access,
      refreshToken: refresh,
      expiresAt: toExpiresAtMs(entry.expires),
      source: 'opencode-auth',
      tokenUrl: OPENCODE_CLAUDE_TOKEN_URL,
      authKey: alias,
      scopes: scopes && scopes.length > 0 ? scopes : null,
    });
    break;
  }

  const envToken = typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === 'string'
    ? process.env.CLAUDE_CODE_OAUTH_TOKEN.trim()
    : '';
  if (envToken) {
    candidates.push({
      accessToken: envToken,
      refreshToken: null,
      expiresAt: null,
      source: 'env',
      tokenUrl: null,
      scopes: null,
    });
  }

  return candidates;
};

const resolveClaudeUsageCredential = (): ClaudeUsageCredential | null => {
  const candidates = listClaudeUsageCredentials();
  if (candidates.length === 0) return null;
  const withProfile = candidates.find((candidate) => hasClaudeProfileScope(candidate.scopes));
  if (withProfile) return withProfile;
  const nonEnv = candidates.find((candidate) => candidate.source !== 'env');
  if (nonEnv) return nonEnv;
  return candidates[0] ?? null;
};

const refreshClaudeOAuthToken = async (input: {
  refreshToken: string;
  tokenUrl: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> => {
  const response = await fetch(input.tokenUrl, {
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
  const payload = await response.json() as Record<string, unknown>;
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  if (!accessToken) {
    throw new Error('Claude token refresh returned no access token');
  }
  const refreshToken = typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : input.refreshToken;
  const expiresIn = Number(payload.expires_in);
  const expiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
  return { accessToken, refreshToken, expiresAt };
};

const persistRefreshedCredential = (
  credential: ClaudeUsageCredential,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
): void => {
  if (credential.source === 'claude-cli' && credential.credentialsPath) {
    writeClaudeCliOAuthCredentials(credential.credentialsPath, tokens);
    return;
  }
  if (credential.source === 'opencode-auth' && credential.authKey) {
    const auth = readAuthFile();
    const previous = auth[credential.authKey] || {};
    auth[credential.authKey] = {
      ...previous,
      type: 'oauth',
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
      expires: tokens.expiresAt,
    };
    writeAuthFile(auth);
  }
};

export const ensureClaudeUsageAccessToken = async (options: {
  forceRefresh?: boolean;
} = {}): Promise<ClaudeUsageAccess | null> => {
  const forceRefresh = Boolean(options.forceRefresh);
  const credential = resolveClaudeUsageCredential();
  if (!credential) return null;

  const canRefresh = Boolean(credential.refreshToken && credential.tokenUrl);
  const needsRefresh = forceRefresh
    || !credential.accessToken
    || isClaudeAccessExpired(credential.expiresAt);

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
      const latest = resolveClaudeUsageCredential() || credential;
      if (!forceRefresh && latest.accessToken && !isClaudeAccessExpired(latest.expiresAt)) {
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

      const tokens = await refreshClaudeOAuthToken({ refreshToken, tokenUrl });
      persistRefreshedCredential({ ...latest, refreshToken, tokenUrl }, tokens);
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
};

export const fetchClaudeUsagePayload = async (accessToken: string): Promise<Response> => {
  return fetch(CLAUDE_USAGE_URL, {
    method: 'GET',
    headers: buildClaudeUsageHeaders(accessToken),
    signal: AbortSignal.timeout(30_000),
  });
};

const mapClaudeRateLimitHeaders = (
  headers: Headers,
): Record<string, UsageWindow> => {
  const windows: Record<string, UsageWindow> = {};
  const fiveUtil = toNumber(headers.get('anthropic-ratelimit-unified-5h-utilization'));
  const fiveReset = toNumber(headers.get('anthropic-ratelimit-unified-5h-reset'));
  if (fiveUtil !== null) {
    windows['5h'] = toUsageWindow({
      usedPercent: fiveUtil * 100,
      windowSeconds: 5 * 60 * 60,
      resetAt: toTimestamp(fiveReset),
    });
  }
  const sevenUtil = toNumber(headers.get('anthropic-ratelimit-unified-7d-utilization'));
  const sevenReset = toNumber(headers.get('anthropic-ratelimit-unified-7d-reset'));
  if (sevenUtil !== null) {
    windows['7d'] = toUsageWindow({
      usedPercent: sevenUtil * 100,
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: toTimestamp(sevenReset),
    });
  }
  return windows;
};

export const fetchClaudeUsageWindowsFromRateLimits = async (
  accessToken: string,
): Promise<Record<string, UsageWindow>> => {
  const response = await fetch(CLAUDE_MESSAGES_URL, {
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
};

export const classifyClaudeUsageHttpError = (status: number, bodyText = ''): string => {
  if (status === 401) return CLAUDE_SESSION_EXPIRED_ERROR;
  if (status === 403 && /user:profile|permission_error|scope/i.test(bodyText)) {
    return CLAUDE_SCOPE_ERROR;
  }
  if (status === 403) return CLAUDE_SCOPE_ERROR;
  return `API error: ${status}`;
};

export const mapClaudeUsageWindows = (payload: Record<string, unknown>): Record<string, UsageWindow> => {
  const windows: Record<string, UsageWindow> = {};
  const fiveHour = payload.five_hour as Record<string, unknown> | undefined;
  const sevenDay = payload.seven_day as Record<string, unknown> | undefined;
  const sevenDaySonnet = payload.seven_day_sonnet as Record<string, unknown> | undefined;
  const sevenDayOpus = payload.seven_day_opus as Record<string, unknown> | undefined;

  if (fiveHour && typeof fiveHour === 'object') {
    windows['5h'] = toUsageWindow({
      usedPercent: toNumber(fiveHour.utilization),
      windowSeconds: 5 * 60 * 60,
      resetAt: toTimestamp(fiveHour.resets_at),
    });
  }
  if (sevenDay && typeof sevenDay === 'object') {
    windows['7d'] = toUsageWindow({
      usedPercent: toNumber(sevenDay.utilization),
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: toTimestamp(sevenDay.resets_at),
    });
  }
  if (sevenDaySonnet && typeof sevenDaySonnet === 'object') {
    windows['7d-sonnet'] = toUsageWindow({
      usedPercent: toNumber(sevenDaySonnet.utilization),
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: toTimestamp(sevenDaySonnet.resets_at),
    });
  }
  if (sevenDayOpus && typeof sevenDayOpus === 'object') {
    windows['7d-opus'] = toUsageWindow({
      usedPercent: toNumber(sevenDayOpus.utilization),
      windowSeconds: 7 * 24 * 60 * 60,
      resetAt: toTimestamp(sevenDayOpus.resets_at),
    });
  }
  return windows;
};

export const hasKnownMissingProfileScope = (scopes: string[] | null | undefined): boolean => {
  return scopes != null && !hasClaudeProfileScope(scopes);
};
