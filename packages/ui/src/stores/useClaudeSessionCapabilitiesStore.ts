import { create } from 'zustand';
import {
  harnessSessionCapabilities,
  type ClaudeSessionCapabilities,
} from '@/lib/harness/client';

export const CLAUDE_BUILTIN_SLASH_COMMANDS = Object.freeze([
  'clear',
  'compact',
  'context',
  'cost',
  'init',
  'pr-comments',
  'release-notes',
  'review',
  'security-review',
  'usage',
]) as readonly string[];

type ClaudeCapabilitiesStore = {
  bySessionId: Record<string, ClaudeSessionCapabilities>;
  getCapabilities: (sessionId: string | null | undefined) => ClaudeSessionCapabilities | null;
  getSlashCommands: (sessionId: string | null | undefined) => readonly string[];
  refresh: (sessionId: string) => Promise<ClaudeSessionCapabilities | null>;
  reset: () => void;
};

const emptyCapabilities = (sessionId: string): ClaudeSessionCapabilities => ({
  sessionId,
  slashCommands: CLAUDE_BUILTIN_SLASH_COMMANDS as string[],
  skills: [],
  agents: [],
  tools: [],
  mcpServers: [],
  updatedAt: 0,
});

export function selectClaudeSlashCommands(
  state: Pick<ClaudeCapabilitiesStore, 'bySessionId'>,
  sessionId: string | null | undefined,
): readonly string[] {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  const slashCommands = id ? state.bySessionId[id]?.slashCommands : undefined;
  if (slashCommands?.length) {
    return slashCommands;
  }
  return CLAUDE_BUILTIN_SLASH_COMMANDS;
}

export const useClaudeSessionCapabilitiesStore = create<ClaudeCapabilitiesStore>((set, get) => ({
  bySessionId: {},

  getCapabilities: (sessionId) => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    return id ? get().bySessionId[id] ?? null : null;
  },

  getSlashCommands: (sessionId) => selectClaudeSlashCommands(get(), sessionId),

  refresh: async (sessionId) => {
    const id = sessionId.trim();
    if (!id) {
      return null;
    }
    try {
      const { capabilities } = await harnessSessionCapabilities(id);
      const slashCommands = capabilities.slashCommands.length > 0
        ? capabilities.slashCommands
        : (CLAUDE_BUILTIN_SLASH_COMMANDS as string[]);
      set((state) => {
        const previous = state.bySessionId[id];
        if (previous && previous.updatedAt > capabilities.updatedAt) {
          return state;
        }
        return {
          bySessionId: {
            ...state.bySessionId,
            [id]: { ...capabilities, slashCommands },
          },
        };
      });
      return get().bySessionId[id] ?? null;
    } catch {
      set((state) => (state.bySessionId[id] ? state : {
        bySessionId: { ...state.bySessionId, [id]: emptyCapabilities(id) },
      }));
      return get().bySessionId[id] ?? null;
    }
  },

  reset: () => set({ bySessionId: {} }),
}));
