import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useHarnessSwitchStore } from '@/stores/useHarnessSwitchStore';
import type { ExecutionTarget } from '@/types/harness';

/**
 * Apply a favorite/recent ExecutionTarget to the current session (or draft).
 * Claude targets switch the harness; OpenCode targets update provider/model.
 */
export function applyFavoriteExecutionTarget(target: ExecutionTarget): void {
  const sessionId = useSessionUIStore.getState().currentSessionId;
  const directory = sessionId
    ? useSessionUIStore.getState().getDirectoryForSession(sessionId)
    : null;

  useHarnessSwitchStore.getState().requestHarnessSwitch(sessionId, target, { directory });

  if (target.harnessId === 'opencode') {
    const { setProvider, setModel } = useConfigStore.getState();
    setProvider(target.providerId);
    setModel(target.modelId);
  }

  useUIStore.getState().addRecentTarget(target);
}
