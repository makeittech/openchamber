import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { indexCatalogsById, parseHarnessCatalog, parseHarnessCatalogList } from '@/lib/harness/catalog';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { HarnessCatalog, HarnessId } from '@/types/harness';
import { isHarnessId } from '@/types/harness';

export type HarnessLoadState = 'idle' | 'loading' | 'ready' | 'error';

export type HarnessStore = {
  catalogs: HarnessCatalog[];
  catalogsById: Partial<Record<HarnessId, HarnessCatalog>>;
  /** Distinct from ready+empty: authoritative fetch outcome. */
  loadState: HarnessLoadState;
  error: string | null;
  selectedHarnessId: HarnessId;
  isDetecting: Partial<Record<HarnessId, boolean>>;
  /** Runtime/directory scope used for the last successful or in-flight load. */
  scopeKey: string | null;

  setSelectedHarnessId: (id: HarnessId) => void;
  getCatalog: (id: HarnessId) => HarnessCatalog | undefined;
  refresh: (options?: { force?: boolean }) => Promise<boolean>;
  refreshDetail: (id: HarnessId) => Promise<boolean>;
  detect: (id: HarnessId) => Promise<boolean>;
  resetForRuntimeSwitch: () => void;
};

const DEFAULT_SCOPE = '__default__';

let loadGeneration = 0;
let refreshInFlight: { scopeKey: string; promise: Promise<boolean> } | null = null;

const resolveDirectory = (): string | null => {
  try {
    const activeProject = useProjectsStore.getState().getActiveProject?.();
    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }
  } catch {
    // fall through
  }
  try {
    const clientDir = opencodeClient.getDirectory();
    if (typeof clientDir === 'string' && clientDir.trim().length > 0) {
      return clientDir.trim();
    }
  } catch {
    // ignore
  }
  return null;
};

const buildScopeKey = (directory: string | null): string => directory?.trim() || DEFAULT_SCOPE;

const buildHarnessUrl = (path: string, directory: string | null): string => {
  if (!directory) {
    return path;
  }
  return `${path}?directory=${encodeURIComponent(directory)}`;
};

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = await response.json() as { error?: unknown; message?: unknown } | null;
    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    if (payload && typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    // ignore
  }
  return `Request failed (${response.status})`;
};

const upsertCatalog = (catalogs: HarnessCatalog[], next: HarnessCatalog): HarnessCatalog[] => {
  const without = catalogs.filter((entry) => entry.descriptor.id !== next.descriptor.id);
  return [...without, next];
};

export const useHarnessStore = create<HarnessStore>()(
  devtools(
    (set, get) => ({
      catalogs: [],
      catalogsById: {},
      loadState: 'idle',
      error: null,
      selectedHarnessId: 'opencode',
      isDetecting: {},
      scopeKey: null,

      setSelectedHarnessId: (id) => {
        if (!isHarnessId(id)) {
          return;
        }
        set({ selectedHarnessId: id });
      },

      getCatalog: (id) => get().catalogsById[id],

      refresh: async (options) => {
        const directory = resolveDirectory();
        const scopeKey = buildScopeKey(directory);
        const force = options?.force === true;

        if (!force && refreshInFlight && refreshInFlight.scopeKey === scopeKey) {
          return refreshInFlight.promise;
        }

        const generation = ++loadGeneration;
        const previous = get();
        set({
          loadState: previous.loadState === 'ready' ? 'ready' : 'loading',
          error: null,
          scopeKey,
        });

        const promise = (async (): Promise<boolean> => {
          try {
            const response = await runtimeFetch(buildHarnessUrl('/api/harness', directory), {
              method: 'GET',
              headers: { Accept: 'application/json' },
            });
            if (generation !== loadGeneration) {
              return false;
            }
            if (!response.ok) {
              const message = await readErrorMessage(response);
              // Failure must not clear prior authoritative catalogs to a fake ready empty.
              set({
                loadState: previous.catalogs.length > 0 ? 'ready' : 'error',
                error: message,
              });
              return false;
            }
            const payload = await response.json().catch(() => null);
            if (generation !== loadGeneration) {
              return false;
            }
            const catalogs = parseHarnessCatalogList(payload);
            if (catalogs === null) {
              set({
                loadState: previous.catalogs.length > 0 ? 'ready' : 'error',
                error: 'Invalid harness catalog response',
              });
              return false;
            }
            set({
              catalogs,
              catalogsById: indexCatalogsById(catalogs),
              loadState: 'ready',
              error: null,
              scopeKey,
            });
            return true;
          } catch (error) {
            if (generation !== loadGeneration) {
              return false;
            }
            const message = error instanceof Error ? error.message : 'Failed to load harness catalog';
            set({
              loadState: previous.catalogs.length > 0 ? 'ready' : 'error',
              error: message,
            });
            return false;
          } finally {
            if (refreshInFlight?.scopeKey === scopeKey) {
              refreshInFlight = null;
            }
          }
        })();

        refreshInFlight = { scopeKey, promise };
        return promise;
      },

      refreshDetail: async (id) => {
        if (!isHarnessId(id)) {
          return false;
        }
        const directory = resolveDirectory();
        const generation = loadGeneration;
        try {
          const response = await runtimeFetch(buildHarnessUrl(`/api/harness/${encodeURIComponent(id)}`, directory), {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (generation !== loadGeneration) {
            return false;
          }
          if (!response.ok) {
            const message = await readErrorMessage(response);
            set({ error: message });
            return false;
          }
          const payload = await response.json().catch(() => null);
          if (generation !== loadGeneration) {
            return false;
          }
          const catalog = parseHarnessCatalog(payload);
          if (!catalog) {
            set({ error: 'Invalid harness detail response' });
            return false;
          }
          const catalogs = upsertCatalog(get().catalogs, catalog);
          set({
            catalogs,
            catalogsById: indexCatalogsById(catalogs),
            error: null,
            loadState: 'ready',
          });
          return true;
        } catch (error) {
          if (generation !== loadGeneration) {
            return false;
          }
          const message = error instanceof Error ? error.message : 'Failed to load harness detail';
          set({ error: message });
          return false;
        }
      },

      detect: async (id) => {
        if (!isHarnessId(id)) {
          return false;
        }
        const directory = resolveDirectory();
        const generation = loadGeneration;
        set({ isDetecting: { ...get().isDetecting, [id]: true } });
        try {
          const response = await runtimeFetch(buildHarnessUrl(`/api/harness/${encodeURIComponent(id)}/detect`, directory), {
            method: 'POST',
            headers: { Accept: 'application/json' },
          });
          if (generation !== loadGeneration) {
            return false;
          }
          if (!response.ok) {
            set({ error: await readErrorMessage(response) });
            return false;
          }
          const payload = await response.json().catch(() => null);
          if (generation !== loadGeneration) {
            return false;
          }
          const catalog = parseHarnessCatalog(payload);
          if (!catalog) {
            set({ error: 'Invalid harness detect response' });
            return false;
          }
          const catalogs = upsertCatalog(get().catalogs, catalog);
          set({
            catalogs,
            catalogsById: indexCatalogsById(catalogs),
            error: null,
            loadState: 'ready',
          });
          return true;
        } catch (error) {
          if (generation !== loadGeneration) {
            return false;
          }
          set({ error: error instanceof Error ? error.message : 'Failed to detect harness' });
          return false;
        } finally {
          // Must clear on every exit, including the stale-generation returns —
          // otherwise a refresh racing a detect strands the spinner forever.
          set({ isDetecting: { ...get().isDetecting, [id]: false } });
        }
      },

      resetForRuntimeSwitch: () => {
        loadGeneration += 1;
        refreshInFlight = null;
        set({
          catalogs: [],
          catalogsById: {},
          loadState: 'idle',
          error: null,
          isDetecting: {},
          scopeKey: null,
        });
      },
    }),
    { name: 'HarnessStore' },
  ),
);
