import type { CapabilityLevel, HarnessCapability, HarnessId } from '@/types/harness';
import { isHarnessId } from '@/types/harness';
import { useSelectionStore } from '@/sync/selection-store';
import { useHarnessStore } from '@/stores/useHarnessStore';

const FULL_CAPABILITIES: Record<HarnessCapability, CapabilityLevel> = {
  prompt: 'full',
  abort: 'full',
  resume: 'full',
  'streaming-text': 'full',
  'streaming-tools': 'full',
  permissions: 'full',
  images: 'full',
  'file-attachments': 'full',
  shell: 'full',
  'slash-commands': 'full',
  mcp: 'full',
  subagents: 'full',
  multirun: 'full',
  goal: 'full',
  'openchamber-tool': 'full',
};

export const STATIC_HARNESS_CAPABILITIES: Record<HarnessId, Record<HarnessCapability, CapabilityLevel>> = {
  opencode: { ...FULL_CAPABILITIES },
  'claude-code': { ...FULL_CAPABILITIES },
};

export function resolveSessionHarnessId(sessionId?: string | null): HarnessId {
  const selection = useSelectionStore.getState();
  const trimmed = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (trimmed) {
    const sticky = selection.getSessionTarget(trimmed) ?? selection.getPendingHandoffTarget(trimmed);
    if (sticky && isHarnessId(sticky.harnessId)) {
      return sticky.harnessId;
    }
  }
  const lastUsed = selection.getLastUsedTarget();
  if (lastUsed && isHarnessId(lastUsed.harnessId)) {
    return lastUsed.harnessId;
  }
  return 'opencode';
}

export function getHarnessCapabilityLevel(
  harnessId: HarnessId,
  capability: HarnessCapability,
): CapabilityLevel {
  const catalog = useHarnessStore.getState().getCatalog(harnessId);
  const fromCatalog = catalog?.descriptor.capabilities?.[capability];
  if (fromCatalog === 'full' || fromCatalog === 'partial' || fromCatalog === 'none') {
    return fromCatalog;
  }
  return STATIC_HARNESS_CAPABILITIES[harnessId]?.[capability] ?? 'none';
}

export function sessionSupports(
  sessionId: string | null | undefined,
  capability: HarnessCapability,
): boolean {
  const harnessId = resolveSessionHarnessId(sessionId);
  return getHarnessCapabilityLevel(harnessId, capability) !== 'none';
}

/**
 * OpenCode can inject follow-ups into an active turn (`delivery: 'steer'`).
 * Claude Code rejects concurrent prompts with TURN_IN_PROGRESS — follow-ups
 * must use the OpenChamber message queue and wait for idle auto-send.
 */
export function harnessSupportsSteerDelivery(harnessId: HarnessId): boolean {
  return harnessId === 'opencode';
}

export function sessionSupportsSteerDelivery(sessionId: string | null | undefined): boolean {
  return harnessSupportsSteerDelivery(resolveSessionHarnessId(sessionId));
}
