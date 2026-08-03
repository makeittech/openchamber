import React from 'react';
import { useI18n } from '@/lib/i18n';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { LinearSettings } from '@/components/sections/openchamber/LinearSettings';
import { CursorSettings } from '@/components/sections/openchamber/CursorSettings';
import { AiWorkflowPromptSettings } from './AiWorkflowPromptSettings';
import { AiWorkflowModelSettings } from './AiWorkflowModelSettings';

export const AiWorkflowPage: React.FC = () => {
  const { t } = useI18n();

  return (
    <SettingsPageLayout title={t('settings.page.aiWorkflow.title')} showSaveStatus>
      <LinearSettings />
      <CursorSettings />
      <AiWorkflowModelSettings />
      <AiWorkflowPromptSettings />
    </SettingsPageLayout>
  );
};
