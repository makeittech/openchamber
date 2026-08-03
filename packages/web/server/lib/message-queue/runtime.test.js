import { describe, expect, it, vi } from 'vitest';
import { createMessageQueueRuntime, MESSAGE_QUEUE_CHANGED_EVENT } from './runtime.js';

const DIRECTORY = '/data/projects/tv';
const SESSION = 'ses_test_1';

const makeDeps = (overrides = {}) => {
  const published = [];
  const emitted = [];
  const hubSubscribers = new Set();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  }));
  const deps = {
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer test' }),
    globalEventHub: {
      subscribeEvent(fn) {
        hubSubscribers.add(fn);
        return () => hubSubscribers.delete(fn);
      },
      publishEvent: (type, data) => published.push({ type, data }),
    },
    emitQueueChanged: (event) => emitted.push(event),
    fetchImpl: fetchMock,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return {
    deps,
    published,
    emitted,
    fetchMock,
    fireHubEvent: (normalized) => {
      for (const fn of [...hubSubscribers]) fn(normalized);
    },
  };
};

const hubEvent = (type, props, directory = DIRECTORY) => ({
  envelope: {},
  payload: { type, properties: props },
  directory,
});

describe('message-queue runtime', () => {
  it('enqueues, lists and returns positions', async () => {
    const { deps, fetchMock } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);

    const first = await runtime.enqueue({
      directory: DIRECTORY,
      sessionId: SESSION,
      item: { content: 'hello', source: 'ui', sendConfig: { providerID: 'p', modelID: 'm' } },
    });
    expect(first.ok).toBe(true);
    expect(first.position).toBe(1);
    expect(first.item.id).toBeTruthy();

    // First enqueue drains immediately when the session is idle, so the queue
    // is empty again and the prompt was dispatched.
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('prompt_async'))).toHaveLength(1);
    });
    expect(runtime.getQueue(DIRECTORY, SESSION)).toEqual([]);
  });

  it('does not drain while the session is busy; drains on session.idle', async () => {
    const { deps, fireHubEvent, fetchMock } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);

    fireHubEvent(hubEvent('session.status', { sessionID: SESSION, status: { type: 'busy' } }));

    const enqueued = await runtime.enqueue({
      directory: DIRECTORY,
      sessionId: SESSION,
      item: { content: 'hold', source: 'ui' },
    });
    expect(enqueued.ok).toBe(true);
    // Only the status prime fetch may happen — no prompt dispatch while busy.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('prompt_async'))).toHaveLength(0);
    expect(runtime.getQueue(DIRECTORY, SESSION)).toHaveLength(1);

    fireHubEvent(hubEvent('session.idle', { sessionID: SESSION }));
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('prompt_async'))).toHaveLength(1);
    });
    expect(runtime.getQueue(DIRECTORY, SESSION)).toHaveLength(0);
  });

  it('emits queue-changed on enqueue, remove, clear and reorder', async () => {
    const { deps, emitted, fireHubEvent } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);
    fireHubEvent(hubEvent('session.status', { sessionID: SESSION, status: { type: 'busy' } }));

    const a = await runtime.enqueue({ directory: DIRECTORY, sessionId: SESSION, item: { id: 'a', content: 'A', source: 'ui' } });
    const b = await runtime.enqueue({ directory: DIRECTORY, sessionId: SESSION, item: { id: 'b', content: 'B', source: 'ui' } });
    expect(a.ok && b.ok).toBe(true);

    runtime.reorder({ directory: DIRECTORY, sessionId: SESSION, fromId: 'b', toId: 'a' });
    expect(runtime.getQueue(DIRECTORY, SESSION).map((i) => i.id)).toEqual(['b', 'a']);

    runtime.remove({ directory: DIRECTORY, sessionId: SESSION, id: 'b' });
    expect(runtime.getQueue(DIRECTORY, SESSION).map((i) => i.id)).toEqual(['a']);

    const cleared = runtime.clear({ directory: DIRECTORY, sessionId: SESSION });
    expect(cleared).toBe(1);
    expect(runtime.getQueue(DIRECTORY, SESSION)).toEqual([]);

    const types = emitted.map((e) => e.type);
    expect(types.every((t) => t === MESSAGE_QUEUE_CHANGED_EVENT)).toBe(true);
    expect(emitted.at(-1).items).toEqual([]);
  });

  it('is idempotent for duplicate client ids', async () => {
    const { deps, fireHubEvent } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);
    fireHubEvent(hubEvent('session.status', { sessionID: SESSION, status: { type: 'busy' } }));

    const first = await runtime.enqueue({ directory: DIRECTORY, sessionId: SESSION, item: { id: 'same', content: 'X', source: 'ui' } });
    const second = await runtime.enqueue({ directory: DIRECTORY, sessionId: SESSION, item: { id: 'same', content: 'X', source: 'ui' } });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(runtime.getQueue(DIRECTORY, SESSION)).toHaveLength(1);
    expect(second.position).toBe(1);
  });

  it('caps queue length per session', async () => {
    const { deps, fireHubEvent } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);
    fireHubEvent(hubEvent('session.status', { sessionID: SESSION, status: { type: 'busy' } }));

    for (let i = 0; i < 21; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runtime.enqueue({ directory: DIRECTORY, sessionId: SESSION, item: { content: `m${i}`, source: 'ui' } });
    }
    const queue = runtime.getQueue(DIRECTORY, SESSION);
    expect(queue).toHaveLength(20);
    expect(queue[0].content).toBe('m1');
  });

  it('keeps the item and backs off when prompt dispatch fails', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('prompt_async')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    });
    const { deps } = makeDeps({ fetchImpl: fetchMock });
    const runtime = createMessageQueueRuntime(deps);

    const result = await runtime.enqueue({
      directory: DIRECTORY,
      sessionId: SESSION,
      item: { content: 'will fail', source: 'ui' },
    });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('prompt_async')).length).toBeGreaterThan(0);
    });
    expect(runtime.getQueue(DIRECTORY, SESSION)).toHaveLength(1);
  });

  it('routes messenger-source items through the registered messenger sender', async () => {
    const { deps, fireHubEvent, fetchMock } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);
    const sender = vi.fn(async () => ({ ok: true }));
    runtime.registerMessengerSender(sender);

    fireHubEvent(hubEvent('session.status', { sessionID: SESSION, status: { type: 'busy' } }));
    await runtime.enqueue({
      directory: DIRECTORY,
      sessionId: SESSION,
      item: { content: 'from discord', source: 'discord', from: { firstName: 'S' } },
    });

    fireHubEvent(hubEvent('session.idle', { sessionID: SESSION }));
    await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(1));
    expect(sender.mock.calls[0][0].item.content).toBe('from discord');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('prompt_async'))).toHaveLength(0);
    expect(runtime.getQueue(DIRECTORY, SESSION)).toHaveLength(0);
  });

  it('falls back to REST when no messenger sender is registered', async () => {
    const { deps, fireHubEvent, fetchMock } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);

    fireHubEvent(hubEvent('session.status', { sessionID: SESSION, status: { type: 'busy' } }));
    await runtime.enqueue({
      directory: DIRECTORY,
      sessionId: SESSION,
      item: { content: 'from discord', source: 'discord' },
    });
    fireHubEvent(hubEvent('session.idle', { sessionID: SESSION }));
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('prompt_async'))).toHaveLength(1);
    });
  });

  it('drops the queue when the session is deleted', async () => {
    const { deps, emitted, fireHubEvent } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);
    fireHubEvent(hubEvent('session.status', { sessionID: SESSION, status: { type: 'busy' } }));
    await runtime.enqueue({ directory: DIRECTORY, sessionId: SESSION, item: { content: 'x', source: 'ui' } });
    expect(runtime.getQueue(DIRECTORY, SESSION)).toHaveLength(1);

    fireHubEvent(hubEvent('session.deleted', { sessionID: SESSION }));
    expect(runtime.getQueue(DIRECTORY, SESSION)).toEqual([]);
    expect(emitted.at(-1).items).toEqual([]);
  });

  it('lists queues for a directory', async () => {
    const { deps, fireHubEvent } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);
    for (const sessionId of ['ses_a', 'ses_b']) {
      fireHubEvent(hubEvent('session.status', { sessionID: sessionId, status: { type: 'busy' } }));
      // eslint-disable-next-line no-await-in-loop
      await runtime.enqueue({ directory: DIRECTORY, sessionId, item: { content: 'x', source: 'ui' } });
    }
    fireHubEvent(hubEvent('session.status', { sessionID: 'ses_other', status: { type: 'busy' } }));
    await runtime.enqueue({ directory: '/other/dir', sessionId: 'ses_other', item: { content: 'y', source: 'ui' } });

    const listed = runtime.list(DIRECTORY);
    expect(Object.keys(listed).sort()).toEqual(['ses_a', 'ses_b']);
    expect(listed.ses_a).toHaveLength(1);
  });

  it('removeAt clears by 1-based position', async () => {
    const { deps, fireHubEvent } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);
    fireHubEvent(hubEvent('session.status', { sessionID: SESSION, status: { type: 'busy' } }));
    await runtime.enqueue({ directory: DIRECTORY, sessionId: SESSION, item: { id: 'a', content: 'A', source: 'ui' } });
    await runtime.enqueue({ directory: DIRECTORY, sessionId: SESSION, item: { id: 'b', content: 'B', source: 'ui' } });

    expect(runtime.removeAt({ directory: DIRECTORY, sessionId: SESSION, position: 1 })).toBe(true);
    expect(runtime.getQueue(DIRECTORY, SESSION).map((i) => i.id)).toEqual(['b']);
    expect(runtime.removeAt({ directory: DIRECTORY, sessionId: SESSION, position: 5 })).toBe(false);
  });

  it('passes model/agent/variant from sendConfig to prompt_async', async () => {
    const { deps, fetchMock } = makeDeps();
    const runtime = createMessageQueueRuntime(deps);

    await runtime.enqueue({
      directory: DIRECTORY,
      sessionId: SESSION,
      item: {
        content: 'cfg',
        source: 'ui',
        sendConfig: { providerID: 'prov', modelID: 'mod', agent: 'build', variant: 'high' },
      },
    });
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('prompt_async'))).toHaveLength(1);
    });
    const [, init] = fetchMock.mock.calls.find(([url]) => String(url).includes('prompt_async'));
    const body = JSON.parse(init.body);
    expect(body.model).toEqual({ providerID: 'prov', modelID: 'mod', variant: 'high' });
    expect(body.agent).toBe('build');
    expect(body.parts[0]).toEqual({ type: 'text', text: 'cfg' });
  });
});
