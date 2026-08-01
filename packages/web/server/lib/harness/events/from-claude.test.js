import { describe, expect, it, beforeEach } from 'bun:test';
import {
  buildTurnAbortEvents,
  buildUserMessageEvents,
  createClaudeMapperContext,
  createOpenCodeId,
  mapClaudeMessageToEvents,
  resetOpenCodeIdState,
} from './from-claude.js';

function freshCtx(overrides = {}) {
  return createClaudeMapperContext({
    sessionId: 'ses_1',
    directory: '/proj',
    userMessageId: 'msg_u',
    assistantMessageId: 'msg_a',
    ...overrides,
  });
}

function streamText(ctx, text, parentToolUseId) {
  return mapClaudeMessageToEvents(ctx, {
    type: 'stream_event',
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
}

function useTool(ctx, { id = 'call_1', name = 'Read', input = {}, parentToolUseId } = {}) {
  return mapClaudeMessageToEvents(ctx, {
    type: 'assistant',
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
}

function finishTool(ctx, { id = 'call_1', content = 'ok', isError = false } = {}) {
  return mapClaudeMessageToEvents(ctx, {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  });
}

function hasStatus(events, type) {
  return events.some((event) => event.type === 'session.status' && event.properties.status.type === type);
}

function findPart(events, type) {
  return events.find((event) => event.properties?.part?.type === type)?.properties.part;
}

function startRetry(ctx, overrides = {}) {
  return mapClaudeMessageToEvents(ctx, {
    type: 'system', subtype: 'api_retry', attempt: 1, retry_delay_ms: 100, ...overrides,
  });
}

function assistantError(ctx, error, {
  uuid = 'asst_1', parentToolUseId, content = [{ type: 'text', text: 'error text' }],
} = {}) {
  return mapClaudeMessageToEvents(ctx, {
    type: 'assistant',
    uuid,
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    message: { content },
    error,
  });
}

function rateLimit(ctx, rateLimitInfo) {
  return mapClaudeMessageToEvents(ctx, { type: 'rate_limit_event', rate_limit_info: rateLimitInfo });
}

function finishResult(ctx, overrides = {}) {
  return mapClaudeMessageToEvents(ctx, {
    type: 'result', subtype: 'error_during_execution', is_error: true, ...overrides,
  });
}

describe('from-claude mapper', () => {
  beforeEach(() => {
    resetOpenCodeIdState();
  });

  it('emits user message.updated + text part + busy status', () => {
    const ctx = freshCtx({ modelRef: 'sonnet' });
    const events = buildUserMessageEvents(ctx, 'hello');
    expect(events.map((e) => e.type)).toEqual([
      'message.updated',
      'message.part.updated',
      'session.status',
    ]);
    expect(events[0].properties.info.role).toBe('user');
    expect(events[1].properties.part.text).toBe('hello');
    expect(events[2].properties.status.type).toBe('busy');
  });

  it('emits file parts for user attachments', () => {
    const ctx = freshCtx();
    const events = buildUserMessageEvents(ctx, 'see image', [{
      mime: 'image/png',
      url: 'data:image/png;base64,aa==',
      filename: 'a.png',
    }]);
    expect(findPart(events, 'file')).toMatchObject({
      type: 'file',
      mime: 'image/png',
      filename: 'a.png',
      messageID: 'msg_u',
    });
  });

  it('createOpenCodeId is ascending / lexicographically sortable', () => {
    const a = createOpenCodeId('prt');
    const b = createOpenCodeId('prt');
    const c = createOpenCodeId('prt');
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
    expect(a.startsWith('prt_')).toBe(true);
  });

  it('maps stream text deltas to message.part.delta', () => {
    const ctx = freshCtx({ textPartId: 'prt_text' });

    const first = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      session_id: 'foreign_1',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Hi' },
      },
    });

    expect(first.foreignSessionId).toBe('foreign_1');
    expect(first.events.some((e) => e.type === 'message.part.delta')).toBe(true);
    const delta = first.events.find((e) => e.type === 'message.part.delta');
    expect(delta.properties).toMatchObject({
      messageID: 'msg_a',
      partID: 'prt_text',
      field: 'text',
      delta: 'Hi',
    });
  });

  it('maps tool_use and tool_result to tool parts and preserves tool name', () => {
    const ctx = freshCtx();
    const toolStart = useTool(ctx, { input: { path: 'a.ts' } });
    expect(toolStart.events.some((e) => e.type === 'message.part.updated')).toBe(true);
    const toolPart = findPart(toolStart.events, 'tool');
    expect(toolPart.tool).toBe('Read');
    expect(toolPart.state.status).toBe('running');
    const startedAt = toolPart.state.time.start;
    expect(typeof startedAt).toBe('number');

    const toolEnd = finishTool(ctx);
    const completed = findPart(toolEnd.events, 'tool');
    expect(completed.state.status).toBe('completed');
    expect(completed.tool).toBe('Read');
    expect(completed.state.time.start).toBe(startedAt);
    expect(completed.state.time.end).toBeGreaterThanOrEqual(startedAt);
  });

  it('interleaves text → tool → text with ascending part ids (tools not below final reply)', () => {
    const ctx = freshCtx();

    const intro = streamText(ctx, 'Checking…');
    const introDelta = intro.events.find((e) => e.type === 'message.part.delta');
    const introPartId = introDelta.properties.partID;

    const tool = useTool(ctx, { name: 'Bash', input: { command: 'ls' } });
    const toolPartId = findPart(tool.events, 'tool').id;

    finishTool(ctx);
    const outro = streamText(ctx, 'Done.');
    const outroDelta = outro.events.find((e) => e.type === 'message.part.delta');
    const outroPartId = outroDelta.properties.partID;

    expect(outroPartId).not.toBe(introPartId);
    expect(introPartId < toolPartId).toBe(true);
    expect(toolPartId < outroPartId).toBe(true);
  });

  it('does not emit an empty text part on result when only tools ran', () => {
    const ctx = freshCtx();

    useTool(ctx);
    finishTool(ctx);

    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'success',
      is_error: false,
    });

    const textParts = mapped.events.filter((e) => e.properties?.part?.type === 'text');
    expect(textParts).toEqual([]);
    expect(hasStatus(mapped.events, 'idle')).toBe(true);
  });

  it('maps result to idle status and finalizes assistant message', () => {
    const ctx = freshCtx({ textPartId: 'prt_text', accumulatedText: 'done', textPartStarted: true });

    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'success',
      session_id: 'foreign_1',
      result: 'done',
      is_error: false,
    });

    expect(hasStatus(mapped.events, 'idle')).toBe(true);
    expect(mapped.events.some((e) => e.type === 'message.updated' && e.properties.info.finish === 'stop')).toBe(true);
  });

  it('suppresses AskUserQuestion tool_use and tool_result blocks', () => {
    const ctx = freshCtx();

    const start = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'call_ask',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Pick one',
              header: 'Choice',
              options: [{ label: 'A', description: 'Option A' }],
              multiSelect: false,
            }],
          },
        }],
      },
    });
    expect(start.events).toEqual([]);
    expect(ctx.askUserQuestionCallIds.has('call_ask')).toBe(true);
    expect(ctx.toolParts.has('call_ask')).toBe(false);

    const result = mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_ask',
          content: { answers: { 'Pick one': 'A' } },
        }],
      },
    });
    expect(result.events).toEqual([]);
  });

  it('ignores unknown message types without throwing', () => {
    const ctx = freshCtx();
    expect(mapClaudeMessageToEvents(ctx, { type: 'totally_unknown' }).events).toEqual([]);
    expect(mapClaudeMessageToEvents(ctx, null).events).toEqual([]);
  });
});

it('echoes tool_use input on the completed state', () => {
  const ctx = freshCtx();
  useTool(ctx, { input: { file_path: '/proj/a.ts' } });
  const { events } = finishTool(ctx);

  const state = events.at(-1).properties.part.state;
  expect(state.status).toBe('completed');
  expect(state.input).toEqual({ file_path: '/proj/a.ts' });
});

describe('extended thinking', () => {
  it('maps thinking deltas to a reasoning part', () => {
    const ctx = freshCtx();

    const { events } = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'weighing options' },
      },
    });

    const opened = events.find((e) => e.type === 'message.part.updated');
    expect(opened.properties.part.type).toBe('reasoning');
    expect(events.at(-1)).toMatchObject({
      type: 'message.part.delta',
      properties: { delta: 'weighing options' },
    });
  });

  it('finalizes reasoning before text on result', () => {
    const ctx = freshCtx();

    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    streamText(ctx, 'answer');

    const { events } = mapClaudeMessageToEvents(ctx, { type: 'result', subtype: 'success' });
    const finals = events
      .filter((e) => e.type === 'message.part.updated')
      .map((e) => [e.properties.part.type, e.properties.part.text]);
    expect(finals).toEqual([['reasoning', 'hmm'], ['text', 'answer']]);
  });

  it('maps Claude result usage into assistant.info.tokens for goal budgets', () => {
    const ctx = freshCtx({
      textPartId: 'prt_text',
      accumulatedText: 'done',
      textPartStarted: true,
    });

    const { events } = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'success',
      result: 'done',
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 5,
      },
    });

    const completed = events.find((e) => (
      e.type === 'message.updated' && e.properties?.info?.role === 'assistant' && e.properties.info.finish === 'stop'
    ));
    expect(completed.properties.info.tokens).toEqual({
      input: 120,
      output: 40,
      reasoning: 0,
      cache: { read: 15, write: 5 },
    });
    expect(completed.properties.info.cost).toBe(0.0123);
  });
});

it('rewrites a divergent full text block instead of dropping the tail', () => {
  const ctx = freshCtx({
    textPartId: 'prt_text',
    accumulatedText: 'strea',
    textPartStarted: true,
  });

  const { events } = mapClaudeMessageToEvents(ctx, {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'completely different answer' }] },
  });

  expect(events.at(-1).properties.part).toMatchObject({
    id: 'prt_text',
    type: 'text',
    text: 'completely different answer',
  });
});

describe('abort finalization', () => {
  it('closes running tool parts and the open text segment', () => {
    const ctx = freshCtx();
    streamText(ctx, 'working');
    useTool(ctx, { name: 'Bash', input: { command: 'ls' } });

    const events = buildTurnAbortEvents(ctx);
    const parts = events.map((e) => e.properties.part);

    expect(parts.find((p) => p.type === 'text')?.text).toBe('working');
    const tool = parts.find((p) => p.type === 'tool');
    expect(tool.state).toMatchObject({
      status: 'error',
      error: 'Aborted by user',
      input: { command: 'ls' },
    });
  });

  it('closes a subagent tool part left running by the abort', () => {
    const ctx = freshCtx();
    useTool(ctx, {
      id: 'call_child',
      name: 'Bash',
      input: { command: 'sleep 999' },
      parentToolUseId: 'toolu_sub',
    });

    const events = buildTurnAbortEvents(ctx);
    const childTool = events
      .map((e) => e.properties.part)
      .find((p) => p?.type === 'tool' && p.callID === 'call_child');

    expect(childTool).toBeDefined();
    expect(childTool.sessionID).not.toBe('ses_1');
    expect(childTool.state).toMatchObject({
      status: 'error',
      error: 'Aborted by user',
      input: { command: 'sleep 999' },
    });
  });

  it('leaves already-settled tools alone', () => {
    const ctx = freshCtx();
    useTool(ctx);
    finishTool(ctx, { content: 'done' });

    expect(buildTurnAbortEvents(ctx)).toEqual([]);
  });
});

describe('from-claude slash / mcp / subagents', () => {
  it('extracts system/init capabilities without emitting transcript events', () => {
    const ctx = freshCtx();
    const { events, capabilities, foreignSessionId } = mapClaudeMessageToEvents(ctx, {
      type: 'system',
      subtype: 'init',
      session_id: 'foreign_1',
      slash_commands: ['compact', 'usage'],
      skills: ['pdf'],
      agents: ['explorer'],
      tools: ['Read', 'Agent'],
      mcp_servers: [{ name: 'fs', status: 'connected' }],
    });
    expect(events).toEqual([]);
    expect(foreignSessionId).toBe('foreign_1');
    expect(capabilities).toMatchObject({
      slash_commands: ['compact', 'usage'],
      skills: ['pdf'],
      agents: ['explorer'],
      mcp_servers: [{ name: 'fs', status: 'connected' }],
    });
  });

  it('creates a child session when Claude Agent tool starts', () => {
    const ctx = freshCtx({ sessionId: 'ses_parent' });
    const { events } = useTool(ctx, {
      id: 'agent_call_1', name: 'Agent', input: { description: 'Review auth', prompt: 'review auth' },
    });
    const created = events.find((e) => e.type === 'session.created');
    expect(created?.properties.info.parentID).toBe('ses_parent');
    expect(created?.properties.info.title).toBe('Review auth');
    expect(findPart(events, 'tool')?.state.metadata.sessionId).toBe(created?.properties.info.id);
  });

  it('routes parent_tool_use_id messages into the child session', () => {
    const ctx = freshCtx({ sessionId: 'ses_parent' });
    const start = useTool(ctx, {
      id: 'agent_call_1', name: 'Agent', input: { description: 'Explore' },
    });
    const childId = start.events.find((e) => e.type === 'session.created')?.properties.info.id;
    const nested = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      parent_tool_use_id: 'agent_call_1',
      message: {
        content: [{ type: 'text', text: 'looking around' }],
      },
    });
    expect(findPart(nested.events, 'text')?.sessionID).toBe(childId);
    const delta = nested.events.find((e) => e.type === 'message.part.delta');
    expect(delta?.properties.sessionID).toBe(childId);
    expect(delta?.properties.delta).toBe('looking around');
  });
});

describe('claude session-limit auto-resume mapper', () => {
  it('initializes latestRateLimitInfo / parentRateLimitError / sdkRetryActive defaults', () => {
    const ctx = freshCtx();
    expect(ctx.latestRateLimitInfo).toBeNull();
    expect(ctx.parentRateLimitError).toBeNull();
    expect(ctx.sdkRetryActive).toBe(false);
  });

  it('rate_limit_event stores sanitized structured rate-limit metadata on ctx and emits no events', () => {
    const ctx = freshCtx();
    const resetsAtMs = Date.now() + 60_000;
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'rate_limit_event',
      uuid: 'rl_1',
      session_id: 'foreign_rl',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: resetsAtMs,
        rateLimitType: 'five_hour',
        overageStatus: 'allowed',
        overageResetsAt: resetsAtMs + 60_000,
        overageInUse: true,
        isUsingOverage: false,
        extraNoise: 'should-not-survive',
      },
      randomField: 'also-noise',
    });

    expect(mapped.events).toEqual([]);
    expect(ctx.latestRateLimitInfo).toMatchObject({
      status: 'rejected',
      resetsAt: resetsAtMs,
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      overageResetsAt: resetsAtMs + 60_000,
      overageInUse: true,
      isUsingOverage: false,
    });
    expect(ctx.latestRateLimitInfo).not.toHaveProperty('extraNoise');
    expect(ctx.sdkRetryActive).toBe(false);
    expect(mapped.rateLimitInfo).toMatchObject({ status: 'rejected', rateLimitType: 'five_hour' });

    const emptyCtx = freshCtx();
    const empty = rateLimit(emptyCtx);
    expect(emptyCtx.latestRateLimitInfo).toBeNull();
    expect(empty).toMatchObject({ events: [], rateLimitInfo: null });
  });

  it('system api_retry emits canonical retry status and sets sdkRetryActive (no idle)', () => {
    const ctx = freshCtx();
    const before = Date.now();
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      retry_delay_ms: 5_000,
    });
    const after = Date.now();

    expect(ctx.sdkRetryActive).toBe(true);
    expect(mapped.events).toHaveLength(1);
    const status = mapped.events[0];
    expect(status.type).toBe('session.status');
    expect(status.properties.sessionID).toBe('ses_1');
    expect(status.properties.status).toMatchObject({
      type: 'retry',
      attempt: 2,
      message: 'api-retry',
    });
    expect(status.properties.status.next).toBeGreaterThanOrEqual(before + 5_000);
    expect(status.properties.status.next).toBeLessThanOrEqual(after + 5_000);
    expect(hasStatus(mapped.events, 'idle')).toBe(false);
    expect(mapped.terminal).toBeUndefined();

    const defaultCtx = freshCtx();
    const defaults = mapClaudeMessageToEvents(defaultCtx, { type: 'system', subtype: 'api_retry' });
    expect(defaultCtx.sdkRetryActive).toBe(true);
    expect(defaults.events[0].properties.status.type).toBe('retry');
    expect(Number.isFinite(defaults.events[0].properties.status.attempt)).toBe(true);
    expect(Number.isFinite(defaults.events[0].properties.status.next)).toBe(true);
  });

  it('transitions retry to busy before the first parent content only', () => {
    for (const emitContent of [
      (ctx) => streamText(ctx, 'yes'),
      (ctx) => mapClaudeMessageToEvents(ctx, {
        type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] },
      }),
    ]) {
      const ctx = freshCtx();
      startRetry(ctx);
      const mapped = emitContent(ctx);
      const busyIndex = mapped.events.findIndex((event) => hasStatus([event], 'busy'));
      const contentIndex = mapped.events.findIndex((event) => (
        event.properties?.part?.type === 'text' || event.type === 'message.part.delta'
      ));
      expect(ctx.sdkRetryActive).toBe(false);
      expect(contentIndex).toBeGreaterThan(busyIndex);
      expect(streamText(ctx, 'second').events.some((event) => event.type === 'session.status')).toBe(false);
    }

    const nestedCtx = freshCtx();
    startRetry(nestedCtx);
    const nested = mapClaudeMessageToEvents(nestedCtx, {
      type: 'assistant',
      parent_tool_use_id: 'agent_call_1',
      message: { content: [{ type: 'text', text: 'subagent activity' }] },
    });
    expect(nested.events.some((event) => event.type === 'session.status')).toBe(false);
    expect(nestedCtx.sdkRetryActive).toBe(true);
  });

  it('maps parent and subagent assistant errors without crossing status ownership', () => {
    const ctx = freshCtx();
    const mapped = assistantError(ctx, 'rate_limit');
    expect(ctx.parentRateLimitError).toEqual({ uuid: 'asst_1' });
    expect(hasStatus(mapped.events, 'idle')).toBe(false);
    const err = mapped.events.find((e) => e.type === 'message.updated' && e.properties.info.error);
    expect(err.properties.info.error.name).toBe('APIError');
    expect(err.properties.info.error.data).toEqual({ message: 'rate_limit', isRetryable: true });

    const overloadedCtx = freshCtx();
    const overloaded = assistantError(overloadedCtx, 'overloaded', { content: [] });
    expect(overloadedCtx.parentRateLimitError).toBeNull();
    expect(hasStatus(overloaded.events, 'idle')).toBe(true);
    expect(overloaded.events.find((e) => e.properties?.info?.error).properties.info.error.data)
      .toEqual({ message: 'overloaded', isRetryable: true });

    const nestedCtx = freshCtx();
    const nested = assistantError(nestedCtx, 'rate_limit', {
      uuid: 'asst_sub', parentToolUseId: 'agent_call_1',
    });
    expect(nestedCtx.parentRateLimitError).toBeNull();
    expect(hasStatus(nested.events, 'idle')).toBe(false);
    expect(nested.events.find((e) => e.properties?.info?.error).properties.info.error.name).toBe('APIError');
  });

  it('returns terminal rate-limit when parent error + rejected window are correlated', () => {
    const ctx = freshCtx();
    const resetsAtMs = Date.now() + 60_000;
    assistantError(ctx, 'rate_limit');
    rateLimit(ctx, { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' });
    const terminal = finishResult(ctx);

    expect(terminal.terminal).toMatchObject({
      type: 'rate-limit',
      rateLimitType: 'five_hour',
      assistantUuid: 'asst_1',
    });
    expect(terminal.terminal.resetAt).toBe(resetsAtMs);
    expect(terminal.events.some((e) => e.type === 'session.status')).toBe(false);
    expect(terminal.events.some((e) => e.type === 'session.error')).toBe(false);
    expect(terminal.events.some((e) => e.type === 'message.part.updated')).toBe(true);
    expect(terminal.events.some(
      (e) => e.type === 'message.updated' && e.properties.info.finish === 'stop',
    )).toBe(true);
    expect(terminal.rateLimitInfo).toMatchObject({ status: 'rejected', rateLimitType: 'five_hour' });
  });

  it('terminal rate-limit detects an overage rejected window via selectRejectedRateLimit', () => {
    const ctx = freshCtx();
    const overageResetsMs = Date.now() + 90_000;
    assistantError(ctx, 'rate_limit', { uuid: 'asst_o1' });
    rateLimit(ctx, { overageStatus: 'rejected', overageResetsAt: overageResetsMs });
    const terminal = finishResult(ctx);
    expect(terminal.terminal).toMatchObject({
      type: 'rate-limit',
      rateLimitType: 'overage',
      assistantUuid: 'asst_o1',
    });
    expect(terminal.terminal.resetAt).toBe(overageResetsMs);
    expect(terminal.events.some((e) => e.type === 'session.status')).toBe(false);
  });

  it('does not produce a terminal without both a parent error and rejected window', () => {
    for (const includeParentError of [false, true]) {
      const ctx = freshCtx();
      if (includeParentError) assistantError(ctx, 'rate_limit', { uuid: 'asst_3' });
      rateLimit(ctx, {
        status: includeParentError ? 'allowed_warning' : 'rejected',
        resetsAt: Date.now() + 60_000,
        rateLimitType: 'five_hour',
      });
      const mapped = finishResult(ctx);
      expect(mapped.terminal).toBeUndefined();
      expect(hasStatus(mapped.events, 'idle')).toBe(true);
      expect(mapped.events.some((event) => event.type === 'session.error')).toBe(true);
    }
  });

  it('terminal rate-limit correlation wins regardless of is_error (parent error already on record)', () => {
    const ctx = freshCtx();
    const resetsAtMs = Date.now() + 60_000;
    assistantError(ctx, 'rate_limit');
    rateLimit(ctx, { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' });
    const mapped = finishResult(ctx, { subtype: 'success', is_error: false });
    expect(mapped.terminal).toMatchObject({ type: 'rate-limit', rateLimitType: 'five_hour', assistantUuid: 'asst_1' });
    expect(mapped.events.some((e) => e.type === 'session.status')).toBe(false);
  });

  it('clears sdkRetryActive on a terminal result without emitting busy', () => {
    const ctx = freshCtx();
    startRetry(ctx);
    const mapped = mapClaudeMessageToEvents(ctx, { type: 'result', subtype: 'success' });
    expect(ctx.sdkRetryActive).toBe(false);
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'busy')).toBe(false);
  });

  it('rateLimitInfo is exposed on every return shape (null until set)', () => {
    const ctx = freshCtx();
    const before = streamText(ctx, 'hi');
    expect(before.rateLimitInfo).toBeNull();
    const resetsAtMs = Date.now() + 60_000;
    rateLimit(ctx, { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' });
    const after = mapClaudeMessageToEvents(ctx, { type: 'result', subtype: 'success' });
    expect(after.rateLimitInfo).toMatchObject({ status: 'rejected', rateLimitType: 'five_hour' });
  });
});
