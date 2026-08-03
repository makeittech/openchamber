import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const PENDING_RETRY_STORE_VERSION = 1;
export const MAX_PENDING_RETRY_RECORDS = 500;
export const MAX_PENDING_RETRY_STORE_BYTES = 1024 * 1024;
export const RETRY_STORE_UNAVAILABLE = 'RETRY_STORE_UNAVAILABLE';

const MAX_SESSION_ID_LENGTH = 512;
const MAX_DIRECTORY_LENGTH = 4096;
const MAX_FOREIGN_SESSION_ID_LENGTH = 512;
const MAX_MODEL_REF_LENGTH = 200;
const MAX_AGENT_NAME_LENGTH = 200;
const MAX_RATE_LIMIT_TYPE_LENGTH = 100;
const MAX_UUID_LENGTH = 200;
const MAX_BLOCKED_REASON_LENGTH = 64;
const MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;
const DEFAULT_LOCK_TIMEOUT_MS = 1000;
const MAX_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_POLL_MS = 10;
const DEFAULT_STALE_LOCK_MS = 30_000;
const MIN_STALE_LOCK_MS = 1000;
const MAX_LOCK_POLL_MS = 100;
const BLOCKED_REASON_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

const RECOVERY_STATES = new Set(['observed', 'waiting', 'launching', 'blocked']);
const AGENTS_MODES = new Set(['claude', 'opencode']);
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PERSISTED_ENVELOPE_FIELDS = new Set(['version', 'retries']);
const PERSISTED_RECORD_FIELDS = new Set([
  'sessionId',
  'directory',
  'foreignSessionId',
  'target',
  'agentsMode',
  'agentName',
  'claudeAgentName',
  'state',
  'generation',
  'attempt',
  'rateLimitType',
  'resetAt',
  'nextAttemptAt',
  'rateLimitAssistantUuid',
  'expectedTailUuid',
  'launchUuid',
  'createdAt',
  'updatedAt',
  'blockedReason',
]);
const PERSISTED_TARGET_FIELDS = new Set([
  'harnessId',
  'modelRef',
  'permissionMode',
  'effort',
]);
const UNSUPPORTED_CHMOD_CODES = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  'EINVAL',
  'EISDIR',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
]);
const READ_FLAGS = fs.constants.O_RDONLY
  | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0));
const TEMP_WRITE_FLAGS = fs.constants.O_WRONLY
  | fs.constants.O_CREAT
  | fs.constants.O_EXCL
  | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0));
const DIRECTORY_READ_FLAGS = fs.constants.O_RDONLY
  | (process.platform === 'win32' ? 0 : (fs.constants.O_DIRECTORY || 0))
  | (process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0));
let lockTokenCounter = 0;

export function resolvePendingRetryStorePath() {
  const root = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  return path.join(root, 'harness-pending-retries.json');
}

function createUnavailableError(message, cause) {
  const error = new Error(message);
  error.code = RETRY_STORE_UNAVAILABLE;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeString(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  const sanitized = value.trim().slice(0, maxLength);
  return sanitized || undefined;
}

// Never normalize authority identifiers: doing so could redirect recovery.
function sanitizeAuthorityId(value, maxLength) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value.includes('\0')
    || value.trim() !== value
  ) {
    return undefined;
  }
  return value;
}

function sanitizeDirectory(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_DIRECTORY_LENGTH
    || value.includes('\0')
    || !path.isAbsolute(value)
  ) {
    return undefined;
  }
  return value;
}

function sanitizeNonnegativeInteger(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_SAFE_NUMBER, Math.floor(Math.max(0, value)));
}

function sanitizeTarget(value) {
  if (!isObject(value) || value.harnessId !== 'claude-code') return null;

  /** @type {Record<string, unknown>} */
  const target = { harnessId: 'claude-code' };
  if (value.modelRef !== undefined) {
    const modelRef = sanitizeAuthorityId(value.modelRef, MAX_MODEL_REF_LENGTH);
    if (!modelRef) return null;
    target.modelRef = modelRef;
  }
  if (typeof value.permissionMode === 'string' && PERMISSION_MODES.has(value.permissionMode)) {
    target.permissionMode = value.permissionMode;
  }
  if (typeof value.effort === 'string' && EFFORT_LEVELS.has(value.effort)) {
    target.effort = value.effort;
  }
  return target;
}

// Unknown persisted fields fail closed instead of leaving sensitive data on disk.
function hasOnlyPersistedFields(value) {
  if (!isObject(value) || !isObject(value.target)) return false;
  return Object.keys(value).every((field) => PERSISTED_RECORD_FIELDS.has(field))
    && Object.keys(value.target).every((field) => PERSISTED_TARGET_FIELDS.has(field));
}

function hasExactPersistedEnvelope(value) {
  if (!isObject(value)) return false;
  const fields = Object.keys(value);
  return fields.length === PERSISTED_ENVELOPE_FIELDS.size
    && fields.every((field) => PERSISTED_ENVELOPE_FIELDS.has(field));
}

export function sanitizePendingRetryRecord(raw) {
  if (!isObject(raw)) return null;

  const sessionId = sanitizeAuthorityId(raw.sessionId, MAX_SESSION_ID_LENGTH);
  const directory = sanitizeDirectory(raw.directory);
  const target = sanitizeTarget(raw.target);
  const state = typeof raw.state === 'string' && RECOVERY_STATES.has(raw.state)
    ? raw.state
    : null;
  if (!sessionId || !directory || !target || !state) return null;

  /** @type {Record<string, unknown>} */
  const record = {
    sessionId,
    directory,
    target,
    state,
    generation: sanitizeNonnegativeInteger(raw.generation) ?? 0,
    attempt: sanitizeNonnegativeInteger(raw.attempt) ?? 0,
    createdAt: sanitizeNonnegativeInteger(raw.createdAt) ?? 0,
    updatedAt: sanitizeNonnegativeInteger(raw.updatedAt) ?? 0,
  };

  const optionalStrings = [
    ['agentName', MAX_AGENT_NAME_LENGTH],
    ['claudeAgentName', MAX_AGENT_NAME_LENGTH],
    ['rateLimitType', MAX_RATE_LIMIT_TYPE_LENGTH],
  ];
  for (const [field, maxLength] of optionalStrings) {
    const value = sanitizeString(raw[field], maxLength);
    if (value) record[field] = value;
  }

  const authorityIds = [
    ['foreignSessionId', MAX_FOREIGN_SESSION_ID_LENGTH],
    ['rateLimitAssistantUuid', MAX_UUID_LENGTH],
    ['expectedTailUuid', MAX_UUID_LENGTH],
    ['launchUuid', MAX_UUID_LENGTH],
  ];
  for (const [field, maxLength] of authorityIds) {
    if (raw[field] === undefined) continue;
    const value = sanitizeAuthorityId(raw[field], maxLength);
    if (!value) return null;
    record[field] = value;
  }

  if (raw.blockedReason !== undefined) {
    if (
      typeof raw.blockedReason !== 'string'
      || raw.blockedReason.length > MAX_BLOCKED_REASON_LENGTH
      || !BLOCKED_REASON_PATTERN.test(raw.blockedReason)
    ) {
      return null;
    }
    record.blockedReason = raw.blockedReason;
  }

  if (typeof raw.agentsMode === 'string' && AGENTS_MODES.has(raw.agentsMode)) {
    record.agentsMode = raw.agentsMode;
  }

  for (const field of ['resetAt', 'nextAttemptAt']) {
    const value = sanitizeNonnegativeInteger(raw[field]);
    if (value !== undefined) record[field] = value;
  }

  return record;
}

function cloneRecord(record) {
  return {
    ...record,
    target: { ...record.target },
  };
}

function isNewerDuplicate(candidate, current) {
  if (candidate.generation !== current.generation) {
    return candidate.generation > current.generation;
  }
  return candidate.updatedAt > current.updatedAt;
}

function chmodSecureSync(fsImpl, targetPath, mode) {
  try {
    fsImpl.chmodSync(targetPath, mode);
  } catch (error) {
    const unsupported = UNSUPPORTED_CHMOD_CODES.has(error?.code)
      || (process.platform === 'win32' && error?.code === 'EPERM');
    if (!unsupported) throw error;
  }
}

function isUnsupportedDirectorySyncError(error) {
  if (UNSUPPORTED_DIRECTORY_SYNC_CODES.has(error?.code)) return true;
  return process.platform === 'win32'
    && (error?.code === 'EACCES' || error?.code === 'EPERM');
}

function defaultSleepSync(durationMs) {
  if (durationMs <= 0) return;
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, durationMs);
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists but is owned by another user. Only ESRCH
    // is a confirmed dead owner; unknown probe failures stay fail-safe/live.
    return error?.code !== 'ESRCH';
  }
}

/**
 * @param {unknown[]} input
 * @param {number} maxRecords
 * @param {{ strict?: boolean }} [options]
 * @returns {Map<string, Record<string, unknown>>}
 */
function sanitizeRecordMap(input, maxRecords, options = {}) {
  if (input.length > maxRecords) {
    throw createUnavailableError(`Pending retry journal exceeds ${maxRecords} records`);
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const next = new Map();
  for (const raw of input) {
    if (options.strict && !hasOnlyPersistedFields(raw)) {
      throw createUnavailableError('Pending retry journal contains unknown record fields');
    }
    const record = sanitizePendingRetryRecord(raw);
    if (!record) {
      throw createUnavailableError('Pending retry journal contains an invalid record');
    }
    if (options.strict && !isDeepStrictEqual(record, raw)) {
      throw createUnavailableError('Pending retry journal contains a noncanonical record');
    }
    const sessionId = /** @type {string} */ (record.sessionId);
    const current = next.get(sessionId);
    if (!current || isNewerDuplicate(record, current)) {
      next.set(sessionId, record);
    }
  }
  return next;
}

function asUnavailable(error, message) {
  if (error?.code === RETRY_STORE_UNAVAILABLE) return error;
  return createUnavailableError(message, error);
}

/**
 * @param {object} [options]
 * @param {string} [options.filePath]
 * @param {typeof fs} [options.fs]
 * @param {number} [options.maxRecords]
 * @param {number} [options.maxBytes]
 * @param {number} [options.lockTimeoutMs]
 * @param {number} [options.lockPollMs]
 * @param {number} [options.staleLockMs]
 * @param {() => number} [options.now]
 * @param {(durationMs: number) => void} [options.sleepSync]
 * @param {(pid: number) => boolean} [options.isProcessAlive]
 */
export function createPendingRetryStore(options = {}) {
  const filePath = typeof options.filePath === 'string' && options.filePath.trim()
    ? path.resolve(options.filePath.trim())
    : resolvePendingRetryStorePath();
  const fsImpl = options.fs || fs;
  const maxRecords = Number.isFinite(options.maxRecords) && options.maxRecords > 0
    ? Math.min(MAX_PENDING_RETRY_RECORDS, Math.max(1, Math.floor(options.maxRecords)))
    : MAX_PENDING_RETRY_RECORDS;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.min(MAX_PENDING_RETRY_STORE_BYTES, Math.max(1, Math.floor(options.maxBytes)))
    : MAX_PENDING_RETRY_STORE_BYTES;
  const lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) && options.lockTimeoutMs >= 0
    ? Math.min(MAX_LOCK_TIMEOUT_MS, Math.floor(options.lockTimeoutMs))
    : DEFAULT_LOCK_TIMEOUT_MS;
  const lockPollMs = Number.isFinite(options.lockPollMs) && options.lockPollMs > 0
    ? Math.min(MAX_LOCK_POLL_MS, Math.max(1, Math.floor(options.lockPollMs)))
    : DEFAULT_LOCK_POLL_MS;
  const staleLockMs = Number.isFinite(options.staleLockMs) && options.staleLockMs >= 0
    ? Math.max(MIN_STALE_LOCK_MS, Math.floor(options.staleLockMs))
    : DEFAULT_STALE_LOCK_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sleepSync = typeof options.sleepSync === 'function' ? options.sleepSync : defaultSleepSync;
  const isProcessAlive = typeof options.isProcessAlive === 'function'
    ? options.isProcessAlive
    : defaultIsProcessAlive;
  const directory = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  const lockOwnerPath = path.join(lockPath, 'owner.json');

  /** @type {Map<string, Record<string, unknown>>} */
  let records = new Map();
  let loaded = false;
  let temporaryCounter = 0;

  function cloneRecords(map = records) {
    return Array.from(map.values(), cloneRecord);
  }

  // Read metadata and bytes from one descriptor. Only open-time ENOENT is absence.
  function readSnapshot() {
    let fd;
    try {
      fd = fsImpl.openSync(filePath, READ_FLAGS);
    } catch (error) {
      if (error?.code === 'ENOENT') return { records: new Map(), exists: false };
      throw error;
    }

    try {
      const before = fsImpl.fstatSync(fd);
      const size = Number(before.size);
      if (!before.isFile() || !Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
        throw createUnavailableError(`Pending retry journal exceeds ${maxBytes} bytes or is not a file`);
      }
      if (process.platform !== 'win32') {
        if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
          throw createUnavailableError('Pending retry journal has the wrong owner');
        }
        if ((before.mode & 0o7777) !== 0o600) {
          throw createUnavailableError('Pending retry journal must have mode 0600');
        }
      }

      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const read = fsImpl.readSync(fd, bytes, offset, size - offset, offset);
        if (!Number.isInteger(read) || read <= 0) {
          throw createUnavailableError('Pending retry journal ended during read');
        }
        offset += read;
      }
      const after = fsImpl.fstatSync(fd);
      if (
        Number(after.size) !== size
        || Number(after.mtimeMs) !== Number(before.mtimeMs)
        || Number(after.ctimeMs) !== Number(before.ctimeMs)
      ) {
        throw createUnavailableError('Pending retry journal changed during read');
      }

      let raw;
      try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (error) {
        throw createUnavailableError('Pending retry journal is not valid UTF-8', error);
      }
      const payload = JSON.parse(raw);
      if (
        !hasExactPersistedEnvelope(payload)
        || payload.version !== PENDING_RETRY_STORE_VERSION
        || !Array.isArray(payload.retries)
      ) {
        throw createUnavailableError('Pending retry journal has an unsupported or invalid payload');
      }
      return {
        records: sanitizeRecordMap(payload.retries, maxRecords, { strict: true }),
        exists: true,
      };
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  function writeAll(fd, bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const written = fsImpl.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(written) || written <= 0) {
        throw createUnavailableError('Pending retry journal temp write made no progress');
      }
      offset += written;
    }
  }

  function syncParentDirectory() {
    let fd;
    try {
      fd = fsImpl.openSync(directory, DIRECTORY_READ_FLAGS);
    } catch (error) {
      if (isUnsupportedDirectorySyncError(error)) return;
      throw error;
    }
    try {
      try {
        fsImpl.fsyncSync(fd);
      } catch (error) {
        if (!isUnsupportedDirectorySyncError(error)) throw error;
      }
    } finally {
      fsImpl.closeSync(fd);
    }
  }

  function serializeSnapshot(snapshot) {
    const payload = {
      version: PENDING_RETRY_STORE_VERSION,
      retries: Array.from(snapshot.values()),
    };
    const serialized = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    if (serialized.byteLength > maxBytes) {
      throw createUnavailableError(`Pending retry journal exceeds ${maxBytes} bytes`);
    }
    return serialized;
  }

  // Restore visible disk authority if durability fails after rename.
  function restorePreviousSnapshot(previous, previousExists) {
    if (!previousExists) {
      try {
        fsImpl.unlinkSync(filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      syncParentDirectory();
      return;
    }

    const serialized = serializeSnapshot(previous);
    temporaryCounter += 1;
    const rollbackTemporary = `${filePath}.${process.pid}.${now()}.${temporaryCounter}.rollback.tmp`;
    let rollbackFd = null;
    try {
      rollbackFd = fsImpl.openSync(rollbackTemporary, TEMP_WRITE_FLAGS, 0o600);
      chmodSecureSync(fsImpl, rollbackTemporary, 0o600);
      writeAll(rollbackFd, serialized);
      fsImpl.fsyncSync(rollbackFd);
      fsImpl.closeSync(rollbackFd);
      rollbackFd = null;
      fsImpl.renameSync(rollbackTemporary, filePath);
      syncParentDirectory();
    } finally {
      if (rollbackFd !== null) {
        try {
          fsImpl.closeSync(rollbackFd);
        } catch {
          // Preserve the rollback failure.
        }
      }
      try {
        fsImpl.unlinkSync(rollbackTemporary);
      } catch {
        // The rollback temp may already have been renamed.
      }
    }
  }

  function persistSnapshot(next, previous, previousExists) {
    const serialized = serializeSnapshot(next);

    temporaryCounter += 1;
    const temporary = `${filePath}.${process.pid}.${now()}.${temporaryCounter}.tmp`;
    let temporaryFd = null;
    let renamed = false;

    try {
      fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSecureSync(fsImpl, directory, 0o700);
      temporaryFd = fsImpl.openSync(temporary, TEMP_WRITE_FLAGS, 0o600);
      chmodSecureSync(fsImpl, temporary, 0o600);
      writeAll(temporaryFd, serialized);
      fsImpl.fsyncSync(temporaryFd);
      fsImpl.closeSync(temporaryFd);
      temporaryFd = null;
      fsImpl.renameSync(temporary, filePath);
      renamed = true;
      syncParentDirectory();
    } catch (error) {
      let rollbackError;
      if (renamed) {
        try {
          restorePreviousSnapshot(previous, previousExists);
        } catch (restoreError) {
          rollbackError = restoreError;
        }
      }
      if (temporaryFd !== null) {
        try {
          fsImpl.closeSync(temporaryFd);
        } catch {
          // Preserve the operation failure; cleanup below remains best-effort.
        }
      }
      try {
        fsImpl.unlinkSync(temporary);
      } catch {
        // The temp file may not have been created or may already have moved.
      }
      const unavailable = asUnavailable(error, 'Pending retry journal could not be persisted');
      if (rollbackError !== undefined) unavailable.rollbackCause = rollbackError;
      throw unavailable;
    }
  }

  function readLockOwner(ownerFilePath = lockOwnerPath) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(ownerFilePath, 'utf8'));
      if (
        !parsed
        || typeof parsed !== 'object'
        || !Number.isInteger(parsed.pid)
        || parsed.pid <= 0
        || typeof parsed.token !== 'string'
        || !parsed.token
      ) {
        return null;
      }
      return { pid: parsed.pid, token: parsed.token };
    } catch {
      return null;
    }
  }

  function reclaimStaleLock() {
    let stats;
    try {
      stats = fsImpl.lstatSync(lockPath);
    } catch (error) {
      return error?.code === 'ENOENT';
    }
    if (!stats.isDirectory() || now() - Number(stats.mtimeMs) < staleLockMs) return false;

    const owner = readLockOwner();
    if (owner && isProcessAlive(owner.pid)) return false;

    // Re-check immediately before the atomic move so an observed owner change
    // is never reclaimed from underneath a newly acquired lock.
    const latestOwner = readLockOwner();
    if ((owner?.token || null) !== (latestOwner?.token || null)) return false;
    let latestStats;
    try {
      latestStats = fsImpl.lstatSync(lockPath);
    } catch {
      return false;
    }
    if (
      !latestStats.isDirectory()
      || Number(latestStats.dev) !== Number(stats.dev)
      || Number(latestStats.ino) !== Number(stats.ino)
      || Number(latestStats.mtimeMs) !== Number(stats.mtimeMs)
    ) {
      return false;
    }
    const quarantine = `${lockPath}.stale.${process.pid}.${now()}.${++lockTokenCounter}`;
    try {
      fsImpl.renameSync(lockPath, quarantine);
    } catch (error) {
      return error?.code === 'ENOENT';
    }
    try {
      fsImpl.rmSync(quarantine, { recursive: true, force: true });
    } catch {
      // The stale lock no longer blocks acquisition; quarantine cleanup is
      // bounded and best-effort.
    }
    return true;
  }

  function acquireMutationLock() {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSecureSync(fsImpl, directory, 0o700);
    const startedAt = now();
    while (true) {
      const token = `${process.pid}-${startedAt}-${++lockTokenCounter}`;
      try {
        fsImpl.mkdirSync(lockPath, { mode: 0o700 });
        chmodSecureSync(fsImpl, lockPath, 0o700);
        try {
          fsImpl.writeFileSync(lockOwnerPath, JSON.stringify({
            pid: process.pid,
            token,
            createdAt: now(),
          }), { mode: 0o600, flag: 'wx' });
          chmodSecureSync(fsImpl, lockOwnerPath, 0o600);
        } catch (error) {
          try {
            fsImpl.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // The acquisition error is authoritative.
          }
          throw error;
        }
        return token;
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw asUnavailable(error, 'Pending retry journal lock could not be acquired');
        }
      }

      if (reclaimStaleLock()) continue;
      const elapsed = now() - startedAt;
      if (elapsed >= lockTimeoutMs) {
        throw createUnavailableError('Pending retry journal lock acquisition timed out');
      }
      sleepSync(Math.min(lockPollMs, lockTimeoutMs - elapsed));
    }
  }

  function releaseMutationLock(token) {
    const owner = readLockOwner();
    if (!owner || owner.token !== token || owner.pid !== process.pid) {
      throw createUnavailableError('Pending retry journal lock ownership was lost');
    }
    try {
      fsImpl.rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      throw asUnavailable(error, 'Pending retry journal lock could not be released');
    }
  }

  /**
   * @param {(latest: Map<string, Record<string, unknown>>) => {
   *   next: Map<string, Record<string, unknown>>,
   *   persist: boolean,
   *   result: unknown,
   * }} mutate
   */
  function runLockedMutation(mutate) {
    ensureLoaded();
    const token = acquireMutationLock();
    let outcome;
    try {
      let latest;
      try {
        latest = readSnapshot();
      } catch (error) {
        throw asUnavailable(error, 'Pending retry journal could not be reloaded for mutation');
      }
      outcome = mutate(latest.records);
      if (outcome.persist) persistSnapshot(outcome.next, latest.records, latest.exists);
    } finally {
      releaseMutationLock(token);
    }
    records = outcome.next;
    return outcome.result;
  }

  function parseExpectedGeneration(mutationOptions) {
    if (
      !mutationOptions
      || !Object.prototype.hasOwnProperty.call(mutationOptions, 'expectedGeneration')
    ) {
      return { provided: false, value: undefined };
    }
    const value = mutationOptions.expectedGeneration;
    if (value === null) return { provided: true, value: null };
    if (!Number.isSafeInteger(value) || value < 0) {
      throw createUnavailableError('expectedGeneration must be a nonnegative integer or null');
    }
    return { provided: true, value };
  }

  function generationMatches(current, expectation) {
    if (!expectation.provided) return true;
    if (expectation.value === null) return !current;
    return current?.generation === expectation.value;
  }

  function init() {
    if (loaded) return { records: cloneRecords() };
    let next;
    try {
      next = readSnapshot().records;
    } catch (error) {
      throw asUnavailable(error, 'Pending retry journal could not be loaded');
    }
    records = next;
    loaded = true;
    return { records: cloneRecords() };
  }

  function ensureLoaded() {
    if (!loaded) init();
  }

  function get(sessionId) {
    ensureLoaded();
    const key = sanitizeAuthorityId(sessionId, MAX_SESSION_ID_LENGTH);
    if (!key) return null;
    const record = records.get(key);
    return record ? cloneRecord(record) : null;
  }

  function list() {
    ensureLoaded();
    return cloneRecords();
  }

  function put(raw, mutationOptions) {
    const record = sanitizePendingRetryRecord(raw);
    if (!record) {
      throw createUnavailableError('Pending retry record is invalid');
    }
    const sessionId = /** @type {string} */ (record.sessionId);
    const expectation = parseExpectedGeneration(mutationOptions);
    return runLockedMutation((latest) => {
      const current = latest.get(sessionId);
      // Generation conflicts and stale/tied writes are deterministic no-ops.
      if (!generationMatches(current, expectation) || (current && !isNewerDuplicate(record, current))) {
        return {
          next: latest,
          persist: false,
          result: current ? cloneRecord(current) : null,
        };
      }
      if (!current && latest.size >= maxRecords) {
        throw createUnavailableError(`Pending retry journal is at its ${maxRecords}-record capacity`);
      }
      const next = new Map(latest);
      next.set(sessionId, record);
      return { next, persist: true, result: cloneRecord(record) };
    });
  }

  function deleteRecord(sessionId, mutationOptions) {
    const key = sanitizeAuthorityId(sessionId, MAX_SESSION_ID_LENGTH);
    if (!key) return false;
    const expectation = parseExpectedGeneration(mutationOptions);
    return runLockedMutation((latest) => {
      const current = latest.get(key);
      if (!current || !generationMatches(current, expectation)) {
        return { next: latest, persist: false, result: false };
      }
      const next = new Map(latest);
      next.delete(key);
      return { next, persist: true, result: true };
    });
  }

  function replace(input) {
    if (!Array.isArray(input)) {
      throw createUnavailableError('Pending retry replacement must be an array');
    }
    const requested = sanitizeRecordMap(input, maxRecords);
    ensureLoaded();
    const baseline = new Map(records);
    return runLockedMutation((latest) => {
      const next = new Map(latest);

      // Remove only records this instance actually observed and that have not
      // changed since. Concurrent additions and newer generations are unrelated
      // authority and survive a stale full-map replacement.
      for (const [sessionId, baselineRecord] of baseline) {
        if (requested.has(sessionId)) continue;
        const latestRecord = latest.get(sessionId);
        if (latestRecord && isDeepStrictEqual(latestRecord, baselineRecord)) {
          next.delete(sessionId);
        }
      }

      for (const [sessionId, requestedRecord] of requested) {
        const baselineRecord = baseline.get(sessionId);
        const latestRecord = latest.get(sessionId);
        if (baselineRecord && !latestRecord) {
          // Another process deleted an observed record; stale replace must not
          // resurrect it.
          continue;
        }
        if (latestRecord && !isNewerDuplicate(requestedRecord, latestRecord)) {
          if (!isDeepStrictEqual(requestedRecord, latestRecord)) continue;
        }
        next.set(sessionId, requestedRecord);
      }

      if (next.size > maxRecords) {
        throw createUnavailableError(`Pending retry journal exceeds ${maxRecords} records`);
      }
      return {
        next,
        persist: true,
        result: cloneRecords(next),
      };
    });
  }

  return {
    init,
    get,
    list,
    put,
    delete: deleteRecord,
    replace,
  };
}

const pendingRetryStore = createPendingRetryStore();

export function initPendingRetryStore() {
  return pendingRetryStore.init();
}

export function getPendingRetry(sessionId) {
  return pendingRetryStore.get(sessionId);
}

export function listPendingRetries() {
  return pendingRetryStore.list();
}

export function putPendingRetry(record, options) {
  return pendingRetryStore.put(record, options);
}

export function deletePendingRetry(sessionId, options) {
  return pendingRetryStore.delete(sessionId, options);
}

export function replacePendingRetries(records) {
  return pendingRetryStore.replace(records);
}
