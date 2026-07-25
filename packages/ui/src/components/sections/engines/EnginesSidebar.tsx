import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { useHarnessStore } from '@/stores/useHarnessStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { HarnessId, HarnessRuntimeStatus } from '@/types/harness';
import { HARNESS_IDS } from '@/types/harness';
import { useShallow } from 'zustand/react/shallow';

interface EnginesSidebarProps {
  onItemSelect?: () => void;
}

type StatusTone = 'success' | 'warning' | 'error' | 'idle';

const statusTone = (status: HarnessRuntimeStatus | undefined, hasError: boolean): StatusTone => {
  if (hasError && !status) return 'error';
  switch (status) {
    case 'ready':
      return 'success';
    case 'needs-login':
    case 'missing-cli':
    case 'unsupported-host':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
};

const StatusDot: React.FC<{ tone: StatusTone }> = ({ tone }) => {
  const classes: Record<StatusTone, string> = {
    success: 'bg-[var(--status-success)]',
    warning: 'bg-[var(--status-warning)]',
    error: 'bg-[var(--status-error)]',
    idle: 'bg-muted-foreground/40',
  };
  return <span className={cn('inline-block h-2 w-2 rounded-full flex-shrink-0', classes[tone])} />;
};

const ENGINE_LABEL_KEYS: Record<
  HarnessId,
  | 'settings.engines.sidebar.engine.opencode'
  | 'settings.engines.sidebar.engine.claudeCode'
  | 'settings.engines.sidebar.engine.cursor'
> = {
  opencode: 'settings.engines.sidebar.engine.opencode',
  'claude-code': 'settings.engines.sidebar.engine.claudeCode',
  cursor: 'settings.engines.sidebar.engine.cursor',
};

const ENGINE_ICON_NAMES: Record<HarnessId, 'code-box' | 'terminal-box' | 'cursor'> = {
  opencode: 'code-box',
  'claude-code': 'terminal-box',
  cursor: 'cursor',
};

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

export const EnginesSidebar: React.FC<EnginesSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const {
    catalogsById,
    selectedHarnessId,
    setSelectedHarnessId,
    loadState,
    error,
    refresh,
  } = useHarnessStore(useShallow((s) => ({
    catalogsById: s.catalogsById,
    selectedHarnessId: s.selectedHarnessId,
    setSelectedHarnessId: s.setSelectedHarnessId,
    loadState: s.loadState,
    error: s.error,
    refresh: s.refresh,
  })));

  React.useEffect(() => {
    void activeProjectId;
    void refresh();
  }, [activeProjectId, refresh]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-1`}>{t('settings.engines.sidebar.title')}</h2>
        <p className="typography-meta text-muted-foreground">
          {loadState === 'loading'
            ? t('settings.engines.sidebar.status.loading')
            : error
              ? t('settings.engines.page.loadError')
              : t('settings.engines.sidebar.subtitle')}
        </p>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {HARNESS_IDS.map((id) => {
          const catalog = catalogsById[id];
          const isSelected = selectedHarnessId === id;
          const status = catalog?.status;
          const tone = statusTone(status, Boolean(error) && !catalog);
          const statusLabel = status
            ? t(STATUS_LABEL_KEYS[status])
            : loadState === 'loading'
              ? t('settings.engines.sidebar.status.loading')
              : t('settings.engines.sidebar.status.unknown');

          return (
            <div
              key={id}
              className={cn(
                'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200',
                isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
              )}
            >
              <button
                type="button"
                onClick={() => {
                  setSelectedHarnessId(id);
                  onItemSelect?.();
                }}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <Icon
                  name={ENGINE_ICON_NAMES[id]}
                  className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                />
                <span className="typography-ui-label font-normal truncate flex-1 min-w-0 text-foreground">
                  {t(ENGINE_LABEL_KEYS[id])}
                </span>
                <StatusDot tone={tone} />
                <span className="typography-micro text-muted-foreground/60 flex-shrink-0 max-w-[5.5rem] truncate">
                  {statusLabel}
                </span>
              </button>
            </div>
          );
        })}
      </ScrollableOverlay>
    </div>
  );
};
