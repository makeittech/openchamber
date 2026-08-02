import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerShutdown, stopInProcessServer } from './server-shutdown.mjs';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test('waits for web stop before exiting', async () => {
  const order = [];
  const stop = deferred();
  const quit = stopInProcessServer({
    handle: { stop: () => { order.push('stop-called'); return stop.promise; } },
    launchFallback: () => order.push('fallback'),
  });
  order.push('after-call');
  stop.resolve();
  await quit;
  order.push('exit');
  assert.deepEqual(order, ['stop-called', 'after-call', 'exit']);
});

test('shares one stop promise across duplicate quit and signal paths', async () => {
  const pending = deferred();
  let calls = 0;
  const shutdown = createServerShutdown({
    getHandle: () => ({ stop: () => { calls += 1; return pending.promise; } }),
  });

  const quit = shutdown();
  const signal = shutdown();
  assert.equal(quit, signal);
  pending.resolve();
  await quit;
  assert.equal(calls, 1);
});

test('passes exitProcess false and only launches fallback for managed OpenCode', async () => {
  const stopOptions = [];
  const fallbacks = [];
  const errors = [];
  await stopInProcessServer({
    handle: {
      getOpenCodeProcessInfo: () => ({ managed: false, pid: 12, port: 4096 }),
      stop: (options) => { stopOptions.push(options); throw new Error('failed'); },
    },
    launchFallback: (info) => fallbacks.push(info),
    logger: { warn: (...args) => errors.push(args) },
  });
  assert.deepEqual(stopOptions, [{ exitProcess: false }]);
  assert.deepEqual(fallbacks, []);
  assert.equal(errors.length, 1);

  await stopInProcessServer({
    handle: {
      getOpenCodeProcessInfo: () => ({ managed: true, pid: 34, port: 4097 }),
      stop: () => Promise.reject(new Error('failed')),
    },
    launchFallback: (info) => fallbacks.push(info),
    logger: { warn: () => {} },
  });
  assert.deepEqual(fallbacks, [{ managed: true, pid: 34, port: 4097 }]);
});

test('timeout logs, launches the managed fallback, and permits exit', async () => {
  const warnings = [];
  const fallbacks = [];
  await stopInProcessServer({
    handle: {
      getOpenCodeProcessInfo: () => ({ managed: true, pid: 56, port: 4098 }),
      stop: () => new Promise(() => {}),
    },
    timeoutMs: 1,
    launchFallback: (info) => fallbacks.push(info),
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(warnings.length, 1);
  assert.deepEqual(fallbacks, [{ managed: true, pid: 56, port: 4098 }]);
});

test('confirmed quit, hard signal, and updater can await the same shutdown', async () => {
  const pending = deferred();
  let calls = 0;
  const shutdown = createServerShutdown({
    getHandle: () => ({ stop: () => { calls += 1; return pending.promise; } }),
  });
  const confirmedQuit = shutdown();
  const hardSignal = shutdown();
  const updater = shutdown();
  pending.resolve();
  await Promise.all([confirmedQuit, hardSignal, updater]);
  assert.equal(calls, 1);
});
