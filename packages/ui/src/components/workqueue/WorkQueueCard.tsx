import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { WorkQueueItem, WorkQueuePriority } from '@/lib/api/types';
import {
  WorkQueueComplexityBadge,
  WorkQueueEnvBadges,
  WorkQueueIssueTypeBadge,
  WorkQueuePriorityBadge,
} from './workQueueBadges';
import { deriveIssueType } from './deriveIssueType';

// Left-border accent so priority reads without having to read the badge
// text. Only this card uses it, so it stays out of workQueueBadges.tsx
// (which must only export components, per react-refresh/only-export-components).
const PRIORITY_BORDER_CLASS: Record<WorkQueuePriority, string> = {
  critical: 'border-l-status-error',
  high: 'border-l-status-warning',
  medium: 'border-l-status-info',
  low: 'border-l-border',
};

interface WorkQueueCardProps {
  item: WorkQueueItem;
  selected?: boolean;
  onSelect: (item: WorkQueueItem) => void;
  dragHandleProps?: React.HTMLAttributes<HTMLDivElement>;
  className?: string;
  style?: React.CSSProperties;
}

// Hierarchy top to bottom: title, priority, repo, type, confidence, metadata
// — matches the redesign's stated emphasis order so the eye lands on what
// the task is, how urgent it is, and where it lives before anything else.
export const WorkQueueCard = React.forwardRef<HTMLDivElement, WorkQueueCardProps>(
  ({ item, selected, onSelect, dragHandleProps, className, style }, ref) => {
    const { t } = useI18n();
    const analysis = item.aiAnalysis;
    const issueType = deriveIssueType(item);
    const borderClass = analysis ? PRIORITY_BORDER_CLASS[analysis.priority] : 'border-l-border';
    const issueNumber = item.source === 'github' ? (item.sourceId.match(/#\d+$/)?.[0] ?? '') : item.identifier;

    return (
      <div
        ref={ref}
        style={style}
        role="button"
        tabIndex={0}
        onClick={() => onSelect(item)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(item);
          }
        }}
        className={cn(
          // border-l-4 (width) is independent of the border-l-{color} tokens
          // in borderClass, so the two never fight over the same property.
          'flex min-h-[104px] flex-col gap-2 rounded-lg border-y border-r border-l-4 border-border/60 bg-card px-3 py-2.5 text-left shadow-sm transition-shadow',
          'hover:border-border hover:shadow-md cursor-pointer',
          selected ? 'border-primary bg-interactive-selection' : borderClass,
          className,
        )}
        {...dragHandleProps}
      >
        <div className="flex items-start justify-between gap-2">
          <span className="typography-ui-label font-medium text-foreground line-clamp-2">{item.title}</span>
          {item.type === 'pr' ? (
            <Icon name="git-pull-request" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          ) : (
            <Icon name="bug" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          )}
        </div>

        {analysis && (
          <div className="flex flex-wrap items-center gap-1.5">
            <WorkQueuePriorityBadge priority={analysis.priority} />
            <WorkQueueIssueTypeBadge issueType={issueType} />
          </div>
        )}

        <div className="flex items-center gap-1.5 typography-micro text-muted-foreground/70">
          <span className="truncate">{item.repo || item.team}</span>
          {issueNumber && (
            <>
              <span aria-hidden="true">&middot;</span>
              <span className="flex-shrink-0">{issueNumber}</span>
            </>
          )}
          {item.assignee && (
            <>
              <span aria-hidden="true">&middot;</span>
              <span className="truncate">{item.assignee}</span>
            </>
          )}
        </div>

        {analysis ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <WorkQueueComplexityBadge complexity={analysis.complexity} />
            {typeof analysis.estimateMinutes === 'number' && (
              <span className="inline-flex items-center gap-1 typography-micro text-muted-foreground">
                <Icon name="time" className="h-3 w-3" />
                {t('workQueue.card.estimateMinutes', { minutes: analysis.estimateMinutes })}
              </span>
            )}
            <WorkQueueEnvBadges
              needsHeadless={analysis.needsHeadless}
              needsBrowser={analysis.needsBrowser}
              needsDocker={analysis.needsDocker}
            />
            <span className="ml-auto inline-flex items-center gap-1 typography-micro text-muted-foreground/70">
              <Icon name="sparkling" className="h-3 w-3" />
              {t('workQueue.card.confidence', { confidence: analysis.confidence })}
            </span>
          </div>
        ) : item.aiAnalysisError ? (
          <span className="typography-micro text-destructive">{t('workQueue.card.analysisError')}</span>
        ) : (
          <span className="typography-micro text-muted-foreground/60">{t('workQueue.card.notAnalyzed')}</span>
        )}
      </div>
    );
  },
);

WorkQueueCard.displayName = 'WorkQueueCard';
