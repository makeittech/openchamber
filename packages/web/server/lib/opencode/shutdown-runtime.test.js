import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGracefulShutdownRuntime } from './shutdown-runtime.js';

const createRuntime = (server, overrides = {}) => createGracefulShutdownRuntime({
  process: { exit: vi.fn() },
  shutdownTimeoutMs: 1000,
  getExitOnShutdown: () => false,
  getIsShuttingDown: () => false,
  setIsShuttingDown: vi.fn(),
  syncToHmrState: vi.fn(),
  openCodeWatcherRuntime: { stop: vi.fn() },
  sessionRuntime: { dispose: vi.fn() },
  scheduledTasksRuntime: { stop: vi.fn() },
  getHealthCheckInterval: () => null,
  clearHealthCheckInterval: vi.fn(),
  getTerminalRuntime: () => null,
  setTerminalRuntime: vi.fn(),
  getMessageStreamRuntime: () => null,
  setMessageStreamRuntime: vi.fn(),
  shouldSkipOpenCodeStop: () => true,
  getOpenCodePort: () => null,
  getOpenCodeProcess: () => null,
  setOpenCodeProcess: vi.fn(),
  killProcessOnPort: vi.fn(),
  waitForPortRelease: vi.fn(async () => true),
  getServer: () => server,
  getUiAuthController: () => null,
  setUiAuthController: vi.fn(),
  getActiveTunnelController: () => null,
  setActiveTunnelController: vi.fn(),
  tunnelAuthController: { clearActiveTunnel: vi.fn() },
  ...overrides,
});

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the server close timeout when the server closes first', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server);
    await runtime.gracefulShutdown({ exitProcess: false });

    vi.advanceTimersByTime(1000);

    expect(warnSpy).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('awaits harness stop before message and OpenCode teardown', async () => {
    const order = [];
    let release;
    const harnessStop = new Promise((resolve) => { release = resolve; });
    const runtime = createRuntime(null, {
      harnessRuntime: { stop: vi.fn(() => { order.push('harness'); return harnessStop; }) },
      getMessageStreamRuntime: () => ({ close: vi.fn(() => order.push('message')) }),
      shouldSkipOpenCodeStop: () => false,
      getOpenCodeProcess: () => ({ close: vi.fn(() => order.push('opencode')) }),
    });
    const shutdown = runtime.gracefulShutdown({ exitProcess: false });
    await Promise.resolve();
    expect(order).toEqual(['harness']);
    release();
    await shutdown;
    expect(order).toEqual(['harness', 'message', 'opencode']);
  });
});
