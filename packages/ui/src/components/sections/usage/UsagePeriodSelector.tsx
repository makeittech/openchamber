import React from 'react';
import { SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { dayKeyFromMs, type UsagePeriodSelection } from '@/lib/quota';

const PRESET_DAYS = [7, 30, 90] as const;

const DATE_INPUT_CLASS = 'h-8 w-36 rounded-md px-2 typography-meta';

interface UsagePeriodSelectorProps {
  period: UsagePeriodSelection;
  onChange: (period: UsagePeriodSelection) => void;
  minDayKey: string;
  maxDayKey: string;
}

export const UsagePeriodSelector: React.FC<UsagePeriodSelectorProps> = ({
  period,
  onChange,
  minDayKey,
  maxDayKey,
}) => {
  const { t } = useI18n();

  const chipValue = period.kind === 'days' && (PRESET_DAYS as readonly number[]).includes(period.days)
    ? String(period.days)
    : 'custom';

  const handleChip = React.useCallback((value: string) => {
    if (value !== 'custom') {
      onChange({ kind: 'days', days: Number(value) });
      return;
    }
    if (period.kind === 'range') return;
    const days = period.kind === 'days' ? period.days : 30;
    const start = new Date(`${maxDayKey}T00:00:00`);
    start.setDate(start.getDate() - (days - 1));
    const startDay = dayKeyFromMs(start.getTime());
    onChange({
      kind: 'range',
      startDay: startDay < minDayKey ? minDayKey : startDay,
      endDay: maxDayKey,
    });
  }, [maxDayKey, minDayKey, onChange, period]);

  const handleDate = React.useCallback((key: 'startDay' | 'endDay', value: string) => {
    if (period.kind !== 'range' || !value) return;
    if (key === 'startDay') {
      onChange({ ...period, startDay: value, endDay: value > period.endDay ? value : period.endDay });
    } else {
      onChange({ ...period, endDay: value, startDay: value < period.startDay ? value : period.startDay });
    }
  }, [onChange, period]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SettingsChipGroup
        aria-label={t('settings.usage.overview.period.aria')}
        value={chipValue}
        onChange={handleChip}
        options={[
          { value: '7', label: t('settings.usage.overview.period.7d') },
          { value: '30', label: t('settings.usage.overview.period.30d') },
          { value: '90', label: t('settings.usage.overview.period.90d') },
          { value: 'custom', label: t('settings.usage.overview.period.custom') },
        ]}
      />
      {period.kind === 'range' && (
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            className={DATE_INPUT_CLASS}
            aria-label={t('settings.usage.overview.period.fromAria')}
            min={minDayKey}
            max={period.endDay}
            value={period.startDay}
            onChange={(event) => handleDate('startDay', event.target.value)}
          />
          <span className="typography-meta text-muted-foreground">–</span>
          <Input
            type="date"
            className={DATE_INPUT_CLASS}
            aria-label={t('settings.usage.overview.period.toAria')}
            min={period.startDay}
            max={maxDayKey}
            value={period.endDay}
            onChange={(event) => handleDate('endDay', event.target.value)}
          />
        </div>
      )}
    </div>
  );
};
