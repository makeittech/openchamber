import { useSyncExternalStore } from 'react';
import {
  getCachedClaudeAgentsMode,
  subscribeClaudeAgentsMode,
  type ClaudeAgentsMode,
} from '@/lib/harness/settings';

function useClaudeAgentsMode(): ClaudeAgentsMode {
  return useSyncExternalStore(
    subscribeClaudeAgentsMode,
    getCachedClaudeAgentsMode,
    getCachedClaudeAgentsMode,
  );
}

export function useClaudeNativeAgentsActive(harnessId: string | null | undefined): boolean {
  return useClaudeAgentsMode() === 'claude' && harnessId === 'claude-code';
}
