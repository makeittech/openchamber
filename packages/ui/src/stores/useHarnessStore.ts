import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { indexCatalogsById, parseHarnessCatalog, parseHarnessCatalogList } from '@/lib/harness/catalog';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { HarnessCatalog, HarnessId } from '@/types/harness';
import { isHarnessId } from '@/types/harness';

type HarnessLoadState = 'idle' | 'loading' | 'ready' | 'error';

type HarnessStore = {
  catalogs: HarnessCatalog[];
  catalogsById: Partial<Record<HarnessId, HarnessCatalog>>;
  loadState: HarnessLoadState;
  error: string | null;
  selectedHarnessId: HarnessId;
  isDetecting: Partial<Record<HarnessId, boolean>>;
  scopeKey: string | null;

  setSelectedHarnessId: (id: HarnessId) => void;
  getCatalog: (id: HarnessId) => HarnessCatalog | undefined;
  refresh: (options?: { force?: boolean }) => Promise<boolean>;
  refreshDetail: (id: HarnessId) => Promise<boolean>;
  detect: (id: HarnessId) => Promise<boolean>;
  resetForRuntimeSwitch: () => void;
};

const DEFAULT_SCOPE = '__default__';
const JSON_HEADERS = { Accept: 'application/json' };

let loadGeneration = 0;
let refreshInFlight: { scopeKey: string; promise: Promise<boolean> } | null = null;

const resolveDirectory = (): string | null => {
  try {
    const activeProject = useProjectsStore.getState().getActiveProject?.();
    const path = activeProject?.path?.trim();
    if (path) return path;
  } catch {
    // Try the client directory.
  }

  try {
    const clientDir = opencodeClient.getDirectory();
    const directory = typeof clientDir === 'string' ? clientDir.trim() : '';
    if (directory) return directory;
  } catch {
    // No directory is available.
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
    // Use the status fallback below.
  }
  return `Request failed (${response.status})`;
};

const withCatalog = (catalogs: HarnessCatalog[], catalog: HarnessCatalog) => {
  const next = [...catalogs.filter((entry) => entry.descriptor.id !== catalog.descriptor.id), catalog];
  return { catalogs: next, catalogsById: indexCatalogsById(next) };
};

type CatalogRequest = {
  path: string;
  method: 'GET' | 'POST';
  directory: string | null;
  generation: number;
  invalidMessage: string;
  failureMessage: string;
};

const requestCatalog = async ({
  path,
  method,
  directory,
  generation,
  invalidMessage,
  failureMessage,
}: CatalogRequest): Promise<{ catalog?: HarnessCatalog; error?: string } | null> => {
  try {
    const response = await runtimeFetch(buildHarnessUrl(path, directory), { method, headers: JSON_HEADERS });
    if (generation !== loadGeneration) {
      return null;
    }
    if (!response.ok) {
      return { error: await readErrorMessage(response) };
    }
    const payload = await response.json().catch(() => null);
    if (generation !== loadGeneration) {
      return null;
    }
    const catalog = parseHarnessCatalog(payload);
    return catalog ? { catalog } : { error: invalidMessage };
  } catch (error) {
    if (generation !== loadGeneration) {
      return null;
    }
    return { error: error instanceof Error ? error.message : failureMessage };
  }
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
              headers: JSON_HEADERS,
            });
            if (generation !== loadGeneration) {
              return false;
            }
            if (!response.ok) {
              const message = await readErrorMessage(response);
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
        const result = await requestCatalog({
          path: `/api/harness/${encodeURIComponent(id)}`,
          method: 'GET',
          directory,
          generation: loadGeneration,
          invalidMessage: 'Invalid harness detail response',
          failureMessage: 'Failed to load harness detail',
        });
        if (!result || !result.catalog) {
          if (result?.error) {
            set({ error: result.error });
          }
          return false;
        }
        set({ ...withCatalog(get().catalogs, result.catalog), error: null, loadState: 'ready' });
        return true;
      },

      detect: async (id) => {
        if (!isHarnessId(id)) {
          return false;
        }
        const directory = resolveDirectory();
        const generation = loadGeneration;
        set({ isDetecting: { ...get().isDetecting, [id]: true } });
        try {
          const result = await requestCatalog({
            path: `/api/harness/${encodeURIComponent(id)}/detect`,
            method: 'POST',
            directory,
            generation,
            invalidMessage: 'Invalid harness detect response',
            failureMessage: 'Failed to detect harness',
          });
          if (!result || !result.catalog) {
            if (result?.error) {
              set({ error: result.error });
            }
            return false;
          }
          set({ ...withCatalog(get().catalogs, result.catalog), error: null, loadState: 'ready' });
          return true;
        } finally {
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
