import React from 'react';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import {
  buildInstanceServices,
  parseInstanceServiceInfo,
  type InstanceServiceInfo,
} from './instanceServiceUrlModel';

type InstanceServiceUrlsProps = {
  /**
   * Pre-fetched `/api/system/info` fields. When provided (including `null`
   * while loading/failed), this component does not fetch on its own — callers
   * that already load system info should pass the parsed payload to avoid a
   * duplicate GET.
   */
  info?: InstanceServiceInfo | null;
  className?: string;
};

/**
 * Shows the active instance's service URLs (local server port + tunnel URL,
 * when a tunnel is active) as labeled buttons that open the URL in the
 * browser. The data comes from `/api/system/info`, which the server derives
 * from its own runtime state — this is what makes each Git-worktree instance
 * distinguishable in the UI without reading terminal output.
 *
 * The section stays hidden when the endpoint is unavailable or reports no
 * usable local/tunnel URL (e.g. VS Code runtime or remote viewers without a
 * tunnel), so a failed fetch never renders stale or wrong URLs.
 */
export const InstanceServiceUrls: React.FC<InstanceServiceUrlsProps> = ({ info: infoProp, className }) => {
  const { t } = useI18n();
  const managed = infoProp !== undefined;
  const [fetchedInfo, setFetchedInfo] = React.useState<InstanceServiceInfo | null>(null);
  const [endpointEpoch, setEndpointEpoch] = React.useState(0);

  React.useEffect(() => {
    if (managed) return;
    return subscribeRuntimeEndpointChanged(() => {
      setEndpointEpoch((current) => current + 1);
    });
  }, [managed]);

  React.useEffect(() => {
    if (managed) return;

    let cancelled = false;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;

    const load = async () => {
      try {
        const response = await runtimeFetch('/api/system/info', {
          signal: controller?.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          if (!cancelled) setFetchedInfo(null);
          return;
        }
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        setFetchedInfo(parseInstanceServiceInfo(data));
      } catch {
        // Best-effort: a failed fetch keeps the section hidden instead of
        // showing data we cannot verify.
        if (!cancelled) setFetchedInfo(null);
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller?.abort();
    };
  }, [managed, endpointEpoch]);

  const info = managed ? infoProp : fetchedInfo;
  const services = buildInstanceServices(info, {
    application: t('settings.openchamber.about.field.applicationUrl'),
    tunnel: t('settings.openchamber.about.field.tunnelUrl'),
  });

  if (services.length === 0) {
    return null;
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {services.map((service) => (
        <Button
          key={service.key}
          type="button"
          variant="outline"
          size="sm"
          title={service.label}
          className="max-w-full gap-1.5 px-2.5"
          onClick={() => {
            void openExternalUrl(service.url);
          }}
        >
          <Icon name="external-link" className="size-3.5 shrink-0" />
          <span className="max-w-64 truncate font-mono typography-micro">{service.url}</span>
        </Button>
      ))}
    </div>
  );
};
