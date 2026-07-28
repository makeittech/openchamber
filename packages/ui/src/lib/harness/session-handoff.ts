/**
 * Cross-harness session handoff helpers (OpenCode ↔ Claude Code).
 * Pending targets live in selection-store; this module owns seed/warn/policy.
 */

import type { ExecutionTarget, HarnessId } from '@/types/harness';
import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import { isSyntheticPart } from '@/lib/messages/synthetic';
import { useSelectionStore } from '@/sync/selection-store';

/** Character budget for seeded prior turns (implementation-defined). */
const HANDOFF_SEED_CHAR_BUDGET = 24_000;

type HandoffSeedResult = {
  text: string;
  omittedTurns: number;
  includedTurns: number;
};

/** Latest non-empty assistant text of a session (newest last), or null. */
export function extractLastAssistantText(
  sessionId: string,
  directory?: string | null,
): string | null {
  const messages = getSyncMessages(sessionId, directory ?? undefined);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const text = extractMessageText(message.id, directory);
    if (text) return text;
  }
  return null;
}

function sessionRequiresHarnessHandoff(
  sessionId: string,
  directory?: string | null,
): boolean {
  if (!sessionId.trim()) return false;
  return getSyncMessages(sessionId, directory ?? undefined).length > 0;
}

/**
 * Apply a harness/target selection for a session.
 * Empty/unused sessions update sticky targets in place; used sessions mark pending handoff.
 */
export function applySessionExecutionTargetSelection(
  sessionId: string | null | undefined,
  target: ExecutionTarget,
  options?: { directory?: string | null },
): 'persisted' | 'pending-handoff' | 'last-used' {
  const selection = useSelectionStore.getState();
  if (!sessionId?.trim()) {
    selection.saveLastUsedTarget(target);
    return 'last-used';
  }

  const requiresHandoff = sessionRequiresHarnessHandoff(sessionId, options?.directory);
  if (!requiresHandoff) {
    selection.clearPendingHandoffTarget(sessionId);
    selection.saveSessionTarget(sessionId, target);
    return 'persisted';
  }

  const sticky = selection.getSessionTarget(sessionId);
  const sourceHarness = sticky?.harnessId ?? 'opencode';
  if (sourceHarness === target.harnessId) {
    selection.clearPendingHandoffTarget(sessionId);
    selection.saveSessionTarget(sessionId, target);
    return 'persisted';
  }

  selection.setPendingHandoffTarget(sessionId, target);
  selection.saveLastUsedTarget(target);
  return 'pending-handoff';
}

function extractMessageText(messageId: string, directory?: string | null): string {
  const parts = getSyncParts(messageId, directory ?? undefined);
  return parts
    .filter((part) => part.type === 'text' && !isSyntheticPart(part))
    .map((part) => {
      const text = typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '';
      return text.trim();
    })
    .filter((text) => text.length > 0)
    .join('\n')
    .trim();
}

/**
 * Build a budgeted preamble from prior user/assistant text turns (most recent first).
 */
export function buildHandoffSeedText(
  sessionId: string,
  directory?: string | null,
  budget: number = HANDOFF_SEED_CHAR_BUDGET,
  sourceHarnessId: HarnessId = 'opencode',
): HandoffSeedResult {
  const messages = getSyncMessages(sessionId, directory ?? undefined);
  const turns: string[] = [];
  let used = 0;
  let omittedTurns = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = extractMessageText(message.id, directory);
    if (!text) continue;

    const label = message.role === 'user' ? 'User' : 'Assistant';
    const block = `${label}:\n${text}`;
    const cost = block.length + (turns.length > 0 ? 2 : 0);
    if (used + cost > budget && turns.length > 0) {
      omittedTurns += 1;
      continue;
    }
    if (used + cost > budget && turns.length === 0) {
      const truncated = block.slice(0, Math.max(0, budget - 40));
      turns.push(`${truncated}\n…`);
      used = budget;
      omittedTurns += 0;
      break;
    }
    turns.push(block);
    used += cost;
  }

  turns.reverse();
  if (turns.length === 0) {
    return { text: '', omittedTurns: 0, includedTurns: 0 };
  }

  const truncationNote = omittedTurns > 0
    ? `Prior conversation truncated for handoff; ${omittedTurns} earlier turns omitted.\n\n`
    : '';

  const sourceLabel = sourceHarnessId === 'claude-code' ? 'Claude Code' : 'OpenCode';
  const text = [
    `Prior conversation context from a ${sourceLabel} session (handoff). This is background only; respond to the user message that follows.`,
    '',
    truncationNote + turns.join('\n\n'),
  ].join('\n');

  return {
    text,
    omittedTurns,
    includedTurns: turns.length,
  };
}


/**
 * Summary text produced by the latest compaction of a session.
 * Works for OpenCode summarize (assistant summary after the compaction part)
 * and Claude `/compact` (system-role summary linked via parentID).
 * Falls back to the newest assistant text when no compaction marker exists.
 */
export function extractCompactionSummary(
  sessionId: string,
  directory?: string | null,
): string | null {
  const messages = getSyncMessages(sessionId, directory ?? undefined);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const marker = messages[i];
    const hasCompactionPart = getSyncParts(marker.id, directory ?? undefined)
      .some((part) => part?.type === 'compaction');
    if (!hasCompactionPart) continue;

    // Prefer the summary message explicitly linked to the compaction command.
    for (let j = i + 1; j < messages.length; j += 1) {
      const candidate = messages[j] as unknown as { parentID?: unknown };
      if (candidate.parentID === marker.id) {
        const text = extractMessageText(messages[j].id, directory);
        if (text) return text;
      }
    }
    // Fallback: first assistant/system text after the marker.
    for (let j = i + 1; j < messages.length; j += 1) {
      const role = messages[j].role as string;
      if (role !== 'assistant' && role !== 'system') continue;
      const text = extractMessageText(messages[j].id, directory);
      if (text) return text;
    }
    return null;
  }
  return extractLastAssistantText(sessionId, directory);
}

export function getPendingHandoffTarget(sessionId: string): ExecutionTarget | null {
  return useSelectionStore.getState().getPendingHandoffTarget(sessionId);
}

export function clearPendingHandoffTarget(sessionId: string): void {
  useSelectionStore.getState().clearPendingHandoffTarget(sessionId);
}

export type CreatedHandoffSession = {
  sessionId: string;
  directory: string | null;
  seed: HandoffSeedResult;
};

/**
 * Create the destination session for a pending harness handoff.
 * Caller persists the target, routes the pending message, and navigates.
 */
export async function createHarnessHandoffSession(args: {
  sourceSessionId: string;
  directory?: string | null;
  sourceHarnessId?: HarnessId;
  title?: string;
  createSession: (
    title?: string,
    directoryOverride?: string | null,
  ) => Promise<{ id: string; directory?: string | null } | null>;
}): Promise<CreatedHandoffSession> {
  const seed = buildHandoffSeedText(
    args.sourceSessionId,
    args.directory,
    HANDOFF_SEED_CHAR_BUDGET,
    args.sourceHarnessId ?? 'opencode',
  );
  const created = await args.createSession(args.title, args.directory ?? null);
  if (!created?.id) {
    throw new Error('Failed to create handoff session');
  }
  return {
    sessionId: created.id,
    directory: created.directory ?? args.directory ?? null,
    seed,
  };
}
