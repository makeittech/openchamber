export interface ProviderAuthMethod {
  type?: string;
  name?: string;
  label?: string;
  description?: string;
  help?: string;
  method?: number;
  [key: string]: unknown;
}

export interface ProviderOAuthEntry {
  /** Index in the provider.auth() array; oauth.authorize addresses methods by this index. */
  index: number;
  method: ProviderAuthMethod;
}

export const normalizeAuthType = (method: ProviderAuthMethod): string => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

export const oauthMethodEntries = (methods: ProviderAuthMethod[]): ProviderOAuthEntry[] =>
  methods
    .map((method, index) => ({ index, method }))
    .filter((entry) => normalizeAuthType(entry.method) === 'oauth');

const isOauthOnly = (methods: ProviderAuthMethod[]): boolean =>
  methods.length > 0 && methods.every((method) => normalizeAuthType(method) === 'oauth');

interface ProviderAuthViewInput {
  methods: ProviderAuthMethod[];
  /** True once provider credential provenance is known (source lookup resolved). */
  credentialsResolved: boolean;
  /** Stored credentials for the provider (auth.json entry). */
  hasStoredCredentials: boolean;
}

interface ProviderAuthView {
  oauthEntries: ProviderOAuthEntry[];
  /** Unknown methods keep the key field; an explicit api method always shows it. */
  showApiKeyField: boolean;
  /** OAuth-only provider whose credentials are known to be missing. */
  signInRequired: boolean;
  /** Open the auth panel without user action instead of a Connected summary. */
  autoOpenPanel: boolean;
  /** Fetch the browser URL up front so it is visible without pressing Connect. */
  autoStartMethodIndex: number | null;
}

/**
 * Derives the Authentication section state from the provider's advertised auth
 * methods. OAuth-only providers (plugin providers such as Cursor) have no API
 * key path at all, so the key field is hidden and, when no credentials are
 * stored, the OAuth flow replaces the Connected summary.
 */
export const deriveProviderAuthView = ({
  methods,
  credentialsResolved,
  hasStoredCredentials,
}: ProviderAuthViewInput): ProviderAuthView => {
  const oauthEntries = oauthMethodEntries(methods);
  const oauthOnly = isOauthOnly(methods);
  const signInRequired = oauthOnly && credentialsResolved && !hasStoredCredentials;

  return {
    oauthEntries,
    showApiKeyField: methods.length === 0 || methods.some((method) => normalizeAuthType(method) === 'api'),
    signInRequired,
    autoOpenPanel: signInRequired,
    autoStartMethodIndex: signInRequired ? (oauthEntries[0]?.index ?? null) : null,
  };
};
