/**
 * Durable retry scheduler runtime for Claude session-limit auto-resume.
 *
 * Consumes the pending-retry store (persistence), retry-policy (deadlines),
 * and recovery-transcript (safety analysis). Uses record generations as
 * compare-and-swap ownership around every asynchronous boundary so stale
 * callbacks/finalizers cannot reinstall canceled or superseded work.
 *
 * One earliest-deadline wake timer is maintained (long waits chunked via
 * `nextTimerChunk`). Bounded concurrency of 2. Failure to persist on schedule
 * rejects (the translator must not claim automatic recovery exists).
 */

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
  const store = deps.store;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const setTimer = deps.setTimer;
  const clearTimer = deps.clearTimer;
  const inspectTranscript = deps.inspectTranscript;
  const launchRecovery = deps.launchRecovery;
  const emitStatus = deps.emitStatus;
  const sessionExists = deps.sessionExists;

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

  function armWake() {
    if (stopped) return;
    if (wakeTimer !== null) {
      clearTimer(wakeTimer);
      wakeTimer = null;
    }
    const records = store.list().filter((r) => r.state === 'waiting' || r.state === 'observed');
    const waiting = records.filter((r) => r.nextAttemptAt && r.nextAttemptAt > 0);
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
    // CAS: transition to launching only if still waiting
    const fresh = store.get(record.sessionId);
    if (!fresh || fresh.state !== 'waiting') return;
    if (fresh.generation !== record.generation) return;

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
      // persistence failure -> remain waiting, re-arm
      armWake();
      return;
    }
    if (
      !putResult
      || putResult.generation !== launchingRecord.generation
      || putResult.state !== 'launching'
    ) {
      // CAS failed (stale) -> do not launch
      armWake();
      return;
    }

    const launchGen = putResult.generation;
    const controller = new AbortController();
    cancelControllers.set(record.sessionId, controller);
    activeLaunches += 1;

    try {
      // Safety check the transcript
      let inspection;
      try {
        inspection = await inspectTranscript({
          foreignSessionId: putResult.foreignSessionId,
          expectedTailUuid: putResult.expectedTailUuid,
          launchUuid: putResult.launchUuid,
        });
      } catch {
        inspection = { safe: false, reason: 'transcript-unreadable' };
      }

      // Re-check generation after async
      const afterInspect = store.get(record.sessionId);
      if (!afterInspect || afterInspect.generation !== launchGen) {
        return; // canceled/superseded
      }

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
        emitRetry({ ...putResult, attempt: putResult.attempt }, null);
        return;
      }

      let toolGuard = null;
      try {
        toolGuard = inspection.fingerprints ? createRecoveryToolGuardAdapter(inspection.fingerprints) : null;
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
      } catch (error) {
        outcome = 'error';
      }

      // Re-check generation after async launch
      const afterLaunch = store.get(record.sessionId);
      if (!afterLaunch || afterLaunch.generation !== launchGen) {
        return; // canceled/superseded
      }

      if (outcome === 'success') {
        store.delete(record.sessionId, { expectedGeneration: launchGen });
        emitIdle(record.sessionId, record.directory);
      } else if (outcome === 'rate-limit' && terminal) {
        const retryRecord = {
          ...afterLaunch,
          state: 'observed',
          generation: launchGen + 1,
          attempt: (afterLaunch.attempt || 1) + 1,
          rateLimitType: terminal.rateLimitType || afterLaunch.rateLimitType,
          resetAt: terminal.resetAt || afterLaunch.resetAt,
          rateLimitAssistantUuid: terminal.assistantUuid || afterLaunch.rateLimitAssistantUuid,
          expectedTailUuid: terminal.assistantUuid || afterLaunch.expectedTailUuid,
          launchUuid: undefined,
          blockedReason: undefined,
          stateUpdatedAt: now(),
          updatedAt: now(),
        };
        retryRecord.state = 'waiting';
        retryRecord.nextAttemptAt = computeDeadline(retryRecord) || 0;
        try {
          store.put(retryRecord, { expectedGeneration: launchGen });
        } catch {
          // ignore
        }
        emitRetry(retryRecord, retryRecord.nextAttemptAt);
      } else {
        // error or unknown outcome
        store.delete(record.sessionId, { expectedGeneration: launchGen });
        emitIdle(record.sessionId, record.directory);
      }
    } finally {
      cancelControllers.delete(record.sessionId);
      activeLaunches -= 1;
      // The wake loop re-arms after all launches in this batch settle.
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

    let putResult;
    try {
      putResult = store.put(record, existing
        ? { expectedGeneration: existing.generation }
        : { expectedGeneration: null });
    } catch (error) {
      // propagation failure -> the translator must not claim automatic recovery
      throw error;
    }
    if (!putResult || putResult.generation !== record.generation) {
      return; // CAS no-op
    }

    emitRetry(record, deadline);
    armWake();
  }

  async function cancel(sessionId) {
    const existing = store.get(sessionId);
    if (!existing) {
      return null;
    }
    // Abort any active launch
    const controller = cancelControllers.get(sessionId);
    if (controller) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    cancelControllers.delete(sessionId);
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
    if (state === 'unknown') {
      return null; // preserve
    }
    if (state === 'exists') {
      return null; // no-op
    }
    // deleted
    const controller = cancelControllers.get(sessionId);
    if (controller) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
    cancelControllers.delete(sessionId);
    store.delete(sessionId);
    if (wakeTimer !== null) {
      clearTimer(wakeTimer);
      wakeTimer = null;
    }
    armWake();
    return { removed: true };
  }

  function hasPending(sessionId) {
    return store.get(sessionId) != null;
  }

  function listPendingForStatus() {
    const result = {};
    for (const record of store.list()) {
      if (record.state === 'waiting' || record.state === 'launching' || record.state === 'observed') {
        const status = {
          type: 'retry',
          attempt: record.attempt,
          message: record.state === 'blocked' ? MESSAGE_BLOCKED : MESSAGE_WAITING,
        };
        if (record.nextAttemptAt) {
          status.next = record.nextAttemptAt;
        }
        result[record.sessionId] = status;
      } else if (record.state === 'blocked') {
        result[record.sessionId] = {
          type: 'retry',
          attempt: record.attempt,
          message: MESSAGE_BLOCKED,
        };
      }
    }
    return result;
  }

  async function start() {
    stopped = false;
    const records = store.list();
    for (const record of records) {
      if (record.state === 'launching') {
        // Classify persisted launching on restart via transcript
        let inspection;
        try {
          inspection = await inspectTranscript({
            foreignSessionId: record.foreignSessionId,
            expectedTailUuid: record.expectedTailUuid,
            launchUuid: record.launchUuid,
          });
        } catch {
          inspection = { safe: false, reason: 'transcript-unreadable' };
        }
        if (inspection.safe && inspection.tailPresent) {
          // Likely success -> delete
          store.delete(record.sessionId, { expectedGeneration: record.generation });
          continue;
        }
        // Otherwise: ambiguous/block or rate-limit present -> back to waiting
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
          // ignore
        }
      }
      // Seed retry status
      const fresh = store.get(record.sessionId);
      if (fresh) {
        emitRetry(fresh, fresh.nextAttemptAt || null);
      }
    }
    armWake();
  }

  function stop() {
    stopped = true;
    if (wakeTimer !== null) {
      clearTimer(wakeTimer);
      wakeTimer = null;
    }
    // Convert any launching records back to waiting for restart safety
    for (const record of store.list()) {
      if (record.state === 'launching') {
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
          // ignore
        }
      }
    }
    // Abort active launches
    for (const controller of cancelControllers.values()) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
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

/**
 * Adapter so the runtime can hand a hook function to the translator's
 * `startClaudeQuery({ hooks })` without importing recovery-transcript's
 * module-specific shape here. The translator (Task 7) wraps it.
 *
 * @param {any[]} fingerprints
 */
function createRecoveryToolGuardAdapter(fingerprints) {
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) return null;
  return fingerprints;
}
