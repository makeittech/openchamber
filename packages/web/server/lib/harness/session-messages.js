import { getSessionBinding } from './session-bindings.js';
import { getHarnessRecentMessages } from './turn-snapshot.js';
import { getClaudeTranscriptMessages } from './translators/claude-code/transcript-messages.js';

function messageTextKey(record) {
  const role = record?.info?.role === 'user' ? 'user' : 'assistant';
  const parts = Array.isArray(record?.parts) ? record.parts : [];
  const text = parts
    .filter((part) => (part?.type === 'text' || part?.type === 'reasoning') && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n');
  return `${role}:${text}`;
}

function messageCreatedAt(record) {
  const created = record?.info?.time?.created;
  return Number.isFinite(created) ? created : 0;
}

const LIVE_TRANSCRIPT_OVERLAP_MS = 15 * 60 * 1000;

export function mergeHarnessMessagesIntoSessionMessages(openCodeMessages, sessionId) {
  const base = Array.isArray(openCodeMessages) ? [...openCodeMessages] : [];
  if (typeof sessionId !== 'string' || !sessionId) {
    return base;
  }

  const binding = getSessionBinding(sessionId);
  if (binding?.harnessId !== 'claude-code') {
    return base;
  }

  const harnessMessages = getHarnessRecentMessages(sessionId);
  const transcriptMessages = getClaudeTranscriptMessages(sessionId);
  if (transcriptMessages.length === 0
    && (!Array.isArray(harnessMessages) || harnessMessages.length === 0)) {
    return base;
  }

  const live = Array.isArray(harnessMessages) ? harnessMessages : [];
  const liveKeys = new Map();
  for (const record of live) {
    const key = messageTextKey(record);
    if (!key.endsWith(':')) {
      liveKeys.set(key, messageCreatedAt(record));
    }
  }
  const transcript = transcriptMessages.filter((record) => {
    const key = messageTextKey(record);
    const liveCreated = liveKeys.get(key);
    if (liveCreated === undefined) return true;
    return Math.abs(messageCreatedAt(record) - liveCreated) > LIVE_TRANSCRIPT_OVERLAP_MS;
  });

  const byId = new Map();
  const merged = [];
  const push = (record) => {
    const id = record?.info?.id;
    if (typeof id !== 'string' || !id) return;
    if (byId.has(id)) return;
    byId.set(id, record);
    merged.push(record);
  };
  for (const record of transcript) push(record);
  for (const record of base) push(record);

  for (const record of live) {
    const id = record?.info?.id;
    if (typeof id !== 'string' || !id) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, record);
      merged.push(record);
      continue;
    }
    const existingParts = Array.isArray(existing.parts) ? existing.parts.length : 0;
    const nextParts = Array.isArray(record.parts) ? record.parts.length : 0;
    if (nextParts >= existingParts) {
      const index = merged.indexOf(existing);
      if (index >= 0) merged[index] = record;
      byId.set(id, record);
    }
  }

  merged.sort((left, right) => {
    const leftId = typeof left?.info?.id === 'string' ? left.info.id : '';
    const rightId = typeof right?.info?.id === 'string' ? right.info.id : '';
    if (leftId < rightId) return -1;
    if (leftId > rightId) return 1;
    return 0;
  });

  return merged;
}
