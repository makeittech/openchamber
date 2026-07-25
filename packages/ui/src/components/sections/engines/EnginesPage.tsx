import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useHarnessStore } from '@/stores/useHarnessStore';
import { ClaudeCodeEngineDetail } from './ClaudeCodeEngineDetail';
import { CursorEngineDetail } from './CursorEngineDetail';
import { OpenCodeEngineDetail } from './OpenCodeEngineDetail';

export const EnginesPage: React.FC = () => {
  const { t } = useI18n();
  const selectedHarnessId = useHarnessStore((state) => state.selectedHarnessId);

  if (selectedHarnessId === 'claude-code') {
    return <ClaudeCodeEngineDetail />;
  }

  if (selectedHarnessId === 'cursor') {
    return <CursorEngineDetail />;
  }

  if (selectedHarnessId === 'opencode') {
    return <OpenCodeEngineDetail />;
  }

  return (
    <SettingsPageLayout title={t('settings.page.engines.title')} showSaveStatus={false}>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.engines.page.empty.selectEngine')}</p>
    </SettingsPageLayout>
  );
};
