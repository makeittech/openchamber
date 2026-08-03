import { computeNextAttempt, nextTimerChunk } from './retry-policy.js';

const MAX_CONCURRENCY = 2;
const BLOCKED_REASON_UNSAFE = 'recoverable-unsafe';
const MESSAGE_WAITING = 'claude-session-limit';
const MESSAGE_BLOCKED = 'claude-recovery-blocked';

/**
 * @param {object} deps
 * @param {{ init: Function, get: (id: string) => any, list: () => any[], put: (record: any, opts?: any) => any, delete: (id: string, opts?: any) => boolean, replace?: Function }} deps.store
 * @param {() => number} deps.now
 * @param {(fn: () => void, delayMs: number) => any} deps.setTimer
 * @param {(handle: any) => void} deps.clearTimer
 * @param {(params: { foreignSessionId: string, expectedTailUuid: string, launchUuid?: string }) => Promise<{ safe: boolean, fingerprints?: any[], reason?: string, tailPresent?: boolean }>} deps.inspectTranscript
 * @param {(params: { record: any, toolGuard: any, signal: AbortSignal }) => Promise<{ outcome: 'success' | 'rate-limit' | 'error' | 'blocked', terminal?: any }>} deps.launchRecovery
 * @param {(sessionId: string, directory: string, status: object) => void} deps.emitStatus
 * @param {(sessionId: string) => Promise<'exists' | 'deleted' | 'unknown'>} deps.sessionExists
 */
export function createHarnessRetryRuntime(deps) {
  const {
    store,
    setTimer,
    clearTimer,
    inspectTranscript,
    launchRecovery,
    emitStatus,
    sessionExists,
  } = deps;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;

  let wakeTimer = null;
  let activeLaunches = 0;
  /** @type {Map<string, AbortController>} */
  const cancelControllers = new Map();
  let stopped = false;
  let generationSeed = 0;

  function nextGeneration() {
    generationSeed += 1;
    return generationSeed;
  }

  function makeRecord(observation) {
    const sessionId = observation.sessionId;
    return {
      sessionId,
      directory: observation.directory,
      foreignSessionId: observation.foreignSessionId,
      target: observation.target,
      agentsMode: observation.agentsMode,
      agentName: observation.agentName,
      claudeAgentName: observation.claudeAgentName,
      state: 'observed',
      generation: nextGeneration(),
      attempt: observation.attempt || 1,
      rateLimitType: observation.rateLimitType,
      resetAt: observation.resetAt || 0,
      rateLimitAssistantUuid: observation.assistantUuid,
      expectedTailUuid: observation.expectedTailUuid || observation.assistantUuid,
      launchUuid: undefined,
      createdAt: now(),
      updatedAt: now(),
      blockedReason: undefined,
      nextAttemptAt: 0,
    };
  }

  function computeDeadline(record) {
    const compute = computeNextAttempt(
      { resetAt: record.resetAt || undefined, attempt: record.attempt, sessionId: record.sessionId },
      { now: now() },
    );
    if (compute.blocked) return null;
    return compute.nextAttemptAt;
  }

  function emitRetry(record, deadline) {
    const status = {
      type: 'retry',
      attempt: record.attempt,
      message: deadline === null ? MESSAGE_BLOCKED : MESSAGE_WAITING,
    };
    if (deadline !== null) {
      status.next = deadline;
    }
    emitStatus(record.sessionId, record.directory, status);
  }

  function emitIdle(sessionId, directory) {
    emitStatus(sessionId, directory, { type: 'idle' });
  }

  function clearWakeTimer() {
    if (wakeTimer === null) return;
    clearTimer(wakeTimer);
    wakeTimer = null;
  }

  async function inspect(record) {
    try {
      return await inspectTranscript({
        foreignSessionId: record.foreignSessionId,
        expectedTailUuid: record.expectedTailUuid,
        launchUuid: record.launchUuid,
      });
    } catch {
      return { safe: false, reason: 'transcript-unreadable' };
    }
  }

  function resetLaunchingRecord(record) {
    const waiting = {
      ...record,
      state: 'waiting',
      launchUuid: undefined,
      updatedAt: now(),
    };
    waiting.nextAttemptAt = computeDeadline(waiting) || (now() + 5000);
    try {
      store.put(waiting, { expectedGeneration: record.generation });
    } catch {
      // A failed rewrite leaves the existing durable launch authoritative.
    }
  }

  function armWake() {
    if (stopped) return;
    clearWakeTimer();
    const waiting = store.list().filter((record) => (
      (record.state === 'waiting' || record.state === 'observed')
      && record.nextAttemptAt > 0
    ));
    if (waiting.length === 0) return;
    const earliest = waiting.reduce((min, r) => (r.nextAttemptAt < min.nextAttemptAt ? r : min));
    const delay = nextTimerChunk(earliest.nextAttemptAt, now());
    wakeTimer = setTimer(() => {
      wakeTimer = null;
      return onWake();
    }, Math.max(0, delay));
  }

  async function onWake() {
    if (stopped) return;
    const capacity = Math.max(0, MAX_CONCURRENCY - activeLaunches);
    const due = store.list()
      .filter((r) => r.state === 'waiting' && r.nextAttemptAt <= now())
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
      .slice(0, capacity);
    await Promise.all(due.map((record) => launchCycle(record)));
    armWake();
  }

  async function launchCycle(record) {
    if (stopped) return;
    const fresh = store.get(record.sessionId);
    if (!fresh || fresh.state !== 'waiting' || fresh.generation !== record.generation) return;

    const launchingRecord = {
      ...fresh,
      state: 'launching',
      generation: fresh.generation + 1,
      launchUuid: `${fresh.sessionId}:${fresh.generation + 1}`,
      updatedAt: now(),
    };
    let putResult;
    try {
      putResult = store.put(launchingRecord, { expectedGeneration: fresh.generation });
    } catch {
      armWake();
      return;
    }
    if (
      !putResult
      || putResult.generation !== launchingRecord.generation
      || putResult.state !== 'launching'
    ) {
      armWake();
      return;
    }

    const launchGen = putResult.generation;
    const controller = new AbortController();
    cancelControllers.set(record.sessionId, controller);
    activeLaunches += 1;

    try {
      const inspection = await inspect(putResult);

      const afterInspect = store.get(record.sessionId);
      if (!afterInspect || afterInspect.generation !== launchGen) return;

      if (!inspection.safe) {
        const blockedRecord = {
          ...putResult,
          state: 'blocked',
          generation: launchGen + 1,
          blockedReason: inspection.reason || BLOCKED_REASON_UNSAFE,
          updatedAt: now(),
        };
        try {
          const persisted = store.put(blockedRecord, { expectedGeneration: launchGen });
          if (persisted?.generation !== blockedRecord.generation) return;
        } catch {
          // ignore
        }
        emitRetry(putResult, null);
        return;
      }

      let toolGuard = null;
      try {
        toolGuard = Array.isArray(inspection.fingerprints) && inspection.fingerprints.length > 0
          ? inspection.fingerprints
          : null;
      } catch {
        toolGuard = null;
      }

      let outcome;
      let terminal;
      try {
        const result = await launchRecovery({
          record: putResult,
          toolGuard,
          signal: controller.signal,
        });
        outcome = result?.outcome;
        terminal = result?.terminal;
      } catch {
        outcome = 'error';
      }

      const afterLaunch = store.get(record.sessionId);
      if (!afterLaunch || afterLaunch.generation !== launchGen) return;

      if (outcome === 'success') {
        store.delete(record.sessionId, { expectedGeneration: launchGen });
        emitIdle(record.sessionId, record.directory);
      } else if (outcome === 'rate-limit' && terminal) {
        const retryRecord = {
          ...afterLaunch,
          state: 'waiting',
          generation: launchGen + 1,
          attempt: (afterLaunch.attempt || 1) + 1,
          rateLimitType: terminal.rateLimitType || afterLaunch.rateLimitType,
          resetAt: terminal.resetAt || afterLaunch.resetAt,
          rateLimitAssistantUuid: terminal.assistantUuid || afterLaunch.rateLimitAssistantUuid,
          expectedTailUuid: terminal.assistantUuid || afterLaunch.expectedTailUuid,
          launchUuid: undefined,
          blockedReason: undefined,
          updatedAt: now(),
        };
        retryRecord.nextAttemptAt = computeDeadline(retryRecord) || 0;
        try {
          store.put(retryRecord, { expectedGeneration: launchGen });
        } catch {
          // ignore
        }
        emitRetry(retryRecord, retryRecord.nextAttemptAt);
      } else {
        store.delete(record.sessionId, { expectedGeneration: launchGen });
        emitIdle(record.sessionId, record.directory);
      }
    } finally {
      cancelControllers.delete(record.sessionId);
      activeLaunches -= 1;
    }
  }

  /**
   * Schedule a confirmed rate-limit observation from the mapper terminal.
   * Synchronous: persists before emitting so the translator cannot claim
   * recovery exists when persistence failed.
   */
  function schedule(observation) {
    if (stopped) return;
    const existing = store.get(observation.sessionId);
    if (
      existing
      && existing.rateLimitAssistantUuid === observation.assistantUuid
      && existing.attempt === (observation.attempt || 1)
    ) {
      return;
    }
    const record = makeRecord(observation);
    if (existing) {
      record.generation = existing.generation + 1;
    }
    record.state = 'waiting';

    let deadline;
    try {
      deadline = computeDeadline(record);
    } catch {
      deadline = 0;
    }
    record.nextAttemptAt = deadline || 0;

    const putResult = store.put(record, existing
      ? { expectedGeneration: existing.generation }
      : { expectedGeneration: null });
    if (!putResult || putResult.generation !== record.generation) {
      return;
    }

    emitRetry(record, deadline);
    armWake();
  }

  async function cancel(sessionId) {
    const existing = store.get(sessionId);
    if (!existing) {
      return null;
    }
    abortLaunch(sessionId);
    store.delete(sessionId);
    if (existing.directory) {
      emitIdle(sessionId, existing.directory);
    }
    return { aborted: true };
  }

  async function deleteSession(sessionId, options = {}) {
    const existing = store.get(sessionId);
    if (!existing) return null;
    let state = options.authoritative === true ? 'missing' : 'unknown';
    if (options.authoritative !== true) {
      try {
        state = await sessionExists(sessionId);
      } catch {
        state = 'unknown';
      }
    }
    if (state === 'unknown' || state === 'exists') return null;
    abortLaunch(sessionId);
    store.delete(sessionId);
    clearWakeTimer();
    armWake();
    return { removed: true };
  }

  function hasPending(sessionId) {
    return store.get(sessionId) != null;
  }

  function abortLaunch(sessionId) {
    try {
      cancelControllers.get(sessionId)?.abort();
    } catch {
      // Abort is best-effort; deleting the durable obligation remains authoritative.
    }
    cancelControllers.delete(sessionId);
  }

  function listPendingForStatus() {
    const result = {};
    for (const record of store.list()) {
      if (!['waiting', 'launching', 'observed', 'blocked'].includes(record.state)) continue;
      const status = {
        type: 'retry',
        attempt: record.attempt,
        message: record.state === 'blocked' ? MESSAGE_BLOCKED : MESSAGE_WAITING,
      };
      if (record.state !== 'blocked' && record.nextAttemptAt) status.next = record.nextAttemptAt;
      result[record.sessionId] = status;
    }
    return result;
  }

  async function start() {
    stopped = false;
    const records = store.list();
    for (const record of records) {
      if (record.state === 'launching') {
        const inspection = await inspect(record);
        if (inspection.safe && inspection.tailPresent) {
          store.delete(record.sessionId, { expectedGeneration: record.generation });
          continue;
        }
        resetLaunchingRecord(record);
      }
      const fresh = store.get(record.sessionId);
      if (fresh) {
        emitRetry(fresh, fresh.nextAttemptAt || null);
      }
    }
    armWake();
  }

  function stop() {
    stopped = true;
    clearWakeTimer();
    for (const record of store.list()) {
      if (record.state === 'launching') resetLaunchingRecord(record);
    }
    for (const sessionId of cancelControllers.keys()) {
      abortLaunch(sessionId);
    }
    cancelControllers.clear();
  }

  return {
    schedule,
    cancel,
    deleteSession,
    stop,
    start,
    hasPending,
    listPendingForStatus,
  };
}
