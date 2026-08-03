import type { Part } from '@opencode-ai/sdk/v2';

const HANDOFF_CONTEXT_BEGIN_PREFIX = '--- BEGIN SESSION CONTEXT (';
const HANDOFF_CONTEXT_END = '--- END SESSION CONTEXT ---';

export type HandoffContextMode = 'duplicate' | 'summarize';

export function buildHandoffContextText(args: {
  sourceLabel: string;
  mode: HandoffContextMode;
  body: string;
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

function isHandoffContextText(text: string): boolean {
  return text.trimStart().startsWith(HANDOFF_CONTEXT_BEGIN_PREFIX);
}

export function isHandoffContextPart(part: Part): boolean {
  if (part.type !== 'text') return false;
  const text = (part as { text?: unknown }).text;
  return typeof text === 'string' && isHandoffContextText(text);
}

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
