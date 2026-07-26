/**
 * Map Cursor agent-client stream events → OpenCode-shaped canonical events.
 */

import {
  buildUserMessageEvents,
  createClaudeMapperContext,
  createOpenCodeId,
} from './from-claude.js';

/**
 * @typedef {object} CursorMapperContext
 * @property {string} sessionId
 * @property {string} directory
 * @property {string} userMessageId
 * @property {string} assistantMessageId
 * @property {string} [modelRef]
 * @property {string} [textPartId]
 * @property {string} [thinkingPartId]
 * @property {Map<string, string>} [toolPartIds]
 * @property {number} [assistantCreatedAt]
 * @property {string} [accumulatedText]
 * @property {string} [accumulatedThinking]
 * @property {boolean} [assistantStarted]
 */

/**
 * @param {Partial<CursorMapperContext>} input
 * @returns {CursorMapperContext}
 */
export function createCursorMapperContext(input) {
  const base = createClaudeMapperContext(input);
  return {
    ...base,
    modelRef: input.modelRef || base.modelRef || 'composer-1.5',
    thinkingPartId: input.thinkingPartId || createOpenCodeId('prt'),
    toolPartIds: input.toolPartIds || base.toolPartIds || new Map(),
    accumulatedThinking: input.accumulatedThinking || '',
    assistantStarted: Boolean(input.assistantStarted),
  };
}

export { buildUserMessageEvents, createOpenCodeId };

/**
 * @param {CursorMapperContext} ctx
 * @param {boolean} completed
 */
function assistantInfo(ctx, completed) {
  const info = {
    id: ctx.assistantMessageId,
    sessionID: ctx.sessionId,
    role: 'assistant',
    time: {
      created: ctx.assistantCreatedAt,
      ...(completed ? { completed: Date.now() } : {}),
    },
    parentID: ctx.userMessageId,
    modelID: ctx.modelRef || 'composer-1.5',
    providerID: 'cursor',
    mode: 'build',
    agent: 'build',
    path: {
      cwd: ctx.directory,
      root: ctx.directory,
    },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  if (completed) info.finish = 'stop';
  return info;
}

/**
 * @param {CursorMapperContext} ctx
 * @returns {object[]}
 */
function ensureAssistantStarted(ctx) {
  if (ctx.assistantStarted) return [];
  ctx.assistantStarted = true;
  return [{
    type: 'message.updated',
    properties: { info: assistantInfo(ctx, false) },
  }];
}

/**
 * @param {CursorMapperContext} ctx
 * @param {string} delta
 * @returns {object[]}
 */
function textDeltaEvents(ctx, delta) {
  if (typeof delta !== 'string' || !delta) return [];
  const events = ensureAssistantStarted(ctx);
  if (!ctx.accumulatedText) {
    events.push({
      type: 'message.part.updated',
      properties: {
        sessionID: ctx.sessionId,
        part: {
          id: ctx.textPartId,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMessageId,
          type: 'text',
          text: '',
          time: { start: Date.now() },
        },
      },
    });
  }
  ctx.accumulatedText = (ctx.accumulatedText || '') + delta;
  events.push({
    type: 'message.part.delta',
    properties: {
      sessionID: ctx.sessionId,
      messageID: ctx.assistantMessageId,
      partID: ctx.textPartId,
      field: 'text',
      delta,
    },
  });
  return events;
}

/**
 * @param {CursorMapperContext} ctx
 * @param {string} delta
 * @returns {object[]}
 */
function thinkingDeltaEvents(ctx, delta) {
  if (typeof delta !== 'string' || !delta) return [];
  const events = ensureAssistantStarted(ctx);
  if (!ctx.accumulatedThinking) {
    events.push({
      type: 'message.part.updated',
      properties: {
        sessionID: ctx.sessionId,
        part: {
          id: ctx.thinkingPartId,
          sessionID: ctx.sessionId,
          messageID: ctx.assistantMessageId,
          type: 'reasoning',
          text: '',
          time: { start: Date.now() },
        },
      },
    });
  }
  ctx.accumulatedThinking = (ctx.accumulatedThinking || '') + delta;
  events.push({
    type: 'message.part.delta',
    properties: {
      sessionID: ctx.sessionId,
      messageID: ctx.assistantMessageId,
      partID: ctx.thinkingPartId,
      field: 'text',
      delta,
    },
  });
  return events;
}

/**
 * Map one Cursor stream event to OpenCode-shaped events.
 *
 * @param {CursorMapperContext} ctx
 * @param {object} event
 * @returns {{ events: object[], checkpoint?: Uint8Array | null, conversationId?: string }}
 */
export function mapCursorEventToEvents(ctx, event) {
  if (!event || typeof event !== 'object') {
    return { events: [] };
  }

  switch (event.type) {
    case 'text-delta':
      return { events: textDeltaEvents(ctx, event.text) };
    case 'thinking-delta':
      return { events: thinkingDeltaEvents(ctx, event.text) };
    case 'checkpoint':
      return {
        events: [],
        checkpoint: event.bytes instanceof Uint8Array ? event.bytes : null,
      };
    case 'error': {
      const message = typeof event.error === 'string' ? event.error : 'Cursor turn failed';
      return {
        events: [
          {
            type: 'session.status',
            properties: {
              sessionID: ctx.sessionId,
              status: { type: 'idle' },
            },
          },
          {
            type: 'session.error',
            properties: {
              sessionID: ctx.sessionId,
              error: { message },
            },
          },
        ],
      };
    }
    case 'done': {
      const events = [];
      if (ctx.assistantStarted || ctx.accumulatedText) {
        events.push({
          type: 'message.updated',
          properties: { info: assistantInfo(ctx, true) },
        });
        if (ctx.accumulatedText) {
          events.push({
            type: 'message.part.updated',
            properties: {
              sessionID: ctx.sessionId,
              part: {
                id: ctx.textPartId,
                sessionID: ctx.sessionId,
                messageID: ctx.assistantMessageId,
                type: 'text',
                text: ctx.accumulatedText,
                time: { start: ctx.assistantCreatedAt, end: Date.now() },
              },
            },
          });
        }
      }
      events.push({
        type: 'session.status',
        properties: {
          sessionID: ctx.sessionId,
          status: { type: 'idle' },
        },
      });
      return { events };
    }
    case 'tool-call':
      return { events: toolCallEvents(ctx, event) };
    case 'tool-result':
      return { events: toolResultEvents(ctx, event) };
    default:
      return { events: [] };
  }
}

/**
 * @param {CursorMapperContext} ctx
 * @param {object} event
 * @returns {object[]}
 */
function toolCallEvents(ctx, event) {
  const toolCallId = typeof event.toolCallId === 'string' && event.toolCallId
    ? event.toolCallId
    : createOpenCodeId('call');
  let partId = ctx.toolPartIds.get(toolCallId);
  if (!partId) {
    partId = createOpenCodeId('prt');
    ctx.toolPartIds.set(toolCallId, partId);
  }
  const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
  const input = event.input && typeof event.input === 'object' ? event.input : {};
  const events = ensureAssistantStarted(ctx);
  events.push({
    type: 'message.part.updated',
    properties: {
      sessionID: ctx.sessionId,
      part: {
        id: partId,
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMessageId,
        type: 'tool',
        callID: toolCallId,
        tool: toolName,
        state: {
          status: 'running',
          input,
          time: { start: Date.now() },
        },
      },
    },
  });
  return events;
}

/**
 * @param {CursorMapperContext} ctx
 * @param {object} event
 * @returns {object[]}
 */
function toolResultEvents(ctx, event) {
  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : '';
  if (!toolCallId) return [];
  let partId = ctx.toolPartIds.get(toolCallId);
  if (!partId) {
    partId = createOpenCodeId('prt');
    ctx.toolPartIds.set(toolCallId, partId);
  }
  const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool';
  const output = typeof event.output === 'string' ? event.output : '';
  const isError = event.isError === true;
  const events = ensureAssistantStarted(ctx);
  events.push({
    type: 'message.part.updated',
    properties: {
      sessionID: ctx.sessionId,
      part: {
        id: partId,
        sessionID: ctx.sessionId,
        messageID: ctx.assistantMessageId,
        type: 'tool',
        callID: toolCallId,
        tool: toolName,
        state: isError
          ? {
            status: 'error',
            input: {},
            error: output || 'Tool error',
            time: { start: Date.now(), end: Date.now() },
          }
          : {
            status: 'completed',
            input: {},
            output: output || '',
            title: toolName,
            metadata: {},
            time: { start: Date.now(), end: Date.now() },
          },
      },
    },
  });
  return events;
}

/**
 * Build user-message events with providerID cursor.
 *
 * @param {CursorMapperContext} ctx
 * @param {string} text
 * @returns {object[]}
 */
export function buildCursorUserMessageEvents(ctx, text) {
  const events = buildUserMessageEvents(ctx, text);
  for (const event of events) {
    const info = event?.properties?.info;
    if (info?.model && typeof info.model === 'object') {
      info.model.providerID = 'cursor';
      info.model.modelID = ctx.modelRef || info.model.modelID || 'composer-1.5';
    }
  }
  return events;
}
