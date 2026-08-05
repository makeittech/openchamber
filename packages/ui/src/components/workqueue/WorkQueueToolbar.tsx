import React from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { WorkQueueItem, WorkQueueItemType, WorkQueuePriority, WorkQueueComplexity } from '@/lib/api/types';
import { WorkQueueFilterDropdown } from './WorkQueueFilterDropdown';
import { deriveIssueType, type WorkQueueIssueType } from './deriveIssueType';

/** '' keeps the board's own ordering; the rest re-rank by analysis output or date. */
export type WorkQueueSort = '' | 'criticality' | 'bugs' | 'features' | 'newest' | 'oldest';

export interface WorkQueueFilters {
  search: string;
  repo: string;
  assignee: string;
  type: WorkQueueItemType | '';
  issueType: WorkQueueIssueType | '';
  priority: WorkQueuePriority | '';
  complexity: WorkQueueComplexity | '';
  sort: WorkQueueSort;
}

const QUICK_ISSUE_TYPES: Exclude<WorkQueueIssueType, 'other'>[] = ['bug', 'feature', 'enhancement', 'question', 'documentation'];

interface WorkQueueToolbarProps {
  items: WorkQueueItem[];
  filters: WorkQueueFilters;
  onFiltersChange: (filters: WorkQueueFilters) => void;
  onResetFilters: () => void;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  onSync: () => void;
  isSyncing: boolean;
  onAnalyzeAll: () => void;
  isBulkAnalyzing: boolean;
  pendingAnalysisCount: number;
}

export const WorkQueueToolbar: React.FC<WorkQueueToolbarProps> = ({
  items,
  filters,
  onFiltersChange,
  onResetFilters,
  advancedOpen,
  onAdvancedOpenChange,
  onSync,
  isSyncing,
  onAnalyzeAll,
  isBulkAnalyzing,
  pendingAnalysisCount,
}) => {
  const { t } = useI18n();
  const searchRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const issueTypeCounts = React.useMemo(() => {
    const counts: Partial<Record<WorkQueueIssueType, number>> = {};
    for (const item of items) {
      const issueType = deriveIssueType(item);
      counts[issueType] = (counts[issueType] ?? 0) + 1;
    }
    return counts;
  }, [items]);

  const hasActiveFilters = Object.entries(filters).some(([key, value]) => key !== 'sort' && value !== '');

  // Number of active facets (search excluded — it's always visible in the
  // primary row and doesn't need a badge on the Filters toggle).
  const activeFacetCount = Object.entries(filters).filter(([key, value]) =>
    key !== 'sort' && key !== 'search' && value !== '',
  ).length;

  const repoOptions = React.useMemo(() => {
    const repos = new Set(items.map((item) => item.repo).filter(Boolean));
    return Array.from(repos).sort().map((repo) => ({ value: repo, label: repo }));
  }, [items]);

  const assigneeOptions = React.useMemo(() => {
    const assignees = new Set(items.map((item) => item.assignee).filter(Boolean));
    return Array.from(assignees).sort().map((assignee) => ({ value: assignee, label: assignee }));
  }, [items]);

  const typeOptions = [
    { value: 'issue', label: t('workQueue.type.issue') },
    { value: 'pr', label: t('workQueue.type.pr') },
  ];
  const priorityOptions: Array<{ value: WorkQueuePriority; label: string }> = [
    { value: 'critical', label: t('workQueue.priority.critical') },
    { value: 'high', label: t('workQueue.priority.high') },
    { value: 'medium', label: t('workQueue.priority.medium') },
    { value: 'low', label: t('workQueue.priority.low') },
  ];
  const complexityOptions: Array<{ value: WorkQueueComplexity; label: string }> = [
    { value: 'easy', label: t('workQueue.complexity.easy') },
    { value: 'medium', label: t('workQueue.complexity.medium') },
    { value: 'hard', label: t('workQueue.complexity.hard') },
    { value: 'huge', label: t('workQueue.complexity.huge') },
  ];
  const sortOptions: Array<{ value: WorkQueueSort; label: string }> = [
    { value: 'newest', label: t('workQueue.toolbar.sortNewest') },
    { value: 'oldest', label: t('workQueue.toolbar.sortOldest') },
    { value: 'criticality', label: t('workQueue.toolbar.sortCriticality') },
    { value: 'bugs', label: t('workQueue.toolbar.sortBugs') },
    { value: 'features', label: t('workQueue.toolbar.sortFeatures') },
  ];

  return (
    <div className="flex flex-col border-b border-border/50">
      {/* Primary row: always visible. Search + filters toggle + bulk actions. */}
      <div data-wq-toolbar-row="primary" className="flex flex-wrap items-center gap-2 px-4 py-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={filters.search}
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            placeholder={t('workQueue.toolbar.searchPlaceholder')}
            className="h-9 pl-8"
            aria-label={t('workQueue.toolbar.searchPlaceholder')}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 flex-shrink-0"
          aria-expanded={advancedOpen}
          aria-controls="workqueue-filters-panel"
          onClick={() => onAdvancedOpenChange(!advancedOpen)}
        >
          <Icon name="equalizer-2" className="h-3.5 w-3.5" />
          {t('workQueue.toolbar.filters')}
          {activeFacetCount > 0 && (
            <span
              className={cn(
                'inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 typography-micro font-medium leading-none',
                advancedOpen ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-primary',
              )}
            >
              {activeFacetCount}
            </span>
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={onSync} disabled={isSyncing} className="gap-1.5 flex-shrink-0">
          <Icon name="refresh" className={isSyncing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {t('workQueue.toolbar.sync')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onAnalyzeAll}
          disabled={isBulkAnalyzing || pendingAnalysisCount === 0}
          className="gap-1.5 flex-shrink-0"
        >
          <Icon name="sparkling" className={isBulkAnalyzing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {pendingAnalysisCount > 0
            ? t('workQueue.toolbar.analyzeAllWithCount', { count: pendingAnalysisCount })
            : t('workQueue.toolbar.analyzeAll')}
        </Button>
      </div>

      {/* Filters panel: collapsed by default so the queue gets the vertical
          space. Opens on the Filters toggle; the same toggle closes it. */}
      {advancedOpen && (
        <div id="workqueue-filters-panel" data-wq-filters className="flex flex-col gap-2 border-t border-border/40 bg-muted/10 px-4 py-2.5">
          <div data-wq-toolbar-row="chips" className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="chip"
              size="sm"
              aria-pressed={filters.issueType === ''}
              onClick={() => onFiltersChange({ ...filters, issueType: '' })}
            >
              {t('workQueue.toolbar.filterAll')}
            </Button>
            {QUICK_ISSUE_TYPES.filter((issueType) => (issueTypeCounts[issueType] ?? 0) > 0).map((issueType) => (
              <Button
                key={issueType}
                type="button"
                variant="chip"
                size="sm"
                aria-pressed={filters.issueType === issueType}
                onClick={() => onFiltersChange({ ...filters, issueType: filters.issueType === issueType ? '' : issueType })}
              >
                {t(`workQueue.issueType.${issueType}` as const)}
                <span className="ml-1 text-muted-foreground/70">{issueTypeCounts[issueType]}</span>
              </Button>
            ))}
          </div>

          <div data-wq-toolbar-row="dropdowns" className="flex flex-wrap items-center gap-1.5">
            <WorkQueueFilterDropdown
              label={t('workQueue.toolbar.filterRepo')}
              value={filters.repo}
              allLabel={t('workQueue.toolbar.filterAll')}
              options={repoOptions}
              onChange={(repo) => onFiltersChange({ ...filters, repo })}
            />
            <WorkQueueFilterDropdown
              label={t('workQueue.toolbar.filterAssignee')}
              value={filters.assignee}
              allLabel={t('workQueue.toolbar.filterAll')}
              options={assigneeOptions}
              onChange={(assignee) => onFiltersChange({ ...filters, assignee })}
            />
            <WorkQueueFilterDropdown
              label={t('workQueue.toolbar.filterType')}
              value={filters.type}
              allLabel={t('workQueue.toolbar.filterAll')}
              options={typeOptions}
              onChange={(type) => onFiltersChange({ ...filters, type: type as WorkQueueItemType | '' })}
            />
            <WorkQueueFilterDropdown
              label={t('workQueue.toolbar.filterPriority')}
              value={filters.priority}
              allLabel={t('workQueue.toolbar.filterAll')}
              options={priorityOptions}
              onChange={(priority) => onFiltersChange({ ...filters, priority: priority as WorkQueuePriority | '' })}
            />
            <WorkQueueFilterDropdown
              label={t('workQueue.toolbar.filterComplexity')}
              value={filters.complexity}
              allLabel={t('workQueue.toolbar.filterAll')}
              options={complexityOptions}
              onChange={(complexity) => onFiltersChange({ ...filters, complexity: complexity as WorkQueueComplexity | '' })}
            />
            <WorkQueueFilterDropdown
              label={t('workQueue.toolbar.sortLabel')}
              value={filters.sort}
              allLabel={t('workQueue.toolbar.sortDefault')}
              options={sortOptions}
              onChange={(sort) => onFiltersChange({ ...filters, sort: sort as WorkQueueSort })}
            />

            {hasActiveFilters && (
              <Button type="button" variant="ghost" size="sm" onClick={onResetFilters} className="ml-auto gap-1 text-muted-foreground">
                <Icon name="close" className="h-3.5 w-3.5" />
                {t('workQueue.toolbar.resetFilters')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
