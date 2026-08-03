import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createClaudeCodeTranslator } from './index.js';
import { buildOpenCodeAgentInheritance } from './opencode-agents.js';
import {
  getPendingPermissionCount,
  listPendingPermissions,
  rejectPendingForSession,
  replyPermission,
} from './permissions.js';
import {
  configureSessionBindings,
  getSessionBinding,
  resetSessionBindings,
} from '../../session-bindings.js';
import { resetHarnessTurnSnapshots } from '../../turn-snapshot.js';

function createControlledStream() {
  const queue = [];
  let done = false;
  let failure;
  let waiter;

  function settle() {
    if (!waiter) return;
    const current = waiter;
    waiter = undefined;
    if (queue.length) current.resolve({ done: false, value: queue.shift() });
    else if (failure) current.reject(failure);
    else if (done) current.resolve({ done: true, value: undefined });
    else waiter = current;
  }

  return {
    stream: {
      [Symbol.asyncIterator]() { return this; },
      next() {
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
        if (failure) return Promise.reject(failure);
        if (done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
      },
      return() {
        done = true;
        settle();
        return Promise.resolve({ done: true, value: undefined });
      },
    },
    push(value) { queue.push(value); settle(); },
    end() { done = true; settle(); },
    fail(error) { failure = error; settle(); },
  };
}

function createHandle(controller, options = {}) {
  return {
    stream: controller.stream,
    interrupt: mock(options.interrupt || (async () => {})),
    close: mock(options.close || (() => controller.end())),
  };
}

function retryRuntime(overrides = {}) {
  return {
    schedule: () => {},
    hasPending: () => false,
    cancel: async () => null,
    start: async () => {},
    stop: async () => {},
    deleteSession: async () => null,
    ...overrides,
  };
}

function createHarness(handle, extraDeps = {}) {
  const events = [];
  const startQuery = mock(async () => handle);
  const translator = createClaudeCodeTranslator({
    detect: mock(async () => ({ status: 'ready' })),
    startQuery,
    getBroadcast: () => (payload) => events.push(payload),
    ...extraDeps,
  });
  return { events, startQuery, translator };
}

function basePrompt(sessionId, overrides = {}) {
  return {
    sessionId,
    directory: '/project',
    text: 'hello',
    target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    messageId: `msg_user_${sessionId}`,
    assistantMessageId: `msg_assistant_${sessionId}`,
    ...overrides,
  };
}

const eventTypes = (events) => events.map(({ type }) => type);
const idleEvents = (events, sessionId) => events.filter((event) => (
  event.type === 'session.status'
  && event.properties?.sessionID === sessionId
  && event.properties?.status?.type === 'idle'
));
const hasAbortMessage = (events) => events.some((event) => (
  event.type === 'message.updated'
  && event.properties?.info?.error?.name === 'MessageAbortedError'
));

async function waitFor(condition) {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

async function finish(controller, translator, sessionId) {
  controller.end();
  await waitFor(() => !translator._activeTurns.has(sessionId));
}

function emitRateLimit(controller, suffix) {
  controller.push({
    type: 'assistant',
    uuid: `asst_${suffix}`,
    error: 'rate_limit',
    message: { content: [{ type: 'text', text: 'limited' }] },
  });
  controller.push({
    type: 'rate_limit_event',
    uuid: `rl_${suffix}`,
    rate_limit_info: {
      status: 'rejected',
      resetsAt: Date.now() + 60_000,
      rateLimitType: 'five_hour',
    },
  });
  controller.push({ type: 'result', subtype: 'error_during_execution', is_error: true });
}

function agentResolver(agents = [
  {
    name: 'build',
    mode: 'primary',
    native: true,
    prompt: 'Prefer ddgs for web search.',
    permission: [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: 'read', pattern: '*.env', action: 'ask' },
    ],
  },
  {
    name: 'pr-review',
    mode: 'subagent',
    description: 'Reviews pull requests',
    prompt: 'You are a meticulous PR reviewer.',
  },
]) {
  return async ({ agentName }) => buildOpenCodeAgentInheritance(agents, agentName);
}

beforeEach(() => {
  configureSessionBindings({ persist: false, load: true });
  resetSessionBindings();
  resetHarnessTurnSnapshots();
});

afterEach(() => {
  resetSessionBindings();
  resetHarnessTurnSnapshots();
});

describe('createClaudeCodeTranslator', () => {
  it('persists a confirmed rate limit without idle or error', async () => {
    const controller = createControlledStream();
    const schedule = mock(() => {});
    const { events, translator } = createHarness(createHandle(controller), {
      retryRuntime: retryRuntime({ schedule }),
    });
    await translator.prompt(basePrompt('ses_limit'));
    emitRateLimit(controller, 'limit');
    await finish(controller, translator, 'ses_limit');

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(idleEvents(events, 'ses_limit')).toHaveLength(0);
    expect(eventTypes(events)).not.toContain('session.error');
  });

  it('turns retry persistence failure into a hard error and idle', async () => {
    const controller = createControlledStream();
    const schedule = () => {
      throw Object.assign(new Error('disk failed'), { code: 'RETRY_STORE_UNAVAILABLE' });
    };
    const { events, translator } = createHarness(createHandle(controller), {
      retryRuntime: retryRuntime({ schedule }),
    });
    await translator.prompt(basePrompt('ses_limit_disk'));
    emitRateLimit(controller, 'limit_disk');
    await finish(controller, translator, 'ses_limit_disk');

    expect(eventTypes(events)).toContain('session.error');
    expect(idleEvents(events, 'ses_limit_disk')).toHaveLength(1);
    expect(getSessionBinding('ses_limit_disk')?.lastError?.code).toBe('RETRY_STORE_UNAVAILABLE');
  });

  it('schedules durable recovery when the SDK throws its exit error after the rate-limit result', async () => {
    const controller = createControlledStream();
    const schedule = mock(() => {});
    const { events, translator } = createHarness(createHandle(controller), {
      retryRuntime: retryRuntime({ schedule }),
    });
    await translator.prompt(basePrompt('ses_limit_throw'));
    emitRateLimit(controller, 'limit_throw');
    controller.fail(new Error(
      "Claude Code returned an error result: You've hit your session limit · resets 11am (Europe/Kyiv)",
    ));
    await finish(controller, translator, 'ses_limit_throw');

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'ses_limit_throw',
      attempt: 1,
    }));
    expect(idleEvents(events, 'ses_limit_throw')).toHaveLength(0);
    expect(eventTypes(events)).not.toContain('session.error');
    expect(getSessionBinding('ses_limit_throw')?.lastError).toBeUndefined();
  });

  it('turns retry persistence failure after a thrown SDK exit error into a hard error and idle', async () => {
    const controller = createControlledStream();
    const schedule = () => {
      throw Object.assign(new Error('disk failed'), { code: 'RETRY_STORE_UNAVAILABLE' });
    };
    const { events, translator } = createHarness(createHandle(controller), {
      retryRuntime: retryRuntime({ schedule }),
    });
    await translator.prompt(basePrompt('ses_limit_throw_disk'));
    emitRateLimit(controller, 'limit_throw_disk');
    controller.fail(new Error('Claude Code returned an error result: limit'));
    await finish(controller, translator, 'ses_limit_throw_disk');

    expect(eventTypes(events)).toContain('session.error');
    expect(idleEvents(events, 'ses_limit_throw_disk')).toHaveLength(1);
    expect(getSessionBinding('ses_limit_throw_disk')?.lastError?.code).toBe('RETRY_STORE_UNAVAILABLE');
  });

  it('rejects public prompts while a retry or turn is active', async () => {
    const pendingController = createControlledStream();
    const pending = createHarness(createHandle(pendingController), {
      retryRuntime: retryRuntime({ hasPending: (id) => id === 'ses_pending' }),
    });
    await expect(pending.translator.prompt(basePrompt('ses_pending'))).rejects.toMatchObject({
      code: 'TURN_IN_PROGRESS', statusCode: 409,
    });
    expect(pending.startQuery).not.toHaveBeenCalled();

    const activeController = createControlledStream();
    const active = createHarness(createHandle(activeController));
    await active.translator.prompt(basePrompt('ses_active'));
    await expect(active.translator.prompt(basePrompt('ses_active'))).rejects.toMatchObject({
      code: 'TURN_IN_PROGRESS', statusCode: 409,
    });
    expect(active.startQuery).toHaveBeenCalledTimes(1);
    await finish(activeController, active.translator, 'ses_active');
  });

  for (const [name, complete] of [['abort', false], ['normal completion', true]]) {
    it(`cancels the MCP bridge signal on ${name}`, async () => {
      const sessionId = complete ? 'ses_mcp_done' : 'ses_mcp_abort';
      const controller = createControlledStream();
      let mcpSignal;
      const { translator } = createHarness(createHandle(controller), {
        createOpenChamberMcpServers: async ({ signal }) => {
          mcpSignal = signal;
          return null;
        },
      });
      await translator.prompt(basePrompt(sessionId));
      expect(mcpSignal).toBeInstanceOf(AbortSignal);
      expect(mcpSignal.aborted).toBe(false);

      if (complete) await finish(controller, translator, sessionId);
      else await translator.abort({ sessionId });
      expect(mcpSignal.aborted).toBe(true);
    });
  }

  it('aborts an active turn with idle and MessageAbortedError', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { events, translator } = createHarness(handle);
    await translator.prompt(basePrompt('ses_abort'));

    await expect(translator.abort({ sessionId: 'ses_abort' })).resolves.toMatchObject({
      ok: true, aborted: true,
    });
    expect(handle.interrupt).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalled();
    expect(translator._activeTurns.has('ses_abort')).toBe(false);
    expect(idleEvents(events, 'ses_abort')).toHaveLength(1);
    expect(hasAbortMessage(events)).toBe(true);
  });

  it('suppresses stream errors caused by abort', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller, {
      close: () => controller.fail(new Error('stream closed during abort')),
    });
    const { events, translator } = createHarness(handle);
    await translator.prompt(basePrompt('ses_abort_error'));
    await translator.abort({ sessionId: 'ses_abort_error' });
    await waitFor(() => handle.close.mock.calls.length >= 2);

    expect(eventTypes(events)).not.toContain('session.error');
    expect(getSessionBinding('ses_abort_error')?.lastError).toBeUndefined();
    expect(hasAbortMessage(events)).toBe(true);
  });

  it('emits idle when a stream ends without a result', async () => {
    const controller = createControlledStream();
    const { events, translator } = createHarness(createHandle(controller));
    await translator.prompt(basePrompt('ses_no_result'));
    await finish(controller, translator, 'ses_no_result');

    expect(idleEvents(events, 'ses_no_result')).toHaveLength(1);
    expect(eventTypes(events)).not.toContain('session.error');
  });

  it('forwards and persists target effort', async () => {
    const controller = createControlledStream();
    const { startQuery, translator } = createHarness(createHandle(controller));
    await translator.prompt(basePrompt('ses_effort', {
      target: { harnessId: 'claude-code', modelRef: 'sonnet', effort: 'xhigh' },
    }));

    expect(startQuery.mock.calls[0][0].effort).toBe('xhigh');
    expect(getSessionBinding('ses_effort')?.target?.effort).toBe('xhigh');
    await finish(controller, translator, 'ses_effort');
  });

  it('inherits the OpenCode agent prompt, rules, and custom subagents', async () => {
    const controller = createControlledStream();
    const { startQuery, translator } = createHarness(createHandle(controller), {
      resolveOpenCodeAgents: agentResolver(),
    });
    await translator.prompt(basePrompt('ses_oc_agents', { agentsMode: 'opencode', agent: 'build' }));
    const options = startQuery.mock.calls[0][0];

    expect(options.systemPrompt).toEqual({
      type: 'preset', preset: 'claude_code', append: 'Prefer ddgs for web search.',
    });
    expect(Object.keys(options.agents)).toEqual(['pr-review']);
    expect(options.agents['pr-review']).toMatchObject({
      description: 'Reviews pull requests',
      prompt: 'You are a meticulous PR reviewer.',
    });
    await expect(options.canUseTool('Bash', { command: 'git status' }, {}))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'git status' } });

    const envAsk = options.canUseTool('Read', { file_path: '/project/.env' }, {});
    expect(getPendingPermissionCount()).toBe(1);
    replyPermission({
      sessionId: 'ses_oc_agents',
      requestId: listPendingPermissions()[0].id,
      reply: 'reject',
    });
    await expect(envAsk).resolves.toMatchObject({ behavior: 'deny' });
    await finish(controller, translator, 'ses_oc_agents');
  });

  it('applies the spawned subagent ruleset to nested calls and stamps asks on the child session id', async () => {
    const controller = createControlledStream();
    const { events, startQuery, translator } = createHarness(createHandle(controller), {
      resolveOpenCodeAgents: agentResolver(),
    });
    await translator.prompt(basePrompt('ses_sub_policy', { agentsMode: 'opencode', agent: 'build' }));
    const options = startQuery.mock.calls[0][0];

    // The parent `build` agent allows Read; the `pr-review` subagent has no
    // permission rules and must ask. SubagentStart binds the nested calls.
    expect(options.hooks?.SubagentStart).toBeDefined();
    await options.hooks.SubagentStart[0].hooks[0]({ agent_id: 'agent_1', agent_type: 'pr-review' });

    const nested = options.canUseTool('Read', { file_path: '/project/src/a.ts' }, { agentID: 'agent_1' });
    expect(getPendingPermissionCount()).toBe(1);
    const asked = events.find((event) => event.type === 'permission.asked').properties;
    expect(asked.sessionID).toMatch(/^ses_claude_sub_/);
    expect(asked.sessionID).not.toBe('ses_sub_policy');
    expect(asked.metadata.fromSubagent).toBe(true);
    expect(asked.metadata.parentSessionID).toBe('ses_sub_policy');

    replyPermission({ sessionId: asked.sessionID, requestId: asked.id, reply: 'reject' });
    await expect(nested).resolves.toMatchObject({ behavior: 'deny' });

    // Parent-level calls still resolve against the parent policy.
    await expect(options.canUseTool('Read', { file_path: '/project/src/b.ts' }, {}))
      .resolves.toEqual({ behavior: 'allow', updatedInput: { file_path: '/project/src/b.ts' } });
    await finish(controller, translator, 'ses_sub_policy');
  });

  it('derives OpenCode permissionMode from server rules, not the client', async () => {
    const controller = createControlledStream();
    const { startQuery, translator } = createHarness(createHandle(controller), {
      resolveOpenCodeAgents: agentResolver([{
        name: 'careful',
        mode: 'primary',
        permission: [{ permission: 'edit', pattern: '*', action: 'ask' }],
      }]),
    });
    await translator.prompt(basePrompt('ses_oc_mode', {
      target: { harnessId: 'claude-code', modelRef: 'sonnet', permissionMode: 'acceptEdits' },
      agentsMode: 'opencode',
      agent: 'careful',
    }));

    expect(startQuery.mock.calls[0][0].permissionMode).toBe('default');
    await finish(controller, translator, 'ses_oc_mode');
  });

  it('fails closed to permission prompts when OpenCode agent lookup fails', async () => {
    const controller = createControlledStream();
    const { startQuery, translator } = createHarness(createHandle(controller), {
      resolveOpenCodeAgents: async () => { throw new Error('offline'); },
    });
    await translator.prompt(basePrompt('ses_oc_fail', { agentsMode: 'opencode', agent: 'build' }));
    const options = startQuery.mock.calls[0][0];

    expect(options.systemPrompt).toBeUndefined();
    expect(options.agents).toBeUndefined();
    void options.canUseTool('Bash', { command: 'rm -rf /' }, {});
    expect(getPendingPermissionCount()).toBe(1);
    rejectPendingForSession('ses_oc_fail');
    await finish(controller, translator, 'ses_oc_fail');
  });

  it('forwards only a validated native agent in Claude mode', async () => {
    const controller = createControlledStream();
    const resolveOpenCodeAgents = mock(agentResolver());
    const { startQuery, translator } = createHarness(createHandle(controller), {
      resolveOpenCodeAgents,
      listClaudeAgents: async () => ({ agents: [{ name: 'Explore' }] }),
    });
    await translator.prompt(basePrompt('ses_claude_agents', {
      target: { harnessId: 'claude-code', modelRef: 'sonnet', permissionMode: 'acceptEdits' },
      agentsMode: 'claude',
      agent: 'build',
      claudeAgent: 'explore',
    }));
    const options = startQuery.mock.calls[0][0];

    expect(resolveOpenCodeAgents).not.toHaveBeenCalled();
    expect(options.systemPrompt).toBeUndefined();
    expect(options.agents).toBeUndefined();
    expect(options.permissionMode).toBeUndefined();
    expect(options.agent).toBe('Explore');
    await finish(controller, translator, 'ses_claude_agents');
  });

  it('drops an unknown native agent instead of failing the turn', async () => {
    const controller = createControlledStream();
    const { startQuery, translator } = createHarness(createHandle(controller), {
      listClaudeAgents: async () => ({ agents: [{ name: 'Explore' }] }),
    });
    await translator.prompt(basePrompt('ses_claude_unknown', {
      agentsMode: 'claude', claudeAgent: 'deleted-agent',
    }));

    expect(startQuery.mock.calls[0][0].agent).toBeUndefined();
    await finish(controller, translator, 'ses_claude_unknown');
  });

  for (const [name, text, expected] of [
    ['command only', '', 'Review PR 2480'],
    ['command with queued text', 'also check tests', 'Review PR 2480\n\nalso check tests'],
  ]) {
    it(`sends expanded ${name} as the prompt`, async () => {
      const controller = createControlledStream();
      const resolveOpenCodeCommand = mock(async () => ({ name: 'pr-review', text: 'Review PR 2480' }));
      const { events, startQuery, translator } = createHarness(createHandle(controller), {
        resolveOpenCodeCommand,
      });
      const sessionId = text ? 'ses_command_extra' : 'ses_command';
      await translator.prompt(basePrompt(sessionId, {
        text,
        command: { name: 'pr-review', arguments: '2480' },
      }));

      expect(resolveOpenCodeCommand).toHaveBeenCalledWith({
        name: 'pr-review', args: '2480', directory: '/project',
      });
      expect(startQuery.mock.calls[0][0].prompt).toBe(expected);
      const userText = events.find((event) => (
        event.type === 'message.part.updated'
        && event.properties?.part?.messageID === `msg_user_${sessionId}`
      ));
      expect(userText?.properties?.part?.text).toBe(expected);
      await finish(controller, translator, sessionId);
    });
  }

  for (const [name, resolver, expectedError] of [
    ['translation is unavailable', undefined, { code: 'COMMAND_UNAVAILABLE', statusCode: 503 }],
    ['lookup fails', async () => {
      throw Object.assign(new Error('not found'), { code: 'COMMAND_NOT_FOUND', statusCode: 404 });
    }, { code: 'COMMAND_NOT_FOUND', statusCode: 404 }],
  ]) {
    it(`does not start a turn when command ${name}`, async () => {
      const controller = createControlledStream();
      const { events, startQuery, translator } = createHarness(createHandle(controller), {
        ...(resolver ? { resolveOpenCodeCommand: resolver } : {}),
      });
      await expect(translator.prompt(basePrompt(`ses_command_${expectedError.statusCode}`, {
        text: '', command: { name: 'nope' },
      }))).rejects.toMatchObject(expectedError);

      expect(startQuery).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
      expect(translator._activeTurns.size).toBe(0);
    });
  }
});
