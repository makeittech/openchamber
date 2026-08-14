import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_ICON_BUTTON_CLASS,
  SettingsChipGroup,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  averageCostPer1kTokens,
  buildPeriodUsageSummary,
  colorForProviderIndex,
  dayKeyFromMs,
  formatCompactNumber,
  formatPercentDelta,
  formatSignedCompact,
  formatSignedUsd,
  formatUsd,
  percentChange,
  resolveUsagePeriod,
  type UsageMetricMode,
  type UsagePeriodSelection,
} from '@/lib/quota';
import { useUsageHistory, useUsageSessions } from '@/lib/quota/useUsageHistory';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { cn } from '@/lib/utils';
import type { DailyUsagePoint } from '@/lib/quota/usagePeriodStats';
import { UsageAreaChart } from './UsageAreaChart';
import { UsageDonutChart } from './UsageDonutChart';
import { UsagePeriodSelector } from './UsagePeriodSelector';
import { buildUsageProviderCatalog, getProviderRemainingDisplay } from './usageProviderHelpers';

const OTHER_SERIES_ID = '__other__';
const MAX_PROVIDER_SERIES = 5;

const DeltaBadge: React.FC<{
  delta: number | null;
  invert?: boolean;
  label: string;
}> = ({ delta, invert = false, label }) => {
  if (delta === null) {
    return <span className="typography-micro text-muted-foreground">{label}</span>;
  }
  // For spend/tokens/requests, increases are "worse" (red); cost-per-token decreases are better (green).
  const toneClass = invert
    ? (delta < 0 ? 'text-[var(--status-success)]' : delta > 0 ? 'text-[var(--status-error)]' : 'text-muted-foreground')
    : (delta > 0 ? 'text-[var(--status-error)]' : delta < 0 ? 'text-[var(--status-success)]' : 'text-muted-foreground');
  return <span className={cn('typography-micro tabular-nums', toneClass)}>{label}</span>;
};

export const UsageOverview: React.FC = () => {
  const { t, locale } = useI18n();
  const results = useQuotaStore((state) => state.results);
  const hiddenProviderIds = useQuotaStore((state) => state.hiddenProviderIds);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const loadSettings = useQuotaStore((state) => state.loadSettings);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);
  const configProviders = useConfigStore((state) => state.providers);

  const [period, setPeriod] = React.useState<UsagePeriodSelection>({ kind: 'days', days: 7 });
  const [metric, setMetric] = React.useState<UsageMetricMode>('cost');
  const [tick, setTick] = React.useState(0);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    void loadSettings();
    void fetchAllQuotas();
  }, [loadSettings, fetchAllQuotas]);

  React.useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const {
    sessions,
    status: sessionSourceStatus,
    minimumDayKey,
    refresh: refreshSessions,
  } = useUsageSessions(tick);
  const analysisNowMs = React.useMemo(() => {
    void tick;
    return Date.now();
  }, [tick]);
  const resolvedPeriod = React.useMemo(
    () => resolveUsagePeriod(period, analysisNowMs, minimumDayKey),
    [analysisNowMs, minimumDayKey, period],
  );
  const historyMinDayKey = React.useMemo(() => {
    const previousStart = new Date(resolvedPeriod.startMs);
    previousStart.setDate(previousStart.getDate() - resolvedPeriod.days);
    return dayKeyFromMs(previousStart.getTime());
  }, [resolvedPeriod]);
  const history = useUsageHistory(sessions, {
    minDayKey: historyMinDayKey,
    refreshKey: tick,
    sourceStatus: sessionSourceStatus,
  });
  const hiddenSet = React.useMemo(() => new Set<string>(hiddenProviderIds), [hiddenProviderIds]);
  const visibleHistoryRecords = React.useMemo(
    () => history.records.filter((record) => !hiddenSet.has(record.providerId)),
    [hiddenSet, history.records],
  );

  const periodSummary = React.useMemo(
    () => buildPeriodUsageSummary(visibleHistoryRecords, {
      period,
      nowMs: analysisNowMs,
      minimumDayKey,
    }),
    [analysisNowMs, minimumDayKey, period, visibleHistoryRecords],
  );

  const catalog = React.useMemo(() => buildUsageProviderCatalog({
    configProviders,
    quotaResults: results,
    usageProviderNames: history.providerNames,
  }), [configProviders, results, history.providerNames]);

  const catalogById = React.useMemo(() => new Map(catalog.map((entry) => [entry.id, entry])), [catalog]);

  const providerColorById = React.useMemo(() => {
    const map = new Map<string, string>();
    periodSummary.byProvider.forEach((entry, index) => {
      map.set(entry.providerId, colorForProviderIndex(index));
    });
    return map;
  }, [periodSummary.byProvider]);

  const chartData = React.useMemo(() => {
    const topIds = [...periodSummary.byProvider]
      .sort((left, right) => right[metric] - left[metric])
      .slice(0, MAX_PROVIDER_SERIES)
      .map((entry) => entry.providerId);
    const topSet = new Set(topIds);
    const days: DailyUsagePoint[] = periodSummary.days.map((day) => {
      let otherCost = 0;
      let otherTokens = 0;
      let otherRequests = 0;
      for (const [providerId, bucket] of Object.entries(day.byProvider)) {
        if (topSet.has(providerId)) continue;
        otherCost += bucket.cost;
        otherTokens += bucket.tokens;
        otherRequests += bucket.requests;
      }
      const byProvider = topIds.length === 0 || (otherCost === 0 && otherTokens === 0 && otherRequests === 0)
        ? day.byProvider
        : {
            ...day.byProvider,
            [OTHER_SERIES_ID]: { cost: otherCost, tokens: otherTokens, requests: otherRequests },
          };
      return { ...day, byProvider };
    });
    const hasOther = days.some((day) => {
      const bucket = day.byProvider[OTHER_SERIES_ID];
      return bucket !== undefined && (bucket.cost > 0 || bucket.tokens > 0 || bucket.requests > 0);
    });
    const ids = hasOther ? [...topIds, OTHER_SERIES_ID] : topIds;
    const series = ids.map((id, index) => ({
      id,
      label: id === OTHER_SERIES_ID ? t('settings.usage.overview.providers.other') : catalogById.get(id)?.name ?? id,
      color: id === OTHER_SERIES_ID
        ? 'var(--muted-foreground)'
        : colorForProviderIndex(index),
    }));
    return { days, series };
  }, [catalogById, metric, periodSummary.byProvider, periodSummary.days, t]);

  const spendDelta = periodSummary.totals.cost - periodSummary.previousTotals.cost;
  const spendDeltaPct = percentChange(periodSummary.totals.cost, periodSummary.previousTotals.cost);
  const tokenDelta = periodSummary.totals.tokens - periodSummary.previousTotals.tokens;
  const tokenDeltaPct = percentChange(periodSummary.totals.tokens, periodSummary.previousTotals.tokens);
  const requestDelta = periodSummary.totals.requests - periodSummary.previousTotals.requests;
  const requestDeltaPct = percentChange(periodSummary.totals.requests, periodSummary.previousTotals.requests);
  const avgCost = averageCostPer1kTokens(periodSummary.totals.cost, periodSummary.totals.tokens);
  const prevAvgCost = averageCostPer1kTokens(periodSummary.previousTotals.cost, periodSummary.previousTotals.tokens);
  const avgCostDelta = avgCost !== null && prevAvgCost !== null ? avgCost - prevAvgCost : null;
  const avgCostDeltaPct = avgCost !== null && prevAvgCost !== null ? percentChange(avgCost, prevAvgCost) : null;
  const previousPeriodLabel = t('settings.usage.overview.metric.vsPrevious');

  const dayFormatter = React.useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
    [locale],
  );
  const preciseNumberFormatter = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const formatDay = React.useCallback((ms: number) => dayFormatter.format(new Date(ms)), [dayFormatter]);

  const rangeLabel = React.useMemo(() => {
    const withYear = new Date(periodSummary.rangeStartMs).getFullYear() !== new Date(periodSummary.rangeEndMs).getFullYear();
    const format = withYear
      ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' })
      : dayFormatter;
    return `${format.format(new Date(periodSummary.rangeStartMs))} – ${format.format(new Date(periodSummary.rangeEndMs))}`;
  }, [dayFormatter, locale, periodSummary.rangeEndMs, periodSummary.rangeStartMs]);

  const formatMetricValue = React.useCallback((value: number) => (
    metric === 'cost' ? formatUsd(value, 4) : preciseNumberFormatter.format(value)
  ), [metric, preciseNumberFormatter]);

  const donutSlices = periodSummary.byProvider
    .filter((entry) => entry.cost > 0)
    .map((entry) => ({
      id: entry.providerId,
      label: catalogById.get(entry.providerId)?.name ?? entry.providerId,
      value: entry.cost,
      color: providerColorById.get(entry.providerId) ?? colorForProviderIndex(0),
    }));

  const tableRows = React.useMemo(() => {
    const totalsById = new Map(periodSummary.byProvider.map((entry) => [entry.providerId, entry]));
    const ids = new Set<string>([...catalog.map((entry) => entry.id), ...totalsById.keys()]);
    return Array.from(ids)
      .filter((id) => !hiddenSet.has(id))
      .map((id) => {
        const meta = catalogById.get(id);
        const totals = totalsById.get(id) ?? { cost: 0, tokens: 0, requests: 0 };
        const quotaResult = meta?.quotaProviderId
          ? results.find((entry) => entry.providerId === meta.quotaProviderId) ?? null
          : null;
        return {
          id,
          name: meta?.name ?? id,
          totals,
          remaining: getProviderRemainingDisplay(quotaResult?.usage),
        };
      })
      .sort((left, right) => right.totals.cost - left.totals.cost || right.totals.tokens - left.totals.tokens);
  }, [catalog, catalogById, hiddenSet, periodSummary.byProvider, results]);

  return (
    <SettingsPageLayout
      className="max-w-[1100px]"
      title={t('settings.usage.overview.title')}
      description={t('settings.usage.overview.description')}
      headerEnd={(
        <div className="flex flex-wrap items-center gap-2">
          <UsagePeriodSelector
            period={period}
            onChange={setPeriod}
            minDayKey={minimumDayKey}
            maxDayKey={dayKeyFromMs(analysisNowMs)}
          />
          <span className="typography-meta text-muted-foreground tabular-nums">{rangeLabel}</span>
          <Button
            size="sm"
            variant="ghost"
            className={SETTINGS_ICON_BUTTON_CLASS}
            onClick={() => {
              void fetchAllQuotas();
              void refreshSessions();
              setTick((value) => value + 1);
            }}
            aria-label={t('settings.usage.sidebar.actions.refreshAria')}
            title={t('settings.usage.sidebar.actions.refreshTitle')}
            disabled={isLoading}
          >
            <Icon name="refresh" className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
          </Button>
        </div>
      )}
      showSaveStatus
    >
      {(history.status === 'partial' || history.status === 'error') && (
        <div className="mb-4 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-4 py-3">
          <p className="typography-meta text-[var(--status-warning)]">
            {t(history.status === 'error' ? 'settings.usage.overview.history.error' : 'settings.usage.overview.history.partial')}
          </p>
        </div>
      )}
      <SettingsSection divider={false} settingsItem="usage.overview">
        <div className="grid gap-3 @xl:grid-cols-2 @3xl:grid-cols-4">
          {[
            {
              key: 'spend',
              icon: 'donut-chart' as const,
              label: t('settings.usage.overview.metric.totalSpend'),
              value: formatUsd(periodSummary.totals.cost),
              deltaLabel: `${formatSignedUsd(spendDelta)} (${formatPercentDelta(spendDeltaPct)}) ${previousPeriodLabel}`,
              delta: spendDeltaPct,
              invert: false,
            },
            {
              key: 'tokens',
              icon: 'stack' as const,
              label: t('settings.usage.overview.metric.totalTokens'),
              value: formatCompactNumber(periodSummary.totals.tokens),
              deltaLabel: `${formatSignedCompact(tokenDelta)} (${formatPercentDelta(tokenDeltaPct)}) ${previousPeriodLabel}`,
              delta: tokenDeltaPct,
              invert: false,
            },
            {
              key: 'requests',
              icon: 'chat-3' as const,
              label: t('settings.usage.overview.metric.requests'),
              value: formatCompactNumber(periodSummary.totals.requests),
              deltaLabel: `${formatSignedCompact(requestDelta)} (${formatPercentDelta(requestDeltaPct)}) ${previousPeriodLabel}`,
              delta: requestDeltaPct,
              invert: false,
            },
            {
              key: 'avg',
              icon: 'flashlight' as const,
              label: t('settings.usage.overview.metric.avgCost'),
              value: avgCost === null ? '—' : formatUsd(avgCost),
              deltaLabel: avgCostDelta === null
                ? '—'
                : `${formatSignedUsd(avgCostDelta)} (${formatPercentDelta(avgCostDeltaPct)}) ${previousPeriodLabel}`,
              delta: avgCostDeltaPct,
              invert: true,
            },
          ].map((card) => (
            <div
              key={card.key}
              className="rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-4 py-3"
            >
              <div className="flex items-center gap-2 text-muted-foreground">
                <Icon name={card.icon} className="h-3.5 w-3.5" />
                <span className="typography-micro">{card.label}</span>
              </div>
              <div className="mt-2 typography-ui-header tabular-nums text-foreground">{card.value}</div>
              <div className="mt-1">
                <DeltaBadge delta={card.delta} invert={card.invert} label={card.deltaLabel} />
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection>
        <div className="grid gap-4 @3xl:grid-cols-[minmax(0,1.4fr)_minmax(16rem,0.8fr)]">
          <div className="rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h3 className="typography-ui-header font-medium text-foreground">
                {t('settings.usage.overview.chart.usageOverTime')}
              </h3>
              <SettingsChipGroup
                aria-label={t('settings.usage.overview.chart.metricAria')}
                value={metric}
                onChange={(value) => setMetric(value as UsageMetricMode)}
                options={[
                  { value: 'tokens', label: t('settings.usage.overview.chart.metric.tokens') },
                  { value: 'cost', label: t('settings.usage.overview.chart.metric.cost') },
                  { value: 'requests', label: t('settings.usage.overview.chart.metric.requests') },
                ]}
              />
            </div>
            {history.status === 'loading' && history.records.length === 0 ? (
              <div className="flex h-[180px] items-center justify-center typography-meta text-muted-foreground">
                {t('settings.usage.overview.history.loading')}
              </div>
            ) : (
              <UsageAreaChart
                days={chartData.days}
                metric={metric}
                series={chartData.series}
                ariaLabel={t('settings.usage.overview.chart.usageOverTime')}
                emptyLabel={t('settings.usage.overview.chart.empty')}
                formatValue={formatMetricValue}
                formatDay={formatDay}
              />
            )}
            {chartData.series.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3">
                {chartData.series.map((entry) => (
                  <div key={entry.id} className="flex items-center gap-1.5 typography-micro text-muted-foreground">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
                    <span>{entry.label}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-4">
            <h3 className="mb-4 typography-ui-header font-medium text-foreground">
              {t('settings.usage.overview.chart.topProviders')}
            </h3>
            <UsageDonutChart
              slices={donutSlices}
              centerLabel={t('settings.usage.overview.metric.totalSpend')}
              centerValue={formatUsd(periodSummary.totals.cost)}
              emptyLabel={t('settings.usage.overview.chart.empty')}
              ariaLabel={t('settings.usage.overview.chart.topProviders')}
              formatValue={(value) => formatUsd(value, 4)}
            />
            <div className="mt-4 space-y-2">
              {donutSlices.map((slice) => {
                const share = periodSummary.totals.cost > 0
                  ? Math.round((slice.value / periodSummary.totals.cost) * 100)
                  : 0;
                return (
                  <div key={slice.id} className="flex items-center justify-between gap-2 typography-meta">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: slice.color }} />
                      <span className="truncate text-foreground">{slice.label}</span>
                    </div>
                    <span className="tabular-nums text-muted-foreground">
                      {formatUsd(slice.value)} ({share}%)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.usage.overview.providers.title')}>
        {tableRows.length === 0 ? (
          <p className="typography-meta text-muted-foreground">{t('settings.usage.overview.empty.description')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] typography-meta">
              <thead>
                <tr className="border-b border-[var(--surface-subtle)] text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('settings.usage.overview.providers.col.provider')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('settings.usage.overview.providers.col.spend')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('settings.usage.overview.providers.col.tokens')}</th>
                  <th className="py-2 pr-3 text-right font-medium">{t('settings.usage.overview.providers.col.requests')}</th>
                  <th className="py-2 text-right font-medium">{t('settings.usage.overview.providers.col.remaining')}</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row) => {
                  const hasUsage = row.totals.cost > 0 || row.totals.tokens > 0 || row.totals.requests > 0;
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-[var(--surface-subtle)] last:border-0"
                    >
                      <td className="py-2 pr-3">
                        <button
                          type="button"
                          className="flex max-w-full items-center gap-2 text-left text-foreground hover:underline"
                          aria-label={t('settings.usage.overview.providers.openDetailAria', { provider: row.name })}
                          onClick={() => setSelectedProvider(row.id)}
                        >
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: providerColorById.get(row.id) ?? 'var(--surface-subtle)' }} />
                          <span className="truncate">{row.name}</span>
                        </button>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-foreground">{hasUsage ? formatUsd(row.totals.cost) : t('settings.usage.overview.providers.noUsage')}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{hasUsage ? formatCompactNumber(row.totals.tokens) : '—'}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{hasUsage ? formatCompactNumber(row.totals.requests) : '—'}</td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">
                        {row.remaining?.kind === 'percent'
                          ? t('settings.usage.overview.providers.remainingPct', { percent: row.remaining.percent })
                          : row.remaining?.kind === 'amount'
                            ? row.remaining.label
                            : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
