import { resolveUsageProviderId } from './providerAliases';

export type UsageMetricMode = 'tokens' | 'cost' | 'requests';

export type UsagePeriodSelection =
  | { kind: 'days'; days: number }
  | { kind: 'range'; startDay: string; endDay: string };

export interface UsageHistoryRecord {
  dayKey: string;
  providerId: string;
  cost: number;
  tokens: number;
  requests: number;
}

export interface DailyUsagePoint {
  dayKey: string;
  dayStartMs: number;
  cost: number;
  tokens: number;
  requests: number;
  byProvider: Record<string, { cost: number; tokens: number; requests: number }>;
}

interface ProviderPeriodTotals {
  providerId: string;
  cost: number;
  tokens: number;
  requests: number;
}

interface PeriodUsageSummary {
  rangeStartMs: number;
  rangeEndMs: number;
  previousStartMs: number;
  previousEndMs: number;
  days: DailyUsagePoint[];
  totals: { cost: number; tokens: number; requests: number };
  previousTotals: { cost: number; tokens: number; requests: number };
  byProvider: ProviderPeriodTotals[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const dayKeyFromMs = (ms: number): string => {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const startOfLocalDay = (ms: number): number => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const addLocalDays = (ms: number, days: number): number => {
  const date = new Date(ms);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const endOfLocalDay = (ms: number): number => addLocalDays(ms, 1) - 1;

const parseLocalDay = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return startOfLocalDay(date.getTime());
};

const localDayOrdinal = (ms: number): number => {
  const date = new Date(ms);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
};

const countDaysInclusive = (startMs: number, endMs: number): number =>
  localDayOrdinal(endMs) - localDayOrdinal(startMs) + 1;

export const resolveUsagePeriod = (
  period: UsagePeriodSelection,
  nowMs: number,
  minimumDayKey?: string,
): { startMs: number; endMs: number; days: number } => {
  const nowDay = startOfLocalDay(nowMs);
  const minDay = Math.min(parseLocalDay(minimumDayKey) ?? Number.NEGATIVE_INFINITY, nowDay);
  const clamp = (ms: number) => Math.max(minDay, Math.min(ms, nowDay));

  if (period.kind === 'range') {
    const rawStart = parseLocalDay(period.startDay) ?? nowDay;
    const rawEnd = parseLocalDay(period.endDay) ?? nowDay;
    const startMs = clamp(Math.min(rawStart, rawEnd));
    const endMs = clamp(Math.max(rawStart, rawEnd));
    return { startMs, endMs, days: countDaysInclusive(startMs, endMs) };
  }

  const days = Number.isFinite(period.days) ? Math.max(1, Math.round(period.days)) : 1;
  const startMs = addLocalDays(nowDay, -(days - 1));
  return { startMs, endMs: nowDay, days: countDaysInclusive(startMs, nowDay) };
};

export const sessionTokenTotal = (tokens: {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
} | null | undefined): number => {
  if (!tokens) return 0;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + cacheRead + cacheWrite;
};

export const percentChange = (current: number, previous: number): number | null => {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) {
    if (current === 0) return 0;
    return null;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
};

export const averageCostPer1kTokens = (cost: number, tokens: number): number | null => {
  if (!Number.isFinite(cost) || !Number.isFinite(tokens) || tokens <= 0) return null;
  return (cost / tokens) * 1000;
};

const emptyDay = (dayStartMs: number): DailyUsagePoint => ({
  dayKey: dayKeyFromMs(dayStartMs),
  dayStartMs,
  cost: 0,
  tokens: 0,
  requests: 0,
  byProvider: {},
});

const accumulateInto = (
  target: { cost: number; tokens: number; requests: number },
  record: Pick<UsageHistoryRecord, 'cost' | 'tokens' | 'requests'>,
) => {
  target.cost += record.cost;
  target.tokens += record.tokens;
  target.requests += record.requests;
};

export const buildPeriodUsageSummary = (
  records: readonly UsageHistoryRecord[],
  options: {
    period: UsagePeriodSelection;
    nowMs?: number;
    providerFilter?: string | null;
    minimumDayKey?: string;
  },
): PeriodUsageSummary => {
  const nowMs = options.nowMs ?? Date.now();
  const { startMs: rangeStartMs, endMs: rangeEndDayMs, days } = resolveUsagePeriod(
    options.period,
    nowMs,
    options.minimumDayKey,
  );
  const rangeEndMs = Math.min(endOfLocalDay(rangeEndDayMs), nowMs);
  const previousEndMs = rangeStartMs;
  const previousStartMs = addLocalDays(rangeStartMs, -days);

  const points: DailyUsagePoint[] = [];
  const dayIndex = new Map<string, DailyUsagePoint>();
  for (let offset = 0; offset < days; offset += 1) {
    const dayStartMs = addLocalDays(rangeStartMs, offset);
    const point = emptyDay(dayStartMs);
    points.push(point);
    dayIndex.set(point.dayKey, point);
  }

  const totals = { cost: 0, tokens: 0, requests: 0 };
  const previousTotals = { cost: 0, tokens: 0, requests: 0 };
  const providerTotals = new Map<string, ProviderPeriodTotals>();
  const providerFilter = resolveUsageProviderId(options.providerFilter);

  for (const record of records) {
    const dayMs = parseLocalDay(record.dayKey);
    if (dayMs === null) continue;
    const providerId = resolveUsageProviderId(record.providerId);
    if (!providerId) continue;
    if (providerFilter && providerId !== providerFilter) continue;

    if (dayMs >= rangeStartMs && dayMs <= rangeEndDayMs) {
      accumulateInto(totals, record);
      const day = dayIndex.get(record.dayKey);
      if (day) {
        day.cost += record.cost;
        day.tokens += record.tokens;
        day.requests += record.requests;
        const bucket = day.byProvider[providerId] ?? { cost: 0, tokens: 0, requests: 0 };
        bucket.cost += record.cost;
        bucket.tokens += record.tokens;
        bucket.requests += record.requests;
        day.byProvider[providerId] = bucket;

        const provider = providerTotals.get(providerId) ?? { providerId, cost: 0, tokens: 0, requests: 0 };
        provider.cost += record.cost;
        provider.tokens += record.tokens;
        provider.requests += record.requests;
        providerTotals.set(providerId, provider);
      }
      continue;
    }

    if (dayMs >= previousStartMs && dayMs < previousEndMs) {
      accumulateInto(previousTotals, record);
    }
  }

  const byProvider = Array.from(providerTotals.values())
    .sort((left, right) => right.cost - left.cost || right.tokens - left.tokens);

  return {
    rangeStartMs,
    rangeEndMs,
    previousStartMs,
    previousEndMs,
    days: points,
    totals,
    previousTotals,
    byProvider,
  };
};

/** Aggregate per-provider (day, provider) records; keeps the first provider display name. */
export const aggregateUsageRecords = (
  rows: readonly { dayKey: string; providerId: string; providerName?: string; cost: number; tokens: number; requests: number }[],
): { records: UsageHistoryRecord[]; providerNames: Map<string, string> } => {
  const byKey = new Map<string, UsageHistoryRecord>();
  const providerNames = new Map<string, string>();
  for (const row of rows) {
    const providerId = resolveUsageProviderId(row.providerId);
    const dayMs = parseLocalDay(row.dayKey);
    if (!providerId || dayMs === null) continue;
    const cost = Number.isFinite(row.cost) ? Math.max(0, row.cost) : 0;
    const tokens = Number.isFinite(row.tokens) ? Math.max(0, row.tokens) : 0;
    const requests = Number.isFinite(row.requests) ? Math.max(0, row.requests) : 0;
    if (cost === 0 && tokens === 0 && requests === 0) continue;
    const key = `${row.dayKey}::${providerId}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.cost += cost;
      existing.tokens += tokens;
      existing.requests += requests;
    } else {
      byKey.set(key, { dayKey: row.dayKey, providerId, cost, tokens, requests });
    }
    if (!providerNames.has(providerId)) {
      providerNames.set(providerId, row.providerName ?? row.providerId);
    }
  }
  return { records: Array.from(byKey.values()), providerNames };
};

export const formatCompactNumber = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (abs >= 100) return String(Math.round(value));
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
};

export const formatUsd = (value: number, digits?: number): string => {
  if (!Number.isFinite(value)) return '—';
  const precision = digits ?? (value !== 0 && Math.abs(value) < 0.01 ? 4 : 2);
  return `$${value.toFixed(precision)}`;
};

export const formatSignedUsd = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${prefix}${formatUsd(Math.abs(value))}`;
};

export const formatSignedCompact = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const prefix = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${prefix}${formatCompactNumber(Math.abs(value))}`;
};

export const formatPercentDelta = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const prefix = rounded > 0 ? '+' : '';
  return `${prefix}${rounded}%`;
};

const CHART_SERIES_COLORS = [
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-1)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

export const colorForProviderIndex = (index: number): string =>
  CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length];
