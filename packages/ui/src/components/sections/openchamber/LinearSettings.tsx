import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import type { LinearAutomationSettings } from '@/lib/api/types';

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 2 * 60_000;

const getCallbackUrl = (): string => {
  try {
    return `${window.location.origin}/api/linear/auth/callback`;
  } catch {
    return '/api/linear/auth/callback';
  }
};

export const LinearSettings: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const runtimeLinear = getRegisteredRuntimeAPIs()?.linear;
  const status = useLinearAuthStore((state) => state.status);
  const isLoading = useLinearAuthStore((state) => state.isLoading);
  const hasChecked = useLinearAuthStore((state) => state.hasChecked);
  const refreshStatus = useLinearAuthStore((state) => state.refreshStatus);
  const setStatus = useLinearAuthStore((state) => state.setStatus);

  const [isBusy, setIsBusy] = React.useState(false);
  const [isWaitingForAuth, setIsWaitingForAuth] = React.useState(false);
  const [apiKeyInput, setApiKeyInput] = React.useState('');
  const pollTimerRef = React.useRef<number | null>(null);
  const pollDeadlineRef = React.useRef<number>(0);

  const stopPolling = React.useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsWaitingForAuth(false);
  }, []);

  React.useEffect(() => {
    if (!hasChecked) {
      void refreshStatus(runtimeLinear).catch((error) => {
        console.warn('Failed to load Linear auth status:', error);
      });
    }
    return () => {
      stopPolling();
    };
  }, [hasChecked, refreshStatus, runtimeLinear, stopPolling]);

  const startConnect = React.useCallback(async () => {
    if (!runtimeLinear) {
      return;
    }
    setIsBusy(true);
    try {
      const { authorizeUrl } = await runtimeLinear.authStart(getCallbackUrl());
      await openExternalUrl(authorizeUrl);

      // Poll the auth status until the OAuth callback stores the connection
      // (or the user cancels / the flow times out).
      setIsWaitingForAuth(true);
      pollDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS;
      pollTimerRef.current = window.setInterval(() => {
        void (async () => {
          if (Date.now() > pollDeadlineRef.current) {
            stopPolling();
            return;
          }
          const next = await refreshStatus(runtimeLinear, { force: true });
          if (next?.connected) {
            stopPolling();
            toast.success(t('settings.linear.page.toast.connected'));
          }
        })();
      }, POLL_INTERVAL_MS);
    } catch (error) {
      console.error('Failed to start Linear connect:', error);
      toast.error(t('settings.linear.page.toast.startConnectFailed'));
    } finally {
      setIsBusy(false);
    }
  }, [refreshStatus, runtimeLinear, stopPolling, t]);

  const connectWithApiKey = React.useCallback(async () => {
    if (!runtimeLinear || !apiKeyInput.trim()) {
      return;
    }
    setIsBusy(true);
    try {
      const next = await runtimeLinear.authApiKey(apiKeyInput.trim());
      setApiKeyInput('');
      setStatus(next);
      toast.success(t('settings.linear.page.toast.connected'));
    } catch (error) {
      console.error('Failed to connect Linear with API key:', error);
      toast.error(t('settings.linear.page.toast.apiKeyConnectFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsBusy(false);
    }
  }, [apiKeyInput, runtimeLinear, setStatus, t]);

  const disconnect = React.useCallback(async () => {
    if (!runtimeLinear) {
      return;
    }
    setIsBusy(true);
    try {
      stopPolling();
      await runtimeLinear.authDisconnect();
      toast.success(t('settings.linear.page.toast.disconnected'));
      await refreshStatus(runtimeLinear, { force: true });
    } catch (error) {
      console.error('Failed to disconnect Linear:', error);
      toast.error(t('settings.linear.page.toast.disconnectFailed'));
    } finally {
      setIsBusy(false);
    }
  }, [refreshStatus, runtimeLinear, stopPolling, t]);

  const updateAutomation = React.useCallback(async (patch: Partial<LinearAutomationSettings>) => {
    if (!runtimeLinear) {
      return;
    }
    const previous = status;
    // Optimistic: checkboxes reflect the change immediately, a failure rolls back.
    if (previous) {
      setStatus({
        ...previous,
        automation: { moveToInProgressOnStart: true, moveToDoneOnComplete: false, ...previous.automation, ...patch },
      });
    }
    try {
      const { automation } = await runtimeLinear.updateAutomation(patch);
      const current = useLinearAuthStore.getState().status;
      if (current) {
        setStatus({ ...current, automation });
      }
    } catch (error) {
      console.error('Failed to update Linear automation:', error);
      if (previous) {
        setStatus(previous);
      }
      toast.error(t('settings.linear.page.toast.automationUpdateFailed'));
    }
  }, [runtimeLinear, setStatus, status, t]);

  if (isLoading && !hasChecked) {
    return null;
  }

  const connected = Boolean(status?.connected);
  const configured = status?.configured !== false;
  const user = status?.user;
  const organization = status?.organization;
  const automation: LinearAutomationSettings = {
    moveToInProgressOnStart: status?.automation?.moveToInProgressOnStart !== false,
    moveToDoneOnComplete: status?.automation?.moveToDoneOnComplete === true,
  };

  const apiKeyForm = (
    <div className="flex flex-col gap-1.5">
      <span className="typography-meta text-muted-foreground">
        {t('settings.linear.page.apiKey.label')}
      </span>
      <div className={cn('flex gap-2', isMobile ? 'flex-col' : 'flex-row')}>
        <Input
          type="password"
          value={apiKeyInput}
          onChange={(event) => setApiKeyInput(event.target.value)}
          placeholder={t('settings.linear.page.apiKey.placeholder')}
          aria-label={t('settings.linear.page.apiKey.label')}
          autoComplete="off"
          className="h-9 max-w-xs font-mono"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void connectWithApiKey();
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => void connectWithApiKey()}
          disabled={isBusy || !runtimeLinear || !apiKeyInput.trim()}
          className={cn(isMobile ? 'w-full' : undefined)}
        >
          {t('settings.linear.page.apiKey.connect')}
        </Button>
      </div>
    </div>
  );

  return (
    <SettingsSection
      title={t('settings.linear.page.title')}
      settingsItem="ai-workflow.linear-workspace"
      info={t('settings.linear.page.tooltip.connectWorkspace')}
      divider={false}
    >
      <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
        {connected ? (
          <div className={cn("px-4 py-3", isMobile ? "flex flex-col gap-3" : "flex items-center justify-between gap-4")}>
            <div className={cn("flex min-w-0 items-center gap-4", isMobile ? "w-full" : undefined)}>
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user?.displayName || user?.name || 'Linear'}
                  className="h-10 w-10 shrink-0 rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)] object-cover"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)]">
                  <Icon name="links" className="h-4 w-4 text-muted-foreground" />
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div className="typography-ui-label text-foreground">
                  {user?.displayName || user?.name || 'Linear'}
                </div>
                <div className={cn("flex items-center gap-2 typography-meta text-muted-foreground mt-0.5", isMobile ? "flex-wrap" : "truncate")}>
                  <span>{t('settings.linear.page.status.connected')}</span>
                  <span className="opacity-50">•</span>
                  <span>{status?.kind === 'api_key'
                    ? t('settings.linear.page.status.methodApiKey')
                    : t('settings.linear.page.status.methodOauth')}</span>
                  {organization?.name ? (
                    <>
                      <span className="opacity-50">•</span>
                      <span>{t('settings.linear.page.label.workspace', { value: organization.name })}</span>
                    </>
                  ) : null}
                </div>
                {status?.scope ? (
                  <div className="typography-micro text-muted-foreground/70 mt-0.5">
                    {t('settings.linear.page.label.scopes', { value: status.scope })}
                  </div>
                ) : null}
              </div>
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={disconnect}
              disabled={isBusy}
              className={cn("text-[var(--status-error)] hover:text-[var(--status-error)]", isMobile ? "w-full" : undefined)}
            >
              {t('settings.linear.page.actions.disconnect')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-col">
                <span className="typography-ui-label text-foreground">{t('settings.linear.page.status.notConnected')}</span>
                {isWaitingForAuth ? (
                  <span className="typography-meta text-muted-foreground mt-0.5">
                    {t('settings.linear.page.flow.waiting')}
                  </span>
                ) : null}
              </div>
              {configured ? (
                isWaitingForAuth ? (
                  <Button size="sm" variant="outline" onClick={stopPolling}>
                    {t('settings.linear.page.flow.cancel')}
                  </Button>
                ) : (
                  <Button size="sm" variant="default" onClick={startConnect} disabled={isBusy || !runtimeLinear}>
                    {t('settings.linear.page.actions.connect')}
                  </Button>
                )
              ) : null}
            </div>
            {!configured ? (
              <span className="typography-meta text-muted-foreground break-words">
                {t('settings.linear.page.setupHint', { redirectUri: getCallbackUrl() })}
              </span>
            ) : null}
            {apiKeyForm}
          </div>
        )}
      </div>

      {connected ? (
        <div className="flex flex-col gap-1 px-1 pt-3">
          <SettingsCheckboxRow
            checked={automation.moveToInProgressOnStart}
            onChange={(checked) => void updateAutomation({ moveToInProgressOnStart: checked })}
            label={t('settings.linear.page.automation.moveToInProgress')}
            info={t('settings.linear.page.automation.moveToInProgress.info')}
            ariaLabel={t('settings.linear.page.automation.moveToInProgress')}
          />
          <SettingsCheckboxRow
            checked={automation.moveToDoneOnComplete}
            onChange={(checked) => void updateAutomation({ moveToDoneOnComplete: checked })}
            label={t('settings.linear.page.automation.moveToDone')}
            info={t('settings.linear.page.automation.moveToDone.info')}
            ariaLabel={t('settings.linear.page.automation.moveToDone')}
          />
        </div>
      ) : null}
    </SettingsSection>
  );
};
