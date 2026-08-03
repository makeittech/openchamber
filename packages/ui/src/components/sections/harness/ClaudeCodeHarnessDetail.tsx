import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsChipGroup,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { updateDesktopSettings } from '@/lib/persistence';
import {
  setCachedWarnOnHarnessSwitch,
  setCachedClaudeAgentsMode,
  withHarnessSettingsDefaults,
  type ClaudeAgentsMode,
} from '@/lib/harness/settings';
import { openExternalUrl } from '@/lib/url';
import { useHarnessStore } from '@/stores/useHarnessStore';
import { useUIStore } from '@/stores/useUIStore';
import type { CapabilityLevel, HarnessCapability, HarnessRuntimeStatus } from '@/types/harness';
import { HARNESS_CAPABILITIES } from '@/types/harness';
import { useShallow } from 'zustand/react/shallow';
import { ClaudeImportDialog } from '@/components/sections/harness/ClaudeImportDialog';

const STATUS_LABEL_KEYS: Record<
  HarnessRuntimeStatus,
  | 'settings.harness.sidebar.status.ready'
  | 'settings.harness.sidebar.status.needsLogin'
  | 'settings.harness.sidebar.status.missingCli'
  | 'settings.harness.sidebar.status.unsupportedHost'
  | 'settings.harness.sidebar.status.error'
> = {
  ready: 'settings.harness.sidebar.status.ready',
  'needs-login': 'settings.harness.sidebar.status.needsLogin',
  'missing-cli': 'settings.harness.sidebar.status.missingCli',
  'unsupported-host': 'settings.harness.sidebar.status.unsupportedHost',
  error: 'settings.harness.sidebar.status.error',
};

const CAPABILITY_LABEL_KEYS: Record<HarnessCapability, `settings.harness.capability.${HarnessCapability}`> = {
  prompt: 'settings.harness.capability.prompt',
  abort: 'settings.harness.capability.abort',
  resume: 'settings.harness.capability.resume',
  'streaming-text': 'settings.harness.capability.streaming-text',
  'streaming-tools': 'settings.harness.capability.streaming-tools',
  permissions: 'settings.harness.capability.permissions',
  images: 'settings.harness.capability.images',
  'file-attachments': 'settings.harness.capability.file-attachments',
  shell: 'settings.harness.capability.shell',
  'slash-commands': 'settings.harness.capability.slash-commands',
  mcp: 'settings.harness.capability.mcp',
  subagents: 'settings.harness.capability.subagents',
  multirun: 'settings.harness.capability.multirun',
  goal: 'settings.harness.capability.goal',
  'openchamber-tool': 'settings.harness.capability.openchamber-tool',
};

const LEVEL_LABEL_KEYS: Record<
  CapabilityLevel,
  | 'settings.harness.claudeCode.capability.full'
  | 'settings.harness.claudeCode.capability.partial'
  | 'settings.harness.claudeCode.capability.none'
> = {
  full: 'settings.harness.claudeCode.capability.full',
  partial: 'settings.harness.claudeCode.capability.partial',
  none: 'settings.harness.claudeCode.capability.none',
};

const CLAUDE_DOCS_FALLBACK = 'https://docs.anthropic.com/en/docs/claude-code';

export const ClaudeCodeHarnessDetail: React.FC = () => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const { catalog, isDetecting, detect, error, loadState } = useHarnessStore(useShallow((s) => ({
    catalog: s.catalogsById['claude-code'],
    isDetecting: Boolean(s.isDetecting['claude-code']),
    detect: s.detect,
    error: s.error,
    loadState: s.loadState,
  })));

  const [warnOnHandoff, setWarnOnHandoff] = React.useState(true);
  const [agentsMode, setAgentsMode] = React.useState<ClaudeAgentsMode>('opencode');
  const [settingsLoaded, setSettingsLoaded] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);

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
        const resolved = withHarnessSettingsDefaults({
          harnessWarnOnSwitch:
            typeof data.harnessWarnOnSwitch === 'boolean'
              ? data.harnessWarnOnSwitch
              : undefined,
          harnessClaudeCodeAgentsMode:
            data.harnessClaudeCodeAgentsMode === 'claude' || data.harnessClaudeCodeAgentsMode === 'opencode'
              ? data.harnessClaudeCodeAgentsMode
              : undefined,
        });
        setWarnOnHandoff(resolved.harnessWarnOnSwitch);
        setCachedWarnOnHarnessSwitch(resolved.harnessWarnOnSwitch);
        setAgentsMode(resolved.harnessClaudeCodeAgentsMode);
        setCachedClaudeAgentsMode(resolved.harnessClaudeCodeAgentsMode);
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

  const handleWarnChange = React.useCallback((enabled: boolean) => {
    setWarnOnHandoff(enabled);
    setCachedWarnOnHarnessSwitch(enabled);
    void updateDesktopSettings({ harnessWarnOnSwitch: enabled });
  }, []);

  const handleAgentsModeChange = React.useCallback((mode: ClaudeAgentsMode) => {
    setAgentsMode(mode);
    setCachedClaudeAgentsMode(mode);
    void updateDesktopSettings({ harnessClaudeCodeAgentsMode: mode });
  }, []);

  const handleRedetect = React.useCallback(() => {
    void detect('claude-code');
  }, [detect]);

  const docsUrl = catalog?.descriptor.install.docsUrl || CLAUDE_DOCS_FALLBACK;
  const status = catalog?.status;
  const capabilities = catalog?.descriptor.capabilities;

  return (
    <SettingsPageLayout
      title={t('settings.harness.claudeCode.title')}
      description={t('settings.harness.claudeCode.description')}
      showSaveStatus
    >
      <SettingsSection
        title={t('settings.harness.claudeCode.section.status')}
        divider={false}
        settingsItem="harness.claude-code"
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <SettingsFieldRow label={t('settings.harness.claudeCode.field.status')}>
          <span className="typography-ui text-foreground">
            {status
              ? t(STATUS_LABEL_KEYS[status])
              : loadState === 'loading'
                ? t('settings.harness.sidebar.status.loading')
                : t('settings.harness.sidebar.status.unknown')}
          </span>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.harness.claudeCode.field.version')}>
          <span className="typography-ui text-foreground">
            {catalog?.version
              ? t('settings.harness.claudeCode.status.version', { version: catalog.version })
              : t('settings.harness.claudeCode.status.versionUnknown')}
          </span>
        </SettingsFieldRow>
        {catalog?.statusDetail || error ? (
          <p className={SETTINGS_HELPER_CLASS}>{catalog?.statusDetail || error}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isDetecting}
            onClick={handleRedetect}
            aria-label={t('settings.harness.claudeCode.actions.redetectAria')}
          >
            {isDetecting
              ? t('settings.harness.sidebar.status.loading')
              : t('settings.harness.claudeCode.actions.redetect')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void openExternalUrl(docsUrl)}
            aria-label={t('settings.harness.claudeCode.actions.openDocsAria')}
          >
            {t('settings.harness.claudeCode.actions.openDocs')}
          </Button>
        </div>
        {status === 'needs-login' || status === 'missing-cli' ? (
          <div className="space-y-1">
            <p className="typography-ui-label text-foreground">{t('settings.harness.claudeCode.login.title')}</p>
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.harness.claudeCode.login.body')}</p>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title={t('settings.harness.claudeCode.section.capabilities')}
        settingsItem="harness.claude-code.capabilities"
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
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.harness.claudeCode.capabilities.empty')}</p>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.harness.claudeCode.section.agents')}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <SettingsFieldRow
          label={t('settings.harness.claudeCode.agentsMode.label')}
          info={t('settings.harness.claudeCode.agentsMode.info')}
          settingsItem="harness.claude-code.agents-mode"
        >
          <SettingsChipGroup
            aria-label={t('settings.harness.claudeCode.agentsMode.aria')}
            value={agentsMode}
            onChange={handleAgentsModeChange}
            options={[
              {
                value: 'claude',
                label: t('settings.harness.claudeCode.agentsMode.claude'),
                disabled: !settingsLoaded,
              },
              {
                value: 'opencode',
                label: t('settings.harness.claudeCode.agentsMode.opencode'),
                disabled: !settingsLoaded,
              },
            ]}
          />
        </SettingsFieldRow>
      </SettingsSection>

      <SettingsSection
        title={t('settings.harness.claudeCode.section.warnings')}
        contentClassName={SETTINGS_FIELDS_STACK_CLASS}
      >
        <SettingsCheckboxRow
          checked={warnOnHandoff}
          onChange={handleWarnChange}
          disabled={!settingsLoaded}
          label={t('settings.harness.claudeCode.warnHandoff.label')}
          ariaLabel={t('settings.harness.claudeCode.warnHandoff.aria')}
          info={t('settings.harness.claudeCode.warnHandoff.info')}
          settingsItem="harness.claude-code.warn-handoff"
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.harness.claudeCode.section.import')}
        settingsItem="harness.claude-code.import"
        contentClassName="space-y-3"
      >
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.harness.claudeCode.import.note')}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setImportOpen(true)}
          aria-label={t('settings.harness.claudeCode.import.actions.openAria')}
        >
          {t('settings.harness.claudeCode.import.actions.open')}
        </Button>
      </SettingsSection>

      <SettingsSection
        title={t('settings.harness.claudeCode.section.apiKeys')}
        settingsItem="harness.claude-code.api-keys"
        contentClassName="space-y-3"
      >
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.harness.claudeCode.apiKeys.note')}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setSettingsPage('providers')}
        >
          {t('settings.harness.opencode.link.providers')}
        </Button>
      </SettingsSection>

      <ClaudeImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </SettingsPageLayout>
  );
};
