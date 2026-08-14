import type { ProviderResult, QuotaProviderId } from '@/types';
import {
  QUOTA_PROVIDERS,
  clampPercent,
  isQuotaProviderId,
  resolveUsageProviderId,
} from '@/lib/quota';

interface UsageProviderMeta {
  id: string;
  name: string;
  quotaProviderId: QuotaProviderId | null;
  connected: boolean;
}

export const buildUsageProviderCatalog = ({
  configProviders,
  quotaResults,
  usageProviderNames,
}: {
  configProviders: readonly { id: string; name?: string }[];
  quotaResults: readonly ProviderResult[];
  /** providerId → display name recovered from usage history. */
  usageProviderNames?: ReadonlyMap<string, string>;
}): UsageProviderMeta[] => {
  const providers = new Map<string, UsageProviderMeta>();
  const quotaMeta = new Map(QUOTA_PROVIDERS.map((provider) => [provider.id, provider]));

  const add = (rawId: string, rawName: string | undefined, connected: boolean) => {
    const id = resolveUsageProviderId(rawId);
    if (!id) return;
    const known = isQuotaProviderId(id) ? quotaMeta.get(id) : undefined;
    const existing = providers.get(id);
    const name = rawName?.trim() || undefined;
    providers.set(id, {
      id,
      name: known?.name ?? existing?.name ?? name ?? id,
      quotaProviderId: isQuotaProviderId(id) ? id : null,
      connected: connected || existing?.connected === true,
    });
  };

  for (const provider of configProviders) add(provider.id, provider.name, true);
  for (const provider of QUOTA_PROVIDERS) {
    const result = quotaResults.find((entry) => entry.providerId === provider.id);
    if (result?.configured) add(provider.id, provider.name, true);
  }
  for (const [providerId, providerName] of usageProviderNames ?? []) {
    add(providerId, providerName, false);
  }

  return Array.from(providers.values());
};

export const getProviderUsedPercent = (
  usage: ProviderResult['usage'] | null | undefined,
): number | null => {
  const windows = usage?.windows ?? {};
  const values = Object.values(windows)
    .map((window) => {
      if (typeof window.usedPercent === 'number') return window.usedPercent;
      if (typeof window.remainingPercent === 'number') return 100 - window.remainingPercent;
      return null;
    })
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return clampPercent(Math.max(...values));
};

const getProviderRemainingPercent = (
  usage: ProviderResult['usage'] | null | undefined,
): number | null => {
  const values = Object.values(usage?.windows ?? {})
    .map((window) => {
      if (typeof window.remainingPercent === 'number') return window.remainingPercent;
      if (typeof window.usedPercent === 'number') return 100 - window.usedPercent;
      return null;
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));
  return values.length === 0 ? null : clampPercent(Math.min(...values));
};

const COST_REMAINING_WINDOW_KEYS = [
  'credits',
  'credits_balance',
  'plan_limit',
  'billing_cycle',
  'on_demand',
] as const;

/**
 * Compact remaining readout for provider lists (sidebar): percent when available,
 * otherwise the cost/credit `valueLabel` from the primary quota window.
 */
export const getProviderRemainingDisplay = (
  usage: ProviderResult['usage'] | null | undefined,
): { kind: 'percent'; percent: number } | { kind: 'amount'; label: string } | null => {
  const remainingPercent = getProviderRemainingPercent(usage);
  if (remainingPercent !== null) {
    return { kind: 'percent', percent: remainingPercent };
  }

  const windows = usage?.windows ?? {};
  for (const key of COST_REMAINING_WINDOW_KEYS) {
    const label = windows[key]?.valueLabel?.trim();
    if (label) return { kind: 'amount', label };
  }
  for (const window of Object.values(windows)) {
    const label = window.valueLabel?.trim();
    if (label) return { kind: 'amount', label };
  }
  return null;
};

const hasProviderId = (
  providerIds: ReadonlySet<string> | readonly string[] | undefined,
  providerId: string,
): boolean => {
  if (!providerIds) return false;
  if ('has' in providerIds) return providerIds.has(providerId);
  return providerIds.includes(providerId);
};

type UsageProviderInclusionOptions = {
  configured?: boolean;
  /** Quota IDs mapped from OpenCode-connected providers (Settings → Providers). */
  connectedQuotaProviderIds?: ReadonlySet<string> | readonly string[];
};

/** Provider is eligible for Usage (quota-configured and/or OpenCode-connected). */
export const isIncludedUsageProvider = (
  providerId: string,
  options: UsageProviderInclusionOptions,
): boolean => {
  if (options.configured) return true;
  return hasProviderId(options.connectedQuotaProviderIds, providerId);
};
