import { useSyncExternalStore } from 'react';
import {
  getCachedClaudeAgentsMode,
  subscribeClaudeAgentsMode,
  type ClaudeAgentsMode,
} from '@/lib/harness/settings';

/**
 * React view of the cached Claude agents mode.
 *
 * Reads the same module cache the send path uses, so the composer picker and
 * the turn it produces can never disagree about which agent set is in effect.
 */
export function useClaudeAgentsMode(): ClaudeAgentsMode {
  return useSyncExternalStore(
    subscribeClaudeAgentsMode,
    getCachedClaudeAgentsMode,
    getCachedClaudeAgentsMode,
  );
}

/**
 * Is the composer acting on a Claude session that uses Claude's own agents?
 *
 * In that state the OpenCode agent is inert for the next turn, so surfaces that
 * display or cycle it must opt out. Callers pass the harness id of the target
 * they already resolved, so every surface agrees on which session is meant.
 */
export function useClaudeNativeAgentsActive(harnessId: string | null | undefined): boolean {
  return useClaudeAgentsMode() === 'claude' && harnessId === 'claude-code';
}
