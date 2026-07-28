import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SETTINGS_HELPER_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useHarnessStore } from '@/stores/useHarnessStore';

export const OpenCodeHarnessDetail: React.FC = () => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const catalog = useHarnessStore((state) => state.catalogsById.opencode);
  const statusDetail = catalog?.statusDetail;

  return (
    <SettingsPageLayout
      title={t('settings.harness.opencode.title')}
      description={t('settings.harness.opencode.description')}
      showSaveStatus
    >
      <SettingsSection
        title={t('settings.harness.opencode.section.about')}
        divider={false}
        settingsItem="harness.opencode"
        contentClassName="space-y-3"
      >
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.harness.opencode.about.body')}</p>
        {statusDetail ? (
          <p className={SETTINGS_HELPER_CLASS}>{statusDetail}</p>
        ) : null}
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSettingsPage('providers')}
            >
              {t('settings.harness.opencode.link.providers')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setSettingsPage('agents')}
            >
              {t('settings.harness.opencode.link.agents')}
            </Button>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
