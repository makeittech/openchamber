export interface RetryStatusInfo { attempt?: number; message?: string; next?: number }
type RetryStatusKey =
  | 'chat.statusRow.retrying'
  | 'chat.statusRow.retryingIn'
  | 'chat.statusRow.retryAttempt'
  | 'chat.statusRow.recoveryBlocked';
type Translate = (key: RetryStatusKey, params?: Record<string, string | number>) => string;
const MIN_ABSOLUTE_MILLISECONDS = 1_000_000_000_000;

export const getRetryCountdownSeconds = (next: number | undefined, now = Date.now()): number | null => {
  if (!Number.isFinite(next) || !next || next < MIN_ABSOLUTE_MILLISECONDS) return null;
  return Math.ceil(Math.max(0, next - now) / 1000);
};

const formatRetryCountdown = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const remainder = Math.floor((seconds % 3600) / 60);
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  const days = Math.floor(seconds / 86400);
  const remainder = Math.floor((seconds % 86400) / 3600);
  return remainder ? `${days}d ${remainder}h` : `${days}d`;
};

export const buildRetryStatusLabel = (retryInfo: RetryStatusInfo, t: Translate, now = Date.now()): string => {
  if (retryInfo.message === 'claude-recovery-blocked') return t('chat.statusRow.recoveryBlocked');
  const seconds = getRetryCountdownSeconds(retryInfo.next, now);
  const base = seconds !== null && seconds > 0
    ? t('chat.statusRow.retryingIn', { countdown: formatRetryCountdown(seconds) })
    : t('chat.statusRow.retrying');
  return retryInfo.attempt && retryInfo.attempt > 1
    ? `${base} ${t('chat.statusRow.retryAttempt', { attempt: retryInfo.attempt })}`
    : base;
};
