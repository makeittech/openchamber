import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createClaudeCodeTranslator } from './index.js';
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

  const settle = () => {
    if (!waiter) return;
    const current = waiter;
    waiter = undefined;
    if (queue.length > 0) {
      current.resolve({ done: false, value: queue.shift() });
      return;
    }
    if (failure) {
      current.reject(failure);
      return;
    }
    if (done) {
      current.resolve({ done: true, value: undefined });
    } else {
      waiter = current;
    }
  };

  return {
    stream: {
      [Symbol.asyncIterator]() {
        return this;
      },
      next() {
        if (queue.length > 0) {
          return Promise.resolve({ done: false, value: queue.shift() });
        }
        if (failure) {
          return Promise.reject(failure);
        }
        if (done) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) => {
          waiter = { resolve, reject };
        });
      },
      return() {
        done = true;
        settle();
        return Promise.resolve({ done: true, value: undefined });
      },
    },
    push(value) {
      queue.push(value);
      settle();
    },
    end() {
      done = true;
      settle();
    },
    fail(error) {
      failure = error;
      settle();
    },
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

function createHandle(controller, options = {}) {
  return {
    stream: controller.stream,
    interrupt: mock(options.interrupt || (async () => {})),
    close: mock(options.close || (() => controller.end())),
  };
}

function basePrompt(sessionId = 'ses_test') {
  return {
    sessionId,
    directory: '/project',
    text: 'hello',
    target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    messageId: `msg_user_${sessionId}`,
    assistantMessageId: `msg_assistant_${sessionId}`,
  };
}

function eventTypes(events) {
  return events.map((event) => event.type);
}

function idleEvents(events, sessionId) {
  return events.filter((event) => (
    event.type === 'session.status'
    && event.properties?.sessionID === sessionId
    && event.properties?.status?.type === 'idle'
  ));
}

async function waitFor(condition) {
  const deadline = Date.now() + 250;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
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
  it('rejects a second prompt while a turn is active', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { startQuery, translator } = createHarness(handle);

    await translator.prompt(basePrompt('ses_active'));

    await expect(translator.prompt(basePrompt('ses_active'))).rejects.toMatchObject({
      code: 'TURN_IN_PROGRESS',
      statusCode: 409,
    });
    expect(startQuery).toHaveBeenCalledTimes(1);

    controller.end();
    await waitFor(() => !translator._activeTurns.has('ses_active'));
  });

  it('abort cancels the signal handed to the OpenChamber MCP bridge', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    let mcpSignal = null;
    const { translator } = createHarness(handle, {
      createOpenChamberMcpServers: async ({ signal }) => {
        mcpSignal = signal;
        return null;
      },
    });

    await translator.prompt(basePrompt('ses_mcp_abort'));
    expect(mcpSignal).toBeInstanceOf(AbortSignal);
    expect(mcpSignal.aborted).toBe(false);

    await translator.abort({ sessionId: 'ses_mcp_abort' });

    // A bridged control action with `wait: true` polls until this fires.
    expect(mcpSignal.aborted).toBe(true);
  });

  it('ends the MCP bridge signal when the turn completes normally', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    let mcpSignal = null;
    const { translator } = createHarness(handle, {
      createOpenChamberMcpServers: async ({ signal }) => {
        mcpSignal = signal;
        return null;
      },
    });

    await translator.prompt(basePrompt('ses_mcp_done'));
    controller.end();
    await waitFor(() => !translator._activeTurns.has('ses_mcp_done'));

    expect(mcpSignal.aborted).toBe(true);
  });

  it('abort during an active turn emits idle and MessageAbortedError', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { events, translator } = createHarness(handle);

    await translator.prompt(basePrompt('ses_abort'));
    await expect(translator.abort({ sessionId: 'ses_abort' })).resolves.toMatchObject({
      ok: true,
      aborted: true,
    });

    expect(handle.interrupt).toHaveBeenCalledTimes(1);
    expect(handle.close).toHaveBeenCalled();
    expect(translator._activeTurns.has('ses_abort')).toBe(false);
    expect(idleEvents(events, 'ses_abort')).toHaveLength(1);
    expect(events.some((event) => (
      event.type === 'message.updated'
      && event.properties?.info?.error?.name === 'MessageAbortedError'
    ))).toBe(true);
  });

  it('does not emit session.error when an aborting stream fails', async () => {
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
    expect(events.some((event) => (
      event.type === 'message.updated'
      && event.properties?.info?.error?.name === 'MessageAbortedError'
    ))).toBe(true);
  });

  it('emits idle from finally when the stream ends without a result', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { events, translator } = createHarness(handle);

    await translator.prompt(basePrompt('ses_no_result'));
    controller.end();
    await waitFor(() => !translator._activeTurns.has('ses_no_result'));

    expect(idleEvents(events, 'ses_no_result')).toHaveLength(1);
    expect(eventTypes(events)).not.toContain('session.error');
  });

  it('forwards the sticky target effort to the SDK query', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { startQuery, translator } = createHarness(handle);

    await translator.prompt({
      ...basePrompt('ses_effort'),
      target: { harnessId: 'claude-code', modelRef: 'sonnet', effort: 'xhigh' },
    });

    expect(startQuery.mock.calls[0][0].effort).toBe('xhigh');
    expect(getSessionBinding('ses_effort')?.target?.effort).toBe('xhigh');

    controller.end();
    await waitFor(() => !translator._activeTurns.has('ses_effort'));
  });

  it('sends the expanded OpenCode command as both prompt and user message', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const resolveOpenCodeCommand = mock(async () => ({
      name: 'pr-review',
      text: 'Review this pull request: 2480',
    }));
    const { events, startQuery, translator } = createHarness(handle, { resolveOpenCodeCommand });

    await translator.prompt({
      ...basePrompt('ses_command'),
      text: '',
      command: { name: 'pr-review', arguments: '2480' },
    });

    expect(resolveOpenCodeCommand).toHaveBeenCalledWith({
      name: 'pr-review',
      args: '2480',
      directory: '/project',
    });
    expect(startQuery.mock.calls[0][0].prompt).toBe('Review this pull request: 2480');
    const userText = events.find((event) => (
      event.type === 'message.part.updated'
      && event.properties?.part?.messageID === 'msg_user_ses_command'
    ));
    expect(userText?.properties?.part?.text).toBe('Review this pull request: 2480');

    controller.end();
    await waitFor(() => !translator._activeTurns.has('ses_command'));
  });

  it('keeps queued text after the expanded command', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { startQuery, translator } = createHarness(handle, {
      resolveOpenCodeCommand: async () => ({ name: 'pr-review', text: 'Review PR 2480' }),
    });

    await translator.prompt({
      ...basePrompt('ses_command_extra'),
      text: 'also check the tests',
      command: { name: 'pr-review', arguments: '2480' },
    });

    expect(startQuery.mock.calls[0][0].prompt).toBe('Review PR 2480\n\nalso check the tests');

    controller.end();
    await waitFor(() => !translator._activeTurns.has('ses_command_extra'));
  });

  it('fails the turn cleanly when command translation is unavailable', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { events, startQuery, translator } = createHarness(handle);

    await expect(translator.prompt({
      ...basePrompt('ses_command_unavailable'),
      text: '',
      command: { name: 'pr-review' },
    })).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE', statusCode: 503 });

    // Nothing optimistic was broadcast and no turn was registered, so the client
    // can roll its optimistic message back.
    expect(startQuery).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect(translator._activeTurns.has('ses_command_unavailable')).toBe(false);
  });

  it('propagates a command lookup failure without starting a turn', async () => {
    const controller = createControlledStream();
    const handle = createHandle(controller);
    const { events, startQuery, translator } = createHarness(handle, {
      resolveOpenCodeCommand: async () => {
        const error = new Error('Command /nope was not found in OpenCode');
        error.code = 'COMMAND_NOT_FOUND';
        error.statusCode = 404;
        throw error;
      },
    });

    await expect(translator.prompt({
      ...basePrompt('ses_command_missing'),
      text: '',
      command: { name: 'nope' },
    })).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND', statusCode: 404 });

    expect(startQuery).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });
});
