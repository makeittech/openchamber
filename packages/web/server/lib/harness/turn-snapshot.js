import { isClaudeSubagentSessionId } from './events/from-claude.js';

/** @typedef {{ type: 'busy' | 'idle' } | { type: 'retry', attempt: number, message: string, next?: number }} HarnessSessionStatus */

/**
 * @typedef {object} HarnessTurnSnapshot
 * @property {string} sessionId
 * @property {string} directory
 * @property {HarnessSessionStatus} status
 * @property {number} updatedAt
 * @property {{ info: object, parts: object[] } | null} lastUser
 * @property {{ info: object, parts: object[] } | null} lastAssistant
 * @property {boolean} aborted
 */

/** @type {Map<string, HarnessTurnSnapshot>} */
const snapshots = new Map();

const SESSION_LIMIT = 500;

function evictOldestIdle() {
  /** @type {HarnessTurnSnapshot | null} */
  let oldest = null;
  for (const snap of snapshots.values()) {
    if (snap.status.type !== 'idle') continue;
    if (!oldest || snap.updatedAt < oldest.updatedAt) oldest = snap;
  }
  if (oldest) snapshots.delete(oldest.sessionId);
}

function ensureSnapshot(sessionId, directory = '') {
  if (isClaudeSubagentSessionId(sessionId)) return null;
  let snap = snapshots.get(sessionId);
  if (!snap) {
    snap = {
      sessionId,
      directory: typeof directory === 'string' ? directory : '',
      status: { type: 'idle' },
      updatedAt: Date.now(),
      lastUser: null,
      lastAssistant: null,
      aborted: false,
    };
    snapshots.set(sessionId, snap);
    if (snapshots.size > SESSION_LIMIT) evictOldestIdle();
  } else if (directory && !snap.directory) {
    snap.directory = directory;
  }
  return snap;
}

function applyStatus(event, directory) {
  const sessionId = typeof event.properties?.sessionID === 'string' ? event.properties.sessionID : '';
  if (!sessionId) return;
  const status = event.properties?.status;
  const statusType = status?.type;
  if (statusType !== 'busy' && statusType !== 'idle' && statusType !== 'retry') return;
  const snap = ensureSnapshot(sessionId, directory);
  if (!snap) return;
  snap.status = statusType === 'retry'
    ? {
      type: 'retry',
      attempt: Number.isFinite(status.attempt) ? status.attempt : 1,
      message: typeof status.message === 'string' ? status.message : '',
      ...(Number.isFinite(status.next) ? { next: status.next } : {}),
    }
    : { type: statusType };
  snap.updatedAt = Date.now();
  if (statusType === 'busy') snap.aborted = false;
}

function applyMessage(event, directory) {
  const info = event.properties?.info;
  if (!info || typeof info !== 'object') return;
  const sessionId = typeof info.sessionID === 'string' ? info.sessionID : '';
  if (!sessionId) return;
  const snap = ensureSnapshot(sessionId, directory);
  if (!snap) return;
  snap.updatedAt = Date.now();
  if (info.error?.name === 'MessageAbortedError') snap.aborted = true;

  if (info.role === 'user') {
    snap.lastUser = {
      info,
      parts: snap.lastUser?.info?.id === info.id ? (snap.lastUser.parts || []) : [],
    };
  } else if (info.role === 'assistant') {
    const previous = snap.lastAssistant?.info?.id === info.id ? snap.lastAssistant : null;
    snap.lastAssistant = { info, parts: previous?.parts || [] };
  }
}

function addPart(bucket, messageId, part) {
  if (!bucket || bucket.info?.id !== messageId) return false;
  const parts = Array.isArray(bucket.parts) ? [...bucket.parts] : [];
  const index = parts.findIndex((entry) => entry?.id === part.id);
  if (index >= 0) parts[index] = part;
  else parts.push(part);
  bucket.parts = parts;
  return true;
}

function applyPart(event, directory) {
  const part = event.properties?.part;
  if (!part || typeof part !== 'object') return;
  const sessionId = typeof part.sessionID === 'string'
    ? part.sessionID
    : (typeof event.properties?.sessionID === 'string' ? event.properties.sessionID : '');
  const messageId = typeof part.messageID === 'string' ? part.messageID : '';
  if (!sessionId || !messageId) return;
  const snap = ensureSnapshot(sessionId, directory);
  if (!snap) return;
  snap.updatedAt = Date.now();

  if (!addPart(snap.lastAssistant, messageId, part) && !addPart(snap.lastUser, messageId, part)) {
    if (part.type === 'text') {
      snap.lastAssistant = {
        info: {
          id: messageId,
          sessionID: sessionId,
          role: 'assistant',
          time: { created: Date.now() },
          providerID: 'claude-code',
          modelID: 'sonnet',
          agent: 'build',
          mode: 'build',
        },
        parts: [part],
      };
    }
  }
}

export function applyHarnessEventToSnapshot(event, directory = '') {
  if (!event || typeof event !== 'object') return;
  switch (event.type) {
    case 'session.status':
      applyStatus(event, directory);
      break;
    case 'message.updated':
      applyMessage(event, directory);
      break;
    case 'message.part.updated':
      applyPart(event, directory);
      break;
  }
}

export function getHarnessTurnSnapshot(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return snapshots.get(sessionId) ?? null;
}

export function isHarnessSessionWorking(sessionId) {
  const snap = getHarnessTurnSnapshot(sessionId);
  return snap?.status.type === 'busy' || snap?.status.type === 'retry';
}

export function listHarnessActiveStatuses(directory) {
  const filter = typeof directory === 'string' && directory.trim()
    ? directory.trim()
    : '';
  /** @type {Record<string, HarnessSessionStatus>} */
  const result = {};
  for (const snap of snapshots.values()) {
    if (snap.status.type === 'idle') continue;
    if (filter && snap.directory && snap.directory !== filter) continue;
    result[snap.sessionId] = { ...snap.status };
  }
  return result;
}

export function getHarnessRecentMessages(sessionId) {
  const snap = getHarnessTurnSnapshot(sessionId);
  if (!snap) return null;
  const messages = [];
  if (snap.lastUser) messages.push(snap.lastUser);
  if (snap.lastAssistant) messages.push(snap.lastAssistant);
  return messages;
}

export function clearHarnessTurnSnapshot(sessionId) {
  if (typeof sessionId === 'string' && sessionId) snapshots.delete(sessionId);
}

export function resetHarnessTurnSnapshots() {
  snapshots.clear();
}
