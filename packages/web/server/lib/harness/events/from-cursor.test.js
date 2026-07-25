import { describe, expect, it } from 'bun:test';
import {
  buildCursorUserMessageEvents,
  createCursorMapperContext,
  mapCursorEventToEvents,
} from './from-cursor.js';

describe('from-cursor event mapping', () => {
  it('emits user message events with providerID cursor', () => {
    const ctx = createCursorMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/proj',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_asst',
      modelRef: 'composer-1.5',
    });
    const events = buildCursorUserMessageEvents(ctx, 'hello');
    expect(events.some((e) => e.type === 'message.updated')).toBe(true);
    expect(events.some((e) => e.type === 'session.status')).toBe(true);
    const user = events.find((e) => e.type === 'message.updated');
    expect(user.properties.info.model.providerID).toBe('cursor');
    expect(user.properties.info.model.modelID).toBe('composer-1.5');
  });

  it('maps text-delta to message.part.delta with cursor assistant provider', () => {
    const ctx = createCursorMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/proj',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_asst',
      modelRef: 'composer-1.5',
    });
    const first = mapCursorEventToEvents(ctx, { type: 'text-delta', text: 'Hi' });
    expect(first.events.some((e) => e.type === 'message.updated')).toBe(true);
    expect(first.events.some((e) => e.type === 'message.part.delta')).toBe(true);
    const assistant = first.events.find((e) => e.type === 'message.updated');
    expect(assistant.properties.info.providerID).toBe('cursor');

    const second = mapCursorEventToEvents(ctx, { type: 'text-delta', text: ' there' });
    expect(second.events).toHaveLength(1);
    expect(second.events[0].properties.delta).toBe(' there');
  });

  it('maps error and done to session.status idle', () => {
    const ctx = createCursorMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/proj',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_asst',
    });
    const err = mapCursorEventToEvents(ctx, { type: 'error', error: 'boom' });
    expect(err.events.some((e) => e.type === 'session.error')).toBe(true);
    expect(err.events.some((e) => e.properties?.status?.type === 'idle')).toBe(true);

    const doneCtx = createCursorMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/proj',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_asst',
    });
    mapCursorEventToEvents(doneCtx, { type: 'text-delta', text: 'ok' });
    const done = mapCursorEventToEvents(doneCtx, { type: 'done' });
    expect(done.events.some((e) => e.properties?.status?.type === 'idle')).toBe(true);
    expect(done.events.some((e) => e.type === 'message.updated')).toBe(true);
  });

  it('ignores unknown event types safely', () => {
    const ctx = createCursorMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });
    expect(mapCursorEventToEvents(ctx, { type: 'nope' }).events).toEqual([]);
    expect(mapCursorEventToEvents(ctx, null).events).toEqual([]);
  });
});
