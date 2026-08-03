import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import type { WorkQueueComplexity, WorkQueuePriority } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import type { WorkQueueIssueType } from './deriveIssueType';

// Only four semantic status tones exist in the theme (error/warning/success/info),
// so priority/complexity/type all map onto that fixed ramp rather than any
// hardcoded palette color — see .agents/skills/theme-system.
const PRIORITY_CLASS: Record<WorkQueuePriority, string> = {
  critical: 'bg-status-error/15 text-status-error',
  high: 'bg-status-warning/15 text-status-warning',
  medium: 'bg-status-info/15 text-status-info',
  low: 'bg-muted text-muted-foreground',
};

const COMPLEXITY_CLASS: Record<WorkQueueComplexity, string> = {
  easy: 'bg-status-success/15 text-status-success',
  medium: 'bg-status-info/15 text-status-info',
  hard: 'bg-status-warning/15 text-status-warning',
  huge: 'bg-status-error/15 text-status-error',
};

const ISSUE_TYPE_CLASS: Record<WorkQueueIssueType, string> = {
  bug: 'bg-status-error/15 text-status-error',
  feature: 'bg-status-warning/15 text-status-warning',
  enhancement: 'bg-status-success/15 text-status-success',
  question: 'bg-status-info/15 text-status-info',
  documentation: 'bg-muted text-muted-foreground',
  other: 'bg-muted text-muted-foreground',
};

const badgeClass = 'inline-flex items-center rounded-md px-1.5 py-0.5 typography-micro font-medium leading-none';

export const WorkQueuePriorityBadge: React.FC<{ priority: WorkQueuePriority }> = ({ priority }) => {
  const { t } = useI18n();
  return (
    <span className={cn(badgeClass, PRIORITY_CLASS[priority])}>
      {t(`workQueue.priority.${priority}` as const)}
    </span>
  );
};

export const WorkQueueComplexityBadge: React.FC<{ complexity: WorkQueueComplexity }> = ({ complexity }) => {
  const { t } = useI18n();
  return (
    <span className={cn(badgeClass, COMPLEXITY_CLASS[complexity])}>
      {t(`workQueue.complexity.${complexity}` as const)}
    </span>
  );
};

export const WorkQueueIssueTypeBadge: React.FC<{ issueType: WorkQueueIssueType }> = ({ issueType }) => {
  const { t } = useI18n();
  if (issueType === 'other') return null;
  return (
    <span className={cn(badgeClass, ISSUE_TYPE_CLASS[issueType])}>
      {t(`workQueue.issueType.${issueType}` as const)}
    </span>
  );
};

export const WorkQueueEnvBadges: React.FC<{
  needsHeadless?: boolean;
  needsBrowser?: boolean;
  needsDocker?: boolean;
}> = ({ needsHeadless, needsBrowser, needsDocker }) => {
  const { t } = useI18n();
  if (!needsHeadless && !needsBrowser && !needsDocker) return null;
  return (
    <div className="flex items-center gap-2 text-muted-foreground">
      {needsHeadless && (
        <span className="inline-flex items-center gap-1 typography-micro" title={t('workQueue.env.headless')}>
          <Icon name="terminal-box" className="h-3 w-3" />
        </span>
      )}
      {needsBrowser && (
        <span className="inline-flex items-center gap-1 typography-micro" title={t('workQueue.env.browser')}>
          <Icon name="window" className="h-3 w-3" />
        </span>
      )}
      {needsDocker && (
        <span className="inline-flex items-center gap-1 typography-micro" title={t('workQueue.env.docker')}>
          <Icon name="stack" className="h-3 w-3" />
        </span>
      )}
    </div>
  );
};
