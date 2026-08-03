/**
 * Server-owned message queue for OpenChamber sessions.
 *
 * One queue per (directory, sessionId), held in memory (deliberately
 * ephemeral — see DOCUMENTATION.md). Both producers share this module:
 *
 *  - the web/desktop/mobile UI via `/api/message-queue` routes, and
 *  - messenger surfaces (Discord `/queue`, `. queue` suffix) via direct
 *    in-process calls from the messenger bridge.
 *
 * The runtime is also the single drainer: it watches the global OpenCode
 * event hub and sends the head item once the session settles to idle, so a
 * queued message is delivered exactly once no matter which surface queued
 * it. Items carry the send configuration captured at queue time
 * (provider/model/agent/variant) — nothing is re-resolved at send time.
 */

export const MESSAGE_QUEUE_CHANGED_EVENT = 'openchamber:message-queue-changed';
export const MESSAGE_QUEUE_DRAINED_EVENT = 'openchamber.message-queue.drained';

const MAX_QUEUE_TARGETS = 50;
const MAX_MESSAGES_PER_QUEUE = 20;

const DRAIN_RETRY_BASE_DELAY_MS = 2_000;
const DRAIN_RETRY_MAX_DELAY_MS = 60_000;

const keyFor = (directory, sessionId) => `${directory}\n${sessionId}`;

const clampString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : null);

const normalizeAttachments = (value) => {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const url = clampString(entry.url);
    if (!url) continue;
    out.push({
      mime: clampString(entry.mime) ?? 'application/octet-stream',
      url,
      filename: clampString(entry.filename) ?? 'file',
    });
  }
  return out.length > 0 ? out : undefined;
};

const normalizeSendConfig = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  const providerID = clampString(value.providerID);
  const modelID = clampString(value.modelID);
  if (!providerID || !modelID) return undefined;
  return {
    providerID,
    modelID,
    ...(clampString(value.agent) ? { agent: clampString(value.agent) } : {}),
    ...(clampString(value.variant) ? { variant: clampString(value.variant) } : {}),
  };
};

const normalizeFrom = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  const out = {};
  if (value.id != null) out.id = String(value.id);
  if (clampString(value.firstName)) out.firstName = clampString(value.firstName);
  if (clampString(value.username)) out.username = clampString(value.username);
  return Object.keys(out).length > 0 ? out : undefined;
};

let idCounter = 0;
const generateId = (now) => {
  idCounter = (idCounter + 1) % 1000;
  return `mq-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${idCounter.toString(36)}`;
};

export function createMessageQueueRuntime({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  globalEventHub = null,
  emitQueueChanged = null,
  fetchImpl = fetch,
  logger = console,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, Array<object>>} key = `${directory}\n${sessionId}` */
  const queues = new Map();
  /** Sessions with an in-flight assistant turn (from hub events + own sends). */
  const busySessions = new Set();
  /** Directories whose /session/status snapshot has been primed. */
  const primedStatusDirectories = new Set();
  const statusPrimeInFlight = new Map();
  /** Per-key drain serialization. */
  const drainingKeys = new Set();
  /** @type {Map<string, { failures: number, nextAttemptAt: number }>} */
  const drainBackoff = new Map();
  /** Optional sender for messenger-originated items (registered by the bridge). */
  let messengerSender = null;

  const cloneItems = (items) => (Array.isArray(items) ? items.map((item) => ({ ...item })) : []);

  const emitChanged = (directory, sessionId) => {
    if (typeof emitQueueChanged !== 'function') return;
    try {
      emitQueueChanged({
        type: MESSAGE_QUEUE_CHANGED_EVENT,
        directory,
        sessionId,
        items: cloneItems(queues.get(keyFor(directory, sessionId))),
      });
    } catch (error) {
      logger?.warn?.('[message-queue] emitQueueChanged failed:', error?.message ?? error);
    }
  };

  const evictStaleTargetsIfNeeded = () => {
    if (queues.size <= MAX_QUEUE_TARGETS) return;
    const entries = [...queues.entries()]
      .filter(([, items]) => items.length > 0 && typeof items[0]?.createdAt === 'number')
      .sort((a, b) => a[1][0].createdAt - b[1][0].createdAt);
    for (const [staleKey] of entries.slice(0, queues.size - MAX_QUEUE_TARGETS)) {
      queues.delete(staleKey);
    }
  };

  const buildPromptBody = (item) => {
    const parts = [{ type: 'text', text: item.content }];
    for (const attachment of item.attachments ?? []) {
      parts.push({
        type: 'file',
        mime: attachment.mime,
        url: attachment.url,
        filename: attachment.filename,
      });
    }
    const body = { parts };
    const config = item.sendConfig;
    if (config) {
      body.model = { providerID: config.providerID, modelID: config.modelID };
      if (config.variant) body.model.variant = config.variant;
      if (config.agent) body.agent = config.agent;
    }
    return body;
  };

  const opencodeFetch = async (pathSuffix, init = {}) => {
    const url = buildOpenCodeUrl(pathSuffix, '');
    const headers = {
      ...(init.headers ?? {}),
      ...(typeof getOpenCodeAuthHeaders === 'function' ? getOpenCodeAuthHeaders() : {}),
      'Content-Type': 'application/json',
    };
    return fetchImpl(url, { ...init, headers });
  };

  const sendViaRest = async (directory, sessionId, item) => {
    const params = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    try {
      if (item.kind === 'command') {
        const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/command${params}`, {
          method: 'POST',
          body: JSON.stringify({ command: item.commandName, arguments: item.args ?? '' }),
        });
        if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
        return { ok: true };
      }
      const r = await opencodeFetch(`/session/${encodeURIComponent(sessionId)}/prompt_async${params}`, {
        method: 'POST',
        body: JSON.stringify(buildPromptBody(item)),
      });
      if (!r.ok) return { ok: false, error: `OpenCode ${r.status}: ${(await r.text()).slice(0, 200)}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message ?? 'dispatch failed' };
    }
  };

  const dispatch = async (directory, sessionId, item) => {
    const useMessenger = item.source && item.source !== 'ui' && typeof messengerSender === 'function';
    if (useMessenger) {
      try {
        const result = await messengerSender({ directory, sessionId, item: { ...item } });
        return result?.ok ? { ok: true } : { ok: false, error: result?.error ?? 'messenger send failed' };
      } catch (error) {
        return { ok: false, error: error?.message ?? 'messenger send failed' };
      }
    }
    return sendViaRest(directory, sessionId, item);
  };

  const primeSessionStatus = async (directory) => {
    if (!directory || primedStatusDirectories.has(directory)) return;
    if (statusPrimeInFlight.has(directory)) return statusPrimeInFlight.get(directory);
    const prime = (async () => {
      try {
        const params = `?directory=${encodeURIComponent(directory)}`;
        const r = await opencodeFetch(`/session/status${params}`);
        if (!r.ok) return;
        const data = await r.json().catch(() => null);
        if (!data || typeof data !== 'object') return;
        for (const [sessionId, status] of Object.entries(data)) {
          const type = status?.type ?? status;
          if (type === 'busy' || type === 'retry') {
            busySessions.add(sessionId);
          }
        }
        primedStatusDirectories.add(directory);
      } catch {
        // OpenCode unreachable — the drain attempt will fail and back off.
      } finally {
        statusPrimeInFlight.delete(directory);
      }
    })();
    statusPrimeInFlight.set(directory, prime);
    return prime;
  };

  const isSessionBusy = async (directory, sessionId) => {
    if (busySessions.has(sessionId)) return true;
    await primeSessionStatus(directory);
    return busySessions.has(sessionId);
  };

  const drainRetryDelayMs = (failures) => Math.min(
    DRAIN_RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0),
    DRAIN_RETRY_MAX_DELAY_MS,
  );

  const tryDrain = async (directory, sessionId) => {
    const key = keyFor(directory, sessionId);
    if (drainingKeys.has(key)) return;
    const queue = queues.get(key);
    if (!queue || queue.length === 0) return;

    drainingKeys.add(key);
    try {
      if (await isSessionBusy(directory, sessionId)) return;

      const backoff = drainBackoff.get(key);
      if (backoff && now() < backoff.nextAttemptAt) return;

      const item = queue[0];
      const result = await dispatch(directory, sessionId, item);
      if (!result.ok) {
        const failures = (backoff?.failures ?? 0) + 1;
        drainBackoff.set(key, { failures, nextAttemptAt: now() + drainRetryDelayMs(failures) });
        logger?.warn?.(
          `[message-queue] drain for ${sessionId} failed (${failures}x): ${result.error ?? 'unknown error'}`,
        );
        return;
      }

      drainBackoff.delete(key);
      queue.shift();
      if (queue.length === 0) queues.delete(key);
      // The sent prompt starts a turn — treat the session as busy immediately
      // so a back-to-back enqueue can't double-drain before the busy event.
      busySessions.add(sessionId);
      emitChanged(directory, sessionId);
      if (globalEventHub && typeof globalEventHub.publishEvent === 'function') {
        try {
          globalEventHub.publishEvent(MESSAGE_QUEUE_DRAINED_EVENT, {
            directory,
            sessionId,
            itemId: item.id,
            source: item.source ?? null,
          });
        } catch {
          // best-effort
        }
      }
    } finally {
      drainingKeys.delete(key);
    }
  };

  const findKeyBySessionId = (sessionId) => {
    for (const key of queues.keys()) {
      if (key.endsWith(`\n${sessionId}`)) return key;
    }
    return null;
  };

  const handleHubEvent = (normalized) => {
    const payload = normalized?.payload ?? normalized;
    if (!payload || typeof payload !== 'object') return;
    const type = payload.type ?? payload.event ?? null;
    const props = payload.properties ?? payload.props ?? payload;
    const sessionId = props?.sessionID ?? props?.sessionId ?? props?.info?.id ?? props?.id ?? null;
    if (!sessionId) return;

    if (type === 'session.status') {
      const statusType = props?.status?.type ?? null;
      if (statusType === 'busy' || statusType === 'retry') {
        busySessions.add(sessionId);
        return;
      }
      if (statusType === 'idle') {
        busySessions.delete(sessionId);
        const key = findKeyBySessionId(sessionId);
        if (key) {
          const directory = key.slice(0, key.length - sessionId.length - 1);
          void tryDrain(directory, sessionId);
        }
      }
      return;
    }

    if (type === 'session.idle' || type === 'session.error') {
      busySessions.delete(sessionId);
      const key = findKeyBySessionId(sessionId);
      if (key) {
        const directory = key.slice(0, key.length - sessionId.length - 1);
        void tryDrain(directory, sessionId);
      }
      return;
    }

    if (type === 'session.deleted' || type === 'session.removed') {
      busySessions.delete(sessionId);
      const key = findKeyBySessionId(sessionId);
      if (key) {
        const directory = key.slice(0, key.length - sessionId.length - 1);
        queues.delete(key);
        drainBackoff.delete(key);
        emitChanged(directory, sessionId);
      }
    }
  };

  const unsubscribe = globalEventHub && typeof globalEventHub.subscribeEvent === 'function'
    ? globalEventHub.subscribeEvent(handleHubEvent)
    : null;

  const normalizeItem = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const kind = raw.kind === 'command' ? 'command' : 'prompt';
    if (kind === 'command') {
      const commandName = clampString(raw.commandName);
      if (!commandName) return null;
      return {
        id: clampString(raw.id) ?? generateId(now),
        kind,
        commandName,
        args: typeof raw.args === 'string' ? raw.args : '',
        content: '',
        source: clampString(raw.source) ?? 'ui',
        from: normalizeFrom(raw.from),
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now(),
      };
    }
    const content = clampString(raw.content);
    if (!content) return null;
    return {
      id: clampString(raw.id) ?? generateId(now),
      kind,
      content,
      attachments: normalizeAttachments(raw.attachments),
      sendConfig: normalizeSendConfig(raw.sendConfig),
      source: clampString(raw.source) ?? 'ui',
      from: normalizeFrom(raw.from),
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now(),
    };
  };

  return {
    /**
     * Snapshot of every non-empty queue for a directory.
     * @returns {Record<string, Array<object>>} sessionId → items
     */
    list(directory) {
      const out = {};
      if (!clampString(directory)) return out;
      for (const [key, items] of queues.entries()) {
        if (!key.startsWith(`${directory}\n`) || items.length === 0) continue;
        out[key.slice(directory.length + 1)] = cloneItems(items);
      }
      return out;
    },

    getQueue(directory, sessionId) {
      return cloneItems(queues.get(keyFor(directory, sessionId)));
    },

    async enqueue({ directory, sessionId, item }) {
      if (!clampString(directory) || !clampString(sessionId)) {
        return { ok: false, error: 'directory and sessionId are required' };
      }
      const normalized = normalizeItem(item);
      if (!normalized) {
        return { ok: false, error: 'invalid queue item' };
      }
      const key = keyFor(directory, sessionId);
      const queue = queues.get(key) ?? [];
      const existingIndex = queue.findIndex((entry) => entry.id === normalized.id);
      if (existingIndex >= 0) {
        // Idempotent re-enqueue (client retry / migration upload): keep the
        // original position so duplicate posts can't reorder or duplicate.
        return { ok: true, position: existingIndex + 1, item: { ...queue[existingIndex] } };
      }
      queue.push(normalized);
      // Same overflow semantics as the UI store: keep the newest N, drop the
      // oldest — but report it so messenger surfaces can tell the user.
      const truncated = queue.length > MAX_MESSAGES_PER_QUEUE;
      const trimmed = truncated ? queue.slice(-MAX_MESSAGES_PER_QUEUE) : queue;
      queues.set(key, trimmed);
      evictStaleTargetsIfNeeded();
      emitChanged(directory, sessionId);
      void tryDrain(directory, sessionId);
      return {
        ok: true,
        position: trimmed.indexOf(normalized) + 1,
        item: { ...normalized },
        ...(truncated ? { truncated: true } : {}),
      };
    },

    remove({ directory, sessionId, id }) {
      const key = keyFor(directory, sessionId);
      const queue = queues.get(key);
      if (!queue) return false;
      const next = queue.filter((entry) => entry.id !== id);
      if (next.length === queue.length) return false;
      if (next.length === 0) queues.delete(key);
      else queues.set(key, next);
      drainBackoff.delete(key);
      emitChanged(directory, sessionId);
      return true;
    },

    removeAt({ directory, sessionId, position }) {
      const key = keyFor(directory, sessionId);
      const queue = queues.get(key);
      if (!queue || position < 1 || position > queue.length) return false;
      queue.splice(position - 1, 1);
      if (queue.length === 0) queues.delete(key);
      drainBackoff.delete(key);
      emitChanged(directory, sessionId);
      return true;
    },

    clear({ directory, sessionId }) {
      const key = keyFor(directory, sessionId);
      const queue = queues.get(key);
      const cleared = queue?.length ?? 0;
      queues.delete(key);
      drainBackoff.delete(key);
      emitChanged(directory, sessionId);
      return cleared;
    },

    reorder({ directory, sessionId, fromId, toId }) {
      if (fromId === toId) return false;
      const key = keyFor(directory, sessionId);
      const queue = queues.get(key);
      if (!queue) return false;
      const fromIndex = queue.findIndex((entry) => entry.id === fromId);
      const toIndex = queue.findIndex((entry) => entry.id === toId);
      if (fromIndex === -1 || toIndex === -1) return false;
      const next = queue.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      queues.set(key, next);
      emitChanged(directory, sessionId);
      return true;
    },

    /** Used by the messenger bridge to deliver messenger-originated items. */
    registerMessengerSender(sender) {
      messengerSender = typeof sender === 'function' ? sender : null;
      return () => {
        if (messengerSender === sender) messengerSender = null;
      };
    },

    /** Exposed for tests/diagnostics. */
    tryDrain,

    stop() {
      unsubscribe?.();
    },
  };
}
