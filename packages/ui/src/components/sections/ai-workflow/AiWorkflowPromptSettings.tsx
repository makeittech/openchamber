import React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import type { WorkQueuePromptSettings } from '@/lib/api/types';

const DEFAULT_PROMPT_SETTINGS: WorkQueuePromptSettings = {
  analysisPromptExtra: '',
  alreadySolvedPromptExtra: '',
  remoteAgentPromptSuffix: '',
};

export const AiWorkflowPromptSettings: React.FC = () => {
  const { t } = useI18n();
  const runtimeWorkQueue = getRegisteredRuntimeAPIs()?.workQueue;

  const [values, setValues] = React.useState<WorkQueuePromptSettings>(DEFAULT_PROMPT_SETTINGS);
  const [isLoading, setIsLoading] = React.useState(true);
  const lastSavedRef = React.useRef<WorkQueuePromptSettings>(DEFAULT_PROMPT_SETTINGS);

  React.useEffect(() => {
    if (!runtimeWorkQueue) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    void runtimeWorkQueue.promptSettingsGet()
      .then((loaded) => {
        if (cancelled) return;
        setValues(loaded);
        lastSavedRef.current = loaded;
      })
      .catch(() => {
        // Best-effort: fields simply start empty if the load fails.
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runtimeWorkQueue]);

  React.useEffect(() => {
    if (isLoading || !runtimeWorkQueue) return;
    const last = lastSavedRef.current;
    const patch: Partial<WorkQueuePromptSettings> = {};
    (Object.keys(values) as Array<keyof WorkQueuePromptSettings>).forEach((key) => {
      if (values[key] !== last[key]) patch[key] = values[key];
    });
    if (Object.keys(patch).length === 0) return;

    const timer = setTimeout(async () => {
      reportSettingsSaveState('saving');
      try {
        const saved = await runtimeWorkQueue.promptSettingsSet(patch);
        lastSavedRef.current = saved;
        reportSettingsSaveState('saved');
      } catch (error) {
        reportSettingsSaveState('error');
        toast.error(t('settings.aiWorkflow.page.toast.saveFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [values, isLoading, runtimeWorkQueue, t]);

  if (!runtimeWorkQueue) {
    return null;
  }

  return (
    <>
      <SettingsSection
        title={t('settings.aiWorkflow.page.section.analysisPrompt')}
        info={t('settings.aiWorkflow.page.info.analysisPrompt')}
        settingsItem="ai-workflow.analysis-prompt"
      >
        <Textarea
          value={values.analysisPromptExtra}
          onChange={(event) => setValues((prev) => ({ ...prev, analysisPromptExtra: event.target.value }))}
          placeholder={t('settings.aiWorkflow.page.field.analysisPromptPlaceholder')}
          rows={5}
          disabled={isLoading}
          outerClassName="min-h-[120px]"
          className="w-full font-mono typography-meta bg-transparent"
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.aiWorkflow.page.section.alreadySolvedPrompt')}
        info={t('settings.aiWorkflow.page.info.alreadySolvedPrompt')}
        settingsItem="ai-workflow.already-solved-prompt"
      >
        <Textarea
          value={values.alreadySolvedPromptExtra}
          onChange={(event) => setValues((prev) => ({ ...prev, alreadySolvedPromptExtra: event.target.value }))}
          placeholder={t('settings.aiWorkflow.page.field.alreadySolvedPromptPlaceholder')}
          rows={5}
          disabled={isLoading}
          outerClassName="min-h-[120px]"
          className="w-full font-mono typography-meta bg-transparent"
        />
      </SettingsSection>

      <SettingsSection
        title={t('settings.aiWorkflow.page.section.remoteAgentPrompt')}
        info={t('settings.aiWorkflow.page.info.remoteAgentPrompt')}
        settingsItem="ai-workflow.remote-agent-prompt"
      >
        <Textarea
          value={values.remoteAgentPromptSuffix}
          onChange={(event) => setValues((prev) => ({ ...prev, remoteAgentPromptSuffix: event.target.value }))}
          placeholder={t('settings.aiWorkflow.page.field.remoteAgentPromptPlaceholder')}
          rows={5}
          disabled={isLoading}
          outerClassName="min-h-[120px]"
          className="w-full font-mono typography-meta bg-transparent"
        />
      </SettingsSection>
    </>
  );
};
