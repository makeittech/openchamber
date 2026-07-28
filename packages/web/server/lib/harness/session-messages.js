/**
 * Merge Claude harness messages into OpenCode `/session/:id/message` responses.
 *
 * Three sources, in ascending precedence:
 * 1. Transcript replay — the durable Claude JSONL on disk (imported sessions
 *    and any history predating this server process).
 * 2. OpenCode's own list (shell session; normally empty for Claude bindings).
 * 3. Live turn snapshot — the in-flight/last turn, which the transcript flush
 *    may not have caught up with yet.
 *
 * Without this, an authoritative empty OpenCode refetch wipes optimistic /
 * event-applied chat and imported sessions render as blank pages.
 */

import { getSessionBinding } from './session-bindings.js';
import { getHarnessRecentMessages } from './turn-snapshot.js';
import { getClaudeTranscriptMessages } from './translators/claude-code/transcript-messages.js';

/**
 * Concatenated text of a message's text/reasoning parts — identity key for
 * transcript/live dedupe (the live turn is appended to the same JSONL the
 * transcript replay reads, so without this both copies render).
 *
 * @param {object} record
 * @returns {string}
 */
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

/**
 * @param {object} record
 * @returns {number}
 */
function messageCreatedAt(record) {
  const created = record?.info?.time?.created;
  return Number.isFinite(created) ? created : 0;
}

/** Dedupe window: live snapshot and transcript flush of the same turn. */
const LIVE_TRANSCRIPT_OVERLAP_MS = 15 * 60 * 1000;

/**
 * @param {unknown} openCodeMessages
 * @param {string} sessionId
 * @returns {Array<{ info: object, parts?: object[] }>}
 */
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
  // Drop transcript copies of turns the live snapshot already represents.
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
