/**
 * Bounded raw-transcript safety analyzer and hidden continuation projection
 * for Claude session-limit recovery.
 *
 * When a Claude Agent SDK turn is rejected mid-stream by a session-limit rate
 * limit, the parent assistant message that hit the limit is what the user
 * perceives as the unfinished turn. Recovery resumes the SDK with that same
 * foreign session id, which makes the SDK replay the on-disk transcript
 * verbatim to rebuild model context. That replay is only safe to continue
 * when *every* `tool_use` the rate-limited assistant issued already has a
 * matching `tool_result` on disk — otherwise resuming would re-execute a
 * tool call whose side effects the model never saw settle.
 *
 * This module:
 *
 * - builds the synthetic SDK user message that prompts the model to continue
 *   (`buildRecoveryUserMessage`). That message is prefixed with
 *   {@link RECOVERY_MARKER} so the transcript replay parser in
 *   `transcript-messages.js` can hide it from the visible chat surface.
 * - inspect the durable Claude transcript through the same `findClaudeTranscriptPath`
 *   the replay uses, walks the tail of the turn from the last real,
 *   non-sidechain / non-meta / non-internal user record onward, pairs every
 *   `tool_use` with its `tool_result` (both success and error count as
 *   settled), and emits the fingerprints the recovery PreToolUse hook will
 *   deny so the resumed model cannot replay an exact pre-limit call
 *   (`inspectRecoveryTranscript` + {@link createRecoveryToolGuard}).
 * - classifies a transcript record as an invisible recovery continuation so
 *   the replay parser can skip it without closing the active turn
 *   ({@link isRecoveryContinuationRecord}).
 *
 * This module is read-only and pure with respect to Claude storage: nothing
 * here writes the transcript, the durable binding store, or OpenCode storage.
 * The actual recovery launch/scheduling lives in later tasks.
 */

import fs from 'node:fs';

import { findClaudeTranscriptPath, MAX_TRANSCRIPT_BYTES } from './transcript-messages.js';

export const RECOVERY_MARKER = '<openchamber-continuation version="1" reason="claude-session-limit">';

const DENY_REASON = 'OpenChamber blocked an exact pre-limit tool replay.';
const MAX_RECOVERY_TOOL_FINGERPRINTS = 1024;

/**
 * Build the synthetic SDK user message that prompts the model to continue an
 * interrupted turn after a Claude session-limit rate-limit. The message is
 * `priority: 'now'` and `isSynthetic: true` and its single text block starts
 * with {@link RECOVERY_MARKER} so the transcript replay parser hides it.
 *
 * @param {string} [launchUuid] UUID of the recovery user message; defaults to
 *   the empty string when omitted so the SDK still emits a record.
 * @returns {{
 *   type: 'user',
 *   uuid: string,
 *   parent_tool_use_id: null,
 *   isSynthetic: true,
 *   priority: 'now',
 *   message: { role: 'user', content: Array<{ type: 'text', text: string }> },
 * }}
 */
export function buildRecoveryUserMessage(launchUuid) {
  const uuid = typeof launchUuid === 'string' ? launchUuid : '';
  return {
    type: 'user',
    uuid,
    parent_tool_use_id: null,
    isSynthetic: true,
    priority: 'now',
    message: {
      role: 'user',
      content: [{ type: 'text', text: `${RECOVERY_MARKER}\nContinue the interrupted response.` }],
    },
  };
}

/**
 * Recursively canonicalize a JSON-shaped value so two structurally-equal
 * inputs reduce to the same string regardless of object-key order. Array
 * order, value types (number vs string vs boolean), and nested structure
 * are preserved. Values JSON cannot represent without ambiguity collapse to
 * `null` (functions, symbols, undefined, non-finite numbers, bigint → its
 * decimal string).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalizeValue(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type !== 'object') {
    if (type === 'undefined') return null;
    if (type === 'function' || type === 'symbol') return null;
    if (type === 'number' && !Number.isFinite(value)) return null;
    if (type === 'bigint') return String(value);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (typeof child === 'undefined') continue;
    out[key] = canonicalizeValue(child);
  }
  return out;
}

/**
 * Canonical fingerprint of a tool call. Stable across object-key order;
 * preserves array order, value types, and nested structure so two equal tool
 * calls produce the same string even when replay produces differently-ordered
 * object keys.
 *
 * @param {string} toolName
 * @param {unknown} input
 * @returns {string}
 */
export function fingerprintToolCall(toolName, input) {
  const tool = typeof toolName === 'string' ? toolName : '';
  const inputArg = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return JSON.stringify({ tool, input: canonicalizeValue(inputArg) });
}

/**
 * Extract the *first* visible text segment from a user message content field.
 * Returns `null` when no text block (and not a string content) is present.
 *
 * @param {unknown} content
 * @returns {string | null}
 */
function firstUserText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object'
        && block.type === 'text' && typeof block.text === 'string') {
        return block.text;
      }
    }
  }
  return null;
}

/**
 * Classify a transcript record as the synthetic recovery continuation injected
 * by the recovery flow. Returns true only when:
 *
 * - the record carries `isSynthetic === true` (strictly), AND
 * - one of the user text blocks (or the string content) starts *exactly* with
 *   {@link RECOVERY_MARKER}.
 *
 * A real user message that merely starts with the same characters but is not
 * synthetic MUST stay visible — only both conditions trigger the hide.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
export function isRecoveryContinuationRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.isSynthetic !== true) return false;
  const message = record.message;
  if (!message || typeof message !== 'object') return false;
  const text = firstUserText(message.content);
  return typeof text === 'string' && text.startsWith(RECOVERY_MARKER);
}

/**
 * Internal user records the replay parser hides but that we still iterate
 * past: harness-injected `<task-notification>` shell-task notices, and the
 * synthetic recovery continuation this feature injects. Neither opens a real
 * visible user turn.
 *
 * @param {object} record
 * @returns {boolean}
 */
function isInternalUserRecord(record) {
  if (isRecoveryContinuationRecord(record)) return true;
  const message = record.message;
  if (!message || typeof message !== 'object') return false;
  const content = message.content;
  if (typeof content === 'string') {
    return content.trimStart().startsWith('<task-notification>');
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object'
        && block.type === 'text' && typeof block.text === 'string'
        && block.text.trimStart().startsWith('<task-notification>')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Does this user record open a *real* visible user turn that the analysis
 * should anchor on? Must be a non-sidechain / non-meta / non-internal user
 * record with at least one non-empty text block.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
function isOpeningUserTurn(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.type !== 'user') return false;
  if (record.isSidechain === true || record.isMeta === true) return false;
  if (isInternalUserRecord(record)) return false;
  const message = record.message;
  if (!message || typeof message !== 'object') return false;
  const content = message.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object'
        && block.type === 'text' && typeof block.text === 'string'
        && block.text.trim()) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Result of {@link inspectRecoveryTranscript} when the transcript is
 * unreadable (missing / empty / oversize / malformed) or no foreign id is
 * supplied.
 *
 * @returns {{ safe: false, reason: 'transcript-unreadable' }}
 */
function unreadable() {
  return { safe: false, reason: 'transcript-unreadable' };
}

/**
 * Read, parse, and analyse the bounded tail of the on-disk Claude transcript
 * for session-limit recovery safety.
 *
 * The analysis window starts at the **last** real, non-sidechain /
 * non-meta / non-internal user turn and runs to the end of the transcript.
 * Within that window:
 *
 * 1. every `tool_use` block (by `id`) must have a matching `tool_result`
 *    (by `tool_use_id`); both success and error results count as settled;
 * 2. any unmatched tool returns `{ safe: false, reason: 'unsettled-tool' }`;
 * 3. settled tool calls are fingerprinted (see {@link fingerprintToolCall});
 * 4. `tailPresent` reports whether the caller-supplied `expectedTailUuid`
 *    (the rate-limited assistant's UUID) appears in the window.
 *
 * Malformed / oversized / unreadable transcripts fail closed:
 * `{ safe: false, reason: 'transcript-unreadable' }`.
 *
 * @param {object} params
 * @param {string} params.foreignSessionId Claude session id (the resume target)
 * @param {string} [params.expectedTailUuid] rate-limit assistant uuid the caller correlated with the structured rate-limit window
 * @param {string} [params.launchUuid] reserved for the synthetic continuation message uuid — informational only here (later tasks own launch)
 * @returns {{ safe: boolean, reason?: 'transcript-unreadable' | 'unsettled-tool', fingerprints?: Array<{ toolName: string, fingerprint: string }>, tailPresent?: boolean }}
 */
export function inspectRecoveryTranscript({ foreignSessionId, expectedTailUuid, launchUuid } = {}) {
  void launchUuid; // reserved for later-task recovery wiring; intentionally unused here.

  const id = typeof foreignSessionId === 'string' ? foreignSessionId.trim() : '';
  if (!id) return unreadable();

  const transcriptPath = findClaudeTranscriptPath(id)
    || findClaudeTranscriptPath(id, { refresh: true });
  if (!transcriptPath) return unreadable();

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TRANSCRIPT_BYTES) return unreadable();
  } catch {
    return unreadable();
  }

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return unreadable();
  }

  /** @type {object[]} */
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // Skip malformed lines the same way the replay parser does.
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    records.push(record);
  }

  // Anchor the analysis on the last real user turn. If none exists, there is
  // nothing to recover: nothing in the window can fail to settle, but there
  // is also no rate-limit tail to verify, so tailPresent = false.
  let startIndex = -1;
  for (let i = 0; i < records.length; i += 1) {
    if (isOpeningUserTurn(records[i])) startIndex = i;
  }
  if (startIndex === -1) {
    return { safe: true, fingerprints: [], tailPresent: false };
  }

  const expectedTail = typeof expectedTailUuid === 'string' && expectedTailUuid ? expectedTailUuid : '';
  /** @type {Set<string>} */
  const toolUseIds = new Set();
  /** @type {Set<string>} */
  const settledToolUseIds = new Set();
  let tailPresent = false;

  for (let i = startIndex; i < records.length; i += 1) {
    const record = records[i];
    if (!record || typeof record !== 'object') continue;
    if (record.isSidechain === true || record.isMeta === true) continue;
    if (expectedTail && typeof record.uuid === 'string' && record.uuid === expectedTail) {
      tailPresent = true;
    }
    const type = record.type;
    if (type !== 'user' && type !== 'assistant') continue;
    const message = record.message;
    const content = message && typeof message === 'object' ? message.content : null;
    if (!Array.isArray(content)) continue;

    if (type === 'assistant') {
      for (const block of content) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
        const callId = typeof block.id === 'string' && block.id ? block.id : null;
        if (!callId) continue;
        toolUseIds.add(callId);
      }
    } else {
      // user record carrying tool_result blocks
      for (const block of content) {
        if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
        const callId = typeof block.tool_use_id === 'string' && block.tool_use_id ? block.tool_use_id : null;
        if (!callId) continue;
        // Only mark settled if the corresponding tool_use is in the window;
        // results referencing pre-window tools don't change the current tail.
        if (toolUseIds.has(callId)) settledToolUseIds.add(callId);
      }
    }
  }

  // Any tool_use without a settled result is unsafe to continue past.
  for (const callId of toolUseIds) {
    if (!settledToolUseIds.has(callId)) {
      return { safe: false, reason: 'unsettled-tool' };
    }
  }

  // Fingerprint settled tool calls in transcript order (assistant records
  // emitted their tool_use blocks in the same order Claude executed them).
  /** @type {Array<{ toolName: string, fingerprint: string }>} */
  const fingerprints = [];
  for (let i = startIndex; i < records.length; i += 1) {
    const record = records[i];
    if (!record || typeof record !== 'object') continue;
    if (record.isSidechain === true || record.isMeta === true) continue;
    if (record.type !== 'assistant') continue;
    const message = record.message;
    const content = message && typeof message === 'object' ? message.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue;
      const callId = typeof block.id === 'string' && block.id ? block.id : null;
      if (!callId || !settledToolUseIds.has(callId)) continue;
      const toolName = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : '';
      const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input)
        ? block.input
        : {};
      fingerprints.push({ toolName, fingerprint: fingerprintToolCall(toolName, input) });
      if (fingerprints.length >= MAX_RECOVERY_TOOL_FINGERPRINTS) {
        return { safe: true, fingerprints, tailPresent };
      }
    }
  }

  return { safe: true, fingerprints, tailPresent };
}

/**
 * Build an SDK `PreToolUse` hook callback that denies exact fingerprint
 * matches — i.e. tool calls the model is replaying from just before the
 * session-limit rate-limit. Novel tool calls (different name and/or different
 * arguments) and tool calls whose fingerprint the inspector did not record
 * pass through with `{ continue: true }`.
 *
 * Accepts either an array of `{ toolName, fingerprint }` shapes (as
 * {@link inspectRecoveryTranscript} returns) or an array of bare fingerprint
 * strings.
 *
 * @param {Array<{ toolName: string, fingerprint: string } | string> | undefined} fingerprints
 * @returns {(input: { tool_name?: string, tool_input?: unknown }, toolUseId?: string, options?: { signal?: AbortSignal }) => Promise<{ hookSpecificOutput?: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: string }, continue?: boolean }>}
 */
export function createRecoveryToolGuard(fingerprints) {
  /** @type {Set<string>} */
  const store = new Set();
  if (Array.isArray(fingerprints)) {
    for (const entry of fingerprints) {
      const fingerprint = typeof entry === 'string'
        ? entry
        : (entry && typeof entry === 'object' && typeof entry.fingerprint === 'string' ? entry.fingerprint : null);
      if (typeof fingerprint === 'string' && fingerprint.length > 0) store.add(fingerprint);
    }
  }
  return async (input) => {
    const candidate = fingerprintToolCall(input?.tool_name, input?.tool_input);
    if (store.has(candidate)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: DENY_REASON,
        },
      };
    }
    return { continue: true };
  };
}