import type { ExecutionTarget, HarnessId } from '@/types/harness';
import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import { isSyntheticPart } from '@/lib/messages/synthetic';
import { useSelectionStore } from '@/sync/selection-store';

const HANDOFF_SEED_CHAR_BUDGET = 24_000;

type HandoffSeedResult = {
  text: string;
  omittedTurns: number;
  includedTurns: number;
};

function extractLastAssistantText(
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

function extractMessageText(messageId: string, directory?: string | null): string {
  const parts = getSyncParts(messageId, directory ?? undefined);
  return parts
    .filter((part) => part.type === 'text' && !isSyntheticPart(part))
    .map((part) => (typeof (part as { text?: unknown }).text === 'string'
      ? (part as { text: string }).text.trim()
      : ''))
    .filter((text) => text.length > 0)
    .join('\n')
    .trim();
}

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
    if (used + cost > budget) {
      if (turns.length > 0) {
        omittedTurns += 1;
        continue;
      }
      // The newest turn alone exceeds the budget, so keep a truncated head of it.
      turns.push(`${block.slice(0, Math.max(0, budget - 40))}\n…`);
      used = budget;
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

    for (let j = i + 1; j < messages.length; j += 1) {
      const candidate = messages[j] as unknown as { parentID?: unknown };
      if (candidate.parentID === marker.id) {
        const text = extractMessageText(messages[j].id, directory);
        if (text) return text;
      }
    }
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

type CreatedHandoffSession = {
  sessionId: string;
  directory: string | null;
  seed: HandoffSeedResult;
};

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
