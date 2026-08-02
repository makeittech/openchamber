import React from 'react';
import { BusyDots } from './BusyDots';
import { useI18n } from '@/lib/i18n';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { buildRetryStatusLabel, getRetryCountdownSeconds, type RetryStatusInfo } from './retryStatus';

interface WorkingPlaceholderProps {
  isWorking: boolean;
  statusText: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  retryInfo?: RetryStatusInfo | null;
  agentName?: string;
  modelName?: string | null;
  providerId?: string | null;
}

const STATUS_DISPLAY_TIME_MS = 1200;

export function WorkingPlaceholder({
  isWorking,
  statusText,
  isGenericStatus,
  isWaitingForPermission,
  retryInfo,
  modelName,
  providerId,
}: WorkingPlaceholderProps) {
  const { t } = useI18n();
  const { src: providerLogoSrc, onError: handleProviderLogoError, hasLogo: hasProviderLogo } = useProviderLogo(providerId ?? null);
  const { currentTheme } = useThemeSystem();
  const isDarkTheme = currentTheme?.metadata.variant === 'dark';
  const [displayedText, setDisplayedText] = React.useState<string | null>(null);
  const [displayedPermission, setDisplayedPermission] = React.useState<boolean>(false);
  const displayedTextRef = React.useRef(displayedText);
  const displayedPermissionRef = React.useRef(displayedPermission);
  displayedTextRef.current = displayedText;
  displayedPermissionRef.current = displayedPermission;

  const statusShownAtRef = React.useRef<number>(0);
  const queuedStatusRef = React.useRef<{ text: string; permission: boolean } | null>(null);
  const processQueueTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Countdown state for retry mode
  const [retryNow, setRetryNow] = React.useState(Date.now);

  React.useEffect(() => {
    if (retryInfo?.message === 'claude-recovery-blocked'
      || getRetryCountdownSeconds(retryInfo?.next) === null) return;
    const update = () => setRetryNow(Date.now());
    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [retryInfo?.message, retryInfo?.next]);

  const clearTimers = React.useCallback(() => {
    if (processQueueTimerRef.current) {
      clearTimeout(processQueueTimerRef.current);
      processQueueTimerRef.current = null;
    }
  }, []);

  const showStatus = React.useCallback((text: string, permission: boolean) => {
    clearTimers();
    queuedStatusRef.current = null;
    setDisplayedText(text);
    setDisplayedPermission(permission);
    statusShownAtRef.current = Date.now();
  }, [clearTimers]);

  const scheduleQueueProcess = React.useCallback(() => {
    if (processQueueTimerRef.current) return;
    const elapsed = Date.now() - statusShownAtRef.current;
    const remaining = Math.max(0, STATUS_DISPLAY_TIME_MS - elapsed);
    processQueueTimerRef.current = setTimeout(() => {
      processQueueTimerRef.current = null;

      const queued = queuedStatusRef.current;
      if (queued) {
        showStatus(queued.text, queued.permission);
      }
    }, remaining);
  }, [showStatus]);

  React.useEffect(() => {
    if (!isWorking) {
      clearTimers();
      queuedStatusRef.current = null;
      setDisplayedText(null);
      setDisplayedPermission(false);
      return;
    }

    // Retry state has its own display — skip the normal queue
    if (retryInfo) {
      clearTimers();
      queuedStatusRef.current = null;
      return;
    }

    const incomingText = isWaitingForPermission ? 'waiting for permission' : statusText;
    const incomingPermission = Boolean(isWaitingForPermission);
    const incomingGeneric = Boolean(isGenericStatus) && !incomingPermission;

    if (!incomingText) {
      return;
    }

    if (!displayedTextRef.current) {
      showStatus(incomingText, incomingPermission);
      return;
    }

    if (incomingText === displayedTextRef.current && incomingPermission === displayedPermissionRef.current) {
      return;
    }

    // Ignore generic churn.
    if (incomingGeneric) {
      return;
    }

    const elapsed = Date.now() - statusShownAtRef.current;
    if (elapsed >= STATUS_DISPLAY_TIME_MS) {
      showStatus(incomingText, incomingPermission);
      return;
    }

    queuedStatusRef.current = { text: incomingText, permission: incomingPermission };
    scheduleQueueProcess();
  }, [
    isWorking,
    statusText,
    isGenericStatus,
    isWaitingForPermission,
    retryInfo,
    clearTimers,
    showStatus,
    scheduleQueueProcess,
  ]);

  React.useEffect(() => () => clearTimers(), [clearTimers]);

  if (!isWorking) {
    return null;
  }

  // Retry state: show countdown and attempt info
  if (retryInfo) {
    const retryText = buildRetryStatusLabel(retryInfo, t, retryNow);

    return (
      <div
        className="flex h-full items-center text-muted-foreground pl-0.5"
        role="status"
        aria-live="polite"
        aria-label={`${retryText}...`}
      >
        <span className="typography-ui-header">
          {retryText}
          <BusyDots />
        </span>
      </div>
    );
  }

  if (!displayedText) {
    return null;
  }

  const trimmedModelName = typeof modelName === 'string' ? modelName.trim() : '';
  const label = trimmedModelName.length > 0
    ? t('chat.statusRow.modelStatus', { model: trimmedModelName, status: displayedText })
    : displayedText.charAt(0).toUpperCase() + displayedText.slice(1);

  return (
    <div
      className={
        'flex h-full items-center text-muted-foreground pl-0.5'
      }
      role="status"
      aria-live={displayedPermission ? 'assertive' : 'polite'}
      aria-label={label}
      data-waiting={displayedPermission ? 'true' : undefined}
    >
      <span className="typography-ui-header">
        {hasProviderLogo && providerLogoSrc ? (
          <img
            src={providerLogoSrc}
            alt=""
            aria-hidden="true"
            className="inline-block h-3.5 w-3.5 mr-1.5 align-[-2px]"
            style={{
              filter: isDarkTheme ? 'brightness(0.9) contrast(1.1) invert(1)' : 'brightness(0.9) contrast(1.1)',
            }}
            onError={handleProviderLogoError}
          />
        ) : null}
        {label}
        <BusyDots />
      </span>
    </div>
  );
}
