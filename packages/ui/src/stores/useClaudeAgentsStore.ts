import { create } from 'zustand';
import { harnessClaudeAgents, harnessSessionBinding, type ClaudeAgent } from '@/lib/harness/client';

/**
 * Claude-native agents (`.claude/agents` + built-ins) for the composer picker
 * when Settings → Harnesses → Claude Code → **Agents to use** is `claude`.
 *
 * The list is directory-scoped because project agents live in the opened repo.
 *
 * The per-session selection is held in memory and rehydrated on demand from the
 * server-side harness binding (`hydrateSelection`), which records the agent each
 * turn actually ran under. Nothing is written to client storage: the authority
 * is the binding, so a reload cannot resurrect a pick the server never used, and
 * an agent deleted from `.claude/agents` is rejected at send time rather than
 * failing the turn.
 */

type DirectoryEntry = {
  agents: ClaudeAgent[];
  loadedAt: number;
  /** Set when the last load failed; the previous list (if any) is kept. */
  error: string | null;
};

const EMPTY_AGENTS: readonly ClaudeAgent[] = Object.freeze([]);

const directoryKey = (directory: string | null | undefined): string => {
  const trimmed = typeof directory === 'string' ? directory.trim() : '';
  return trimmed || '__global__';
};

type ClaudeAgentsStore = {
  byDirectory: Record<string, DirectoryEntry>;
  selectedBySessionId: Record<string, string>;
  inFlight: Record<string, Promise<void>>;
  /** Sessions whose server-side selection was already replayed (mutable set). */
  hydratedSessionIds: Set<string>;
  getAgents: (directory: string | null | undefined) => readonly ClaudeAgent[];
  load: (directory: string | null | undefined, options?: { force?: boolean }) => Promise<void>;
  getSelected: (sessionId: string | null | undefined) => string;
  select: (sessionId: string | null | undefined, agentName: string) => void;
  hydrateSelection: (sessionId: string | null | undefined) => Promise<void>;
  reset: () => void;
};

/** Refetch window — agent files change on disk, not through OpenChamber. */
const STALE_MS = 30_000;

export const useClaudeAgentsStore = create<ClaudeAgentsStore>((set, get) => ({
  byDirectory: {},
  selectedBySessionId: {},
  inFlight: {},
  hydratedSessionIds: new Set(),

  // Returns the stored array (or one frozen empty array) so React selectors
  // keep referential equality across unrelated store updates.
  getAgents: (directory) => get().byDirectory[directoryKey(directory)]?.agents ?? EMPTY_AGENTS,

  load: async (directory, options) => {
    const key = directoryKey(directory);
    const state = get();

    const pending = state.inFlight[key];
    if (pending) return pending;

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
        // Failure must not masquerade as "this project has no agents" — keep
        // whatever was loaded before and surface the error to the picker.
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
        set((current) => {
          const rest = { ...current.inFlight };
          delete rest[key];
          return { inFlight: rest };
        });
      }
    })();

    set((current) => ({ inFlight: { ...current.inFlight, [key]: request } }));
    return request;
  },

  getSelected: (sessionId) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return '';
    return get().selectedBySessionId[id] ?? '';
  },

  select: (sessionId, agentName) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return;
    const name = typeof agentName === 'string' ? agentName.trim() : '';
    set((current) => {
      if ((current.selectedBySessionId[id] ?? '') === name) return current;
      if (!name) {
        const rest = { ...current.selectedBySessionId };
        delete rest[id];
        return { selectedBySessionId: rest };
      }
      return { selectedBySessionId: { ...current.selectedBySessionId, [id]: name } };
    });
  },

  /**
   * Restore the selection the server recorded for this session's last turn.
   *
   * Runs once per session and never overwrites a live pick: a user who already
   * chose an agent in this tab is the newer authority, and the server value is
   * only there so a reload does not silently drop the choice. A missing binding
   * or a failed lookup leaves the selection untouched — it is not evidence that
   * the user picked "Claude default".
   */
  hydrateSelection: async (sessionId) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return;
    const state = get();
    if (state.hydratedSessionIds.has(id)) return;
    if (state.selectedBySessionId[id]) {
      state.hydratedSessionIds.add(id);
      return;
    }
    state.hydratedSessionIds.add(id);

    const binding = await harnessSessionBinding(id);
    const name = typeof binding?.claudeAgentName === 'string' ? binding.claudeAgentName.trim() : '';
    if (!name) return;
    set((current) => (
      // Re-check: the user may have picked one while the request was in flight.
      current.selectedBySessionId[id]
        ? current
        : { selectedBySessionId: { ...current.selectedBySessionId, [id]: name } }
    ));
  },

  reset: () => {
    set({
      byDirectory: {},
      selectedBySessionId: {},
      inFlight: {},
      hydratedSessionIds: new Set(),
    });
  },
}));
