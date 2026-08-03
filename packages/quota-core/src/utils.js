/**
 * Small dependency-free pure helpers shared by the Claude OAuth / usage
 * modules in this package. Mirrors the numeric/timestamp/window shape used by
 * every OpenChamber quota provider (see
 * packages/web/server/lib/quota/utils/{transformers,formatters}.js) so the
 * `usage.windows` payload this package produces matches what both the web
 * server and the VS Code extension already send to the shared UI.
 */

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
export function toTimestamp(value) {
  if (!value) return null;
  if (typeof value === 'number') {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * @param {number} timestamp
 * @returns {string | null}
 */
function formatResetTime(timestamp) {
  try {
    const resetDate = new Date(timestamp);
    if (!Number.isFinite(resetDate.getTime())) {
      return null;
    }

    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();

    if (isToday) {
      return resetDate.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    }

    return resetDate.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

const hasResetTimestamp = (resetAt) => resetAt !== null && resetAt !== undefined && resetAt !== '';

/**
 * @param {number | null} resetAt
 * @returns {number | null}
 */
function calculateResetAfterSeconds(resetAt) {
  if (!hasResetTimestamp(resetAt)) return null;
  const resetAtTime = new Date(resetAt).getTime();
  if (!Number.isFinite(resetAtTime)) return null;
  const delta = Math.floor((resetAtTime - Date.now()) / 1000);
  return delta < 0 ? 0 : delta;
}

/**
 * @param {{
 *   usedPercent: number | null,
 *   windowSeconds: number | null,
 *   resetAt: number | null,
 *   valueLabel?: string | null,
 * }} data
 */
export function toUsageWindow({ usedPercent, windowSeconds, resetAt, valueLabel }) {
  const resetAfterSeconds = calculateResetAfterSeconds(resetAt);
  const resetFormatted = hasResetTimestamp(resetAt) ? formatResetTime(resetAt) : null;
  const hasFiniteUsedPercent = typeof usedPercent === 'number' && Number.isFinite(usedPercent);
  return {
    usedPercent: usedPercent ?? null,
    remainingPercent: hasFiniteUsedPercent ? Math.max(0, 100 - usedPercent) : null,
    windowSeconds: windowSeconds ?? null,
    resetAfterSeconds,
    resetAt: resetAt ?? null,
    resetAtFormatted: resetFormatted,
    resetAfterFormatted: resetFormatted,
    ...(valueLabel ? { valueLabel } : {}),
  };
}

/**
 * @param {Record<string, unknown>} auth
 * @param {string[]} aliases
 * @returns {unknown}
 */
export function getAuthEntry(auth, aliases) {
  for (const alias of aliases) {
    if (auth?.[alias]) {
      return auth[alias];
    }
  }
  return null;
}

/**
 * @param {unknown} entry
 * @returns {Record<string, unknown> | null}
 */
export function normalizeAuthEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { token: entry };
  }
  if (typeof entry === 'object') {
    return /** @type {Record<string, unknown>} */ (entry);
  }
  return null;
}
