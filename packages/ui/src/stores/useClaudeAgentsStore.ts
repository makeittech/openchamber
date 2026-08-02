import { create } from 'zustand';
import { harnessClaudeAgents, harnessSessionBinding, type ClaudeAgent } from '@/lib/harness/client';

type DirectoryEntry = {
  agents: ClaudeAgent[];
  loadedAt: number;
  error: string | null;
};

const EMPTY_AGENTS: readonly ClaudeAgent[] = Object.freeze([]);
const normalized = (value: string | null | undefined): string =>
  typeof value === 'string' ? value.trim() : '';
const directoryKey = (directory: string | null | undefined): string => normalized(directory) || '__global__';

type ClaudeAgentsStore = {
  byDirectory: Record<string, DirectoryEntry>;
  selectedBySessionId: Record<string, string>;
  inFlight: Record<string, Promise<void>>;
  hydratedSessionIds: Set<string>;
  getAgents: (directory: string | null | undefined) => readonly ClaudeAgent[];
  load: (directory: string | null | undefined, options?: { force?: boolean }) => Promise<void>;
  getSelected: (sessionId: string | null | undefined) => string;
  select: (sessionId: string | null | undefined, agentName: string) => void;
  hydrateSelection: (sessionId: string | null | undefined) => Promise<void>;
  reset: () => void;
};

const STALE_MS = 30_000;
const initialState = () => ({
  byDirectory: {},
  selectedBySessionId: {},
  inFlight: {},
  hydratedSessionIds: new Set<string>(),
});

const withoutKey = <T>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

export const useClaudeAgentsStore = create<ClaudeAgentsStore>((set, get) => ({
  ...initialState(),

  getAgents: (directory) => get().byDirectory[directoryKey(directory)]?.agents ?? EMPTY_AGENTS,

  load: async (directory, options) => {
    const key = directoryKey(directory);
    const state = get();

    const pending = state.inFlight[key];
    if (pending) {
      return pending;
    }

    const entry = state.byDirectory[key];
    if (!options?.force && entry && !entry.error && Date.now() - entry.loadedAt < STALE_MS) {
      return;
    }

    const request = (async () => {
      try {
        const result = await harnessClaudeAgents(typeof directory === 'string' ? directory : undefined);
        set((current) => ({
          byDirectory: {
            ...current.byDirectory,
            [key]: { agents: result.agents, loadedAt: Date.now(), error: null },
          },
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to load Claude agents';
        set((current) => {
          const previous = current.byDirectory[key];
          return {
            byDirectory: {
              ...current.byDirectory,
              [key]: {
                agents: previous?.agents ?? [],
                loadedAt: previous?.loadedAt ?? 0,
                error: message,
              },
            },
          };
        });
      } finally {
        set((current) => ({ inFlight: withoutKey(current.inFlight, key) }));
      }
    })();

    set((current) => ({ inFlight: { ...current.inFlight, [key]: request } }));
    return request;
  },

  getSelected: (sessionId) => {
    const id = normalized(sessionId);
    if (!id) {
      return '';
    }
    return get().selectedBySessionId[id] ?? '';
  },

  select: (sessionId, agentName) => {
    const id = normalized(sessionId);
    if (!id) {
      return;
    }
    const name = agentName.trim();
    set((current) => {
      if ((current.selectedBySessionId[id] ?? '') === name) {
        return current;
      }
      if (!name) {
        return { selectedBySessionId: withoutKey(current.selectedBySessionId, id) };
      }
      return { selectedBySessionId: { ...current.selectedBySessionId, [id]: name } };
    });
  },

  hydrateSelection: async (sessionId) => {
    const id = normalized(sessionId);
    if (!id) {
      return;
    }
    const state = get();
    if (state.hydratedSessionIds.has(id)) {
      return;
    }
    if (state.selectedBySessionId[id]) {
      state.hydratedSessionIds.add(id);
      return;
    }
    state.hydratedSessionIds.add(id);

    const binding = await harnessSessionBinding(id);
    const name = typeof binding?.claudeAgentName === 'string' ? binding.claudeAgentName.trim() : '';
    if (!name) {
      return;
    }
    set((current) => current.selectedBySessionId[id]
      ? current
      : { selectedBySessionId: { ...current.selectedBySessionId, [id]: name } });
  },

  reset: () => set(initialState()),
}));
