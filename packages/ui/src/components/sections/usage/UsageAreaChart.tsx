import React from 'react';
import type { UsageMetricMode } from '@/lib/quota';
import type { DailyUsagePoint } from '@/lib/quota/usagePeriodStats';

interface SeriesDef {
  id: string;
  label: string;
  color: string;
}

interface UsageAreaChartProps {
  days: DailyUsagePoint[];
  metric: UsageMetricMode;
  series: SeriesDef[];
  ariaLabel: string;
  emptyLabel: string;
  formatValue: (value: number) => string;
  formatDay: (dayStartMs: number) => string;
}

const WIDTH = 640;
const HEIGHT = 180;
const PAD_X = 4;
const PAD_Y = 8;

const metricValue = (point: DailyUsagePoint, metric: UsageMetricMode, seriesId: string): number => {
  const bucket = point.byProvider[seriesId];
  if (!bucket) return 0;
  if (metric === 'cost') return bucket.cost;
  if (metric === 'requests') return bucket.requests;
  return bucket.tokens;
};

interface XY {
  x: number;
  y: number;
}

const toPoints = (values: number[], maxValue: number): XY[] => {
  const innerWidth = WIDTH - PAD_X * 2;
  const innerHeight = HEIGHT - PAD_Y * 2;
  const step = values.length <= 1 ? 0 : innerWidth / (values.length - 1);
  return values.map((value, index) => ({
    x: PAD_X + index * step,
    y: PAD_Y + innerHeight - (maxValue <= 0 ? 0 : (value / maxValue) * innerHeight),
  }));
};

/** Cubic segments with horizontal tangents; smooth and bounded by adjacent values. */
// eslint-disable-next-line react-refresh/only-export-components
export const buildSmoothLinePath = (points: XY[]): string => {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0].x},${points[0].y}`;
  const parts = [`M${points[0].x},${points[0].y}`];
  for (let i = 0; i < points.length - 1; i += 1) {
    const current = points[i];
    const next = points[i + 1];
    const midpointX = (current.x + next.x) / 2;
    parts.push(`C${midpointX},${current.y} ${midpointX},${next.y} ${next.x},${next.y}`);
  }
  return parts.join(' ');
};

const smoothArea = (points: XY[]): string => {
  if (points.length === 0) return '';
  const line = buildSmoothLinePath(points);
  const last = points[points.length - 1];
  return `${line} L${last.x},${HEIGHT - PAD_Y} L${points[0].x},${HEIGHT - PAD_Y} Z`;
};

export const UsageAreaChart: React.FC<UsageAreaChartProps> = ({
  days,
  metric,
  series,
  ariaLabel,
  emptyLabel,
  formatValue,
  formatDay,
}) => {
  const [hoverIndex, setHoverIndex] = React.useState<number | null>(null);

  const seriesValues = React.useMemo(
    () => series.map((entry) => days.map((day) => metricValue(day, metric, entry.id))),
    [days, metric, series],
  );
  const maxValue = React.useMemo(() => {
    let max = 0;
    for (const values of seriesValues) {
      for (const value of values) {
        if (value > max) max = value;
      }
    }
    return max;
  }, [seriesValues]);

  const seriesPoints = React.useMemo(
    () => seriesValues.map((values) => toPoints(values, maxValue)),
    [seriesValues, maxValue],
  );

  const hasData = maxValue > 0;
  const svgRef = React.useRef<SVGSVGElement | null>(null);

  const handleMove = React.useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || days.length === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.round(ratio * (days.length - 1));
    setHoverIndex(Math.max(0, Math.min(days.length - 1, index)));
  }, [days.length]);

  const hovered = hoverIndex !== null ? days[hoverIndex] : null;
  const hoveredLabel = hovered
    ? `${formatDay(hovered.dayStartMs)}: ${series.map((entry, index) => (
        `${entry.label} ${formatValue(seriesValues[index]?.[hoverIndex ?? 0] ?? 0)}`
      )).join(', ')}`
    : '';

  return (
    <div
      className="w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
      role="img"
      aria-label={ariaLabel}
      tabIndex={hasData ? 0 : undefined}
      onFocus={() => setHoverIndex((current) => current ?? Math.max(0, days.length - 1))}
      onBlur={() => setHoverIndex(null)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const direction = event.key === 'ArrowLeft' ? -1 : 1;
        setHoverIndex((current) => Math.max(0, Math.min(days.length - 1, (current ?? days.length - 1) + direction)));
      }}
    >
      {!hasData ? (
        <div className="flex h-[180px] items-center justify-center rounded-lg border border-dashed border-[var(--interactive-border)] typography-meta text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <>
          <div className="relative">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              className="h-[180px] w-full"
              preserveAspectRatio="none"
              onPointerMove={handleMove}
              onPointerLeave={() => setHoverIndex(null)}
            >
              <line
                x1={PAD_X}
                x2={WIDTH - PAD_X}
                y1={HEIGHT - PAD_Y}
                y2={HEIGHT - PAD_Y}
                stroke="var(--surface-subtle)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              {series.map((entry, index) => {
                const points = seriesPoints[index] ?? [];
                const pointIndex = hoverIndex ?? (points.length === 1 ? 0 : null);
                return (
                  <g key={entry.id}>
                    <path d={smoothArea(points)} fill={entry.color} fillOpacity={0.14} stroke="none" />
                    <path
                      d={buildSmoothLinePath(points)}
                      fill="none"
                      stroke={entry.color}
                      strokeWidth={2}
                      strokeLinecap="round"
                      vectorEffect="non-scaling-stroke"
                    />
                    {pointIndex !== null && points[pointIndex] && (
                      <circle
                        cx={points[pointIndex].x}
                        cy={points[pointIndex].y}
                        r={3.5}
                        fill={entry.color}
                        stroke="var(--surface-elevated)"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    )}
                  </g>
                );
              })}
              {hoverIndex !== null && days.length > 1 && seriesPoints[0]?.[hoverIndex] && (
                <line
                  x1={seriesPoints[0][hoverIndex].x}
                  x2={seriesPoints[0][hoverIndex].x}
                  y1={PAD_Y}
                  y2={HEIGHT - PAD_Y}
                  stroke="var(--surface-subtle)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
            {hovered && (
              <div
                className="pointer-events-none absolute top-1 z-10 min-w-28 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-1.5 shadow-sm"
                style={{
                  left: `${((hoverIndex ?? 0) / Math.max(1, days.length - 1)) * 100}%`,
                  transform: (hoverIndex ?? 0) / Math.max(1, days.length - 1) > 0.6 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
                }}
              >
                <div className="typography-micro text-muted-foreground tabular-nums">{formatDay(hovered.dayStartMs)}</div>
                <div className="mt-0.5 space-y-0.5">
                  {series.map((entry, index) => (
                    <div key={entry.id} className="flex items-center justify-between gap-3 typography-micro">
                      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
                        <span className="truncate">{entry.label}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-foreground">
                        {formatValue(seriesValues[index]?.[hoverIndex ?? 0] ?? 0)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="mt-1 flex justify-between typography-micro text-muted-foreground tabular-nums">
            <span>{days[0] ? formatDay(days[0].dayStartMs) : ''}</span>
            <span>{days[days.length - 1] ? formatDay(days[days.length - 1].dayStartMs) : ''}</span>
          </div>
          <span className="sr-only" aria-live="polite">{hoveredLabel}</span>
        </>
      )}
    </div>
  );
};
