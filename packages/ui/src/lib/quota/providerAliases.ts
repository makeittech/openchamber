import type { QuotaProviderId } from '@/types';
import { QUOTA_PROVIDERS } from './providers';

/**
 * OpenCode auth / session provider IDs that map onto a quota provider.
 * Kept in sync with server aliases under packages/web/server/lib/quota/providers.
 */
const OPENCODE_PROVIDER_ALIASES: Record<string, QuotaProviderId> = {
  anthropic: 'claude',
  claude: 'claude',
  openai: 'codex',
  codex: 'codex',
  chatgpt: 'codex',
  cursor: 'cursor',
  'github-copilot': 'github-copilot',
  copilot: 'github-copilot',
  google: 'google',
  'google.oauth': 'google',
  gemini: 'google',
  'kimi-for-coding': 'kimi-for-coding',
  kimi: 'kimi-for-coding',
  'nano-gpt': 'nano-gpt',
  nanogpt: 'nano-gpt',
  nano_gpt: 'nano-gpt',
  openrouter: 'openrouter',
  'zai-coding-plan': 'zai-coding-plan',
  zai: 'zai-coding-plan',
  'z.ai': 'zai-coding-plan',
  'zhipuai-coding-plan': 'zhipuai-coding-plan',
  zhipuai: 'zhipuai-coding-plan',
  zhipu: 'zhipuai-coding-plan',
  'minimax-coding-plan': 'minimax-coding-plan',
  'minimax-cn-coding-plan': 'minimax-cn-coding-plan',
  'ollama-cloud': 'ollama-cloud',
  ollamacloud: 'ollama-cloud',
  wafer: 'wafer',
  'wafer-ai': 'wafer',
  wafer_ai: 'wafer',
  'wafer.ai': 'wafer',
  'opencode-go': 'opencode-go',
  crof: 'crof',
  deepseek: 'deepseek',
  neuralwatt: 'neuralwatt',
  xai: 'xai',
};

const knownQuotaIds = new Set<string>(QUOTA_PROVIDERS.map((provider) => provider.id));

export const isQuotaProviderId = (providerId: string | null | undefined): providerId is QuotaProviderId =>
  Boolean(providerId && knownQuotaIds.has(providerId));

export const resolveQuotaProviderId = (openCodeProviderId: string | null | undefined): QuotaProviderId | null => {
  if (!openCodeProviderId) return null;
  const normalized = openCodeProviderId.trim().toLowerCase();
  if (!normalized) return null;
  const mapped = OPENCODE_PROVIDER_ALIASES[normalized];
  if (mapped) return mapped;
  if (knownQuotaIds.has(normalized)) return normalized as QuotaProviderId;
  return null;
};

/**
 * Canonical provider ID for usage history. Known aliases share their quota
 * provider page; plugin/custom providers keep their own normalized ID.
 */
export const resolveUsageProviderId = (openCodeProviderId: string | null | undefined): string | null => {
  if (!openCodeProviderId) return null;
  const normalized = openCodeProviderId.trim().toLowerCase();
  if (!normalized) return null;
  return OPENCODE_PROVIDER_ALIASES[normalized] ?? normalized;
};

/**
 * Map OpenCode-connected provider IDs onto Usage/quota provider IDs.
 * Used so Providers → connected accounts auto-appear in Usage even when
 * the quota API has not marked them `configured` yet (e.g. missing auth.json).
 */
export const collectConnectedQuotaProviderIds = (
  openCodeProviderIds: Iterable<string>,
): Set<QuotaProviderId> => {
  const ids = new Set<QuotaProviderId>();
  for (const openCodeProviderId of openCodeProviderIds) {
    const resolved = resolveQuotaProviderId(openCodeProviderId);
    if (resolved) ids.add(resolved);
  }
  return ids;
};

export const USAGE_ADD_PROVIDER_ID = '__add_provider__' as const;
export type UsageSelectionId = string | typeof USAGE_ADD_PROVIDER_ID;
