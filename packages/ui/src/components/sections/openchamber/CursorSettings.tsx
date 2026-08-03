import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import type { CursorApiVersion, WorkQueueCursorAuthStatus } from '@/lib/api/types';

export const CursorSettings: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const runtimeWorkQueue = getRegisteredRuntimeAPIs()?.workQueue;

  const [status, setStatus] = React.useState<WorkQueueCursorAuthStatus | null>(null);
  const [hasChecked, setHasChecked] = React.useState(false);
  const [isBusy, setIsBusy] = React.useState(false);
  const [apiKeyInput, setApiKeyInput] = React.useState('');
  const [repos, setRepos] = React.useState<string[]>([]);
  const [repoInput, setRepoInput] = React.useState('');

  React.useEffect(() => {
    if (!runtimeWorkQueue || hasChecked) return;
    setHasChecked(true);
    void runtimeWorkQueue.cursorAuthStatus().then(setStatus).catch(() => setStatus(null));
    void runtimeWorkQueue.reposList().then((res) => setRepos(res.repos)).catch(() => setRepos([]));
  }, [runtimeWorkQueue, hasChecked]);

  const connect = React.useCallback(async () => {
    if (!runtimeWorkQueue || !apiKeyInput.trim()) return;
    setIsBusy(true);
    try {
      await runtimeWorkQueue.cursorAuthConnect(apiKeyInput.trim());
      setApiKeyInput('');
      setStatus(await runtimeWorkQueue.cursorAuthStatus());
      toast.success(t('settings.cursor.page.toast.connected'));
    } catch (error) {
      toast.error(t('settings.cursor.page.toast.connectFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsBusy(false);
    }
  }, [apiKeyInput, runtimeWorkQueue, t]);

  const disconnect = React.useCallback(async () => {
    if (!runtimeWorkQueue) return;
    setIsBusy(true);
    try {
      await runtimeWorkQueue.cursorAuthDisconnect();
      setStatus(await runtimeWorkQueue.cursorAuthStatus());
      toast.success(t('settings.cursor.page.toast.disconnected'));
    } catch {
      toast.error(t('settings.cursor.page.toast.disconnectFailed'));
    } finally {
      setIsBusy(false);
    }
  }, [runtimeWorkQueue, t]);

  const addRepo = React.useCallback(async () => {
    const trimmed = repoInput.trim();
    if (!runtimeWorkQueue || !trimmed || !/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return;
    const next = Array.from(new Set([...repos, trimmed]));
    try {
      const res = await runtimeWorkQueue.reposSet(next);
      setRepos(res.repos);
      setRepoInput('');
    } catch {
      toast.error(t('settings.cursor.page.toast.reposUpdateFailed'));
    }
  }, [repoInput, repos, runtimeWorkQueue, t]);

  const removeRepo = React.useCallback(async (repo: string) => {
    if (!runtimeWorkQueue) return;
    const next = repos.filter((entry) => entry !== repo);
    try {
      const res = await runtimeWorkQueue.reposSet(next);
      setRepos(res.repos);
    } catch {
      toast.error(t('settings.cursor.page.toast.reposUpdateFailed'));
    }
  }, [repos, runtimeWorkQueue, t]);

  if (!runtimeWorkQueue) {
    return null;
  }

  const connected = Boolean(status?.connected);

  return (
    <SettingsSection
      title={t('settings.cursor.page.title')}
      settingsItem="ai-workflow.cursor-workspace"
      info={t('settings.cursor.page.tooltip.connectWorkspace')}
    >
      <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
        {connected ? (
          <div className={cn('px-4 py-3', isMobile ? 'flex flex-col gap-3' : 'flex items-center justify-between gap-4')}>
            <div className="flex min-w-0 items-center gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)]">
                <Icon name="cloud" className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1 typography-ui-label text-foreground">
                {status?.configuredViaEnv
                  ? t('settings.cursor.page.status.configuredViaEnv')
                  : t('settings.cursor.page.status.connected')}
              </div>
            </div>
            {!status?.configuredViaEnv && (
              <Button
                size="sm"
                variant="outline"
                onClick={disconnect}
                disabled={isBusy}
                className={cn('text-[var(--status-error)] hover:text-[var(--status-error)]', isMobile ? 'w-full' : undefined)}
              >
                {t('settings.cursor.page.actions.disconnect')}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 px-4 py-4">
            <span className="typography-ui-label text-foreground">{t('settings.cursor.page.status.notConnected')}</span>
            <div className="flex flex-col gap-1.5">
              <span className="typography-meta text-muted-foreground">{t('settings.cursor.page.apiKey.label')}</span>
              <div className={cn('flex gap-2', isMobile ? 'flex-col' : 'flex-row')}>
                <Input
                  type="password"
                  value={apiKeyInput}
                  onChange={(event) => setApiKeyInput(event.target.value)}
                  placeholder={t('settings.cursor.page.apiKey.placeholder')}
                  aria-label={t('settings.cursor.page.apiKey.label')}
                  autoComplete="off"
                  className="h-9 max-w-xs font-mono"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void connect();
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void connect()}
                  disabled={isBusy || !apiKeyInput.trim()}
                  className={cn(isMobile ? 'w-full' : undefined)}
                >
                  {t('settings.cursor.page.actions.connect')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2 px-1 pt-3">
        <span className="typography-meta text-muted-foreground">{t('settings.cursor.page.apiVersion.label')}</span>
        {status?.versionConfiguredViaEnv ? (
          <span className="typography-ui-label text-muted-foreground">
            {t('settings.cursor.page.apiVersion.controlledByEnv')}
          </span>
        ) : (
          <SettingsChipGroup
            value={(status?.apiVersion ?? 'v0')}
            options={(
              [
                { value: 'v0', label: t('settings.cursor.page.apiVersion.option.v0') },
                { value: 'v1', label: t('settings.cursor.page.apiVersion.option.v1') },
              ] satisfies { value: CursorApiVersion; label: string }[]
            )}
            onChange={async (next: CursorApiVersion) => {
              if (!runtimeWorkQueue || status?.apiVersion === next) return;
              try {
                const result = await runtimeWorkQueue.cursorApiVersionSet(next);
                setStatus((prev) => prev ? { ...prev, apiVersion: result.apiVersion } : prev);
                toast.success(t('settings.cursor.page.toast.apiVersionSaved'));
              } catch (error) {
                toast.error(t('settings.cursor.page.toast.apiVersionSaveFailed'), {
                  description: error instanceof Error ? error.message : String(error),
                });
              }
            }}
            aria-label={t('settings.cursor.page.apiVersion.label')}
          />
        )}
      </div>

      <div className="flex flex-col gap-2 px-1 pt-3">
        <span className="typography-meta text-muted-foreground">{t('settings.cursor.page.repos.label')}</span>
        <div className={cn('flex gap-2', isMobile ? 'flex-col' : 'flex-row')}>
          <Input
            value={repoInput}
            onChange={(event) => setRepoInput(event.target.value)}
            placeholder={t('settings.cursor.page.repos.placeholder')}
            aria-label={t('settings.cursor.page.repos.label')}
            className="h-9 max-w-xs"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void addRepo();
              }
            }}
          />
          <Button size="sm" variant="outline" onClick={() => void addRepo()} disabled={!repoInput.trim()}>
            {t('settings.cursor.page.repos.add')}
          </Button>
        </div>
        {repos.length === 0 ? (
          <span className="typography-meta text-muted-foreground/70">{t('settings.cursor.page.repos.empty')}</span>
        ) : (
          <div className="flex flex-col gap-1">
            {repos.map((repo) => (
              <div key={repo} className="flex items-center justify-between gap-2 typography-ui-label px-2 py-1 rounded-md bg-[var(--surface-elevated)]/50">
                <span className="truncate">{repo}</span>
                <button
                  type="button"
                  onClick={() => void removeRepo(repo)}
                  aria-label={t('settings.cursor.page.repos.remove')}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  );
};
