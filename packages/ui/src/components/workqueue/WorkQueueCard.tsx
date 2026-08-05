import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorkQueueStore } from '@/stores/useWorkQueueStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
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
    const { workQueue } = useRuntimeAPIs();
    const analyzeItem = useWorkQueueStore((state) => state.analyzeItem);
    const pendingIds = useWorkQueueStore((state) => state.pendingIds);
    const projects = useProjectsStore((state) => state.projects);
    const activeProject = useProjectsStore((state) => state.getActiveProject());
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const [isAnalyzing, setIsAnalyzing] = React.useState(false);

    const analysis = item.aiAnalysis;
    const issueType = deriveIssueType(item);
    const borderClass = analysis ? PRIORITY_BORDER_CLASS[analysis.priority] : 'border-l-border';
    const issueNumber = item.source === 'github' ? (item.sourceId.match(/#\d+$/)?.[0] ?? '') : item.identifier;

    // Same project-directory resolution as the detail panel: analysis needs a
    // checkout to ground its claims in the real commit log.
    const projectDirectory = React.useMemo(() => {
      if (activeProject?.path) return activeProject.path;
      if (currentDirectory) {
        const match = projects.find((project) => project.path === currentDirectory);
        if (match) return match.path;
      }
      return projects[0]?.path || null;
    }, [activeProject?.path, currentDirectory, projects]);

    // The card root handles click (select) and drag (dnd-kit listeners), so a
    // button nested inside must stop both or pressing it would select the
    // card / start a drag instead of analyzing.
    const stopCardInteraction = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    const isBusy = isAnalyzing || pendingIds.has(item.id);

    const handleAnalyze = async (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (!workQueue || isBusy) return;
      setIsAnalyzing(true);
      try {
        await analyzeItem(workQueue, item.id, projectDirectory || undefined);
      } catch (error) {
        toast.error(t('workQueue.detail.toast.analyzeFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsAnalyzing(false);
      }
    };

    return (
      <div
        ref={ref}
        style={style}
        data-wq-card
        data-wq-card-id={item.id}
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
            <span className="ml-auto inline-flex items-center gap-1.5">
              <span className="inline-flex items-center gap-1 typography-micro text-muted-foreground/70">
                <Icon name="sparkling" className="h-3 w-3" />
                {t('workQueue.card.confidence', { confidence: analysis.confidence })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={t('workQueue.card.reanalyze')}
                title={t('workQueue.card.reanalyze')}
                onClick={handleAnalyze}
                onPointerDown={stopCardInteraction}
                onKeyDown={stopCardInteraction}
                disabled={isBusy}
              >
                <Icon name="sparkling" className={isBusy ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
              </Button>
            </span>
          </div>
        ) : item.aiAnalysisError ? (
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <span className="typography-micro text-destructive">{t('workQueue.card.analysisError')}</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="gap-1"
              onClick={handleAnalyze}
              onPointerDown={stopCardInteraction}
              onKeyDown={stopCardInteraction}
              disabled={isBusy}
            >
              <Icon name="sparkling" className={isBusy ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
              {t('workQueue.card.analyze')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="default"
            size="xs"
            className="gap-1 self-start"
            onClick={handleAnalyze}
            onPointerDown={stopCardInteraction}
            onKeyDown={stopCardInteraction}
            disabled={isBusy}
          >
            <Icon name="sparkling" className={isBusy ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
            {isBusy ? t('workQueue.card.analyzing') : t('workQueue.card.analyze')}
          </Button>
        )}
      </div>
    );
  },
);

WorkQueueCard.displayName = 'WorkQueueCard';
