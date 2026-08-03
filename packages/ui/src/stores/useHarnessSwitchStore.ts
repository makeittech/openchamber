import { create } from 'zustand';

import type { ExecutionTarget, HarnessId } from '@/types/harness';
import { useSelectionStore } from '@/sync/selection-store';
import { getSyncMessages } from '@/sync/sync-refs';
import {
  getCachedWarnOnHarnessSwitch,
  setCachedWarnOnHarnessSwitch,
} from '@/lib/harness/settings';
import { performHarnessHandoff } from '@/lib/harness/perform-handoff';
import { updateDesktopSettings } from '@/lib/persistence';

export type HarnessSwitchMode = 'duplicate' | 'summarize';

type HarnessSwitchRequest = {
  sessionId: string;
  directory: string | null;
  sourceHarnessId: HarnessId;
  target: ExecutionTarget;
};

type HarnessSwitchOutcome = 'persisted' | 'pending-handoff' | 'last-used' | 'dialog';

type HarnessSwitchStore = {
  pending: HarnessSwitchRequest | null;
  switching: boolean;
  error: string | null;
  requestHarnessSwitch: (
    sessionId: string | null | undefined,
    target: ExecutionTarget,
    options?: { directory?: string | null },
  ) => HarnessSwitchOutcome;
  cancelHarnessSwitch: () => void;
  confirmHarnessSwitch: (mode: HarnessSwitchMode, dontShowAgain: boolean) => Promise<void>;
};

const idleState = { pending: null, switching: false, error: null };

export const useHarnessSwitchStore = create<HarnessSwitchStore>()((set, get) => ({
  ...idleState,

  requestHarnessSwitch: (sessionId, target, options) => {
    const selection = useSelectionStore.getState();
    if (!sessionId?.trim()) {
      selection.saveLastUsedTarget(target);
      return 'last-used';
    }

    const directory = options?.directory ?? null;
    const hasMessages = getSyncMessages(sessionId, directory ?? undefined).length > 0;
    const sourceHarnessId = selection.getSessionTarget(sessionId)?.harnessId ?? 'opencode';

    if (!hasMessages || sourceHarnessId === target.harnessId) {
      selection.clearPendingHandoffTarget(sessionId);
      selection.saveSessionTarget(sessionId, target);
      return 'persisted';
    }

    if (!getCachedWarnOnHarnessSwitch()) {
      selection.setPendingHandoffTarget(sessionId, target);
      selection.saveLastUsedTarget(target);
      return 'pending-handoff';
    }

    set({
      pending: { sessionId, directory, sourceHarnessId, target },
      switching: false,
      error: null,
    });
    return 'dialog';
  },

  cancelHarnessSwitch: () => {
    if (get().switching) {
      return;
    }
    set(idleState);
  },

  confirmHarnessSwitch: async (mode, dontShowAgain) => {
    const { pending, switching } = get();
    if (!pending || switching) {
      return;
    }
    set({ switching: true, error: null });
    try {
      await performHarnessHandoff({
        sourceSessionId: pending.sessionId,
        directory: pending.directory,
        sourceHarnessId: pending.sourceHarnessId,
        target: pending.target,
        mode,
      });
    } catch (error) {
      set({
        switching: false,
        error: error instanceof Error ? error.message : 'Harness switch failed',
      });
      return;
    }
    if (dontShowAgain) {
      setCachedWarnOnHarnessSwitch(false);
      void updateDesktopSettings({ harnessWarnOnSwitch: false });
    }
    set(idleState);
  },
}));
