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

  it('maps tool-call + tool-result to OpenCode-shaped tool parts', () => {
    const ctx = createCursorMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/proj',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_asst',
      modelRef: 'composer-1.5',
    });
    expect(ctx.toolPartIds).toBeInstanceOf(Map);

    const started = mapCursorEventToEvents(ctx, {
      type: 'tool-call',
      toolCallId: 'call_abc',
      toolName: 'bash',
      input: { command: 'echo hi' },
      status: 'running',
    });
    const runningPart = started.events.find((e) => e.type === 'message.part.updated')?.properties?.part;
    expect(runningPart?.type).toBe('tool');
    expect(runningPart?.tool).toBe('bash');
    expect(runningPart?.callID).toBe('call_abc');
    expect(runningPart?.state?.status).toBe('running');
    expect(runningPart?.state?.input).toEqual({ command: 'echo hi' });
    expect(ctx.toolPartIds.get('call_abc')).toBe(runningPart.id);

    const completed = mapCursorEventToEvents(ctx, {
      type: 'tool-result',
      toolCallId: 'call_abc',
      toolName: 'bash',
      output: 'hi\n',
      isError: false,
    });
    const donePart = completed.events.find((e) => e.type === 'message.part.updated')?.properties?.part;
    expect(donePart?.id).toBe(runningPart.id);
    expect(donePart?.state?.status).toBe('completed');
    expect(donePart?.state?.output).toBe('hi\n');

    const errored = mapCursorEventToEvents(ctx, {
      type: 'tool-result',
      toolCallId: 'call_err',
      toolName: 'read',
      output: 'missing',
      isError: true,
    });
    const errPart = errored.events.find((e) => e.type === 'message.part.updated')?.properties?.part;
    expect(errPart?.state?.status).toBe('error');
    expect(errPart?.state?.error).toBe('missing');
  });
});
