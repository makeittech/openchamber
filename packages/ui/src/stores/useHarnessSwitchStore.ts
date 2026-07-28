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

export type HarnessSwitchRequest = {
  sessionId: string;
  directory: string | null;
  sourceHarnessId: HarnessId;
  target: ExecutionTarget;
};

export type HarnessSwitchOutcome = 'persisted' | 'pending-handoff' | 'last-used' | 'dialog';

type HarnessSwitchStore = {
  /** Request currently awaiting user confirmation (dialog open). */
  pending: HarnessSwitchRequest | null;
  /** True while the confirmed handoff runs (summarize/create/post). */
  switching: boolean;
  /** Last failure to surface inside the dialog. */
  error: string | null;
  requestHarnessSwitch: (
    sessionId: string | null | undefined,
    target: ExecutionTarget,
    options?: { directory?: string | null },
  ) => HarnessSwitchOutcome;
  cancelHarnessSwitch: () => void;
  confirmHarnessSwitch: (mode: HarnessSwitchMode, dontShowAgain: boolean) => Promise<void>;
};

/**
 * Central entry point for every harness switch on a session.
 *
 * - No session / unused session / same harness: persist in place (no popup).
 * - Used session + warn disabled: legacy silent pending handoff (applied on
 *   the next sent message).
 * - Used session + warn enabled: open the switch dialog; on confirm the new
 *   session is created immediately with the chosen transfer mode.
 */
export const useHarnessSwitchStore = create<HarnessSwitchStore>()((set, get) => ({
  pending: null,
  switching: false,
  error: null,

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
    if (get().switching) return;
    set({ pending: null, switching: false, error: null });
  },

  confirmHarnessSwitch: async (mode, dontShowAgain) => {
    const { pending, switching } = get();
    if (!pending || switching) return;
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
    // Don't-show-again persists only after a successful confirmed switch.
    if (dontShowAgain) {
      setCachedWarnOnHarnessSwitch(false);
      void updateDesktopSettings({ harnessWarnOnSwitch: false });
    }
    set({ pending: null, switching: false, error: null });
  },
}));
