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
      // MVP: surface as ignored — no OpenCode tool part yet.
      return { events: [] };
    default:
      return { events: [] };
  }
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
