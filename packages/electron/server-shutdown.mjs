const DEFAULT_TIMEOUT_MS = 10_000;

const isManagedTarget = (info) => {
  if (info?.managed !== true) return false;
  const pid = Number(info.pid);
  const port = Number(info.port);
  return (Number.isFinite(pid) && pid > 0) || (Number.isFinite(port) && port > 0);
};

export async function stopInProcessServer({
  handle,
  launchFallback = () => {},
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!handle || typeof handle.stop !== 'function') return;

  let processInfo = null;
  try {
    processInfo = handle.getOpenCodeProcessInfo?.() ?? null;
  } catch (error) {
    logger.warn('[electron] failed to inspect managed OpenCode before shutdown:', error);
  }

  let timeout;
  try {
    const stopPromise = Promise.resolve(handle.stop({ exitProcess: false }));
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`web shutdown timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([stopPromise, timeoutPromise]);
  } catch (error) {
    logger.warn('[electron] in-process web shutdown failed; allowing Desktop to exit:', error);
    if (isManagedTarget(processInfo)) {
      try {
        launchFallback(processInfo);
      } catch (fallbackError) {
        logger.warn('[electron] failed to launch managed OpenCode shutdown fallback:', fallbackError);
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function createServerShutdown({
  getHandle,
  clearHandle = () => {},
  launchFallback,
  logger,
  timeoutMs,
}) {
  let shutdownPromise = null;
  return () => {
    if (shutdownPromise) return shutdownPromise;
    const handle = getHandle();
    shutdownPromise = stopInProcessServer({ handle, launchFallback, logger, timeoutMs })
      .finally(() => clearHandle(handle));
    return shutdownPromise;
  };
}
