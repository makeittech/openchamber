import type { ExecutionTarget } from '@/types/harness';
import { isExecutionTarget } from '@/types/harness';
import { useSelectionStore } from '@/sync/selection-store';

export type ResolveExecutionTargetArgs = {
  sessionId: string;
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

export type ActiveHarnessTargetArgs = {
  sessionId?: string | null;
  sessionTarget?: ExecutionTarget | null;
  pendingHandoffTarget?: ExecutionTarget | null;
  lastUsedTarget?: ExecutionTarget | null;
};

/**
 * Resolve the harness target the composer is currently acting on, from targets
 * the caller already holds (no store read).
 *
 * Preference: session target → pending handoff → last used. A pending handoff
 * counts only for a real session; without one there is nothing to hand off from.
 */
export function resolveActiveHarnessTarget(args: ActiveHarnessTargetArgs): ExecutionTarget | null {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (sessionId) {
    if (args.sessionTarget && isExecutionTarget(args.sessionTarget)) return args.sessionTarget;
    if (args.pendingHandoffTarget && isExecutionTarget(args.pendingHandoffTarget)) {
      return args.pendingHandoffTarget;
    }
  }
  if (args.lastUsedTarget && isExecutionTarget(args.lastUsedTarget)) {
    return args.lastUsedTarget;
  }
  return null;
}

/**
 * Resolve the sticky ExecutionTarget for a session.
 * Preference: sessionTargets[sessionId] → lastUsedTarget → OpenCode from provider/model args.
 *
 * Callers that open existing OpenCode sessions should hydrate an opencode
 * sessionTarget when missing so a Claude lastUsedTarget does not leak across sessions.
 */
export function resolveExecutionTarget(args: ResolveExecutionTargetArgs): ExecutionTarget {
  const selection = useSelectionStore.getState();
  const sessionId = args.sessionId.trim();
  if (sessionId) {
    const sessionTarget = selection.getSessionTarget(sessionId);
    if (sessionTarget && isExecutionTarget(sessionTarget)) {
      return sessionTarget;
    }
  }

  const lastUsed = selection.getLastUsedTarget();
  if (lastUsed && isExecutionTarget(lastUsed)) {
    return lastUsed;
  }

  return {
    harnessId: 'opencode',
    providerId: args.providerID,
    modelId: args.modelID,
    ...(args.agent ? { agentName: args.agent } : {}),
    ...(args.variant ? { variant: args.variant } : {}),
  };
}

export function buildOpenCodeExecutionTarget(args: {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
}): ExecutionTarget {
  return {
    harnessId: 'opencode',
    providerId: args.providerID,
    modelId: args.modelID,
    ...(args.agent ? { agentName: args.agent } : {}),
    ...(args.variant ? { variant: args.variant } : {}),
  };
}

/** Persist the active target for a session (and as last-used). */
export function persistSessionExecutionTarget(sessionId: string, target: ExecutionTarget): void {
  if (!sessionId.trim() || !isExecutionTarget(target)) {
    return;
  }
  useSelectionStore.getState().saveSessionTarget(sessionId, target);
}
