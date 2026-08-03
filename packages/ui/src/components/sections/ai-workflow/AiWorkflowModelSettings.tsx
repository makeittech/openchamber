import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { SettingsSection, SettingsFieldRow, SETTINGS_CUSTOM_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';

// The default analysis model (Settings > AI Workflow). Leaving it unset keeps
// AI analysis on the small-model module's own auto-resolution chain across
// every authenticated provider, rather than pinning it to one — this is the
// single source of truth the issue detail panel's "set as default" star also
// reads and writes via the same workQueue.analysisModelGet/Set calls.
export const AiWorkflowModelSettings: React.FC = () => {
  const { t } = useI18n();
  const runtimeWorkQueue = getRegisteredRuntimeAPIs()?.workQueue;

  const [model, setModel] = React.useState('');
  const [providers, setProviders] = React.useState<string[] | undefined>();

  React.useEffect(() => {
    if (!runtimeWorkQueue) return;
    let cancelled = false;
    void runtimeWorkQueue.analysisModelGet()
      .then(({ model: loaded }) => {
        if (!cancelled) setModel(loaded);
      })
      .catch(() => {
        // Best-effort: the picker simply starts on auto-resolution.
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeWorkQueue]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await runtimeFetch('/api/small-model', { method: 'GET', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const payload = await response.json().catch(() => null) as { authenticatedProviders?: unknown } | null;
        if (!cancelled && Array.isArray(payload?.authenticatedProviders)) {
          setProviders(payload.authenticatedProviders.filter((id): id is string => typeof id === 'string'));
        }
      } catch {
        // leave undefined — picker falls back to showing all providers
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const parsedModel = React.useMemo(() => parseModelIdentifier(model) ?? { providerId: '', modelId: '' }, [model]);

  const handleChange = React.useCallback(async (providerId: string, modelId: string) => {
    if (!runtimeWorkQueue) return;
    const next = providerId && modelId ? `${providerId}/${modelId}` : '';
    setModel(next);
    reportSettingsSaveState('saving');
    try {
      const { model: saved } = await runtimeWorkQueue.analysisModelSet(next);
      setModel(saved);
      reportSettingsSaveState('saved');
    } catch (error) {
      reportSettingsSaveState('error');
      toast.error(t('settings.aiWorkflow.page.toast.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [runtimeWorkQueue, t]);

  if (!runtimeWorkQueue) {
    return null;
  }

  return (
    <SettingsSection
      title={t('settings.aiWorkflow.page.section.analysisModel')}
      info={t('settings.aiWorkflow.page.info.analysisModel')}
      settingsItem="ai-workflow.analysis-model"
    >
      <SettingsFieldRow label={t('settings.aiWorkflow.page.field.analysisModel')}>
        <ModelSelector
          providerId={parsedModel.providerId}
          modelId={parsedModel.modelId}
          onChange={handleChange}
          allowedProviderIds={providers}
          placeholder={t('settings.aiWorkflow.page.field.analysisModelAuto')}
          className={SETTINGS_CUSTOM_TRIGGER_CLASS}
        />
      </SettingsFieldRow>
    </SettingsSection>
  );
};
