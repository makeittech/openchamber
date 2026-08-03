import { applyHarnessEventToSnapshot } from '../turn-snapshot.js';

/** @type {Set<(event: object, directory: string) => void>} */
const observers = new Set();

export function addHarnessEventObserver(observer) {
  if (typeof observer !== 'function') return () => {};
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

export function withHarnessEventDirectory(payload, directory) {
  if (!payload || typeof payload !== 'object' || !directory) {
    return payload;
  }
  const properties = payload.properties && typeof payload.properties === 'object'
    ? payload.properties
    : {};
  if (typeof properties.directory === 'string' && properties.directory.length > 0) {
    return payload;
  }
  return {
    ...payload,
    properties: {
      ...properties,
      directory,
    },
  };
}

function emitHarnessEvent(broadcast, payload, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const directory = typeof options.directory === 'string' && options.directory.length > 0
    ? options.directory
    : '';
  const eventId = typeof options.eventId === 'string' && options.eventId.length > 0
    ? options.eventId
    : undefined;

  const scopedPayload = withHarnessEventDirectory(payload, directory);

  applyHarnessEventToSnapshot(scopedPayload, directory);
  for (const observer of observers) {
    try {
      observer(scopedPayload, directory);
    } catch (error) {
      console.warn('[harness] event observer failed:', error?.message || error);
    }
  }

  if (typeof broadcast !== 'function') {
    return;
  }
  try {
    broadcast(scopedPayload, {
      ...(directory ? { directory } : {}),
      ...(eventId ? { eventId } : {}),
    });
  } catch (error) {
    console.warn('[harness] event broadcast failed:', error?.message || error);
  }
}

export function emitHarnessEvents(broadcast, directory, events) {
  if (!Array.isArray(events)) return;
  for (const event of events) {
    emitHarnessEvent(broadcast, event, { directory });
  }
}
