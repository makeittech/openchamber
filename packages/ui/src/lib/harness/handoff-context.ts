/**
 * Visible handoff context message format.
 *
 * When a session is transferred across harnesses, the transferred context is
 * posted as a real (non-synthetic) user message at the top of the destination
 * session so it is both model context and visible in the transcript. The
 * marker delimiters let the UI render the message as a collapsible card.
 */

import type { Part } from '@opencode-ai/sdk/v2';

export const HANDOFF_CONTEXT_BEGIN_PREFIX = '--- BEGIN SESSION CONTEXT (';
export const HANDOFF_CONTEXT_END = '--- END SESSION CONTEXT ---';

export type HandoffContextMode = 'duplicate' | 'summarize';

export function buildHandoffContextText(args: {
  sourceLabel: string;
  mode: HandoffContextMode;
  body: string;
  /** Claude harness turns always produce a reply, so the message must ask for a brief ack. */
  targetHarnessId: 'opencode' | 'claude-code';
}): string {
  const header = args.mode === 'summarize'
    ? `summary of previous ${args.sourceLabel} session`
    : `transferred from ${args.sourceLabel}`;
  const instruction = args.targetHarnessId === 'claude-code'
    ? 'This context was transferred from a previous session. Acknowledge it in one short sentence; the user\'s actual request comes next.'
    : 'Use the context above as background for this conversation.';
  return [
    `${HANDOFF_CONTEXT_BEGIN_PREFIX}${header}) ---`,
    args.body,
    HANDOFF_CONTEXT_END,
    '',
    instruction,
  ].join('\n');
}

export function isHandoffContextText(text: string): boolean {
  return text.trimStart().startsWith(HANDOFF_CONTEXT_BEGIN_PREFIX);
}

/** True when a user text part carries transferred handoff context. */
export function isHandoffContextPart(part: Part): boolean {
  if (part.type !== 'text') return false;
  const text = (part as { text?: unknown }).text;
  return typeof text === 'string' && isHandoffContextText(text);
}

/** Extract the body between the marker lines for card rendering. */
export function parseHandoffContextText(text: string): { header: string; body: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(HANDOFF_CONTEXT_BEGIN_PREFIX)) {
    return null;
  }
  const headerStart = HANDOFF_CONTEXT_BEGIN_PREFIX.length;
  const headerEnd = trimmed.indexOf(') ---', headerStart);
  if (headerEnd < 0) {
    return null;
  }
  const header = trimmed.slice(headerStart, headerEnd);
  const bodyStart = trimmed.indexOf('\n', headerEnd);
  if (bodyStart < 0) {
    return null;
  }
  const endIndex = trimmed.indexOf(HANDOFF_CONTEXT_END, bodyStart);
  if (endIndex < 0) {
    return null;
  }
  const body = trimmed.slice(bodyStart + 1, endIndex).trim();
  return { header, body };
}
