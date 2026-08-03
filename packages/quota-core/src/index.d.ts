/**
 * Hand-written type declarations for @openchamber/quota-core.
 *
 * The package ships as plain JSDoc-typed ESM (no build step, consumed
 * directly by the web server's un-transpiled Node runtime). The VS Code
 * extension's tsconfig has no `allowJs`, so these declarations are what make
 * the package type-check there; keep this file's shapes in sync with
 * src/*.js by hand.
 */

export type ClaudeCredentialSource = 'env' | 'claude-cli' | 'opencode-auth';

export interface ClaudeUsageCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  source: ClaudeCredentialSource;
  tokenUrl: string | null;
  authKey?: string;
  credentialsPath?: string;
  scopes?: string[] | null;
}

export interface ClaudeUsageAccess {
  accessToken: string;
  source: ClaudeCredentialSource;
  canRefresh: boolean;
  scopes?: string[] | null;
}

export interface UsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
}

type ReadFile = (path: string, encoding: BufferEncoding) => string;
type ExistsSync = (path: string) => boolean;
type EnvRecord = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface ClaudeCredentialIoOptions {
  env?: EnvRecord;
  homeDir?: string;
  readFile?: ReadFile;
  existsSync?: ExistsSync;
}

export interface ClaudeCliCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[] | null;
  source: 'env' | 'file';
  credentialsPath: string | null;
}

export interface ClaudeExtractedOAuthCredentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[] | null;
}

export interface WriteClaudeCliOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface WriteClaudeCliOAuthOptions {
  readFile?: ReadFile;
  writeFile?: (path: string, data: string, options?: { encoding?: BufferEncoding; mode?: number }) => void;
  renameSync?: (from: string, to: string) => void;
  existsSync?: ExistsSync;
  chmodSync?: (path: string, mode: number) => void;
}

export interface ResolveClaudeUsageCredentialOptions extends ClaudeCredentialIoOptions {
  readAuth?: () => Record<string, unknown>;
  preferProfileScope?: boolean;
}

export interface EnsureClaudeUsageAccessTokenOptions extends ResolveClaudeUsageCredentialOptions {
  forceRefresh?: boolean;
  writeAuth?: (auth: Record<string, unknown>) => void;
  writeCliCredentials?: (
    filePath: string,
    tokens: WriteClaudeCliOAuthTokens,
    options?: WriteClaudeCliOAuthOptions,
  ) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface RefreshClaudeOAuthTokenInput {
  refreshToken: string;
  tokenUrl: string;
  fetchImpl?: typeof fetch;
}

export interface RefreshClaudeOAuthTokenResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface FetchImplOptions {
  fetchImpl?: typeof fetch;
}

export interface RateLimitProbeOptions extends FetchImplOptions {
  now?: () => number;
  bypassCache?: boolean;
}

export interface ToUsageWindowInput {
  usedPercent: number | null;
  windowSeconds: number | null;
  resetAt: number | null;
  valueLabel?: string | null;
}

export const CLAUDE_OAUTH_CLIENT_ID: string;
export const OPENCODE_CLAUDE_TOKEN_URL: string;
export const CLAUDE_CLI_TOKEN_URL: string;
export const CLAUDE_USAGE_URL: string;
export const CLAUDE_USAGE_USER_AGENT: string;
export const CLAUDE_SESSION_EXPIRED_ERROR: string;
export const CLAUDE_SCOPE_ERROR: string;

export declare function isClaudeAccessExpired(
  expiresAt: number | null | undefined,
  now?: number,
): boolean;

export declare function hasClaudeProfileScope(scopes: string[] | null | undefined): boolean;

export declare function buildClaudeUsageHeaders(accessToken: string): Record<string, string>;

export declare function refreshClaudeOAuthToken(
  input: RefreshClaudeOAuthTokenInput,
): Promise<RefreshClaudeOAuthTokenResult>;

export declare function resolveClaudeUsageCredential(
  options?: ResolveClaudeUsageCredentialOptions,
): ClaudeUsageCredential | null;

export declare function ensureClaudeUsageAccessToken(
  options?: EnsureClaudeUsageAccessTokenOptions,
): Promise<ClaudeUsageAccess | null>;

export declare function fetchClaudeUsagePayload(
  accessToken: string,
  options?: FetchImplOptions,
): Promise<Response>;

export declare function mapClaudeRateLimitHeaders(
  headers: Headers | Record<string, string | null | undefined>,
): Record<string, UsageWindow>;

export declare function fetchClaudeUsageWindowsFromRateLimits(
  accessToken: string,
  options?: RateLimitProbeOptions,
): Promise<Record<string, UsageWindow>>;

export declare function classifyClaudeUsageHttpError(status: number, bodyText?: string): string;

/** @internal test helper */
export declare function __resetClaudeRefreshLockForTests(): void;

export declare function readClaudeCodeOAuthTokenFromEnv(env?: EnvRecord): string | null;

export declare function listClaudeCredentialsCandidates(
  homeDir?: string,
  env?: EnvRecord,
): string[];

export declare function extractClaudeOAuthCredentials(
  parsed: unknown,
): ClaudeExtractedOAuthCredentials | null;

export declare function extractClaudeOAuthAccessToken(parsed: unknown): string | null;

export declare function readClaudeCliOAuthCredentials(
  options?: ClaudeCredentialIoOptions,
): ClaudeCliCredentials | null;

export declare function readClaudeCliOAuthAccessToken(
  options?: ClaudeCredentialIoOptions,
): string | null;

export declare function writeClaudeCliOAuthCredentials(
  filePath: string,
  tokens: WriteClaudeCliOAuthTokens,
  options?: WriteClaudeCliOAuthOptions,
): void;

export declare function hasClaudeCliOAuthCredentials(options?: ClaudeCredentialIoOptions): boolean;

export declare function mapClaudeUsageWindows(payload: unknown): Record<string, UsageWindow>;

export declare function shouldSkipClaudeUsageEndpoint(
  access: { source?: string; scopes?: string[] | null } | null | undefined,
): boolean;

export declare function toNumber(value: unknown): number | null;
export declare function toTimestamp(value: unknown): number | null;
export declare function toUsageWindow(data: ToUsageWindowInput): UsageWindow;
