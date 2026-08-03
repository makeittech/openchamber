import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/lib/url';
import type { ProviderOAuthEntry } from './providerAuth';

export interface ProviderOAuthDetails {
  url?: string;
  instructions?: string;
  userCode?: string;
}

interface ProviderAuthPanelProps {
  providerId: string;
  oauthEntries: ProviderOAuthEntry[];
  showApiKeyField: boolean;
  apiKeyValue: string;
  onApiKeyChange: (value: string) => void;
  onSaveApiKey: () => void;
  busyKey: string | null;
  oauthDetails: Record<string, ProviderOAuthDetails>;
  oauthCodes: Record<string, string>;
  onOAuthCodeChange: (codeKey: string, value: string) => void;
  pendingOAuth: { providerId: string; methodIndex: number } | null;
  onOAuthStart: (methodIndex: number) => void;
  onOAuthComplete: (methodIndex: number) => void;
  onCopyOAuthLink: (url: string) => void;
  onCopyOAuthCode: (code: string) => void;
  className?: string;
}

/**
 * Authentication controls shared by the connected provider detail page and the
 * add-provider flow, so both surfaces expose the same API key and OAuth paths.
 */
export const ProviderAuthPanel: React.FC<ProviderAuthPanelProps> = ({
  providerId,
  oauthEntries,
  showApiKeyField,
  apiKeyValue,
  onApiKeyChange,
  onSaveApiKey,
  busyKey,
  oauthDetails,
  oauthCodes,
  onOAuthCodeChange,
  pendingOAuth,
  onOAuthStart,
  onOAuthComplete,
  onCopyOAuthLink,
  onCopyOAuthCode,
  className,
}) => {
  const { t } = useI18n();
  const apiKeyBusy = busyKey === `api:${providerId}`;

  return (
    <div className={cn('space-y-4', className)}>
      {showApiKeyField ? (
        <div className="py-1.5">
          <label className="typography-ui-label text-foreground flex items-center gap-1.5">
            {t('settings.providers.page.auth.apiKeyLabel')}
            <SettingsInfoHint>{t('settings.providers.page.auth.apiKeyTooltip')}</SettingsInfoHint>
          </label>
          <div className="flex flex-col @xl:flex-row @xl:items-center gap-2 mt-1.5">
            <Input
              type="password"
              value={apiKeyValue}
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
              className="flex-1 font-mono text-xs"
            />
            <Button
              size="xs"
              className="!font-normal shrink-0"
              onClick={onSaveApiKey}
              disabled={apiKeyBusy}
            >
              {apiKeyBusy ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
            </Button>
          </div>
        </div>
      ) : null}

      {oauthEntries.length > 0 ? (
        <div className={cn('space-y-4', showApiKeyField && 'border-t border-[var(--surface-subtle)] pt-2')}>
          {oauthEntries.map(({ index, method }) => {
            const methodLabel = method.label
              || method.name
              || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
            const codeKey = `${providerId}:${index}`;
            const details = oauthDetails[codeKey];
            const isPending = pendingOAuth?.providerId === providerId && pendingOAuth?.methodIndex === index;
            const startBusy = busyKey === `oauth:${providerId}:${index}`;
            const completeBusy = busyKey === `oauth-complete:${providerId}:${index}`;

            return (
              <div key={codeKey} className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="typography-ui-label text-foreground">{methodLabel}</div>
                    {(method.description || method.help) && (
                      <div className="typography-meta text-muted-foreground">
                        {String(method.description || method.help)}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    className="!font-normal"
                    onClick={() => onOAuthStart(index)}
                    disabled={startBusy}
                  >
                    {t('settings.providers.page.actions.connect')}
                  </Button>
                </div>

                {details?.instructions && (
                  <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded whitespace-pre-line">
                    {details.instructions}
                  </p>
                )}

                {details?.userCode && (
                  <div className="flex items-center gap-2 mt-2">
                    <Input value={details.userCode} readOnly className="font-mono text-center tracking-widest" />
                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => onCopyOAuthCode(details.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                  </div>
                )}

                {details?.url && (
                  <div className="flex items-center gap-2 mt-2">
                    <Input value={details.url} readOnly className="text-xs text-muted-foreground" />
                    <div className="flex gap-1 shrink-0">
                      <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(details.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                      <Button variant="outline" size="xs" className="!font-normal" onClick={() => onCopyOAuthLink(details.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                    </div>
                  </div>
                )}

                {isPending && (
                  <div className="flex items-center gap-2 mt-2">
                    <Input
                      value={oauthCodes[codeKey] ?? ''}
                      onChange={(event) => onOAuthCodeChange(codeKey, event.target.value)}
                      placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                      className="font-mono text-xs"
                    />
                    <Button
                      size="xs"
                      className="!font-normal"
                      onClick={() => onOAuthComplete(index)}
                      disabled={completeBusy}
                    >
                      {completeBusy ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};
