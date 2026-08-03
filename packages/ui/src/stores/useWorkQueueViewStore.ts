import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';
import type { WorkQueueItemType, WorkQueuePriority, WorkQueueComplexity } from '@/lib/api/types';
import type { WorkQueueNavSection } from '@/components/workqueue/WorkQueueSidebarNav';
import type { WorkQueueSort } from '@/components/workqueue/WorkQueueToolbar';
import type { WorkQueueIssueType } from '@/components/workqueue/deriveIssueType';

type ViewMode = 'board' | 'matrix' | 'list' | 'calendar';

export type WorkQueueViewFilters = {
  search: string;
  repo: string;
  assignee: string;
  type: WorkQueueItemType | '';
  issueType: WorkQueueIssueType | '';
  priority: WorkQueuePriority | '';
  complexity: WorkQueueComplexity | '';
  sort: WorkQueueSort;
};

const DEFAULT_FILTERS: WorkQueueViewFilters = {
  search: '',
  repo: '',
  assignee: '',
  type: '',
  issueType: '',
  priority: '',
  complexity: '',
  sort: '',
};

type WorkQueueViewState = {
  section: WorkQueueNavSection;
  viewMode: ViewMode;
  filters: WorkQueueViewFilters;
  advancedFiltersOpen: boolean;
  setSection: (section: WorkQueueNavSection) => void;
  setViewMode: (viewMode: ViewMode) => void;
  setFilters: (filters: WorkQueueViewFilters) => void;
  setAdvancedFiltersOpen: (open: boolean) => void;
  resetFilters: () => void;
};

// Only view/filter preferences persist here — the actual item list stays in
// useWorkQueueStore, fetched fresh from the server on every open.
export const useWorkQueueViewStore = create<WorkQueueViewState>()(
  persist(
    (set) => ({
      section: 'queue',
      viewMode: 'board',
      filters: DEFAULT_FILTERS,
      advancedFiltersOpen: false,
      setSection: (section) => set({ section }),
      setViewMode: (viewMode) => set({ viewMode }),
      setFilters: (filters) => set({ filters }),
      setAdvancedFiltersOpen: (advancedFiltersOpen) => set({ advancedFiltersOpen }),
      resetFilters: () => set({ filters: DEFAULT_FILTERS }),
    }),
    {
      name: 'workqueue-view-store',
      storage: createDeferredSafeJSONStorage(),
      version: 1,
      partialize: (state) => ({
        section: state.section,
        viewMode: state.viewMode,
        filters: state.filters,
        advancedFiltersOpen: state.advancedFiltersOpen,
      }),
    },
  ),
);
