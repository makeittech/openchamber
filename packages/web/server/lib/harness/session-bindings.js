/**
 * Sticky session → harness bindings with durable JSON persistence.
 * Never persists secrets. harnessId is sticky for a session id's lifetime.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_VERSION = 1;
const DEFAULT_MAX_BINDINGS = 200;
const DEFAULT_DEBOUNCE_MS = 250;

/** @type {Map<string, object>} */
let bindings = new Map();
/** @type {string | null} */
let storeFilePath = null;
let persistEnabled = true;
let maxBindings = DEFAULT_MAX_BINDINGS;
let debounceMs = DEFAULT_DEBOUNCE_MS;
/** @type {ReturnType<typeof setTimeout> | null} */
let writeTimer = null;
let loaded = false;
/** @type {typeof fs} */
let fsImpl = fs;

/**
 * @returns {string}
 */
export function resolveSessionBindingsPath() {
  const dataDir = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(dataDir, 'harness-session-bindings.json');
}

/**
 * @param {unknown} value
 * @returns {object | null}
 */
const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function sanitizeTarget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = /** @type {Record<string, unknown>} */ (value);
  const harnessId = typeof target.harnessId === 'string' ? target.harnessId : '';
  if (!harnessId) return null;

  /** @type {Record<string, unknown>} */
  const out = { harnessId };
  if (typeof target.modelRef === 'string') out.modelRef = target.modelRef;
  if (typeof target.permissionMode === 'string') out.permissionMode = target.permissionMode;
  if (typeof target.effort === 'string' && CLAUDE_EFFORT_LEVELS.has(target.effort)) {
    out.effort = target.effort;
  }
  if (typeof target.providerId === 'string') out.providerId = target.providerId;
  if (typeof target.modelId === 'string') out.modelId = target.modelId;
  if (typeof target.agentName === 'string') out.agentName = target.agentName;
  if (typeof target.variant === 'string') out.variant = target.variant;
  return out;
}

/**
 * @param {unknown} value
 * @returns {object | null}
 */
function sanitizeCapabilitySnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, level] of Object.entries(value)) {
    if (typeof level === 'string') out[key] = level;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * @param {unknown} value
 * @returns {{ code: string, message: string, at: number } | undefined}
 */
function sanitizeLastError(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const error = /** @type {Record<string, unknown>} */ (value);
  const code = typeof error.code === 'string' ? error.code : 'HARNESS_ERROR';
  const message = typeof error.message === 'string' ? error.message : 'Harness error';
  const at = typeof error.at === 'number' && Number.isFinite(error.at) ? error.at : Date.now();
  return { code, message, at };
}

/**
 * Strip secrets / unknown privileged fields before persist or accept.
 * @param {unknown} raw
 * @returns {object | null}
 */
export function sanitizeSessionBinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = /** @type {Record<string, unknown>} */ (raw);
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  const harnessId = typeof input.harnessId === 'string' ? input.harnessId : '';
  const directory = typeof input.directory === 'string' ? input.directory : '';
  if (!sessionId || !harnessId || !directory) return null;

  const target = sanitizeTarget(input.target) || { harnessId };
  const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
    ? input.createdAt
    : Date.now();
  const updatedAt = typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt)
    ? input.updatedAt
    : createdAt;

  /** @type {Record<string, unknown>} */
  const binding = {
    sessionId,
    harnessId,
    directory,
    target,
    createdAt,
    updatedAt,
    capabilitySnapshot: sanitizeCapabilitySnapshot(input.capabilitySnapshot),
  };

  if (typeof input.foreignSessionId === 'string' && input.foreignSessionId) {
    binding.foreignSessionId = input.foreignSessionId;
  }
  if (typeof input.seedFromSessionId === 'string' && input.seedFromSessionId) {
    binding.seedFromSessionId = input.seedFromSessionId;
  }
  // Agent selection of the last user-driven turn. Server-side continuations
  // (session goal) have no composer to read it from, and a Claude assistant
  // message carries no agent, so without this the continuation would inherit
  // nothing and start asking for every tool mid-goal.
  if (input.agentsMode === 'claude' || input.agentsMode === 'opencode') {
    binding.agentsMode = input.agentsMode;
  }
  if (typeof input.agentName === 'string' && input.agentName.trim()) {
    binding.agentName = input.agentName.trim().slice(0, 200);
  }
  if (typeof input.claudeAgentName === 'string' && input.claudeAgentName.trim()) {
    binding.claudeAgentName = input.claudeAgentName.trim().slice(0, 200);
  }
  const lastError = sanitizeLastError(input.lastError);
  if (lastError) binding.lastError = lastError;

  return binding;
}

/**
 * @param {Map<string, object>} map
 */
function pruneBindings(map) {
  if (map.size <= maxBindings) return;
  const ranked = Array.from(map.values()).sort((a, b) => {
    const aAt = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
    const bAt = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
    return aAt - bAt;
  });
  const removeCount = map.size - maxBindings;
  for (let i = 0; i < removeCount; i += 1) {
    const sessionId = ranked[i]?.sessionId;
    if (typeof sessionId === 'string') map.delete(sessionId);
  }
}

/**
 * @returns {string}
 */
function effectiveStorePath() {
  return storeFilePath || resolveSessionBindingsPath();
}

function cancelScheduledWrite() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}

/**
 * Atomic write, mode 0o600, versioned JSON. Never writes secrets.
 */
export function flushSessionBindings() {
  cancelScheduledWrite();
  if (!persistEnabled) return;

  const filePath = effectiveStorePath();
  const directory = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const bindingsList = Array.from(bindings.values())
    .map((binding) => sanitizeSessionBinding(binding))
    .filter(Boolean);
  const payload = {
    version: STORE_VERSION,
    bindings: bindingsList,
  };

  try {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fsImpl.chmodSync(directory, 0o700);
    } catch {
      // best-effort on platforms that ignore chmod
    }
    fsImpl.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try {
      fsImpl.chmodSync(temporary, 0o600);
    } catch {
      // ignore
    }
    fsImpl.renameSync(temporary, filePath);
    try {
      fsImpl.chmodSync(filePath, 0o600);
    } catch {
      // ignore
    }
  } catch (error) {
    try {
      fsImpl.unlinkSync(temporary);
    } catch {
      // ignore
    }
    console.warn('[harness] Failed to persist session bindings:', error?.message || error);
  }
}

function schedulePersist() {
  if (!persistEnabled) return;
  cancelScheduledWrite();
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushSessionBindings();
  }, debounceMs);
  if (typeof writeTimer?.unref === 'function') writeTimer.unref();
}

function mutateBindings(mutator) {
  ensureSessionBindingsLoaded();
  const result = mutator();
  pruneBindings(bindings);
  schedulePersist();
  return result;
}

/**
 * Configure persistence (tests: temp path / persist:false). Reloads on next ensure.
 *
 * @param {object} [options]
 * @param {string} [options.filePath]
 * @param {boolean} [options.persist]
 * @param {number} [options.maxBindings]
 * @param {number} [options.debounceMs]
 * @param {typeof fs} [options.fs]
 * @param {boolean} [options.load] load immediately after configure
 */
export function configureSessionBindings(options = {}) {
  cancelScheduledWrite();
  if (typeof options.filePath === 'string' && options.filePath.trim()) {
    storeFilePath = path.resolve(options.filePath.trim());
  }
  if (typeof options.persist === 'boolean') {
    persistEnabled = options.persist;
  }
  if (Number.isFinite(options.maxBindings) && options.maxBindings > 0) {
    maxBindings = Math.floor(options.maxBindings);
  }
  if (Number.isFinite(options.debounceMs) && options.debounceMs >= 0) {
    debounceMs = Math.floor(options.debounceMs);
  }
  if (options.fs) {
    fsImpl = options.fs;
  }
  loaded = false;
  if (options.load) {
    initSessionBindings();
  }
}

/**
 * Load bindings from disk into the in-memory Map (idempotent until reset/configure).
 * @param {Parameters<typeof configureSessionBindings>[0]} [options]
 */
export function initSessionBindings(options = {}) {
  if (options && Object.keys(options).length > 0) {
    configureSessionBindings({ ...options, load: false });
  }
  if (loaded) return;
  loaded = true;
  bindings = new Map();
  if (!persistEnabled) return;

  const filePath = effectiveStorePath();
  try {
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.bindings) ? parsed.bindings : [];
    for (const item of list) {
      const binding = sanitizeSessionBinding(item);
      if (!binding) continue;
      bindings.set(binding.sessionId, binding);
    }
    pruneBindings(bindings);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[harness] Failed to load session bindings:', error?.message || error);
    }
  }
}

function ensureSessionBindingsLoaded() {
  if (!loaded) initSessionBindings();
}

/**
 * @param {string} sessionId
 * @returns {object | null}
 */
export function getSessionBinding(sessionId) {
  ensureSessionBindingsLoaded();
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return bindings.get(sessionId) || null;
}

/**
 * Create or return existing sticky binding. Never mutates harnessId on an
 * existing binding — callers must hand off to a new session instead.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {string} input.harnessId
 * @param {string} input.directory
 * @param {object} input.target
 * @param {object} [input.capabilitySnapshot]
 * @param {string} [input.seedFromSessionId]
 * @param {string} [input.foreignSessionId]
 * @param {'claude' | 'opencode'} [input.agentsMode]
 * @param {string} [input.agentName] Selected OpenCode agent (opencode mode).
 * @param {string} [input.claudeAgentName] Selected native Claude agent (claude mode).
 * @returns {{ binding: object, created: boolean, conflict?: boolean }}
 */
export function bindSession(input) {
  return mutateBindings(() => {
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : '';
    const harnessId = typeof input?.harnessId === 'string' ? input.harnessId : '';
    const directory = typeof input?.directory === 'string' ? input.directory : '';
    if (!sessionId || !harnessId || !directory) {
      const error = new Error('sessionId, harnessId, and directory are required');
      error.code = 'BINDING_INVALID';
      error.statusCode = 400;
      throw error;
    }

    const existing = bindings.get(sessionId);
    if (existing) {
      if (existing.harnessId !== harnessId) {
        return { binding: existing, created: false, conflict: true };
      }
      const next = {
        ...existing,
        directory,
        target: sanitizeTarget(input.target) ?? existing.target,
        updatedAt: Date.now(),
      };
      if (input.capabilitySnapshot) {
        next.capabilitySnapshot = sanitizeCapabilitySnapshot(input.capabilitySnapshot);
      }
      if (input.foreignSessionId) next.foreignSessionId = input.foreignSessionId;
      if (input.seedFromSessionId) next.seedFromSessionId = input.seedFromSessionId;
      // Re-stamped every user turn so a continuation always reuses the agent
      // the session is actually running under, not the one it started with.
      if (input.agentsMode === 'claude' || input.agentsMode === 'opencode') {
        next.agentsMode = input.agentsMode;
      }
      if (typeof input.agentName === 'string') {
        const agentName = input.agentName.trim().slice(0, 200);
        if (agentName) next.agentName = agentName;
        else delete next.agentName;
      }
      if (typeof input.claudeAgentName === 'string') {
        const claudeAgentName = input.claudeAgentName.trim().slice(0, 200);
        if (claudeAgentName) next.claudeAgentName = claudeAgentName;
        else delete next.claudeAgentName;
      }
      bindings.set(sessionId, next);
      return { binding: next, created: false, conflict: false };
    }

    const now = Date.now();
    const binding = sanitizeSessionBinding({
      sessionId,
      harnessId,
      directory,
      target: input.target || { harnessId },
      createdAt: now,
      updatedAt: now,
      capabilitySnapshot: input.capabilitySnapshot || null,
      foreignSessionId: input.foreignSessionId,
      seedFromSessionId: input.seedFromSessionId,
      agentsMode: input.agentsMode,
      agentName: input.agentName,
      claudeAgentName: input.claudeAgentName,
    });
    bindings.set(sessionId, binding);
    return { binding, created: true, conflict: false };
  });
}

/**
 * @param {string} sessionId
 * @param {Partial<object>} patch
 * @returns {object | null}
 */
export function updateSessionBinding(sessionId, patch) {
  return mutateBindings(() => {
    const existing = getSessionBinding(sessionId);
    if (!existing) return null;
    const next = sanitizeSessionBinding({
      ...existing,
      ...patch,
      sessionId: existing.sessionId,
      harnessId: existing.harnessId,
      updatedAt: Date.now(),
    });
    if (!next) return null;
    // harnessId is sticky — ignore attempts to rewrite.
    next.harnessId = existing.harnessId;
    bindings.set(sessionId, next);
    return next;
  });
}

/**
 * @param {string} sessionId
 * @param {string} foreignSessionId
 * @returns {object | null}
 */
export function setForeignSessionId(sessionId, foreignSessionId) {
  if (typeof foreignSessionId !== 'string' || !foreignSessionId) return getSessionBinding(sessionId);
  return updateSessionBinding(sessionId, { foreignSessionId });
}

/**
 * @param {string} sessionId
 * @param {{ code: string, message: string }} error
 * @returns {object | null}
 */
export function setBindingError(sessionId, error) {
  return updateSessionBinding(sessionId, {
    lastError: {
      code: error.code || 'HARNESS_ERROR',
      message: error.message || 'Harness error',
      at: Date.now(),
    },
  });
}

/**
 * @param {string} sessionId
 * @returns {boolean}
 */
export function clearSessionBinding(sessionId) {
  return mutateBindings(() => bindings.delete(sessionId));
}

/**
 * Test / lifecycle helper — clears in-memory bindings.
 * @param {{ clearDisk?: boolean }} [options]
 */
export function resetSessionBindings(options = {}) {
  cancelScheduledWrite();
  bindings.clear();
  loaded = true;
  if (options.clearDisk && persistEnabled) {
    const filePath = effectiveStorePath();
    try {
      fsImpl.unlinkSync(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn('[harness] Failed to clear session bindings file:', error?.message || error);
      }
    }
  }
}

/**
 * @returns {object[]}
 */
export function listSessionBindings() {
  ensureSessionBindingsLoaded();
  return Array.from(bindings.values());
}
