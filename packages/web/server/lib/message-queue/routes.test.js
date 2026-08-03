import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

import { registerMessageQueueRoutes } from './routes.js';
import { createMessageQueueRuntime } from './runtime.js';

const DIRECTORY = '/data/projects/tv';
const SESSION = 'ses_routes_1';

function createApp(runtimeOverrides = {}) {
  const emitted = [];
  const hubSubscribers = new Set();
  const runtime = createMessageQueueRuntime({
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    globalEventHub: {
      subscribeEvent(fn) {
        hubSubscribers.add(fn);
        return () => hubSubscribers.delete(fn);
      },
      publishEvent: () => {},
    },
    emitQueueChanged: (event) => emitted.push(event),
    fetchImpl: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' })),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    ...runtimeOverrides,
  });
  const app = express();
  app.use(express.json());
  registerMessageQueueRoutes(app, { messageQueueRuntime: runtime });
  const fireHubEvent = (normalized) => {
    for (const fn of [...hubSubscribers]) fn(normalized);
  };
  return { app, runtime, emitted, fireHubEvent };
}

const markBusy = (fireHubEvent, sessionId = SESSION) => {
  // Force the session into a busy state so enqueues stay queued (no drain).
  fireHubEvent({
    envelope: {},
    payload: { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } },
    directory: DIRECTORY,
  });
};

describe('message-queue routes', () => {
  it('round-trips enqueue → list → remove → clear', async () => {
    const { app, runtime, fireHubEvent } = createApp();
    markBusy(fireHubEvent);

    const added = await request(app)
      .post('/api/message-queue')
      .send({ directory: DIRECTORY, sessionId: SESSION, item: { id: 'q1', content: 'hello', source: 'ui' } });
    expect(added.status).toBe(200);
    expect(added.body.ok).toBe(true);
    expect(added.body.position).toBe(1);

    const listed = await request(app)
      .get('/api/message-queue')
      .query({ directory: DIRECTORY });
    expect(listed.status).toBe(200);
    expect(listed.body.queues[SESSION]).toHaveLength(1);
    expect(listed.body.queues[SESSION][0].id).toBe('q1');

    const removed = await request(app)
      .delete(`/api/message-queue/${SESSION}/q1`)
      .query({ directory: DIRECTORY });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(true);

    await request(app)
      .post('/api/message-queue')
      .send({ directory: DIRECTORY, sessionId: SESSION, item: { content: 'again', source: 'ui' } });
    const cleared = await request(app)
      .delete(`/api/message-queue/${SESSION}`)
      .query({ directory: DIRECTORY });
    expect(cleared.status).toBe(200);
    expect(cleared.body.cleared).toBe(1);
  });

  it('reorders by ids', async () => {
    const { app, runtime, fireHubEvent } = createApp();
    markBusy(fireHubEvent);
    for (const id of ['a', 'b']) {
      // eslint-disable-next-line no-await-in-loop
      await request(app)
        .post('/api/message-queue')
        .send({ directory: DIRECTORY, sessionId: SESSION, item: { id, content: id, source: 'ui' } });
    }
    const reordered = await request(app)
      .post(`/api/message-queue/${SESSION}/reorder`)
      .send({ directory: DIRECTORY, fromId: 'b', toId: 'a' });
    expect(reordered.status).toBe(200);
    expect(reordered.body.reordered).toBe(true);
    expect(runtime.getQueue(DIRECTORY, SESSION).map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('400s on missing directory / sessionId', async () => {
    const { app } = createApp();
    const listed = await request(app).get('/api/message-queue');
    expect(listed.status).toBe(400);

    const added = await request(app).post('/api/message-queue').send({ item: { content: 'x' } });
    expect(added.status).toBe(400);
  });

  it('rejects invalid items with 400', async () => {
    const { app, runtime, fireHubEvent } = createApp();
    markBusy(fireHubEvent);
    const added = await request(app)
      .post('/api/message-queue')
      .send({ directory: DIRECTORY, sessionId: SESSION, item: { content: '' } });
    expect(added.status).toBe(400);
    expect(added.body.ok).toBe(false);
  });
});
