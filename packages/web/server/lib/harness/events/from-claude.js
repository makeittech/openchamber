/** Map Claude Agent SDK messages to OpenCode-shaped canonical events. */

import crypto from 'node:crypto';
import { selectRejectedRateLimit } from '../retry-policy.js';

const ID_RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_RANDOM_LENGTH = 14;

let lastIdTimestamp = 0;
let idCounter = 0;

function randomBase62() {
  const bytes = crypto.randomBytes(ID_RANDOM_LENGTH);
  let result = '';
  for (let i = 0; i < ID_RANDOM_LENGTH; i += 1) {
    result += ID_RANDOM_CHARS[bytes[i] % ID_RANDOM_CHARS.length];
  }
  return result;
}

/**
 * OpenCode-compatible ascending id (`msg_*` / `prt_*` / `perm_*` / `call_*`).
 * Lexicographic order matches creation order across the UI event reducer.
 *
 * @param {string} prefix
 * @returns {string}
 */
export function createOpenCodeId(prefix) {
  const now = Date.now();
  if (now !== lastIdTimestamp) {
    lastIdTimestamp = now;
    idCounter = 0;
  }
  idCounter += 1;

  const value = BigInt(now) * BigInt(0x1000) + BigInt(idCounter);
  let hex = '';
  for (let i = 0; i < 6; i += 1) {
    const byte = Number((value >> BigInt(40 - 8 * i)) & BigInt(0xff));
    hex += byte.toString(16).padStart(2, '0');
  }

  return `${prefix}_${hex}${randomBase62()}`;
}

/** Test helper — reset ascending id clock state. */
export function resetOpenCodeIdState() {
  lastIdTimestamp = 0;
  idCounter = 0;
}

/**
 * @typedef {object} ClaudeSubagentContext
 * @property {string} sessionId
 * @property {string} assistantMessageId
 * @property {string} userMessageId
 * @property {string} title
 * @property {string} textPartId
 * @property {string} reasoningPartId
 * @property {Map<string, { partId: string, toolName: string, input: object, settled?: boolean }>} toolParts
 * @property {string} accumulatedText
 * @property {boolean} textPartStarted
 * @property {boolean} needsNewTextSegment
 * @property {string} accumulatedReasoning
 * @property {boolean} reasoningPartStarted
 * @property {boolean} needsNewReasoningSegment
 * @property {boolean} created
 */

/**
 * @typedef {object} ClaudeMapperContext
 * @property {string} sessionId
 * @property {string} directory
 * @property {string} userMessageId
 * @property {string} assistantMessageId
 * @property {string} [modelRef]
 * @property {string} [textPartId]
 * @property {Map<string, { partId: string, toolName: string, input: object, startedAt?: number, settled?: boolean }>} [toolParts]
 * @property {string} [foreignSessionId]
 * @property {number} [assistantCreatedAt]
 * @property {string} [accumulatedText]
 * @property {boolean} [needsNewTextSegment]
 * @property {boolean} [textPartStarted]
 * @property {string} [reasoningPartId]
 * @property {string} [accumulatedReasoning]
 * @property {boolean} [needsNewReasoningSegment]
 * @property {boolean} [reasoningPartStarted]
 * @property {Set<string>} [askUserQuestionCallIds]
 * @property {Map<string, ClaudeSubagentContext>} [subagentByToolUseId]
 * @property {object | null} [lastInitCapabilities]
 * @property {object | null} [latestRateLimitInfo]
 * @property {{ uuid: string } | null} [parentRateLimitError]
 * @property {boolean} [sdkRetryActive]
 */

const RATE_LIMIT_INFO_FIELDS = [
  'status',
  'resetsAt',
  'rateLimitType',
  'overageStatus',
  'overageResetsAt',
  'overageInUse',
  'isUsingOverage',
];

function sanitizeRateLimitInfo(info) {
  if (!info || typeof info !== 'object') return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of RATE_LIMIT_INFO_FIELDS) {
    if (key in info) out[key] = info[key];
  }
  return out;
}

const SEGMENT_FIELDS = {
  text: {
    partId: 'textPartId',
    accumulated: 'accumulatedText',
    started: 'textPartStarted',
    needsNew: 'needsNewTextSegment',
  },
  reasoning: {
    partId: 'reasoningPartId',
    accumulated: 'accumulatedReasoning',
    started: 'reasoningPartStarted',
    needsNew: 'needsNewReasoningSegment',
  },
};

function trimmedText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function finiteOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

/**
 * @param {Partial<ClaudeMapperContext>} input
 * @returns {ClaudeMapperContext}
 */
export function createClaudeMapperContext(input) {
  return {
    sessionId: input.sessionId,
    directory: input.directory,
    userMessageId: input.userMessageId || createOpenCodeId('msg'),
    assistantMessageId: input.assistantMessageId || createOpenCodeId('msg'),
    modelRef: input.modelRef || 'sonnet',
    textPartId: input.textPartId || createOpenCodeId('prt'),
    toolParts: input.toolParts || new Map(),
    foreignSessionId: input.foreignSessionId,
    assistantCreatedAt: input.assistantCreatedAt || Date.now(),
    accumulatedText: input.accumulatedText || '',
    needsNewTextSegment: input.needsNewTextSegment === true,
    textPartStarted: input.textPartStarted === true || Boolean(input.accumulatedText),
    reasoningPartId: input.reasoningPartId || createOpenCodeId('prt'),
    accumulatedReasoning: input.accumulatedReasoning || '',
    needsNewReasoningSegment: input.needsNewReasoningSegment === true,
    reasoningPartStarted: input.reasoningPartStarted === true
      || Boolean(input.accumulatedReasoning),
    subagentByToolUseId: input.subagentByToolUseId || new Map(),
    lastInitCapabilities: input.lastInitCapabilities || null,
    latestRateLimitInfo: input.latestRateLimitInfo ?? null,
    parentRateLimitError: input.parentRateLimitError ?? null,
    sdkRetryActive: input.sdkRetryActive === true,
    askUserQuestionCallIds: input.askUserQuestionCallIds || new Set(),
    tokens: input.tokens && typeof input.tokens === 'object' ? input.tokens : emptyTokens(),
    cost: Number.isFinite(input.cost) ? input.cost : 0,
  };
}

const SUBAGENT_SESSION_PREFIX = 'ses_claude_sub_';

function claudeSubagentSessionId(parentSessionId, toolUseId) {
  const safeTool = String(toolUseId || 'agent').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'agent';
  return `${SUBAGENT_SESSION_PREFIX}${parentSessionId.slice(-12)}_${safeTool}`;
}

/** Subagent sessions are transcript-only and must not consume snapshot space. */
export function isClaudeSubagentSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith(SUBAGENT_SESSION_PREFIX);
}

/**
 * @param {ClaudeMapperContext} parentCtx
 * @param {string} toolUseId
 * @param {string} [title]
 * @returns {ClaudeSubagentContext | null}
 */
function ensureSubagentContext(parentCtx, toolUseId, title) {
  if (!toolUseId) return null;
  const requestedTitle = trimmedText(title).slice(0, 120);

  const existing = parentCtx.subagentByToolUseId.get(toolUseId);
  if (existing) {
    if (requestedTitle && existing.title === 'Subagent') existing.title = requestedTitle;
    return existing;
  }

  const child = {
    sessionId: claudeSubagentSessionId(parentCtx.sessionId, toolUseId),
    assistantMessageId: createOpenCodeId('msg'),
    userMessageId: createOpenCodeId('msg'),
    title: requestedTitle || 'Subagent',
    textPartId: createOpenCodeId('prt'),
    reasoningPartId: createOpenCodeId('prt'),
    toolParts: new Map(),
    accumulatedText: '',
    textPartStarted: false,
    needsNewTextSegment: false,
    accumulatedReasoning: '',
    reasoningPartStarted: false,
    needsNewReasoningSegment: false,
    created: false,
  };
  parentCtx.subagentByToolUseId.set(toolUseId, child);
  return child;
}

/**
 * @param {ClaudeMapperContext} parentCtx
 * @param {ClaudeSubagentContext | null} child
 * @returns {object[]}
 */
function buildSubagentCreatedEvents(parentCtx, child) {
  if (!child || child.created) return [];
  child.created = true;
  const now = Date.now();
  return [{ type: 'session.created', properties: { info: {
    id: child.sessionId,
    parentID: parentCtx.sessionId,
    title: child.title,
    time: { created: now, updated: now },
  } } }];
}

/** Identity fields are read from the child but never written back. */
const CHILD_IDENTITY_FIELDS = ['sessionId', 'assistantMessageId', 'userMessageId'];
const CHILD_STREAM_FIELDS = [
  'textPartId', 'reasoningPartId', 'toolParts', 'accumulatedText', 'textPartStarted',
  'needsNewTextSegment', 'accumulatedReasoning', 'reasoningPartStarted', 'needsNewReasoningSegment',
];

/** Temporarily map shared content helpers over a child context. */
function withSubagentContext(parentCtx, child, fn) {
  const snapshot = {};
  for (const field of [...CHILD_IDENTITY_FIELDS, ...CHILD_STREAM_FIELDS]) {
    snapshot[field] = parentCtx[field];
    parentCtx[field] = child[field];
  }

  try {
    return fn();
  } finally {
    for (const field of CHILD_STREAM_FIELDS) child[field] = parentCtx[field];
    for (const field of Object.keys(snapshot)) parentCtx[field] = snapshot[field];
  }
}

function sessionStatusEvent(sessionId, status) {
  return { type: 'session.status', properties: { sessionID: sessionId, status } };
}

function assistantUpdatedEvent(ctx, completed) {
  return { type: 'message.updated', properties: { info: assistantInfo(ctx, completed) } };
}

/** Wrap part fields in the canonical `message.part.updated` envelope. */
function partEvent(ctx, part) {
  return {
    type: 'message.part.updated',
    properties: {
      sessionID: ctx.sessionId,
      part: {
        id: part.id,
        sessionID: ctx.sessionId,
        messageID: part.messageID || ctx.assistantMessageId,
        ...part,
      },
    },
  };
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {string} text
 * @param {Array<{ mime?: string, url?: string, filename?: string }>} [files]
 * @returns {object[]}
 */
export function buildUserMessageEvents(ctx, text, files) {
  const now = Date.now();
  const events = [
    {
      type: 'message.updated',
      properties: {
        info: {
          id: ctx.userMessageId,
          sessionID: ctx.sessionId,
          role: 'user',
          time: { created: now },
          agent: 'build',
          model: {
            providerID: 'claude-code',
            modelID: ctx.modelRef || 'sonnet',
          },
        },
      },
    },
    partEvent(ctx, {
      id: createOpenCodeId('prt'),
      messageID: ctx.userMessageId,
      type: 'text',
      text: typeof text === 'string' ? text : '',
      time: { start: now, end: now },
    }),
  ];

  for (const file of asArray(files)) {
    if (!file || typeof file !== 'object') continue;
    const url = typeof file.url === 'string' ? file.url : '';
    if (!url) continue;
    events.push(partEvent(ctx, {
      id: createOpenCodeId('prt'),
      messageID: ctx.userMessageId,
      type: 'file',
      mime: typeof file.mime === 'string' ? file.mime : '',
      url,
      filename: trimmedText(file.filename) || 'attachment',
      time: { start: now, end: now },
    }));
  }

  events.push(sessionStatusEvent(ctx.sessionId, { type: 'busy' }));
  return events;
}

function mapClaudeUsageToTokens(usage) {
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
      read: num(
        source.cache_read_input_tokens
        ?? source.cacheReadInputTokens
        ?? source.cache_read_tokens,
      ),
      write: num(
        source.cache_creation_input_tokens
        ?? source.cacheCreationInputTokens
        ?? source.cache_write_tokens,
      ),
    },
  };
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {unknown} usage
 * @param {unknown} [totalCostUsd]
 */
function applyUsageToContext(ctx, usage, totalCostUsd) {
  if (usage && typeof usage === 'object') {
    ctx.tokens = mapClaudeUsageToTokens(usage);
  }
  const cost = Number(totalCostUsd);
  if (Number.isFinite(cost) && cost >= 0) {
    ctx.cost = cost;
  }
}

function assistantInfo(ctx, completed) {
  const tokens = ctx.tokens && typeof ctx.tokens === 'object' ? ctx.tokens : emptyTokens();
  const info = {
    id: ctx.assistantMessageId,
    sessionID: ctx.sessionId,
    role: 'assistant',
    time: {
      created: ctx.assistantCreatedAt,
      ...(completed ? { completed: Date.now() } : {}),
    },
    parentID: ctx.userMessageId,
    modelID: ctx.modelRef || 'sonnet',
    providerID: 'claude-code',
    mode: 'build',
    agent: 'build',
    path: {
      cwd: ctx.directory,
      root: ctx.directory,
    },
    cost: finiteOrZero(ctx.cost),
    tokens: {
      input: finiteOrZero(tokens.input),
      output: finiteOrZero(tokens.output),
      reasoning: finiteOrZero(tokens.reasoning),
      cache: {
        read: finiteOrZero(tokens.cache?.read),
        write: finiteOrZero(tokens.cache?.write),
      },
    },
  };
  if (completed) info.finish = 'stop';
  return info;
}

function beginNewSegment(ctx, kind) {
  const field = SEGMENT_FIELDS[kind];
  ctx[field.partId] = createOpenCodeId('prt');
  ctx[field.accumulated] = '';
  ctx[field.started] = false;
  ctx[field.needsNew] = false;
}

function startSegmentEvents(ctx, kind) {
  const field = SEGMENT_FIELDS[kind];
  ctx[field.started] = true;
  return [
    assistantUpdatedEvent(ctx, false),
    partEvent(ctx, {
      id: ctx[field.partId],
      type: kind,
      text: '',
      time: { start: Date.now() },
    }),
  ];
}

/** Open the segment, starting a fresh part when the previous one closed at a tool boundary. */
function openSegmentEvents(ctx, kind) {
  const field = SEGMENT_FIELDS[kind];
  if (ctx[field.needsNew]) {
    beginNewSegment(ctx, kind);
  } else if (ctx[field.started]) {
    return [];
  }
  return startSegmentEvents(ctx, kind);
}

function segmentDeltaEvents(ctx, kind, delta) {
  if (typeof delta !== 'string' || !delta) return [];
  const field = SEGMENT_FIELDS[kind];
  const events = openSegmentEvents(ctx, kind);

  ctx[field.accumulated] = (ctx[field.accumulated] || '') + delta;
  events.push({
    type: 'message.part.delta',
    properties: {
      sessionID: ctx.sessionId,
      messageID: ctx.assistantMessageId,
      partID: ctx[field.partId],
      field: 'text',
      delta,
    },
  });
  return events;
}

/** Reconcile a complete block with any deltas already emitted. */
function segmentCompletionEvents(ctx, kind, full) {
  const field = SEGMENT_FIELDS[kind];
  const accumulated = ctx[field.accumulated] || '';

  if (!accumulated || ctx[field.needsNew]) {
    return segmentDeltaEvents(ctx, kind, full);
  }
  if (full.startsWith(accumulated)) {
    const remainder = full.slice(accumulated.length);
    return remainder ? segmentDeltaEvents(ctx, kind, remainder) : [];
  }

  ctx[field.accumulated] = full;
  const events = ctx[field.started] ? [] : startSegmentEvents(ctx, kind);
  events.push(...finalizeSegment(ctx, kind));
  return events;
}

function finalizeSegment(ctx, kind) {
  const field = SEGMENT_FIELDS[kind];
  if (!ctx[field.started]) return [];
  return [partEvent(ctx, {
    id: ctx[field.partId],
    type: kind,
    text: ctx[field.accumulated] || '',
    time: { start: ctx.assistantCreatedAt, end: Date.now() },
  })];
}

/** Reasoning closes before the answer it produced. */
function finalizeOpenSegments(ctx) {
  return [...finalizeSegment(ctx, 'reasoning'), ...finalizeSegment(ctx, 'text')];
}

function toolPartEvent(ctx, callId, entry, state) {
  return partEvent(ctx, {
    id: entry.partId,
    type: 'tool',
    callID: callId,
    tool: entry.toolName,
    state,
  });
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} block
 * @returns {object[]}
 */
function mapContentBlock(ctx, block) {
  if (!block || typeof block !== 'object') return [];
  if (block.type === 'text' && typeof block.text === 'string') {
    return segmentCompletionEvents(ctx, 'text', block.text);
  }
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return segmentCompletionEvents(ctx, 'reasoning', block.thinking);
  }
  if (block.type !== 'tool_use') return [];

  const callId = typeof block.id === 'string' ? block.id : createOpenCodeId('call');
  const toolName = trimmedText(block.name) || 'tool';

  // Any tool boundary closes the current text/reasoning segments.
  ctx.needsNewTextSegment = true;
  ctx.needsNewReasoningSegment = true;

  if (toolName === 'AskUserQuestion') {
    ctx.askUserQuestionCallIds.add(callId);
    return [];
  }

  let entry = ctx.toolParts.get(callId);
  if (!entry) {
    entry = { partId: createOpenCodeId('prt'), toolName, input: {} };
    ctx.toolParts.set(callId, entry);
  } else if (toolName !== 'tool') {
    entry.toolName = toolName;
  }

  const input = block.input && typeof block.input === 'object' ? block.input : {};
  if (Object.keys(input).length > 0 || !entry.input) entry.input = input;
  if (typeof entry.startedAt !== 'number') entry.startedAt = Date.now();

  const events = [
    assistantUpdatedEvent(ctx, false),
    toolPartEvent(ctx, callId, entry, {
      status: 'running',
      input,
      time: { start: entry.startedAt },
    }),
  ];

  const isAgentTool = entry.toolName === 'Agent' || entry.toolName === 'Task';
  if (!isAgentTool || !callId) return events;

  const description = trimmedText(input.description)
    || trimmedText(input.prompt).slice(0, 80)
    || trimmedText(input.subagent_type)
    || 'Subagent';
  const child = ensureSubagentContext(ctx, callId, description);
  events.unshift(...buildSubagentCreatedEvents(ctx, child));
  events[events.length - 1].properties.part.state.metadata = {
    sessionId: child.sessionId,
    title: child.title,
  };
  return events;
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} block
 * @returns {object[]}
 */
function mapToolResultBlock(ctx, block) {
  if (!block || block.type !== 'tool_result') return [];
  const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
  if (!callId || ctx.askUserQuestionCallIds?.has(callId)) return [];

  let entry = ctx.toolParts.get(callId);
  if (!entry) {
    entry = { partId: createOpenCodeId('prt'), toolName: 'tool', input: {} };
    ctx.toolParts.set(callId, entry);
  }
  entry.settled = true;

  let output = '';
  if (typeof block.content === 'string') {
    output = block.content;
  } else if (Array.isArray(block.content)) {
    output = block.content.map((item) => (typeof item?.text === 'string' ? item.text : '')).join('\n');
  }

  const input = entry.input && typeof entry.input === 'object' ? entry.input : {};
  const endedAt = Date.now();
  const time = { start: typeof entry.startedAt === 'number' ? entry.startedAt : endedAt, end: endedAt };
  const state = block.is_error === true
    ? { status: 'error', input, error: output || 'Tool error', time }
    : { status: 'completed', input, output, title: entry.toolName, metadata: {}, time };
  return [toolPartEvent(ctx, callId, entry, state)];
}

function buildContextClosureEvents(ctx, reason) {
  const events = finalizeOpenSegments(ctx);
  const now = Date.now();

  for (const [callId, entry] of ctx.toolParts?.entries() ?? []) {
    if (!entry || entry.settled) continue;
    entry.settled = true;
    events.push(toolPartEvent(ctx, callId, entry, {
      status: 'error',
      input: entry.input && typeof entry.input === 'object' ? entry.input : {},
      error: reason,
      time: {
        start: typeof entry.startedAt === 'number' ? entry.startedAt : ctx.assistantCreatedAt,
        end: now,
      },
    }));
  }

  return events;
}

/** Subagents close before the parent turn. */
function buildTurnClosureEvents(ctx, reason) {
  const events = [];
  for (const child of ctx.subagentByToolUseId?.values() ?? []) {
    events.push(...withSubagentContext(ctx, child, () => [
      ...buildContextClosureEvents(ctx, reason),
      assistantUpdatedEvent(ctx, true),
    ]));
  }
  events.push(...buildContextClosureEvents(ctx, reason));
  return events;
}

export function buildTurnAbortEvents(ctx, reason = 'Aborted by user') {
  if (!ctx || typeof ctx !== 'object') return [];
  return buildTurnClosureEvents(ctx, reason);
}

/** The SDK retry banner clears on the first parent content of the new attempt. */
function clearSdkRetryEvents(ctx, isParent, hasContent) {
  if (!ctx.sdkRetryActive || !isParent || !hasContent) return [];
  ctx.sdkRetryActive = false;
  return [sessionStatusEvent(ctx.sessionId, { type: 'busy' })];
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} message
 * @param {string | undefined} foreignSessionId
 * @returns {{ events: object[], capabilities?: object }}
 */
function mapSystemMessage(ctx, message, foreignSessionId) {
  if (message.subtype === 'init') {
    const capabilities = {
      slash_commands: asArray(message.slash_commands),
      skills: asArray(message.skills),
      agents: asArray(message.agents),
      tools: asArray(message.tools),
      mcp_servers: asArray(message.mcp_servers),
      session_id: foreignSessionId,
    };
    ctx.lastInitCapabilities = capabilities;
    return { events: [], capabilities };
  }

  if (message.subtype === 'compact_boundary') {
    const pre = message.compact_metadata?.pre_tokens;
    const trigger = message.compact_metadata?.trigger;
    const notice = [
      'Conversation compacted',
      typeof pre === 'number' ? `(pre-compaction tokens: ${pre})` : '',
      trigger ? `trigger: ${trigger}` : '',
    ].filter(Boolean).join(' · ');
    return { events: [
      ...segmentDeltaEvents(ctx, 'text', notice),
      ...finalizeOpenSegments(ctx),
      assistantUpdatedEvent(ctx, true),
      sessionStatusEvent(ctx.sessionId, { type: 'idle' }),
    ] };
  }

  if (message.subtype === 'api_retry') {
    ctx.sdkRetryActive = true;
    const retryDelayMs = Number.isFinite(message.retry_delay_ms) ? message.retry_delay_ms : 0;
    return { events: [sessionStatusEvent(ctx.sessionId, {
      type: 'retry',
      attempt: Number.isFinite(message.attempt) ? message.attempt : 1,
      message: 'api-retry',
      next: Date.now() + retryDelayMs,
    })] };
  }

  return { events: [] };
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} event
 * @returns {object[]}
 */
function mapStreamEvent(ctx, event) {
  if (event.type === 'content_block_delta') {
    const delta = event.delta;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return segmentDeltaEvents(ctx, 'text', delta.text);
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return segmentDeltaEvents(ctx, 'reasoning', delta.thinking);
    }
    return [];
  }

  if (event.type !== 'content_block_start') return [];

  const block = event.content_block;
  if (block?.type === 'tool_use') return mapContentBlock(ctx, block);
  if (block?.type === 'text') return openSegmentEvents(ctx, 'text');
  if (block?.type === 'thinking') return openSegmentEvents(ctx, 'reasoning');
  return [];
}

/**
 * @param {ClaudeMapperContext} ctx
 * @param {object} message
 * @param {boolean} isParent
 * @returns {object[]}
 */
function mapAssistantError(ctx, message, isParent) {
  const events = [];
  if (isParent && message.error === 'rate_limit') {
    ctx.parentRateLimitError = { uuid: typeof message.uuid === 'string' ? message.uuid : '' };
  } else if (isParent) {
    events.push(sessionStatusEvent(ctx.sessionId, { type: 'idle' }));
  }

  events.push({
    type: 'message.updated',
    properties: {
      info: {
        ...assistantInfo(ctx, true),
        error: {
          name: 'APIError',
          data: {
            message: String(message.error),
            isRetryable: message.error === 'rate_limit' || message.error === 'overloaded',
          },
        },
      },
    },
  });
  return events;
}

/** Map one SDK message and mutate the context's stream state. */
export function mapClaudeMessageToEvents(ctx, message) {
  if (!message || typeof message !== 'object') {
    return { events: [] };
  }

  const events = [];
  let foreignSessionId;
  /** @type {object | undefined} */
  let capabilities;
  /** @type {{ type: 'rate-limit', rateLimitType: string, resetAt: number, assistantUuid: string } | undefined} */
  let terminal;

  if (typeof message.session_id === 'string' && message.session_id) {
    foreignSessionId = message.session_id;
    ctx.foreignSessionId = foreignSessionId;
  }

  const parentToolUseId = trimmedText(message.parent_tool_use_id);
  const isParent = !parentToolUseId;

  /** Run a mapper against the owning context — the parent, or the addressed subagent. */
  const mapMaybeNested = (mapFn) => {
    if (isParent) {
      events.push(...mapFn());
      return;
    }
    const child = ensureSubagentContext(ctx, parentToolUseId);
    events.push(...buildSubagentCreatedEvents(ctx, child));
    events.push(...withSubagentContext(ctx, child, mapFn));
  };

  switch (message.type) {
    case 'system': {
      const mapped = mapSystemMessage(ctx, message, foreignSessionId);
      events.push(...mapped.events);
      capabilities = mapped.capabilities;
      break;
    }

    case 'stream_event': {
      const event = message.event;
      if (!event || typeof event !== 'object') break;
      events.push(...clearSdkRetryEvents(
        ctx,
        isParent,
        event.type === 'content_block_delta' || event.type === 'content_block_start',
      ));
      mapMaybeNested(() => mapStreamEvent(ctx, event));
      break;
    }

    case 'rate_limit_event': {
      ctx.latestRateLimitInfo = sanitizeRateLimitInfo(message.rate_limit_info);
      break;
    }

    case 'assistant': {
      const content = message.message?.content;
      events.push(...clearSdkRetryEvents(ctx, isParent, asArray(content).length > 0));
      mapMaybeNested(() => {
        const nested = [];
        for (const block of asArray(content)) {
          nested.push(...mapContentBlock(ctx, block));
        }
        if (message.error) nested.push(...mapAssistantError(ctx, message, isParent));
        return nested;
      });
      break;
    }

    case 'user': {
      mapMaybeNested(() => {
        const nested = [];
        for (const block of asArray(message.message?.content)) {
          nested.push(...mapToolResultBlock(ctx, block));
        }
        return nested;
      });
      break;
    }

    case 'result': {
      const resultText = typeof message.result === 'string' ? message.result : '';
      const hasContent = ctx.textPartStarted || ctx.reasoningPartStarted
        || ctx.toolParts.size > 0 || Boolean(resultText);

      applyUsageToContext(ctx, message.usage, message.total_cost_usd);

      if (!ctx.textPartStarted && resultText) {
        events.push(...segmentDeltaEvents(ctx, 'text', resultText));
      }
      events.push(...buildTurnClosureEvents(ctx, 'Turn ended'));
      if (hasContent) events.push(assistantUpdatedEvent(ctx, true));

      ctx.sdkRetryActive = false;

      const rejected = selectRejectedRateLimit(ctx.latestRateLimitInfo);
      if (ctx.parentRateLimitError && rejected) {
        terminal = {
          type: 'rate-limit',
          rateLimitType: rejected.rateLimitType,
          resetAt: rejected.resetAt,
          assistantUuid: ctx.parentRateLimitError.uuid,
        };
        break;
      }

      events.push(sessionStatusEvent(ctx.sessionId, { type: 'idle' }));
      const isError = message.is_error === true
        || (typeof message.subtype === 'string' && message.subtype.startsWith('error_'));
      if (isError) {
        events.push({ type: 'session.error', properties: { sessionID: ctx.sessionId } });
      }
      break;
    }

    default:
      break;
  }

  return { events, foreignSessionId, capabilities, terminal, rateLimitInfo: ctx.latestRateLimitInfo ?? null };
}
