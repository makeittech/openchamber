/**
 * HTTP surface for the server-owned message queue (see ./runtime.js).
 * Registered before the generic `/api/*` OpenCode proxy so these explicit
 * OpenChamber routes win.
 *
 *   GET    /api/message-queue?directory=…                → { queues: { sessionId: items[] } }
 *   POST   /api/message-queue                            { directory, sessionId, item } → { ok, position, item }
 *   DELETE /api/message-queue/:sessionId?directory=…     → { ok, cleared }
 *   DELETE /api/message-queue/:sessionId/:id?directory=… → { ok, removed }
 *   POST   /api/message-queue/:sessionId/reorder         { directory, fromId, toId } → { ok }
 */

const asNonEmptyString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

const readDirectory = (req) => {
  const fromQuery = asNonEmptyString(req?.query?.directory);
  if (fromQuery) return fromQuery;
  return asNonEmptyString(req?.body?.directory);
};

export const registerMessageQueueRoutes = (app, { messageQueueRuntime }) => {
  if (!messageQueueRuntime) {
    throw new Error('registerMessageQueueRoutes requires messageQueueRuntime');
  }

  app.get('/api/message-queue', (req, res) => {
    const directory = readDirectory(req);
    if (!directory) {
      return res.status(400).json({ error: 'directory is required' });
    }
    return res.json({ queues: messageQueueRuntime.list(directory) });
  });

  app.post('/api/message-queue', async (req, res) => {
    const directory = readDirectory(req);
    const sessionId = asNonEmptyString(req?.body?.sessionId);
    if (!directory || !sessionId) {
      return res.status(400).json({ error: 'directory and sessionId are required' });
    }
    const result = await messageQueueRuntime.enqueue({
      directory,
      sessionId,
      item: req?.body?.item,
    });
    if (!result.ok) {
      return res.status(400).json(result);
    }
    return res.json(result);
  });

  app.delete('/api/message-queue/:sessionId', (req, res) => {
    const directory = readDirectory(req);
    const sessionId = asNonEmptyString(req?.params?.sessionId);
    if (!directory || !sessionId) {
      return res.status(400).json({ error: 'directory and sessionId are required' });
    }
    const cleared = messageQueueRuntime.clear({ directory, sessionId });
    return res.json({ ok: true, cleared });
  });

  app.delete('/api/message-queue/:sessionId/:id', (req, res) => {
    const directory = readDirectory(req);
    const sessionId = asNonEmptyString(req?.params?.sessionId);
    const id = asNonEmptyString(req?.params?.id);
    if (!directory || !sessionId || !id) {
      return res.status(400).json({ error: 'directory, sessionId and id are required' });
    }
    const removed = messageQueueRuntime.remove({ directory, sessionId, id });
    return res.json({ ok: true, removed });
  });

  app.post('/api/message-queue/:sessionId/reorder', (req, res) => {
    const directory = readDirectory(req);
    const sessionId = asNonEmptyString(req?.params?.sessionId);
    const fromId = asNonEmptyString(req?.body?.fromId);
    const toId = asNonEmptyString(req?.body?.toId);
    if (!directory || !sessionId || !fromId || !toId) {
      return res.status(400).json({ error: 'directory, sessionId, fromId and toId are required' });
    }
    const reordered = messageQueueRuntime.reorder({ directory, sessionId, fromId, toId });
    return res.json({ ok: true, reordered });
  });
};
