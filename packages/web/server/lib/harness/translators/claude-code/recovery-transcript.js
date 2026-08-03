import fs from 'node:fs';

import { findClaudeTranscriptPath, MAX_TRANSCRIPT_BYTES } from './transcript-messages.js';

export const RECOVERY_MARKER = '<openchamber-continuation version="1" reason="claude-session-limit">';

const DENY_REASON = 'OpenChamber blocked an exact pre-limit tool replay.';
const MAX_RECOVERY_TOOL_FINGERPRINTS = 1024;

const isObject = (value) => value !== null && typeof value === 'object';

export function buildRecoveryUserMessage(launchUuid) {
  return {
    type: 'user',
    uuid: typeof launchUuid === 'string' ? launchUuid : '',
    parent_tool_use_id: null,
    isSynthetic: true,
    priority: 'now',
    message: {
      role: 'user',
      content: [{ type: 'text', text: `${RECOVERY_MARKER}\nContinue the interrupted response.` }],
    },
  };
}

function canonicalizeValue(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalizeValue);

  const type = typeof value;
  if (type === 'bigint') return String(value);
  if (type === 'undefined' || type === 'function' || type === 'symbol') return null;
  if (type === 'number' && !Number.isFinite(value)) return null;
  if (type !== 'object') return value;

  const result = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child !== undefined) result[key] = canonicalizeValue(child);
  }
  return result;
}

export function fingerprintToolCall(toolName, input) {
  return JSON.stringify({
    tool: typeof toolName === 'string' ? toolName : '',
    input: isObject(input) && !Array.isArray(input) ? canonicalizeValue(input) : {},
  });
}

function firstUserText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.find((block) => (
    isObject(block) && block.type === 'text' && typeof block.text === 'string'
  ))?.text ?? null;
}

export function isRecoveryContinuationRecord(record) {
  return isObject(record)
    && record.isSynthetic === true
    && isObject(record.message)
    && firstUserText(record.message.content)?.startsWith(RECOVERY_MARKER) === true;
}

function hasText(content, predicate) {
  if (typeof content === 'string') return predicate(content);
  return Array.isArray(content) && content.some((block) => (
    isObject(block)
    && block.type === 'text'
    && typeof block.text === 'string'
    && predicate(block.text)
  ));
}

function isInternalUserRecord(record) {
  return isRecoveryContinuationRecord(record)
    || (isObject(record.message) && hasText(
      record.message.content,
      (text) => text.trimStart().startsWith('<task-notification>'),
    ));
}

function isOpeningUserTurn(record) {
  return isObject(record)
    && record.type === 'user'
    && record.isSidechain !== true
    && record.isMeta !== true
    && !isInternalUserRecord(record)
    && isObject(record.message)
    && hasText(record.message.content, (text) => text.trim().length > 0);
}

function readTranscript(foreignSessionId) {
  const id = typeof foreignSessionId === 'string' ? foreignSessionId.trim() : '';
  if (!id) return null;

  const transcriptPath = findClaudeTranscriptPath(id)
    || findClaudeTranscriptPath(id, { refresh: true });
  if (!transcriptPath) return null;

  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TRANSCRIPT_BYTES) return null;

    return fs.readFileSync(transcriptPath, 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const record = JSON.parse(line);
          return isObject(record) ? [record] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return null;
  }
}

export function inspectRecoveryTranscript({ foreignSessionId, expectedTailUuid } = {}) {
  const records = readTranscript(foreignSessionId);
  if (!records) return { safe: false, reason: 'transcript-unreadable' };

  const startIndex = records.findLastIndex(isOpeningUserTurn);
  if (startIndex < 0) return { safe: true, fingerprints: [], tailPresent: false };

  const expectedTail = typeof expectedTailUuid === 'string' ? expectedTailUuid : '';
  const toolUseIds = new Set();
  const settledToolUseIds = new Set();
  const toolCalls = [];
  let tailPresent = false;

  for (const record of records.slice(startIndex)) {
    if (record.isSidechain === true || record.isMeta === true) continue;
    if (expectedTail && record.uuid === expectedTail) tailPresent = true;
    if ((record.type !== 'user' && record.type !== 'assistant')
      || !Array.isArray(record.message?.content)) continue;

    for (const block of record.message.content) {
      if (!isObject(block)) continue;
      if (record.type === 'assistant' && block.type === 'tool_use'
        && typeof block.id === 'string' && block.id) {
        toolUseIds.add(block.id);
        toolCalls.push(block);
      } else if (record.type === 'user' && block.type === 'tool_result'
        && typeof block.tool_use_id === 'string' && toolUseIds.has(block.tool_use_id)) {
        settledToolUseIds.add(block.tool_use_id);
      }
    }
  }

  if (toolUseIds.size !== settledToolUseIds.size) {
    return { safe: false, reason: 'unsettled-tool' };
  }

  const fingerprints = toolCalls.slice(0, MAX_RECOVERY_TOOL_FINGERPRINTS).map((block) => {
    const toolName = typeof block.name === 'string' ? block.name.trim() : '';
    return { toolName, fingerprint: fingerprintToolCall(toolName, block.input) };
  });
  return { safe: true, fingerprints, tailPresent };
}

export function createRecoveryToolGuard(fingerprints) {
  const blocked = new Set((Array.isArray(fingerprints) ? fingerprints : []).flatMap((entry) => {
    const fingerprint = typeof entry === 'string' ? entry : entry?.fingerprint;
    return typeof fingerprint === 'string' && fingerprint ? [fingerprint] : [];
  }));

  return async (input) => {
    if (!blocked.has(fingerprintToolCall(input?.tool_name, input?.tool_input))) {
      return { continue: true };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    };
  };
}
