import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { WorkQueueCard } from './WorkQueueCard';
import { WorkQueueDetailPanel } from './WorkQueueDetailPanel';
import { deriveIssueType } from './deriveIssueType';
import { countItemsBySection, matchesSection, matchesFacetFilters, SECTION_ICONS, SECTIONS } from './workQueueFilters';

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

/** Launch result of a cloud agent dispatch, shown as a popup once the
    background launch settles — the dispatch dialog itself closes instantly. */
interface AgentLaunchResult {
  title: string;
  url: string;
  status: string;
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

  const pendingAnalysisCount = React.useMemo(
    () => allItems.filter((item) => !item.aiAnalysis).length,
    [allItems],
  );

  const selectedItem = selectedId ? itemsById[selectedId] ?? null : null;

  // Same shared counts the sidebar shows, used by the mobile section strip so
  // badges never drift from the desktop sidebar. Computed once here and passed
  // down (the sidebar and the mobile strip are both mounted at all times).
  const sectionCounts = React.useMemo(() => countItemsBySection(allItems, filters, SECTIONS), [allItems, filters]);

  // Esc closes the detail overlay first; a second Esc falls through to the
  // WorkQueueWindow dialog (which closes the whole queue). Listen in the
  // capture phase so the panel wins over base-ui's document-level Escape
  // handling. When a nested base-ui dialog is open (cloud agent, finish,
  // launch popup), leave Escape entirely to that dialog — it owns the top of
  // the dialog stack and closes itself.
  React.useEffect(() => {
    if (!selectedItem) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as Element | null;
      const nestedDialogOpen = Boolean(document.querySelector('[data-slot="dialog-content"]'));
      if (target?.closest?.('[data-slot="dialog-content"]')) return;
      if (nestedDialogOpen) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedId(null);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [selectedItem]);
  // Focus management for the detail overlay: focus moves into the panel when
  // it opens and returns to the originating card when it closes, so keyboard
  // users are never left with a dangling focus target. Keyed on `selectedId`
  // (not the item object) so store refreshes of the same card never steal
  // focus mid-interaction.
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const selectedCardIdRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (selectedId) {
      panelRef.current?.querySelector<HTMLButtonElement>('[data-wq-panel-close]')?.focus();
    } else if (selectedCardIdRef.current) {
      const card = document.querySelector<HTMLElement>(`[data-wq-card-id="${CSS.escape(selectedCardIdRef.current)}"]`);
      card?.focus();
    }
  }, [selectedId]);

  const handleSelect = React.useCallback((item: WorkQueueItem) => {
    selectedCardIdRef.current = item.id;
    setSelectedId(item.id);
  }, []);

  const handleClosePanel = React.useCallback(() => {
    setSelectedId(null);
  }, []);

  const [agentLaunch, setAgentLaunch] = React.useState<AgentLaunchResult | null>(null);

  // Keep the active mobile section chip in view after a switch that happened
  // off-screen (only when the section actually changed, never on re-renders).
  const mobileStripRef = React.useRef<HTMLDivElement | null>(null);
  const prevSectionRef = React.useRef(section);
  React.useEffect(() => {
    if (section === prevSectionRef.current) return;
    prevSectionRef.current = section;
    const strip = mobileStripRef.current;
    if (!strip) return;
    const chip = strip.querySelector<HTMLElement>(`[data-section-chip="${CSS.escape(section)}"]`);
    chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [section]);

  const handleCloudAgentLaunched = React.useCallback((item: WorkQueueItem) => {
    if (item.cloudAgent?.url) {
      setAgentLaunch({
        title: item.title,
        url: item.cloudAgent.url,
        status: item.cloudAgent.status,
      });
      return;
    }
    toast.success(t('workQueue.detail.toast.cloudAgentLaunched'));
  }, [t]);

  const handleSync = () => {
    if (!workQueue) return;
    void sync(workQueue);
  };

  const handleMove = (id: string, status: WorkQueueItem['status']) => {
    if (!workQueue) return;
    void moveItem(workQueue, id, status).then((warning) => {
      if (warning?.linearSyncWarning) toast.warning(t('workQueue.board.toast.linearSyncFailed'));
      if (warning?.assigneeSyncWarning) toast.warning(t('workQueue.board.toast.assigneeSyncFailed'));
      if (warning?.linearCreateWarning) toast.warning(t('workQueue.board.toast.linearCreateFailed'));
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
      {/* Section + repo navigation. Full sidebar on md+; on phones the same
          sections move to a horizontal strip (below) and the sidebar hides. */}
      <div data-wq-sidebar className="hidden w-48 flex-shrink-0 border-r border-border/50 md:block">
        <WorkQueueSidebarNav
          items={allItems}
          section={section}
          onSectionChange={setSection}
          filters={filters}
          counts={sectionCounts}
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

        {/* Mobile: section navigation as a horizontally scrollable strip. */}
        <div ref={mobileStripRef} data-wq-mobile-sections className="oc-hide-scrollbar flex items-center gap-1.5 overflow-x-auto border-b border-border/50 px-3 py-2 md:hidden">
          {SECTIONS.map((sectionKey) => {
            const active = section === sectionKey;
            return (
              <button
                key={sectionKey}
                type="button"
                data-section-chip={sectionKey}
                aria-pressed={active}
                aria-current={active ? 'page' : undefined}
                onClick={() => setSection(sectionKey)}
                className={cn(
                  'flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 typography-micro transition-colors',
                  active
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                <Icon name={SECTION_ICONS[sectionKey]} className="h-3.5 w-3.5" />
                {t(`workQueue.nav.${sectionKey}` as const)}
                <span className="text-muted-foreground/60">{sectionCounts[sectionKey] ?? 0}</span>
              </button>
            );
          })}
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

        {/* The detail panel overlays the board instead of squeezing it: the
            board never reflows when a card is selected, stays interactive
            (clicking another card switches the panel), and on a ~1000px
            window the panel can be wide without starving the columns. */}
        <div className="relative flex flex-1 min-h-0">
          <div className="flex flex-1 min-h-0 min-w-0 flex-col">
            {section === 'done' ? (
              /* Done has no board column anymore (finished cards are archived
                 from the queue), so the section renders as a flat list. */
              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
                  {filteredItems.length === 0 && (
                    <p className="py-8 text-center typography-ui-label text-muted-foreground">{t('workQueue.list.empty')}</p>
                  )}
                  {filteredItems.map((item) => (
                    <WorkQueueCard key={item.id} item={item} selected={item.id === selectedId} onSelect={handleSelect} />
                  ))}
                </div>
              </div>
            ) : viewMode === 'board' ? (
              <WorkQueueBoard
                items={filteredItems}
                sort={filters.sort}
                selectedId={selectedId}
                onSelect={handleSelect}
                onMove={handleMove}
              />
            ) : viewMode === 'list' ? (
              <WorkQueueList items={filteredItems} sort={filters.sort} selectedId={selectedId} onSelect={handleSelect} />
            ) : (
              <div className="flex flex-1 items-center justify-center text-muted-foreground typography-ui-label">
                {t('workQueue.view.comingSoon')}
              </div>
            )}
          </div>

          {selectedItem && (
            <div
              ref={panelRef}
              data-wq-panel
              role="dialog"
              aria-label={selectedItem.title}
              className="absolute inset-y-0 right-0 z-30 w-full border-l border-border/50 bg-background shadow-2xl md:w-[min(620px,60vw)]"
            >
              <WorkQueueDetailPanel item={selectedItem} onClose={handleClosePanel} onCloudAgentLaunched={handleCloudAgentLaunched} />
            </div>
          )}
        </div>
      </div>

      {/* Agent launch popup: appears after the background dispatch settles.
          The prominent action is jumping straight to the agent run. */}
      <Dialog open={agentLaunch !== null} onOpenChange={(open) => { if (!open) setAgentLaunch(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('workQueue.cloudAgent.popup.title')}</DialogTitle>
            <DialogDescription>{t('workQueue.cloudAgent.popup.description')}</DialogDescription>
          </DialogHeader>
          {agentLaunch && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
                <Icon name="cloud" className="h-4 w-4 flex-shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="truncate typography-ui-label text-foreground">{agentLaunch.title}</p>
                  <p className="truncate typography-micro text-muted-foreground">{agentLaunch.status}</p>
                </div>
              </div>
              <Button
                size="lg"
                className="w-full gap-2"
                asChild
              >
                <a href={agentLaunch.url} target="_blank" rel="noreferrer">
                  <Icon name="external-link" className="h-4 w-4" />
                  {t('workQueue.cloudAgent.popup.openRun')}
                </a>
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setAgentLaunch(null)}>
              {t('workQueue.cloudAgent.popup.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
