import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorkQueueStore } from '@/stores/useWorkQueueStore';
import { useWorkQueueViewStore } from '@/stores/useWorkQueueViewStore';
import type { WorkQueueItem } from '@/lib/api/types';
import { WorkQueueSidebarNav } from './WorkQueueSidebarNav';
import { WorkQueueToolbar, type WorkQueueFilters } from './WorkQueueToolbar';
import { WorkQueueBoard } from './WorkQueueBoard';
import { WorkQueueList } from './WorkQueueList';
import { WorkQueueDetailPanel } from './WorkQueueDetailPanel';
import { deriveIssueType } from './deriveIssueType';
import { matchesSection, matchesFacetFilters } from './workQueueFilters';

type ViewMode = 'board' | 'matrix' | 'list' | 'calendar';

const VIEW_TABS: Array<{ mode: ViewMode; icon: IconName; enabled: boolean }> = [
  { mode: 'board', icon: 'layout-column', enabled: true },
  { mode: 'matrix', icon: 'node-tree', enabled: false },
  { mode: 'list', icon: 'list-unordered', enabled: true },
  { mode: 'calendar', icon: 'calendar', enabled: false },
];

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Un-analyzed items have no priority to rank by, so they sort after every
// analyzed one rather than silently landing at the top.
const sortItems = (items: WorkQueueItem[], sort: WorkQueueFilters['sort']): WorkQueueItem[] => {
  if (!sort) return items;
  const ranked = items.slice();
  if (sort === 'newest') {
    ranked.sort((a, b) => b.createdAt - a.createdAt);
    return ranked;
  }
  if (sort === 'oldest') {
    ranked.sort((a, b) => a.createdAt - b.createdAt);
    return ranked;
  }
  if (sort === 'criticality') {
    ranked.sort((a, b) => {
      const aRank = a.aiAnalysis ? PRIORITY_RANK[a.aiAnalysis.priority] ?? 9 : 9;
      const bRank = b.aiAnalysis ? PRIORITY_RANK[b.aiAnalysis.priority] ?? 9 : 9;
      return aRank - bRank;
    });
    return ranked;
  }
  // Bugs vs features is derived from source labels, which exist without any
  // AI analysis; a PR is treated as neither.
  const wantedType = sort === 'bugs' ? 'bug' : 'feature';
  ranked.sort((a, b) => Number(deriveIssueType(b) === wantedType) - Number(deriveIssueType(a) === wantedType));
  return ranked;
};

interface WorkQueueViewProps {
  onClose?: () => void;
}

export const WorkQueueView: React.FC<WorkQueueViewProps> = ({ onClose }) => {
  const { t } = useI18n();
  const { workQueue } = useRuntimeAPIs();
  const itemsById = useWorkQueueStore((state) => state.itemsById);
  const isSyncing = useWorkQueueStore((state) => state.isSyncing);
  const isBulkAnalyzing = useWorkQueueStore((state) => state.isBulkAnalyzing);
  const hasLoaded = useWorkQueueStore((state) => state.hasLoaded);
  const loadItems = useWorkQueueStore((state) => state.loadItems);
  const sync = useWorkQueueStore((state) => state.sync);
  const analyzeAll = useWorkQueueStore((state) => state.analyzeAll);
  const moveItem = useWorkQueueStore((state) => state.moveItem);

  const section = useWorkQueueViewStore((state) => state.section);
  const setSection = useWorkQueueViewStore((state) => state.setSection);
  const viewMode = useWorkQueueViewStore((state) => state.viewMode);
  const setViewMode = useWorkQueueViewStore((state) => state.setViewMode);
  const filters = useWorkQueueViewStore((state) => state.filters);
  const setFilters = useWorkQueueViewStore((state) => state.setFilters);
  const resetFilters = useWorkQueueViewStore((state) => state.resetFilters);
  const advancedFiltersOpen = useWorkQueueViewStore((state) => state.advancedFiltersOpen);
  const setAdvancedFiltersOpen = useWorkQueueViewStore((state) => state.setAdvancedFiltersOpen);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!workQueue || hasLoaded) return;
    void loadItems(workQueue);
  }, [workQueue, hasLoaded, loadItems]);

  const allItems = React.useMemo(() => Object.values(itemsById), [itemsById]);

  const filteredItems = React.useMemo(() => {
    const matched = allItems.filter(
      (item) => matchesSection(item, section) && matchesFacetFilters(item, filters),
    );
    return sortItems(matched, filters.sort);
  }, [allItems, section, filters]);

  // PRs are never AI-analyzed, so they are not part of the bulk-analysis backlog.
  const pendingAnalysisCount = React.useMemo(
    () => allItems.filter((item) => item.type !== 'pr' && !item.aiAnalysis).length,
    [allItems],
  );

  const selectedItem = selectedId ? itemsById[selectedId] ?? null : null;

  const handleSync = () => {
    if (!workQueue) return;
    void sync(workQueue);
  };

  const handleMove = (id: string, status: WorkQueueItem['status']) => {
    if (!workQueue) return;
    void moveItem(workQueue, id, status).then((warning) => {
      if (warning?.linearSyncWarning) toast.warning(t('workQueue.board.toast.linearSyncFailed'));
      if (warning?.assigneeSyncWarning) toast.warning(t('workQueue.board.toast.assigneeSyncFailed'));
    });
  };

  const handleAnalyzeAll = () => {
    if (!workQueue) return;
    void analyzeAll(workQueue).then((result) => {
      if (!result) {
        toast.error(t('workQueue.toolbar.toast.bulkAnalyzeFailed'));
        return;
      }
      if (result.failed > 0) {
        toast.warning(t('workQueue.toolbar.toast.bulkAnalyzePartial', { done: result.done, failed: result.failed }));
        return;
      }
      toast.success(t('workQueue.toolbar.toast.bulkAnalyzeDone', { done: result.done }));
    });
  };

  if (!workQueue) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground typography-ui-label">
        {t('workQueue.unavailable')}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <div className="w-56 flex-shrink-0 border-r border-border/50">
        <WorkQueueSidebarNav
          items={allItems}
          section={section}
          onSectionChange={setSection}
          filters={filters}
          onRepoChange={(repo) => setFilters({ ...filters, repo })}
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 py-2">
          <div className="flex items-center gap-1">
            {VIEW_TABS.map((tabDef) => (
              <Button
                key={tabDef.mode}
                type="button"
                variant={viewMode === tabDef.mode ? 'secondary' : 'ghost'}
                size="sm"
                disabled={!tabDef.enabled}
                onClick={() => setViewMode(tabDef.mode)}
                className="gap-1.5"
                title={tabDef.enabled ? undefined : t('workQueue.view.comingSoon')}
              >
                <Icon name={tabDef.icon} className="h-3.5 w-3.5" />
                {t(`workQueue.view.${tabDef.mode}` as const)}
              </Button>
            ))}
          </div>
          {onClose && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose} aria-label={t('workQueue.detail.close')}>
              <Icon name="close" className="h-4 w-4" />
            </Button>
          )}
        </div>

        <WorkQueueToolbar
          items={allItems}
          filters={filters}
          onFiltersChange={setFilters}
          onResetFilters={resetFilters}
          advancedOpen={advancedFiltersOpen}
          onAdvancedOpenChange={setAdvancedFiltersOpen}
          onSync={handleSync}
          isSyncing={isSyncing}
          onAnalyzeAll={handleAnalyzeAll}
          isBulkAnalyzing={isBulkAnalyzing}
          pendingAnalysisCount={pendingAnalysisCount}
        />

        <div className="flex flex-1 min-h-0">
          <div className={cn('flex flex-1 min-h-0 min-w-0 flex-col', selectedItem && 'border-r border-border/50')}>
            {viewMode === 'board' && (
              <WorkQueueBoard
                items={filteredItems}
                sort={filters.sort}
                selectedId={selectedId}
                onSelect={(item) => setSelectedId(item.id)}
                onMove={handleMove}
              />
            )}
            {viewMode === 'list' && (
              <WorkQueueList items={filteredItems} sort={filters.sort} selectedId={selectedId} onSelect={(item) => setSelectedId(item.id)} />
            )}
            {(viewMode === 'matrix' || viewMode === 'calendar') && (
              <div className="flex flex-1 items-center justify-center text-muted-foreground typography-ui-label">
                {t('workQueue.view.comingSoon')}
              </div>
            )}
          </div>

          {selectedItem && (
            <div className="w-[380px] flex-shrink-0">
              <WorkQueueDetailPanel item={selectedItem} onClose={() => setSelectedId(null)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
