import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useHarnessStore } from '@/stores/useHarnessStore';
import { ClaudeCodeHarnessDetail } from './ClaudeCodeHarnessDetail';
import { OpenCodeHarnessDetail } from './OpenCodeHarnessDetail';

export const HarnessPage: React.FC = () => {
  const { t } = useI18n();
  const selectedHarnessId = useHarnessStore((state) => state.selectedHarnessId);

  if (selectedHarnessId === 'claude-code') {
    return <ClaudeCodeHarnessDetail />;
  }

  if (selectedHarnessId === 'opencode') {
    return <OpenCodeHarnessDetail />;
  }

  return (
    <SettingsPageLayout title={t('settings.page.harness.title')} showSaveStatus={false}>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.harness.page.empty.selectHarness')}</p>
    </SettingsPageLayout>
  );
};
