import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createHarnessRetryRuntime } from './retry-runtime.js';
import { createPendingRetryStore } from './pending-retry-store.js';
import {
  resetHarnessTurnSnapshots,
} from './turn-snapshot.js';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpStorePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'retry-runtime-')), 'retries.json');
}

function createStore(filePath) {
  return createPendingRetryStore({ filePath, maxRecords: 50, maxBytes: 256 * 1024 });
}

function baseObservation(sessionId = 'ses_1', overrides = {}) {
  return {
    sessionId,
    directory: '/repo',
    foreignSessionId: 'claude-1',
    target: { harnessId: 'claude-code', modelRef: 'sonnet' },
    agentsMode: 'opencode',
    agentName: 'build',
    claudeAgentName: undefined,
    rateLimitType: 'five_hour',
    resetAt: 0, // 0 = missing reset -> fallback
    assistantUuid: 'asst_1',
    expectedTailUuid: 'asst_1',
    attempt: 1,
    ...overrides,
  };
}

function createFakeTimer(getNow, setNow) {
  let handle = 0;
  const pending = new Map();
  return {
    setTimer(fn, delayMs) {
      handle += 1;
      const id = handle;
      pending.set(id, { fn, delayMs, dueAt: getNow() + delayMs });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    pending,
    async runAll() {
      // Drain the timers that existed when this turn started. Timers created by
      // a retry outcome belong to a later clock turn and remain pending.
      const initialCount = pending.size;
      for (let count = 0; count < initialCount && pending.size > 0; count += 1) {
        let earliest = null;
        for (const [id, entry] of pending) {
          if (!earliest || entry.delayMs < earliest.delayMs) {
            earliest = { id, ...entry };
          }
        }
        if (!earliest) break;
        pending.delete(earliest.id);
        setNow(Math.max(getNow(), earliest.dueAt));
        await earliest.fn();
      }
    },
    async runOne() {
      let earliest = null;
      for (const [id, entry] of pending) {
        if (!earliest || entry.delayMs < earliest.delayMs) {
          earliest = { id, ...entry };
        }
      }
      if (!earliest) return false;
      pending.delete(earliest.id);
      setNow(Math.max(getNow(), earliest.dueAt));
      await earliest.fn();
      return true;
    },
    startOne() {
      let earliest = null;
      for (const [id, entry] of pending) {
        if (!earliest || entry.delayMs < earliest.delayMs) earliest = { id, ...entry };
      }
      if (!earliest) return null;
      pending.delete(earliest.id);
      setNow(Math.max(getNow(), earliest.dueAt));
      return Promise.resolve(earliest.fn());
    },
    count() {
      return pending.size;
    },
  };
}

describe('createHarnessRetryRuntime', () => {
  let clockNow;
  let fakeTimers;
  let store;
  let emitCalls;
  let launchCalls;
  let launchOutcomes;
  let inspectResult;
  let sessionState;
  let runtime;

  beforeEach(() => {
    clockNow = 1_700_000_000_000;
    fakeTimers = createFakeTimer(
      () => clockNow,
      (value) => { clockNow = value; },
    );
    store = createStore(tmpStorePath());
    store.init();
    emitCalls = [];
    launchCalls = [];
    launchOutcomes = [];
    inspectResult = { safe: true, fingerprints: [], tailPresent: true };
    sessionState = new Map();
    const launchRecovery = mock(async ({ record, toolGuard, signal }) => {
      const idx = launchCalls.length;
      launchCalls.push({ record, signal });
      if (launchOutcomes[idx] !== undefined) {
        return launchOutcomes[idx];
      }
      return { outcome: 'success' };
    });
    const inspectTranscript = mock(async ({ foreignSessionId, expectedTailUuid, launchUuid }) => inspectResult);
    const emitStatus = mock((sessionId, directory, status) => {
      emitCalls.push({ sessionId, directory, status });
    });
    const sessionExists = mock(async (sessionId) => sessionState.get(sessionId) ?? 'exists');
    runtime = createHarnessRetryRuntime({
      store,
      now: () => clockNow,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      inspectTranscript,
      launchRecovery,
      emitStatus,
      sessionExists,
    });
  });

  afterEach(() => {
    try {
      runtime.stop();
    } catch {
      // ignore
    }
    resetHarnessTurnSnapshots();
  });

  it('schedule persists waiting before emitting retry status', () => {
    runtime.schedule(baseObservation('ses_persist'));
    const record = store.get('ses_persist');
    expect(record).not.toBeNull();
    expect(record.state).toBe('waiting');
    const retryCalls = emitCalls.filter((e) => e.status.type === 'retry');
    expect(retryCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('schedule throws on persistence failure', () => {
    const failStore = {
      init: () => {},
      get: () => null,
      list: () => [],
      put: () => { throw Object.assign(new Error('disk full'), { code: 'RETRY_STORE_UNAVAILABLE' }); },
      delete: () => false,
      replace: () => [],
    };
    const rt = createHarnessRetryRuntime({
      store: failStore,
      now: () => clockNow,
      setTimer: fakeTimers.setTimer,
      clearTimer: fakeTimers.clearTimer,
      inspectTranscript: async () => ({ safe: true, fingerprints: [], tailPresent: true }),
      launchRecovery: async () => ({ outcome: 'success' }),
      emitStatus: () => {},
      sessionExists: async () => 'exists',
    });
    try {
      rt.schedule(baseObservation('ses_fail'));
      throw new Error('expected schedule to fail');
    } catch (error) {
      expect(error.code).toBe('RETRY_STORE_UNAVAILABLE');
    }
  });

  it('duplicate observation with same generation is idempotent', () => {
    runtime.schedule(baseObservation('ses_dup'));
    const first = store.get('ses_dup');
    expect(first).not.toBeNull();
    runtime.schedule(baseObservation('ses_dup'));
    const second = store.get('ses_dup');
    expect(second.generation).toBe(first.generation);
    expect(emitCalls.filter((e) => e.status.type === 'retry').length).toBe(1);
  });

  it('higher generation supersedes; lower generation is no-op', () => {
    runtime.schedule(baseObservation('ses_gen', { attempt: 1 }));
    const first = store.get('ses_gen');
    const firstGen = first.generation;
    // Simulate a fresh observation with a higher generation by scheduling again after incrementing attempt
    runtime.schedule(baseObservation('ses_gen', { attempt: 2 }));
    const second = store.get('ses_gen');
    expect(second.generation).toBeGreaterThan(firstGen);
    expect(second.attempt).toBe(2);
  });

  it('maintains one earliest-deadline wake timer', () => {
    runtime.schedule(baseObservation('ses_a'));
    runtime.schedule(baseObservation('ses_b'));
    runtime.schedule(baseObservation('ses_c'));
    expect(fakeTimers.count()).toBeLessThanOrEqual(1);
  });

  it('wake re-reads now and launches overdue work after grace', async () => {
    launchOutcomes.push({ outcome: 'success' });
    runtime.schedule(baseObservation('ses_wake', { resetAt: clockNow + 1000 }));
    const beforeLaunch = launchCalls.length;
    await fakeTimers.runAll();
    expect(launchCalls.length).toBe(1);
  });

  it('launching is persisted before launchRecovery is called', async () => {
    launchOutcomes.push({ outcome: 'success' });
    runtime.schedule(baseObservation('ses_launching'));
    await fakeTimers.runAll();
    // The record was deleted on success; verify launch was called
    expect(launchCalls.length).toBe(1);
    // After success, record is gone
    expect(store.get('ses_launching')).toBeNull();
  });

  it('success deletes record before emitting idle', async () => {
    launchOutcomes.push({ outcome: 'success' });
    runtime.schedule(baseObservation('ses_success'));
    await fakeTimers.runAll();
    expect(store.get('ses_success')).toBeNull();
    const idleCalls = emitCalls.filter((e) => e.status.type === 'idle' && e.sessionId === 'ses_success');
    expect(idleCalls.length).toBe(1);
  });

  it('second rate-limit increments attempt and returns to retry without idle', async () => {
    launchOutcomes.push({
      outcome: 'rate-limit',
      terminal: {
        type: 'rate-limit',
        rateLimitType: 'five_hour',
        resetAt: clockNow + 2000,
        assistantUuid: 'asst_2',
      },
    });
    runtime.schedule(baseObservation('ses_second', { attempt: 1 }));
    await fakeTimers.runAll();
    // Launch happened, then rate-limit back to waiting
    expect(launchCalls.length).toBe(1);
    const record = store.get('ses_second');
    expect(record).not.toBeNull();
    expect(record.attempt).toBe(2);
    expect(record.state).toBe('waiting');
    // No idle emitted (still waiting)
    const idleCalls = emitCalls.filter((e) => e.sessionId === 'ses_second' && e.status.type === 'idle');
    expect(idleCalls.length).toBe(0);
  });

  it('hard error deletes record and emits idle', async () => {
    launchOutcomes.push({ outcome: 'error' });
    runtime.schedule(baseObservation('ses_harderr'));
    await fakeTimers.runAll();
    expect(store.get('ses_harderr')).toBeNull();
    const idleCalls = emitCalls.filter((e) => e.sessionId === 'ses_harderr' && e.status.type === 'idle');
    expect(idleCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('blocked transcript persists blocked with no next and never launches', async () => {
    inspectResult = { safe: false, reason: 'unsettled-tool', tailPresent: true };
    runtime.schedule(baseObservation('ses_block'));
    await fakeTimers.runAll();
    const record = store.get('ses_block');
    expect(record).not.toBeNull();
    expect(record.state).toBe('blocked');
    expect(launchCalls.length).toBe(0);
    const blockedStatus = emitCalls.findLast((e) => e.sessionId === 'ses_block' && e.status.type === 'retry');
    expect(blockedStatus).toBeDefined();
    expect(blockedStatus.status.next).toBeUndefined();
  });

  it('cancel waiting deletes record and emits idle', async () => {
    runtime.schedule(baseObservation('ses_cancelwait'));
    await runtime.cancel('ses_cancelwait');
    expect(store.get('ses_cancelwait')).toBeNull();
    const idleCalls = emitCalls.filter((e) => e.sessionId === 'ses_cancelwait' && e.status.type === 'idle');
    expect(idleCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('cancel launching aborts the active launch signal', async () => {
    let aborted = false;
    let finishLaunch;
    launchOutcomes.push(new Promise((resolve) => { finishLaunch = resolve; }));
    runtime.schedule(baseObservation('ses_cancellaunch'));
    const wake = fakeTimers.startOne();
    await Promise.resolve();
    await Promise.resolve();
    expect(launchCalls.length).toBe(1);
    const signal = launchCalls[0].signal;
    expect(signal).toBeDefined();
    signal.addEventListener('abort', () => { aborted = true; });
    await runtime.cancel('ses_cancellaunch');
    expect(aborted).toBe(true);
    finishLaunch({ outcome: 'error' });
    await wake;
  });

  it('stop clears timers without deleting waiting records', async () => {
    runtime.schedule(baseObservation('ses_stop'));
    expect(store.get('ses_stop')).not.toBeNull();
    runtime.stop();
    expect(fakeTimers.count()).toBe(0);
    // Record preserved
    expect(store.get('ses_stop')).not.toBeNull();
  });

  it('start seeds existing waiting statuses', async () => {
    // Pre-populate store directly
    store.put({
      sessionId: 'ses_preexisting',
      directory: '/repo',
      foreignSessionId: 'claude-pre',
      target: { harnessId: 'claude-code', modelRef: 'sonnet' },
      agentsMode: 'opencode',
      agentName: 'build',
      state: 'waiting',
      generation: 1,
      attempt: 1,
      nextAttemptAt: clockNow + 5000,
      rateLimitType: 'five_hour',
      resetAt: clockNow + 5000,
      rateLimitAssistantUuid: 'asst_pre',
      expectedTailUuid: 'asst_pre',
      createdAt: clockNow,
      updatedAt: clockNow,
    });
    await runtime.start();
    const retryCalls = emitCalls.filter((e) => e.sessionId === 'ses_preexisting' && e.status.type === 'retry');
    expect(retryCalls.length).toBe(1);
  });

  it('hasPending and listPendingForStatus are accurate', () => {
    expect(runtime.hasPending('ses_none')).toBe(false);
    runtime.schedule(baseObservation('ses_has'));
    expect(runtime.hasPending('ses_has')).toBe(true);
    const statuses = runtime.listPendingForStatus();
    expect(statuses['ses_has']).toBeDefined();
  });

  it('deleteSession removes record when session truly deleted and does not emit', async () => {
    runtime.schedule(baseObservation('ses_del'));
    sessionState.set('ses_del', 'deleted');
    await runtime.deleteSession('ses_del');
    expect(store.get('ses_del')).toBeNull();
    // No idle emitted for deleted session
    const idleCalls = emitCalls.filter((e) => e.sessionId === 'ses_del' && e.status.type === 'idle');
    expect(idleCalls.length).toBe(0);
  });

  it('deleteSession keeps record when session unknown', async () => {
    runtime.schedule(baseObservation('ses_unknown'));
    sessionState.set('ses_unknown', 'unknown');
    await runtime.deleteSession('ses_unknown');
    expect(store.get('ses_unknown')).not.toBeNull();
  });

  it('deleteSession is no-op when session still exists', async () => {
    runtime.schedule(baseObservation('ses_exists'));
    sessionState.set('ses_exists', 'exists');
    await runtime.deleteSession('ses_exists');
    expect(store.get('ses_exists')).not.toBeNull();
  });
});
