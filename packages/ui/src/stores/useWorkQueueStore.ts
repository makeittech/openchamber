import { create } from 'zustand';
import type {
  RuntimeAPIs,
  WorkQueueBulkAnalysisResult,
  WorkQueueCloseReason,
  WorkQueueFinishResult,
  WorkQueueItem,
  WorkQueueItemStatus,
  WorkQueueSyncResult,
} from '@/lib/api/types';

type WorkQueueAPI = NonNullable<RuntimeAPIs['workQueue']>;

type WorkQueueStore = {
  itemsById: Record<string, WorkQueueItem>;
  // Ids with an in-flight optimistic mutation. A background sync/load response
  // must not clobber an item while its own patch is still resolving — the
  // patch response is the authoritative write for that item.
  pendingIds: Set<string>;
  isLoading: boolean;
  isSyncing: boolean;
  isBulkAnalyzing: boolean;
  hasLoaded: boolean;
  error: string | null;
  lastSyncResult: WorkQueueSyncResult | null;

  loadItems: (api: WorkQueueAPI) => Promise<void>;
  sync: (api: WorkQueueAPI) => Promise<WorkQueueSyncResult | null>;
  /** Returns non-blocking warning codes when the local move succeeded but the Linear/assignee write-back didn't. */
  moveItem: (
    api: WorkQueueAPI,
    id: string,
    status: WorkQueueItemStatus,
  ) => Promise<{ linearSyncWarning?: string; assigneeSyncWarning?: string; linearCreateWarning?: string } | undefined>;
  linkSession: (api: WorkQueueAPI, id: string, sessionId: string) => Promise<void>;
  /** Records a PR the user manually attached as evidence this item is already done. */
  attachPr: (api: WorkQueueAPI, id: string, prUrl: string) => Promise<boolean>;
  analyzeItem: (api: WorkQueueAPI, id: string, directory?: string) => Promise<void>;
  analyzeAll: (api: WorkQueueAPI, directory?: string) => Promise<WorkQueueBulkAnalysisResult | null>;
  finishItem: (
    api: WorkQueueAPI,
    id: string,
    options?: { mergePr?: boolean; closeReason?: WorkQueueCloseReason; duplicateOfUrl?: string },
  ) => Promise<WorkQueueFinishResult | null>;
  launchCloudAgent: (api: WorkQueueAPI, id: string, options?: { prompt?: string; model?: string; repository?: string }) => Promise<void>;
  refreshCloudAgentStatus: (api: WorkQueueAPI, id: string) => Promise<void>;
};

const mergeIncoming = (
  current: Record<string, WorkQueueItem>,
  pendingIds: Set<string>,
  incoming: WorkQueueItem[],
): Record<string, WorkQueueItem> => {
  const next = { ...current };
  for (const item of incoming) {
    if (pendingIds.has(item.id)) continue;
    next[item.id] = item;
  }
  return next;
};

export const useWorkQueueStore = create<WorkQueueStore>((set, get) => ({
  itemsById: {},
  pendingIds: new Set(),
  isLoading: false,
  isSyncing: false,
  isBulkAnalyzing: false,
  hasLoaded: false,
  error: null,
  lastSyncResult: null,

  loadItems: async (api) => {
    set({ isLoading: true, error: null });
    try {
      const { items } = await api.itemsList();
      const { itemsById, pendingIds } = get();
      set({ itemsById: mergeIncoming(itemsById, pendingIds, items), isLoading: false, hasLoaded: true });
    } catch (error) {
      set({ isLoading: false, hasLoaded: true, error: error instanceof Error ? error.message : String(error) });
    }
  },

  sync: async (api) => {
    set({ isSyncing: true, error: null });
    try {
      const result = await api.sync();
      set({ lastSyncResult: result, isSyncing: false });
      await get().loadItems(api);
      return result;
    } catch (error) {
      set({ isSyncing: false, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  moveItem: async (api, id, status) => {
    const previous = get().itemsById[id];
    if (!previous) return undefined;
    set((state) => ({
      itemsById: { ...state.itemsById, [id]: { ...previous, status } },
      pendingIds: new Set(state.pendingIds).add(id),
    }));
    try {
      const { item, linearSyncWarning, assigneeSyncWarning, linearCreateWarning } = await api.patch(id, { status });
      set((state) => {
        const nextPending = new Set(state.pendingIds);
        nextPending.delete(id);
        return { itemsById: { ...state.itemsById, [id]: item }, pendingIds: nextPending };
      });
      // The local move already succeeded server-side even if the Linear/
      // assignee write-back didn't — surface the warning without rolling
      // anything back.
      if (!linearSyncWarning && !assigneeSyncWarning && !linearCreateWarning) return undefined;
      return { linearSyncWarning, assigneeSyncWarning, linearCreateWarning };
    } catch (error) {
      // Roll back to the pre-drag state so the board never shows a status
      // the server didn't actually accept.
      set((state) => {
        const nextPending = new Set(state.pendingIds);
        nextPending.delete(id);
        return {
          itemsById: { ...state.itemsById, [id]: previous },
          pendingIds: nextPending,
          error: error instanceof Error ? error.message : String(error),
        };
      });
      return undefined;
    }
  },

  linkSession: async (api, id, sessionId) => {
    try {
      const { item } = await api.patch(id, { linkedSessionId: sessionId, status: 'in_progress' });
      set((state) => ({ itemsById: { ...state.itemsById, [id]: item } }));
    } catch {
      // Session creation already succeeded; a failed link-back is surfaced
      // via the normal error toast in the caller, not by rolling anything back.
    }
  },

  attachPr: async (api, id, prUrl) => {
    try {
      const { item } = await api.patch(id, { attachedPrUrl: prUrl });
      set((state) => ({ itemsById: { ...state.itemsById, [id]: item } }));
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },

  analyzeItem: async (api, id, directory) => {
    set((state) => ({ pendingIds: new Set(state.pendingIds).add(id) }));
    try {
      const { item } = await api.analyze(id, directory);
      set((state) => {
        const nextPending = new Set(state.pendingIds);
        nextPending.delete(id);
        return { itemsById: { ...state.itemsById, [id]: item }, pendingIds: nextPending };
      });
    } catch (error) {
      set((state) => {
        const nextPending = new Set(state.pendingIds);
        nextPending.delete(id);
        return { pendingIds: nextPending, error: error instanceof Error ? error.message : String(error) };
      });
    }
  },

  analyzeAll: async (api, directory) => {
    set({ isBulkAnalyzing: true, error: null });
    try {
      const result = await api.analyzeBulk(directory);
      set({ isBulkAnalyzing: false });
      // Bulk analysis rewrites many items server-side; reload rather than
      // trying to reconcile each one locally.
      await get().loadItems(api);
      return result;
    } catch (error) {
      set({ isBulkAnalyzing: false, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  finishItem: async (api, id, options) => {
    try {
      const result = await api.finish(id, options);
      if (result.archived) {
        set((state) => {
          const next = { ...state.itemsById };
          delete next[id];
          return { itemsById: next };
        });
      }
      return result;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  },

  launchCloudAgent: async (api, id, options) => {
    set((state) => ({ pendingIds: new Set(state.pendingIds).add(id) }));
    try {
      const { item } = await api.launchCloudAgent(id, options);
      set((state) => {
        const nextPending = new Set(state.pendingIds);
        nextPending.delete(id);
        return { itemsById: { ...state.itemsById, [id]: item }, pendingIds: nextPending };
      });
    } catch (error) {
      set((state) => {
        const nextPending = new Set(state.pendingIds);
        nextPending.delete(id);
        return { pendingIds: nextPending, error: error instanceof Error ? error.message : String(error) };
      });
    }
  },

  refreshCloudAgentStatus: async (api, id) => {
    try {
      const { cloudAgent } = await api.cloudAgentStatus(id);
      set((state) => {
        const current = state.itemsById[id];
        if (!current || !cloudAgent) return state;
        return { itemsById: { ...state.itemsById, [id]: { ...current, cloudAgent } } };
      });
    } catch {
      // Status polling failures are transient; the next poll will retry.
    }
  },
}));
