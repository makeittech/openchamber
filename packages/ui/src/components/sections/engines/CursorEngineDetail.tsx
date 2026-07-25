import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  setCachedCursorWarnOnOpenCodeHandoff,
  withEnginesSettingsDefaults,
} from '@/lib/harness/settings';
import { HarnessClientError, pollCursorLogin, startCursorLogin } from '@/lib/harness/client';
import { openExternalUrl } from '@/lib/url';
import { useHarnessStore } from '@/stores/useHarnessStore';
import type { CapabilityLevel, HarnessCapability, HarnessRuntimeStatus } from '@/types/harness';
import { HARNESS_CAPABILITIES } from '@/types/harness';
import { useShallow } from 'zustand/react/shallow';

const STATUS_LABEL_KEYS: Record<
  HarnessRuntimeStatus,
  | 'settings.engines.sidebar.status.ready'
  | 'settings.engines.sidebar.status.needsLogin'
  | 'settings.engines.sidebar.status.missingCli'
  | 'settings.engines.sidebar.status.unsupportedHost'
  | 'settings.engines.sidebar.status.error'
> = {
  ready: 'settings.engines.sidebar.status.ready',
  'needs-login': 'settings.engines.sidebar.status.needsLogin',
  'missing-cli': 'settings.engines.sidebar.status.missingCli',
  'unsupported-host': 'settings.engines.sidebar.status.unsupportedHost',
  error: 'settings.engines.sidebar.status.error',
};

const CAPABILITY_LABEL_KEYS: Record<HarnessCapability, `settings.engines.capability.${HarnessCapability}`> = {
  prompt: 'settings.engines.capability.prompt',
  abort: 'settings.engines.capability.abort',
  resume: 'settings.engines.capability.resume',
  'streaming-text': 'settings.engines.capability.streaming-text',
  'streaming-tools': 'settings.engines.capability.streaming-tools',
  permissions: 'settings.engines.capability.permissions',
  images: 'settings.engines.capability.images',
  'file-attachments': 'settings.engines.capability.file-attachments',
  shell: 'settings.engines.capability.shell',
  'slash-commands': 'settings.engines.capability.slash-commands',
  mcp: 'settings.engines.capability.mcp',
  subagents: 'settings.engines.capability.subagents',
  multirun: 'settings.engines.capability.multirun',
  goal: 'settings.engines.capability.goal',
  'openchamber-tool': 'settings.engines.capability.openchamber-tool',
};

const LEVEL_LABEL_KEYS: Record<
  CapabilityLevel,
  | 'settings.engines.cursor.capability.full'
  | 'settings.engines.cursor.capability.partial'
  | 'settings.engines.cursor.capability.none'
> = {
  full: 'settings.engines.cursor.capability.full',
  partial: 'settings.engines.cursor.capability.partial',
  none: 'settings.engines.cursor.capability.none',
};

const CURSOR_DOCS_FALLBACK = 'https://cursor.com/docs';
const LOGIN_POLL_INTERVAL_MS = 1500;
const LOGIN_POLL_TIMEOUT_MS = 5 * 60 * 1000;

export const CursorEngineDetail: React.FC = () => {
  const { t } = useI18n();
  const { catalog, isDetecting, detect, error, loadState } = useHarnessStore(useShallow((s) => ({
    catalog: s.catalogsById.cursor,
    isDetecting: Boolean(s.isDetecting.cursor),
    detect: s.detect,
    error: s.error,
    loadState: s.loadState,
  })));

  const [warnOnHandoff, setWarnOnHandoff] = React.useState(true);
  const [settingsLoaded, setSettingsLoaded] = React.useState(false);
  const [loginBusy, setLoginBusy] = React.useState(false);
  const [loginDetail, setLoginDetail] = React.useState<string | null>(null);
  const loginAbortRef = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          return;
        }
        const data = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (cancelled || !data) {
          return;
        }
        const resolved = withEnginesSettingsDefaults({
          enginesCursorWarnOnOpenCodeHandoff:
            typeof data.enginesCursorWarnOnOpenCodeHandoff === 'boolean'
              ? data.enginesCursorWarnOnOpenCodeHandoff
              : undefined,
        });
        setWarnOnHandoff(resolved.enginesCursorWarnOnOpenCodeHandoff);
        setCachedCursorWarnOnOpenCodeHandoff(resolved.enginesCursorWarnOnOpenCodeHandoff);
      } catch {
        // keep default
      } finally {
        if (!cancelled) {
          setSettingsLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => () => {
    loginAbortRef.current = true;
  }, []);

  const handleWarnChange = React.useCallback((enabled: boolean) => {
    setWarnOnHandoff(enabled);
    setCachedCursorWarnOnOpenCodeHandoff(enabled);
    void updateDesktopSettings({ enginesCursorWarnOnOpenCodeHandoff: enabled });
  }, []);

  const handleRedetect = React.useCallback(() => {
    void detect('cursor');
  }, [detect]);

  const handleLogin = React.useCallback(() => {
    void (async () => {
      loginAbortRef.current = false;
      setLoginBusy(true);
      setLoginDetail(null);
      try {
        const started = await startCursorLogin();
        await openExternalUrl(started.loginUrl);

        const deadline = Date.now() + LOGIN_POLL_TIMEOUT_MS;
        while (!loginAbortRef.current && Date.now() < deadline) {
          const poll = await pollCursorLogin(started.loginId);
          if (poll.status === 'complete') {
            setLoginDetail(null);
            await detect('cursor');
            return;
          }
          if (poll.status === 'error') {
            setLoginDetail(poll.detail || t('settings.engines.cursor.login.failed'));
            return;
          }
          await new Promise((resolve) => {
            window.setTimeout(resolve, LOGIN_POLL_INTERVAL_MS);
          });
        }
        if (!loginAbortRef.current) {
          setLoginDetail(t('settings.engines.cursor.login.timeout'));
        }
      } catch (err) {
        const message = err instanceof HarnessClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : t('settings.engines.cursor.login.failed');
        setLoginDetail(message);
      } finally {
        setLoginBusy(false);
      }
    })();
  }, [detect, t]);

  const docsUrl = catalog?.engine.install.docsUrl || CURSOR_DOCS_FALLBACK;
  const status = catalog?.status;
  const capabilities = catalog?.engine.capabilities;
  const showLogin = status === 'needs-login' || status === 'ready' || status === 'error' || !status;

  return (
    <SettingsPageLayout
      title={t('settings.engines.cursor.title')}
      description={t('settings.engines.cursor.description')}
      showSaveStatus
    >
      <SettingsSection
        title={t('settings.engines.cursor.section.status')}
        divider={false}
        settingsItem="engines.cursor"
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <SettingsFieldRow label={t('settings.engines.cursor.field.status')}>
          <span className="typography-ui text-foreground">
            {status
              ? t(STATUS_LABEL_KEYS[status])
              : loadState === 'loading'
                ? t('settings.engines.sidebar.status.loading')
                : t('settings.engines.sidebar.status.unknown')}
          </span>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.engines.cursor.field.version')}>
          <span className="typography-ui text-foreground">
            {catalog?.version
              ? t('settings.engines.cursor.status.version', { version: catalog.version })
              : t('settings.engines.cursor.status.versionUnknown')}
          </span>
        </SettingsFieldRow>
        {catalog?.statusDetail || error || loginDetail ? (
          <p className={SETTINGS_HELPER_CLASS}>{loginDetail || catalog?.statusDetail || error}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {showLogin ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loginBusy || isDetecting}
              onClick={handleLogin}
              aria-label={t('settings.engines.cursor.actions.loginAria')}
            >
              {loginBusy
                ? t('settings.engines.cursor.actions.loginPending')
                : t('settings.engines.cursor.actions.login')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isDetecting || loginBusy}
            onClick={handleRedetect}
            aria-label={t('settings.engines.cursor.actions.redetectAria')}
          >
            {isDetecting
              ? t('settings.engines.sidebar.status.loading')
              : t('settings.engines.cursor.actions.redetect')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void openExternalUrl(docsUrl)}
            aria-label={t('settings.engines.cursor.actions.openDocsAria')}
          >
            {t('settings.engines.cursor.actions.openDocs')}
          </Button>
        </div>
        {status === 'needs-login' ? (
          <div className="space-y-1">
            <p className="typography-ui-label text-foreground">{t('settings.engines.cursor.login.title')}</p>
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.engines.cursor.login.body')}</p>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t('settings.engines.cursor.section.capabilities')}
        settingsItem="engines.cursor.capabilities"
        contentClassName="space-y-2"
      >
        {capabilities ? (
          <ul className="space-y-1.5">
            {HARNESS_CAPABILITIES.map((capability) => {
              const level = capabilities[capability];
              return (
                <li key={capability} className="flex items-baseline justify-between gap-3">
                  <span className="typography-ui text-foreground">{t(CAPABILITY_LABEL_KEYS[capability])}</span>
                  <span className="typography-meta text-muted-foreground shrink-0">{t(LEVEL_LABEL_KEYS[level])}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.engines.cursor.capabilities.empty')}</p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.engines.cursor.section.warnings')}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <SettingsCheckboxRow
          checked={warnOnHandoff}
          onChange={handleWarnChange}
          disabled={!settingsLoaded}
          label={t('settings.engines.cursor.warnHandoff.label')}
          ariaLabel={t('settings.engines.cursor.warnHandoff.aria')}
          info={t('settings.engines.cursor.warnHandoff.info')}
          settingsItem="engines.cursor.warn-handoff"
        />
      </SettingsSection>
    </SettingsPageLayout>
  );
};
