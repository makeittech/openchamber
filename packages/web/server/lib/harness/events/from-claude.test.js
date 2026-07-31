import { describe, expect, it, beforeEach } from 'bun:test';
import {
  buildTurnAbortEvents,
  buildUserMessageEvents,
  createClaudeMapperContext,
  createOpenCodeId,
  mapClaudeMessageToEvents,
  resetOpenCodeIdState,
} from './from-claude.js';

describe('from-claude mapper', () => {
  beforeEach(() => {
    resetOpenCodeIdState();
  });

  it('emits user message.updated + text part + busy status', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      modelRef: 'sonnet',
    });
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
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });
    const events = buildUserMessageEvents(ctx, 'see image', [{
      mime: 'image/png',
      url: 'data:image/png;base64,aa==',
      filename: 'a.png',
    }]);
    const filePart = events.find((e) => e.properties?.part?.type === 'file');
    expect(filePart?.properties.part).toMatchObject({
      type: 'file',
      mime: 'image/png',
      filename: 'a.png',
      messageID: 'msg_user',
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
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      textPartId: 'prt_text',
    });

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
      messageID: 'msg_assistant',
      partID: 'prt_text',
      field: 'text',
      delta: 'Hi',
    });
  });

  it('maps tool_use and tool_result to tool parts and preserves tool name', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });

    const toolStart = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      session_id: 'foreign_1',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } }],
      },
    });
    expect(toolStart.events.some((e) => e.type === 'message.part.updated')).toBe(true);
    const toolPart = toolStart.events.find((e) => e.properties?.part?.type === 'tool');
    expect(toolPart.properties.part.tool).toBe('Read');
    expect(toolPart.properties.part.state.status).toBe('running');
    const startedAt = toolPart.properties.part.state.time.start;
    expect(typeof startedAt).toBe('number');

    const toolEnd = mapClaudeMessageToEvents(ctx, {
      type: 'user',
      session_id: 'foreign_1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    });
    const completed = toolEnd.events.find((e) => e.properties?.part?.type === 'tool');
    expect(completed.properties.part.state.status).toBe('completed');
    expect(completed.properties.part.tool).toBe('Read');
    expect(completed.properties.part.state.time.start).toBe(startedAt);
    expect(completed.properties.part.state.time.end).toBeGreaterThanOrEqual(startedAt);
  });

  it('interleaves text → tool → text with ascending part ids (tools not below final reply)', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });

    const intro = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking…' } },
    });
    const introDelta = intro.events.find((e) => e.type === 'message.part.delta');
    const introPartId = introDelta.properties.partID;

    const tool = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
      },
    });
    const toolPart = tool.events.find((e) => e.properties?.part?.type === 'tool');
    const toolPartId = toolPart.properties.part.id;

    mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    });

    const outro = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } },
    });
    const outroDelta = outro.events.find((e) => e.type === 'message.part.delta');
    const outroPartId = outroDelta.properties.partID;

    // Distinct text segments around the tool.
    expect(outroPartId).not.toBe(introPartId);
    // Lexicographic / chronological order matches UI Binary.search part ordering.
    expect(introPartId < toolPartId).toBe(true);
    expect(toolPartId < outroPartId).toBe(true);
  });

  it('does not emit an empty text part on result when only tools ran', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }],
      },
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    });

    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'success',
      is_error: false,
    });

    const textParts = mapped.events.filter((e) => e.properties?.part?.type === 'text');
    expect(textParts).toEqual([]);
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(true);
  });

  it('maps result to idle status and finalizes assistant message', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
      textPartId: 'prt_text',
      accumulatedText: 'done',
      textPartStarted: true,
    });

    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'success',
      session_id: 'foreign_1',
      result: 'done',
      is_error: false,
    });

    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(true);
    expect(mapped.events.some((e) => e.type === 'message.updated' && e.properties.info.finish === 'stop')).toBe(true);
  });

  it('suppresses AskUserQuestion tool_use and tool_result blocks', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

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
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/tmp/project',
      userMessageId: 'msg_user',
      assistantMessageId: 'msg_assistant',
    });
    expect(mapClaudeMessageToEvents(ctx, { type: 'totally_unknown' }).events).toEqual([]);
    expect(mapClaudeMessageToEvents(ctx, null).events).toEqual([]);
  });
});

describe('tool arguments survive completion', () => {
  it('echoes the tool_use input on the completed state', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'call_1',
          name: 'Read',
          input: { file_path: '/proj/a.ts' },
        }],
      },
    });

    const { events } = mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
      },
    });

    const state = events.at(-1).properties.part.state;
    expect(state.status).toBe('completed');
    // The UI reducer replaces state wholesale — dropping input blanks the args.
    expect(state.input).toEqual({ file_path: '/proj/a.ts' });
  });
});

describe('extended thinking', () => {
  it('maps thinking deltas to a reasoning part', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

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
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'hmm' }] },
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
    });

    const { events } = mapClaudeMessageToEvents(ctx, { type: 'result', subtype: 'success' });
    const finals = events
      .filter((e) => e.type === 'message.part.updated')
      .map((e) => [e.properties.part.type, e.properties.part.text]);
    expect(finals).toEqual([['reasoning', 'hmm'], ['text', 'answer']]);
  });

  it('maps Claude result usage into assistant.info.tokens for goal budgets', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
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

describe('divergent full text block', () => {
  it('rewrites the segment instead of dropping the tail', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
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
});

describe('abort finalization', () => {
  it('closes running tool parts and the open text segment', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working' } },
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
      },
    });

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
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    // Subagent tools live in ctx.subagentByToolUseId, not ctx.toolParts —
    // walking only the parent leaves the nested transcript spinning forever.
    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      parent_tool_use_id: 'toolu_sub',
      message: {
        content: [{ type: 'tool_use', id: 'call_child', name: 'Bash', input: { command: 'sleep 999' } }],
      },
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
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });

    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call_1', name: 'Read', input: {} }] },
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] },
    });

    expect(buildTurnAbortEvents(ctx)).toEqual([]);
  });
});

describe('from-claude slash / mcp / subagents', () => {
  beforeEach(() => {
    resetOpenCodeIdState();
  });

  it('extracts system/init capabilities without emitting transcript events', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });
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
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_parent',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });
    const { events } = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'agent_call_1',
          name: 'Agent',
          input: { description: 'Review auth', prompt: 'review auth', subagent_type: 'doc-writer' },
        }],
      },
    });
    const created = events.find((e) => e.type === 'session.created');
    expect(created?.properties.info.parentID).toBe('ses_parent');
    expect(created?.properties.info.title).toBe('Review auth');
    const tool = events.find((e) => e.properties?.part?.type === 'tool');
    expect(tool?.properties.part.tool).toBe('task');
    expect(tool?.properties.part.state.metadata.sessionId).toBe(created?.properties.info.id);
  });

  it('preserves task child-session metadata when the Agent tool completes', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_parent',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });
    const start = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'agent_call_1',
          name: 'Agent',
          input: { description: 'Explore', subagent_type: 'doc-writer' },
        }],
      },
    });
    const childId = start.events.find((e) => e.type === 'session.created')?.properties.info.id;
    const done = mapClaudeMessageToEvents(ctx, {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'agent_call_1',
          content: 'done',
        }],
      },
    });
    const tool = done.events.find((e) => e.properties?.part?.type === 'tool');
    expect(tool?.properties.part.tool).toBe('task');
    expect(tool?.properties.part.state.status).toBe('completed');
    expect(tool?.properties.part.state.metadata.sessionId).toBe(childId);
  });

  it('routes parent_tool_use_id messages into the child session', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_parent',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });
    const start = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'agent_call_1',
          name: 'Agent',
          input: { description: 'Explore' },
        }],
      },
    });
    const childId = start.events.find((e) => e.type === 'session.created')?.properties.info.id;
    const nested = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      parent_tool_use_id: 'agent_call_1',
      message: {
        content: [{ type: 'text', text: 'looking around' }],
      },
    });
    const textPart = nested.events.find((e) => e.properties?.part?.type === 'text');
    expect(textPart?.properties.part.sessionID).toBe(childId);
    const delta = nested.events.find((e) => e.type === 'message.part.delta');
    expect(delta?.properties.sessionID).toBe(childId);
    expect(delta?.properties.delta).toBe('looking around');
  });
});

describe('claude session-limit auto-resume mapper', () => {
  beforeEach(() => {
    resetOpenCodeIdState();
  });

  function freshCtx(overrides = {}) {
    return createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
      ...overrides,
    });
  }

  it('initializes latestRateLimitInfo / parentRateLimitError / sdkRetryActive defaults', () => {
    const ctx = createClaudeMapperContext({
      sessionId: 'ses_1',
      directory: '/proj',
      userMessageId: 'msg_u',
      assistantMessageId: 'msg_a',
    });
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
        // unrelated extras filtered out by sanitization
        extraNoise: 'should-not-survive',
      },
      randomField: 'also-noise',
    });

    // No visible events emitted by the rate-limit event itself.
    expect(mapped.events).toEqual([]);
    // Sanitized metadata keyed by the SDK fields selectRejectedRateLimit consumes.
    expect(ctx.latestRateLimitInfo).toMatchObject({
      status: 'rejected',
      resetsAt: resetsAtMs,
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      overageResetsAt: resetsAtMs + 60_000,
      overageInUse: true,
      isUsingOverage: false,
    });
    // Sanitization: no foreign keys leaked onto ctx.
    expect(ctx.latestRateLimitInfo).not.toHaveProperty('extraNoise');
    // No scheduling, just remembering — flag not touched.
    expect(ctx.sdkRetryActive).toBe(false);
    // Return shape surfaces the structured info for downstream consumers.
    expect(mapped.rateLimitInfo).toMatchObject({ status: 'rejected', rateLimitType: 'five_hour' });
  });

  it('rate_limit_event with missing rate_limit_info stores null on ctx and emits no events', () => {
    const ctx = freshCtx();
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'rate_limit_event',
      uuid: 'rl_2',
    });
    expect(ctx.latestRateLimitInfo).toBeNull();
    expect(mapped.events).toEqual([]);
    expect(mapped.rateLimitInfo).toBeNull();
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
    // Exactly one event: the canonical retry status.
    expect(mapped.events).toHaveLength(1);
    const status = mapped.events[0];
    expect(status.type).toBe('session.status');
    expect(status.properties.sessionID).toBe('ses_1');
    expect(status.properties.status).toMatchObject({
      type: 'retry',
      attempt: 2,
      message: 'api-retry',
    });
    // `next` is an absolute epoch-ms = Date.now() + retry_delay_ms.
    expect(status.properties.status.next).toBeGreaterThanOrEqual(before + 5_000);
    expect(status.properties.status.next).toBeLessThanOrEqual(after + 5_000);
    // No idle emitted; no durable retry scheduled from this transient event.
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(false);
    expect(mapped.terminal).toBeUndefined();
  });

  it('system api_retry without attempt/delay coalesces to finite canonical defaults', () => {
    const ctx = freshCtx();
    const mapped = mapClaudeMessageToEvents(ctx, { type: 'system', subtype: 'api_retry' });
    expect(ctx.sdkRetryActive).toBe(true);
    expect(mapped.events).toHaveLength(1);
    expect(mapped.events[0].properties.status.type).toBe('retry');
    expect(Number.isFinite(mapped.events[0].properties.status.attempt)).toBe(true);
    expect(Number.isFinite(mapped.events[0].properties.status.next)).toBe(true);
  });

  it('stream text delta after api_retry transitions retry -> busy BEFORE content events', () => {
    const ctx = freshCtx();
    mapClaudeMessageToEvents(ctx, { type: 'system', subtype: 'api_retry', attempt: 1, retry_delay_ms: 100 });
    expect(ctx.sdkRetryActive).toBe(true);

    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'yes' } },
    });

    // Clearing + busy transition before any content arrival.
    expect(ctx.sdkRetryActive).toBe(false);
    const statusIdx = mapped.events.findIndex((e) => e.type === 'session.status' && e.properties.status.type === 'busy');
    const deltaIdx = mapped.events.findIndex((e) => e.type === 'message.part.delta');
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(deltaIdx).toBeGreaterThan(statusIdx);
  });

  it('assistant content after api_retry transitions retry -> busy BEFORE content events', () => {
    const ctx = freshCtx();
    mapClaudeMessageToEvents(ctx, { type: 'system', subtype: 'api_retry', attempt: 1, retry_delay_ms: 100 });
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    expect(ctx.sdkRetryActive).toBe(false);
    const statusIdx = mapped.events.findIndex((e) => e.type === 'session.status' && e.properties.status.type === 'busy');
    const contentIdx = mapped.events.findIndex(
      (e) => e.properties?.part?.type === 'text' || e.type === 'message.part.delta',
    );
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(contentIdx).toBeGreaterThan(statusIdx);
  });

  it('subsequent activity after busy transition does NOT re-emit busy', () => {
    const ctx = freshCtx();
    mapClaudeMessageToEvents(ctx, { type: 'system', subtype: 'api_retry', attempt: 1, retry_delay_ms: 100 });
    mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } },
    });
    expect(ctx.sdkRetryActive).toBe(false);

    const second = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'second' } },
    });
    expect(second.events.some((e) => e.type === 'session.status')).toBe(false);
  });

  it('subagent content after api_retry does NOT emit a parent busy transition', () => {
    const ctx = freshCtx();
    mapClaudeMessageToEvents(ctx, { type: 'system', subtype: 'api_retry', attempt: 1, retry_delay_ms: 100 });
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      parent_tool_use_id: 'agent_call_1',
      message: { content: [{ type: 'text', text: 'subagent activity' }] },
    });
    // The parent's session.status transitions are unaffected by nested activity.
    expect(mapped.events.some((e) => e.type === 'session.status')).toBe(false);
  });

  it('parent assistant rate_limit error records parentRateLimitError and skips idle', () => {
    const ctx = freshCtx();
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      uuid: 'asst_1',
      message: { content: [{ type: 'text', text: "You've hit your session limit..." }] },
      error: 'rate_limit',
    });
    expect(ctx.parentRateLimitError).toEqual({ uuid: 'asst_1' });
    // No idle emits when correlating a parent rate-limit error.
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(false);
    // Retains the existing error message.updated emission with the APIError.
    const err = mapped.events.find((e) => e.type === 'message.updated' && e.properties.info.error);
    expect(err).toBeDefined();
    expect(err.properties.info.error.name).toBe('APIError');
    expect(err.properties.info.error.data.message).toBe('rate_limit');
    expect(err.properties.info.error.data.isRetryable).toBe(true);
  });

  it('parent non-rate_limit assistant error retains idle emission (regression)', () => {
    const ctx = freshCtx();
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      uuid: 'asst_2',
      message: { content: [] },
      error: 'overloaded',
    });
    expect(ctx.parentRateLimitError).toBeNull();
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(true);
    const err = mapped.events.find((e) => e.type === 'message.updated' && e.properties.info.error);
    expect(err).toBeDefined();
    expect(err.properties.info.error.data.message).toBe('overloaded');
    expect(err.properties.info.error.data.isRetryable).toBe(true);
  });

  it('subagent (nested) rate_limit error does NOT set the parent rate-limit correlation', () => {
    const ctx = freshCtx();
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      parent_tool_use_id: 'agent_call_1',
      uuid: 'asst_sub',
      message: { content: [{ type: 'text', text: 'subagent rate-limited branch' }] },
      error: 'rate_limit',
    });
    expect(ctx.parentRateLimitError).toBeNull();
    // Subagent errors never emit parent idle.
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(false);
    // Still emits the subagent error message.updated (existing behavior).
    const err = mapped.events.find((e) => e.type === 'message.updated' && e.properties.info.error);
    expect(err).toBeDefined();
    expect(err.properties.info.error.name).toBe('APIError');
    expect(err.properties.info.error.data.message).toBe('rate_limit');
  });

  it('returns terminal rate-limit when parent error + rejected window are correlated', () => {
    const ctx = freshCtx();
    const resetsAtMs = Date.now() + 60_000;

    // parent rate-limit error seen first
    mapClaudeMessageToEvents(ctx, {
      type: 'assistant',
      uuid: 'asst_1',
      message: { content: [{ type: 'text', text: "You've hit your session limit..." }] },
      error: 'rate_limit',
    });
    // structured rate-limit event seen
    mapClaudeMessageToEvents(ctx, {
      type: 'rate_limit_event',
      uuid: 'rl_1',
      rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' },
    });
    // terminal result
    const terminal = mapClaudeMessageToEvents(ctx, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
    });

    expect(terminal.terminal).toMatchObject({
      type: 'rate-limit',
      rateLimitType: 'five_hour',
      assistantUuid: 'asst_1',
    });
    // resetAt equals the validated absolute epoch-ms from selectRejectedRateLimit.
    expect(terminal.terminal.resetAt).toBe(resetsAtMs);
    // No idle / session.error emitted when correlating a hard rejected window.
    expect(terminal.events.some((e) => e.type === 'session.status')).toBe(false);
    expect(terminal.events.some((e) => e.type === 'session.error')).toBe(false);
    // Closure events for open segments/tools and final message.updated still
    // land so the transcript surfaces the rate-limit error text.
    expect(terminal.events.some((e) => e.type === 'message.part.updated')).toBe(true);
    expect(terminal.events.some(
      (e) => e.type === 'message.updated' && e.properties.info.finish === 'stop',
    )).toBe(true);
    // rateLimitInfo mirrored on the terminal return.
    expect(terminal.rateLimitInfo).toMatchObject({ status: 'rejected', rateLimitType: 'five_hour' });
  });

  it('terminal rate-limit detects an overage rejected window via selectRejectedRateLimit', () => {
    const ctx = freshCtx();
    const overageResetsMs = Date.now() + 90_000;
    mapClaudeMessageToEvents(ctx, {
      type: 'assistant', uuid: 'asst_o1',
      message: { content: [{ type: 'text', text: 'overage' }] },
      error: 'rate_limit',
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'rate_limit_event', uuid: 'rl_o1',
      rate_limit_info: { overageStatus: 'rejected', overageResetsAt: overageResetsMs },
    });
    const terminal = mapClaudeMessageToEvents(ctx, {
      type: 'result', subtype: 'error_during_execution', is_error: true,
    });
    expect(terminal.terminal).toMatchObject({
      type: 'rate-limit',
      rateLimitType: 'overage',
      assistantUuid: 'asst_o1',
    });
    expect(terminal.terminal.resetAt).toBe(overageResetsMs);
    expect(terminal.events.some((e) => e.type === 'session.status')).toBe(false);
  });

  it('does NOT produce terminal when no parent rate-limit error is set (regression)', () => {
    const ctx = freshCtx();
    const resetsAtMs = Date.now() + 60_000;
    mapClaudeMessageToEvents(ctx, {
      type: 'rate_limit_event', uuid: 'rl_1',
      rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' },
    });
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'result', subtype: 'error_during_execution', is_error: true,
    });
    expect(mapped.terminal).toBeUndefined();
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(true);
    expect(mapped.events.some((e) => e.type === 'session.error')).toBe(true);
  });

  it('does NOT produce terminal when the window is not a hard rejected window (regression)', () => {
    const ctx = freshCtx();
    mapClaudeMessageToEvents(ctx, {
      type: 'assistant', uuid: 'asst_3',
      message: { content: [{ type: 'text', text: 'warned' }] },
      error: 'rate_limit',
    });
    // allowed_warning is not a hard wait.
    mapClaudeMessageToEvents(ctx, {
      type: 'rate_limit_event', uuid: 'rl_ok',
      rate_limit_info: { status: 'allowed_warning', resetsAt: Date.now() + 60_000, rateLimitType: 'five_hour' },
    });
    const mapped = mapClaudeMessageToEvents(ctx, {
      type: 'result', subtype: 'error_during_execution', is_error: true,
    });
    expect(mapped.terminal).toBeUndefined();
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(true);
    expect(mapped.events.some((e) => e.type === 'session.error')).toBe(true);
  });

  it('terminal rate-limit correlation wins regardless of is_error (parent error already on record)', () => {
    const ctx = freshCtx();
    const resetsAtMs = Date.now() + 60_000;
    mapClaudeMessageToEvents(ctx, {
      type: 'assistant', uuid: 'asst_1',
      message: { content: [{ type: 'text', text: 'RL' }] },
      error: 'rate_limit',
    });
    mapClaudeMessageToEvents(ctx, {
      type: 'rate_limit_event', uuid: 'rl_1',
      rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' },
    });
    // Even a nominally-success result still correlates: no idle, terminal set.
    const mapped = mapClaudeMessageToEvents(ctx, { type: 'result', subtype: 'success' });
    expect(mapped.terminal).toMatchObject({ type: 'rate-limit', rateLimitType: 'five_hour', assistantUuid: 'asst_1' });
    expect(mapped.events.some((e) => e.type === 'session.status')).toBe(false);
  });

  it('clears sdkRetryActive on a terminal result without emitting busy', () => {
    const ctx = freshCtx();
    mapClaudeMessageToEvents(ctx, { type: 'system', subtype: 'api_retry', attempt: 1, retry_delay_ms: 100 });
    const mapped = mapClaudeMessageToEvents(ctx, { type: 'result', subtype: 'success' });
    expect(ctx.sdkRetryActive).toBe(false);
    expect(mapped.events.some((e) => e.type === 'session.status' && e.properties.status.type === 'busy')).toBe(false);
  });

  it('rateLimitInfo is exposed on every return shape (null until set)', () => {
    const ctx = freshCtx();
    const before = mapClaudeMessageToEvents(ctx, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
    });
    expect(before.rateLimitInfo).toBeNull();
    const resetsAtMs = Date.now() + 60_000;
    mapClaudeMessageToEvents(ctx, {
      type: 'rate_limit_event', uuid: 'rl_x',
      rate_limit_info: { status: 'rejected', resetsAt: resetsAtMs, rateLimitType: 'five_hour' },
    });
    const after = mapClaudeMessageToEvents(ctx, { type: 'result', subtype: 'success' });
    expect(after.rateLimitInfo).toMatchObject({ status: 'rejected', rateLimitType: 'five_hour' });
  });
});
