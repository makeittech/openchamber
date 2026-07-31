/**
 * Replay Claude Code JSONL transcripts as OpenCode-shaped messages.
 *
 * Harness turns (and imported Claude sessions) are broadcast-only: OpenCode's
 * own message store stays empty, so `/session/:id/message` would otherwise
 * return an authoritative-looking empty list and the UI renders a blank page.
 * The Claude transcript on disk is the durable history — this module parses it
 * into the same `{ info, parts }` shape the live event mapper emits, with
 * deterministic ascending ids so repeated reads are stable.
 *
 * Read-only: nothing is written into OpenCode storage. Results are cached per
 * transcript (path + mtime + size) and re-parsed only when the file changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getSessionBinding } from '../../session-bindings.js';
import { toOpenCodeToolName } from '../../events/from-claude.js';
import { resolveClaudeProjectsRoot } from './import-from-disk.js';
import { isRecoveryContinuationRecord } from './recovery-transcript.js';

const JSONL_EXT = '.jsonl';
const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;
export const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const ID_RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** @type {Map<string, { path: string | null, resolvedAt: number }>} */
const transcriptPathCache = new Map();
/** @type {Map<string, { mtimeMs: number, size: number, messages: object[], aiTitle: string | null }>} */
const transcriptParseCache = new Map();
/** @type {Map<string, { mtimeMs: number, size: number, aiTitle: string | null }>} */
const transcriptTitleCache = new Map();

/**
 * Deterministic base62 suffix from a string seed (stable across re-parses,
 * unlike the live mapper's random suffix).
 *
 * @param {string} seed
 * @param {number} [length]
 * @returns {string}
 */
function stableSuffix(seed, length = 14) {
  let hash1 = 0x811c9dc5;
  let hash2 = 0x01000193;
  for (let i = 0; i < seed.length; i += 1) {
    const code = seed.charCodeAt(i);
    hash1 = Math.imul(hash1 ^ code, 0x01000193) >>> 0;
    hash2 = (Math.imul(hash2, 31) + code) >>> 0;
  }
  let out = '';
  let state1 = hash1 || 1;
  let state2 = hash2 || 0x9e3779b9;
  for (let i = 0; i < length; i += 1) {
    state1 = (Math.imul(state1, 1103515245) + 12345) >>> 0;
    state2 = (Math.imul(state2, 1664525) + 1013904223) >>> 0;
    out += ID_RANDOM_CHARS[((state1 ^ state2) >>> 0) % ID_RANDOM_CHARS.length];
  }
  return out;
}

/**
 * Ascending OpenCode-compatible id derived from the record timestamp so
 * lexicographic order matches transcript order (UI sorts parts/messages by id).
 *
 * @param {string} prefix
 * @param {number} timestampMs
 * @param {number} seq
 * @param {string} seed
 * @returns {string}
 */
function transcriptId(prefix, timestampMs, seq, seed) {
  const value = BigInt(Math.max(0, Math.floor(timestampMs))) * BigInt(0x1000)
    + BigInt(Math.max(0, seq) % 0x1000);
  let hex = '';
  for (let i = 0; i < 6; i += 1) {
    hex += Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff)).toString(16).padStart(2, '0');
  }
  return `${prefix}_${hex}${stableSuffix(seed)}`;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function parseTimestampMs(value) {
  if (typeof value !== 'string' || !value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Locate the transcript file for a Claude session id by scanning the projects
 * root. Cached per id; pass `refresh: true` to re-resolve (e.g. first turn of
 * a session whose file did not exist yet).
 *
 * @param {string} foreignSessionId
 * @param {object} [options]
 * @param {boolean} [options.refresh]
 * @returns {string | null}
 */
export function findClaudeTranscriptPath(foreignSessionId, options = {}) {
  if (typeof foreignSessionId !== 'string' || !foreignSessionId.trim()) return null;
  const id = foreignSessionId.trim();
  if (!options.refresh && transcriptPathCache.has(id)) {
    return transcriptPathCache.get(id).path;
  }

  const projectsRoot = resolveClaudeProjectsRoot();
  let found = null;
  if (projectsRoot) {
    const fileName = `${id}${JSONL_EXT}`;
    let projectKeys = [];
    try {
      projectKeys = fs.readdirSync(projectsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      projectKeys = [];
    }
    for (const projectKey of projectKeys) {
      for (const dir of [path.join(projectsRoot, projectKey), path.join(projectsRoot, projectKey, 'sessions')]) {
        const candidate = path.join(dir, fileName);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            found = candidate;
            break;
          }
        } catch {
          // keep scanning
        }
      }
      if (found) break;
    }
  }

  transcriptPathCache.set(id, { path: found, resolvedAt: Date.now() });
  return found;
}

/**
 * Harness-injected `<task-notification>` user records (orphaned background
 * shell tasks surfaced on resume) are model context, not user turns —
 * replaying them renders system XML as a user bubble on every refetch.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isTaskNotificationText(text) {
  return text.trimStart().startsWith('<task-notification>');
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * @param {string} text
 * @returns {string}
 */
function capToolOutput(text) {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n… [truncated ${text.length - MAX_TOOL_OUTPUT_CHARS} chars]`;
}

/**
 * @param {unknown} usage
 * @returns {{ input: number, output: number, reasoning: number, cache: { read: number, write: number } }}
 */
function mapUsage(usage) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const num = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  return {
    input: num(source.input_tokens ?? source.inputTokens),
    output: num(source.output_tokens ?? source.outputTokens),
    reasoning: num(source.reasoning_tokens ?? source.reasoningTokens),
    cache: {
      read: num(source.cache_read_input_tokens ?? source.cacheReadInputTokens),
      write: num(source.cache_creation_input_tokens ?? source.cacheCreationInputTokens),
    },
  };
}

/**
 * Parse a Claude transcript into OpenCode-shaped messages.
 *
 * Grouping: a user record with real text opens a new turn (user message +
 * lazy assistant bucket). `tool_result`-only user records settle tool parts
 * on the open assistant bucket instead of rendering as empty user bubbles.
 *
 * @param {object} params
 * @param {string} params.sessionId OpenCode shell session id
 * @param {string} [params.directory]
 * @param {string} [params.modelRef]
 * @param {string} params.transcriptPath
 * @returns {{ messages: object[], aiTitle: string | null }}
 */
export function parseClaudeTranscript(params) {
  const sessionId = params.sessionId;
  const directory = typeof params.directory === 'string' ? params.directory : '';
  const modelRef = typeof params.modelRef === 'string' && params.modelRef ? params.modelRef : 'sonnet';

  const raw = fs.readFileSync(params.transcriptPath, 'utf8');
  const lines = raw.split(/\r?\n/);

  /** @type {object[]} */
  const messages = [];
  /** @type {{ info: object, parts: object[] } | null} */
  let currentUser = null;
  /** @type {{ info: object, parts: object[] } | null} */
  let currentAssistant = null;
  /** @type {Map<string, { part: object, state: object }>} */
  const toolParts = new Map();
  let aiTitle = null;
  let seq = 0;

  const nextSeq = () => {
    seq += 1;
    return seq;
  };

  const closeTurn = () => {
    currentUser = null;
    currentAssistant = null;
    toolParts.clear();
  };

  const ensureAssistant = (createdMs, seed, parentId) => {
    if (currentAssistant) return currentAssistant;
    const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    currentAssistant = {
      info: {
        id: transcriptId('msg', createdMs, nextSeq(), `${seed}:assistant`),
        sessionID: sessionId,
        role: 'assistant',
        time: { created: createdMs || Date.now() },
        parentID: parentId,
        modelID: modelRef,
        providerID: 'claude-code',
        mode: 'build',
        agent: 'build',
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens,
      },
      parts: [],
    };
    messages.push(currentAssistant);
    return currentAssistant;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;

    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
      aiTitle = record.aiTitle.trim();
      continue;
    }

    if (record.type !== 'user' && record.type !== 'assistant') continue;
    if (record.isSidechain === true || record.isMeta === true) continue;
    const message = record.message;
    if (!message || typeof message !== 'object') continue;
    const createdMs = parseTimestampMs(record.timestamp);
    const seed = typeof record.uuid === 'string' && record.uuid ? record.uuid : `line-${seq}`;
    const content = message.content;

    if (record.type === 'user') {
      // Synthetic recovery continuation injected by the Claude session-limit
      // recovery flow is invisible context the model uses to resume, not a
      // visible user turn. Skip it entirely (the continuation text starts
      // with `<openchamber-continuation>` and the record is `isSynthetic`).
      // Unlike `<task-notification>`, this MUST NOT close the current turn —
      // the post-recovery assistant stays grouped under the original user.
      if (isRecoveryContinuationRecord(record)) {
        continue;
      }
      const blocks = Array.isArray(content) ? content : [];
      const textParts = [];
      if (typeof content === 'string' && content.trim() && !isTaskNotificationText(content)) {
        textParts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of blocks) {
          if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()
            && !isTaskNotificationText(block.text)) {
            textParts.push(block.text);
          }
        }
      }

      if (textParts.length > 0) {
        closeTurn();
        const created = createdMs || Date.now();
        currentUser = {
          info: {
            id: transcriptId('msg', created, nextSeq(), `${seed}:user`),
            sessionID: sessionId,
            role: 'user',
            time: { created },
            agent: 'build',
            model: { providerID: 'claude-code', modelID: modelRef },
          },
          parts: textParts.map((text, index) => ({
            id: transcriptId('prt', created, nextSeq(), `${seed}:text:${index}`),
            sessionID: sessionId,
            messageID: '',
            type: 'text',
            text,
            time: { start: created, end: created },
          })),
        };
        for (const part of currentUser.parts) {
          part.messageID = currentUser.info.id;
        }
        messages.push(currentUser);
        continue;
      }

      // tool_result-only user record: settle open tool parts.
      if (Array.isArray(content)) {
        for (const block of blocks) {
          if (!block || block.type !== 'tool_result') continue;
          const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const entry = callId ? toolParts.get(callId) : null;
          if (!entry) continue;
          const output = capToolOutput(toolResultText(block.content));
          const ended = createdMs || Date.now();
          entry.part.state = block.is_error === true
            ? {
              status: 'error',
              input: entry.state.input,
              error: output || 'Tool error',
              time: { start: entry.state.time?.start ?? ended, end: ended },
            }
            : {
              status: 'completed',
              input: entry.state.input,
              output,
              title: entry.part.tool,
              metadata: {},
              time: { start: entry.state.time?.start ?? ended, end: ended },
            };
        }
      }
      continue;
    }

    // assistant record
    const blocks = Array.isArray(content) ? content : [];
    if (blocks.length === 0) continue;
    const assistant = ensureAssistant(createdMs, seed, currentUser?.info?.id);
    if (message.model && typeof message.model === 'string' && message.model) {
      assistant.info.modelID = message.model;
    }
    const usage = mapUsage(message.usage);
    if (usage.input || usage.output || usage.cache.read || usage.cache.write) {
      assistant.info.tokens = usage;
    }
    const completed = createdMs || Date.now();
    assistant.info.time = { ...assistant.info.time, completed };

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        assistant.parts.push({
          id: transcriptId('prt', createdMs, nextSeq(), `${seed}:text:${assistant.parts.length}`),
          sessionID: sessionId,
          messageID: assistant.info.id,
          type: 'text',
          text: block.text,
          time: { start: createdMs || completed, end: completed },
        });
        continue;
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        assistant.parts.push({
          id: transcriptId('prt', createdMs, nextSeq(), `${seed}:thinking:${assistant.parts.length}`),
          sessionID: sessionId,
          messageID: assistant.info.id,
          type: 'reasoning',
          text: block.thinking,
          time: { start: createdMs || completed, end: completed },
        });
        continue;
      }
      if (block.type === 'tool_use') {
        const callId = typeof block.id === 'string' && block.id ? block.id : transcriptId('call', createdMs, nextSeq(), `${seed}:call`);
        const rawToolName = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool';
        const toolName = toOpenCodeToolName(rawToolName);
        const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {};
        const part = {
          id: transcriptId('prt', createdMs, nextSeq(), `${seed}:tool:${callId}`),
          sessionID: sessionId,
          messageID: assistant.info.id,
          type: 'tool',
          callID: callId,
          tool: toolName,
          state: {
            status: 'running',
            input,
            time: { start: createdMs || completed },
          },
        };
        toolParts.set(callId, { part, state: { input, time: { start: createdMs || completed } } });
        assistant.parts.push(part);
      }
    }
  }

  // A transcript can end mid-turn (aborted/interrupted): mark still-running
  // tools as error so the UI does not spin forever on replay.
  for (const { part } of toolParts.values()) {
    if (part.state?.status === 'running') {
      part.state = {
        status: 'error',
        input: part.state.input,
        error: 'Tool call did not complete (transcript ended)',
        time: { start: part.state.time?.start, end: part.state.time?.start },
      };
    }
  }

  for (const assistant of messages) {
    if (assistant?.info?.role === 'assistant' && Array.isArray(assistant.parts)) {
      if (assistant.info.finish === undefined) assistant.info.finish = 'stop';
    }
  }

  return { messages, aiTitle };
}

/**
 * Transcript-backed messages for an OpenCode shell session bound to Claude.
 * Returns [] when the session has no Claude binding or no transcript on disk.
 *
 * @param {string} sessionId
 * @returns {Array<{ info: object, parts: object[] }>}
 */
export function getClaudeTranscriptMessages(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return [];
  const binding = getSessionBinding(sessionId);
  if (binding?.harnessId !== 'claude-code') return [];
  const foreignSessionId = typeof binding.foreignSessionId === 'string' ? binding.foreignSessionId : '';
  if (!foreignSessionId) return [];

  const transcriptPath = findClaudeTranscriptPath(foreignSessionId)
    // The very first read can race transcript creation on a brand-new turn.
    || findClaudeTranscriptPath(foreignSessionId, { refresh: true });
  if (!transcriptPath) return [];

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TRANSCRIPT_BYTES) return [];
  } catch {
    return [];
  }

  const cached = transcriptParseCache.get(foreignSessionId);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.messages;
  }

  try {
    const { messages, aiTitle } = parseClaudeTranscript({
      sessionId,
      directory: typeof binding.directory === 'string' ? binding.directory : '',
      modelRef: typeof binding.target?.modelRef === 'string' ? binding.target.modelRef : 'sonnet',
      transcriptPath,
    });
    transcriptParseCache.set(foreignSessionId, { mtimeMs: stat.mtimeMs, size: stat.size, messages, aiTitle });
    return messages;
  } catch {
    // A partially-written transcript must never break the message route.
    return cached?.messages || [];
  }
}

/**
 * Latest Claude-generated session title (`ai-title` records) for a binding.
 *
 * @param {string} foreignSessionId
 * @returns {string | null}
 */
export function readClaudeTranscriptTitle(foreignSessionId) {
  if (typeof foreignSessionId !== 'string' || !foreignSessionId.trim()) return null;
  const transcriptPath = findClaudeTranscriptPath(foreignSessionId)
    || findClaudeTranscriptPath(foreignSessionId, { refresh: true });
  if (!transcriptPath) return null;

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TRANSCRIPT_BYTES) return null;
  } catch {
    return null;
  }

  const cached = transcriptTitleCache.get(foreignSessionId);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.aiTitle;
  }

  // Light dedicated scan: title reads must not populate the message cache
  // (replay ids embed the shell session id, which this probe does not know).
  let aiTitle = null;
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('ai-title')) continue;
      try {
        const record = JSON.parse(trimmed);
        if (record?.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
          aiTitle = record.aiTitle.trim();
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    return null;
  }

  transcriptTitleCache.set(foreignSessionId, { mtimeMs: stat.mtimeMs, size: stat.size, aiTitle });
  return aiTitle;
}

/** Test helper. */
export function resetClaudeTranscriptCaches() {
  transcriptPathCache.clear();
  transcriptParseCache.clear();
  transcriptTitleCache.clear();
}
